from __future__ import annotations

import datetime as dt
import uuid
from collections.abc import Sequence

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from .chunking import chunk_text
from .config import Settings, get_settings
from .content import content_hash
from .ids import uuid7
from .models import (
    EmbeddingProfile,
    Job,
    Peer,
    Project,
    Record,
    RecordSegment,
    Session,
    SessionPeer,
    Workspace,
)
from .schemas import (
    PeerCreate,
    ProjectCreate,
    RecordBatchCreate,
    RecordBatchReceipt,
    RecordReceipt,
    SessionCreate,
    WorkspaceCreate,
)


class ScopeNotFoundError(LookupError):
    pass


class RecordConflictError(RuntimeError):
    def __init__(self, record_ids: Sequence[uuid.UUID]) -> None:
        self.record_ids = list(record_ids)
        super().__init__(
            "record id was previously used with different content or scope"
        )


async def create_workspace(db: AsyncSession, body: WorkspaceCreate) -> Workspace:
    workspace_id = body.id or uuid7()
    assert body.slug is not None
    stmt = (
        pg_insert(Workspace.__table__)
        .values(
            id=workspace_id,
            slug=body.slug,
            name=body.name,
            metadata=body.metadata,
        )
        .on_conflict_do_nothing(index_elements=[Workspace.slug])
    )
    await db.execute(stmt)
    workspace = await db.scalar(select(Workspace).where(Workspace.slug == body.slug))
    if workspace is None:
        raise RuntimeError("workspace upsert did not return a row")
    return workspace


async def list_workspaces(db: AsyncSession) -> list[Workspace]:
    return list(
        (
            await db.scalars(
                select(Workspace).order_by(Workspace.created_at, Workspace.id)
            )
        ).all()
    )


async def create_project(
    db: AsyncSession, workspace_id: uuid.UUID, body: ProjectCreate
) -> Project:
    if (
        await db.scalar(select(Workspace.id).where(Workspace.id == workspace_id))
        is None
    ):
        raise ScopeNotFoundError("workspace not found")
    project_id = body.id or uuid7()
    assert body.slug is not None
    await db.execute(
        pg_insert(Project.__table__)
        .values(
            id=project_id,
            workspace_id=workspace_id,
            slug=body.slug,
            name=body.name,
            metadata=body.metadata,
        )
        .on_conflict_do_nothing(index_elements=[Project.workspace_id, Project.slug])
    )
    project = await db.scalar(
        select(Project).where(
            Project.workspace_id == workspace_id, Project.slug == body.slug
        )
    )
    if project is None:
        raise RuntimeError("project upsert did not return a row")
    return project


async def list_projects(db: AsyncSession, workspace_id: uuid.UUID) -> list[Project]:
    if (
        await db.scalar(select(Workspace.id).where(Workspace.id == workspace_id))
        is None
    ):
        raise ScopeNotFoundError("workspace not found")
    return list(
        (
            await db.scalars(
                select(Project)
                .where(Project.workspace_id == workspace_id)
                .order_by(Project.created_at, Project.id)
            )
        ).all()
    )


async def create_peer(
    db: AsyncSession, workspace_id: uuid.UUID, body: PeerCreate
) -> Peer:
    if (
        await db.scalar(select(Workspace.id).where(Workspace.id == workspace_id))
        is None
    ):
        raise ScopeNotFoundError("workspace not found")
    peer_id = body.id or uuid7()
    await db.execute(
        pg_insert(Peer.__table__)
        .values(
            id=peer_id,
            workspace_id=workspace_id,
            external_key=body.external_key,
            name=body.name,
            kind=body.kind,
            metadata=body.metadata,
        )
        .on_conflict_do_nothing(index_elements=[Peer.workspace_id, Peer.external_key])
    )
    peer = await db.scalar(
        select(Peer).where(
            Peer.workspace_id == workspace_id,
            Peer.external_key == body.external_key,
        )
    )
    if peer is None:
        raise RuntimeError("peer upsert did not return a row")
    return peer


async def create_session(
    db: AsyncSession,
    workspace_id: uuid.UUID,
    project_id: uuid.UUID,
    body: SessionCreate,
) -> Session:
    if (
        await db.scalar(
            select(Project.id).where(
                Project.id == project_id, Project.workspace_id == workspace_id
            )
        )
        is None
    ):
        raise ScopeNotFoundError("project not found")
    session_id = body.id or uuid7()
    await db.execute(
        pg_insert(Session.__table__)
        .values(
            id=session_id,
            workspace_id=workspace_id,
            project_id=project_id,
            external_key=body.external_key,
            name=body.name,
            source_app=body.source_app,
            metadata=body.metadata,
        )
        .on_conflict_do_nothing(
            index_elements=[Session.project_id, Session.external_key]
        )
    )
    session = await db.scalar(
        select(Session).where(
            Session.workspace_id == workspace_id,
            Session.project_id == project_id,
            Session.external_key == body.external_key,
        )
    )
    if session is None:
        raise RuntimeError("session upsert did not return a row")

    if body.peer_ids:
        valid_peers = set(
            (
                await db.scalars(
                    select(Peer.id).where(
                        Peer.workspace_id == workspace_id,
                        Peer.id.in_(body.peer_ids),
                    )
                )
            ).all()
        )
        if valid_peers != set(body.peer_ids):
            raise ScopeNotFoundError("one or more peers were not found")
        for peer_id in body.peer_ids:
            await _ensure_session_peer(db, session, peer_id)
    return session


async def _ensure_session_peer(
    db: AsyncSession, session: Session, peer_id: uuid.UUID
) -> None:
    await db.execute(
        pg_insert(SessionPeer)
        .values(
            session_id=session.id,
            peer_id=peer_id,
            workspace_id=session.workspace_id,
            project_id=session.project_id,
        )
        .on_conflict_do_update(
            index_elements=[SessionPeer.session_id, SessionPeer.peer_id],
            set_={"left_at": None},
        )
    )


async def _resolve_author(
    db: AsyncSession,
    *,
    workspace_id: uuid.UUID,
    author_peer_id: uuid.UUID | None,
    author_key: str | None,
    author_name: str | None,
    author_kind: str,
) -> Peer:
    if author_peer_id is not None:
        peer = await db.scalar(
            select(Peer).where(
                Peer.id == author_peer_id, Peer.workspace_id == workspace_id
            )
        )
        if peer is not None:
            return peer
        if author_key is None:
            raise ScopeNotFoundError("author peer not found")
    if author_key is None:
        raise ScopeNotFoundError("author peer not found")
    return await create_peer(
        db,
        workspace_id,
        PeerCreate(
            id=author_peer_id,
            external_key=author_key,
            name=author_name or author_key,
            kind=author_kind,
        ),
    )


async def ensure_embedding_profile(
    db: AsyncSession, settings: Settings
) -> EmbeddingProfile:
    await db.execute(
        pg_insert(EmbeddingProfile)
        .values(
            id=uuid7(),
            name=settings.embedding_profile_name,
            model=settings.embedding_model or settings.embedding_profile_name,
            dimensions=settings.embedding_dimensions,
            storage="halfvec",
            normalized=True,
            query_instruction=settings.embedding_query_instruction,
            active=True,
        )
        .on_conflict_do_nothing(index_elements=[EmbeddingProfile.name])
    )
    profile = await db.scalar(
        select(EmbeddingProfile).where(
            EmbeddingProfile.name == settings.embedding_profile_name
        )
    )
    if profile is None:
        raise RuntimeError("embedding profile upsert did not return a row")
    return profile


async def ingest_records(
    db: AsyncSession,
    *,
    workspace_id: uuid.UUID,
    project_id: uuid.UUID,
    session_id: uuid.UUID,
    body: RecordBatchCreate,
    settings: Settings | None = None,
) -> RecordBatchReceipt:
    settings = settings or get_settings()
    session = await db.scalar(
        select(Session)
        .where(
            Session.id == session_id,
            Session.workspace_id == workspace_id,
            Session.project_id == project_id,
        )
        .with_for_update()
    )
    if session is None:
        raise ScopeNotFoundError("session not found")

    input_hashes = {item.id: content_hash(item.content) for item in body.records}
    existing = {
        item.id: item
        for item in (
            await db.scalars(select(Record).where(Record.id.in_(input_hashes)))
        ).all()
    }
    conflicts = [
        record_id
        for record_id, record in existing.items()
        if record.content_hash != input_hashes[record_id]
        or record.workspace_id != workspace_id
        or record.project_id != project_id
        or record.session_id != session_id
    ]
    if conflicts:
        raise RecordConflictError(conflicts)

    profile = await ensure_embedding_profile(db, settings)
    next_sequence = session.next_record_sequence
    receipts: list[RecordReceipt] = []
    jobs_created = 0

    for item in body.records:
        prior = existing.get(item.id)
        if prior is not None:
            segment_count = int(
                await db.scalar(
                    select(func.count(RecordSegment.id)).where(
                        RecordSegment.record_id == prior.id,
                        RecordSegment.workspace_id == workspace_id,
                        RecordSegment.project_id == project_id,
                    )
                )
                or 0
            )
            receipts.append(
                RecordReceipt(
                    id=prior.id,
                    sequence=prior.sequence,
                    content_hash=prior.content_hash,
                    created=False,
                    segment_count=segment_count,
                )
            )
            continue

        author = await _resolve_author(
            db,
            workspace_id=workspace_id,
            author_peer_id=item.author_peer_id,
            author_key=item.author_key,
            author_name=item.author_name,
            author_kind=item.author_kind,
        )
        await _ensure_session_peer(db, session, author.id)
        record = Record(
            id=item.id,
            workspace_id=workspace_id,
            project_id=project_id,
            session_id=session_id,
            author_peer_id=author.id,
            sequence=next_sequence,
            kind=item.kind,
            content=item.content,
            content_hash=input_hashes[item.id],
            occurred_at=item.occurred_at,
            source_app=item.source_app or session.source_app,
            extra_metadata=item.metadata,
        )
        db.add(record)

        chunks = chunk_text(
            item.content,
            max_tokens=settings.segment_max_tokens,
            overlap_ratio=settings.segment_overlap_ratio,
        )
        for chunk in chunks:
            db.add(
                RecordSegment(
                    workspace_id=workspace_id,
                    project_id=project_id,
                    record_id=item.id,
                    ordinal=chunk.ordinal,
                    content=chunk.content,
                    content_hash=content_hash(chunk.content),
                    token_start=chunk.token_start,
                    token_end=chunk.token_end,
                    token_count=chunk.token_count,
                )
            )

        for kind, suffix, payload in (
            (
                "embed_record",
                profile.name,
                {"record_id": str(item.id), "profile_id": str(profile.id)},
            ),
            ("extract_claims", "v1", {"record_id": str(item.id)}),
        ):
            db.add(
                Job(
                    workspace_id=workspace_id,
                    project_id=project_id,
                    session_id=session_id,
                    kind=kind,
                    dedupe_key=f"{kind}:{item.id}:{suffix}",
                    payload=payload,
                    status="pending",
                    max_attempts=settings.worker_max_attempts,
                    run_after=dt.datetime.now(dt.UTC),
                )
            )
            jobs_created += 1

        receipts.append(
            RecordReceipt(
                id=item.id,
                sequence=next_sequence,
                content_hash=input_hashes[item.id],
                created=True,
                segment_count=len(chunks),
            )
        )
        next_sequence += 1

    session.next_record_sequence = next_sequence
    await db.flush()
    return RecordBatchReceipt(
        workspace_id=workspace_id,
        project_id=project_id,
        session_id=session_id,
        records=receipts,
        jobs_created=jobs_created,
    )
