from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import logging
import socket
import uuid
from dataclasses import dataclass

from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert

from .config import Settings, get_settings
from .content import normalized_claim
from .db import dispose_engine, get_session_factory
from .ids import uuid7
from .models import (
    Claim,
    ClaimEdge,
    ClaimEmbedding,
    ClaimSource,
    EmbeddingProfile,
    Job,
    Peer,
    Project,
    Record,
    RecordEmbedding,
    RecordSegment,
)
from .providers import ModelProviders, ProviderUnavailable, TransientProviderError

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class ClaimedJob:
    id: uuid.UUID
    workspace_id: uuid.UUID
    project_id: uuid.UUID
    session_id: uuid.UUID | None
    kind: str
    payload: dict[str, object]
    attempts: int
    max_attempts: int
    lease_owner: str


async def claim_jobs(settings: Settings, owner: str) -> list[ClaimedJob]:
    now = dt.datetime.now(dt.UTC)
    lease_until = now + dt.timedelta(seconds=settings.worker_lease_seconds)
    async with get_session_factory()() as db:
        stmt = (
            select(Job)
            .where(
                or_(
                    and_(Job.status.in_(["pending", "retry"]), Job.run_after <= now),
                    and_(
                        Job.status == "running",
                        Job.lease_expires_at.is_not(None),
                        Job.lease_expires_at < now,
                    ),
                )
            )
            .order_by(Job.run_after, Job.created_at, Job.id)
            .limit(settings.worker_batch_size)
            .with_for_update(skip_locked=True)
        )
        jobs = list((await db.scalars(stmt)).all())
        claimed: list[ClaimedJob] = []
        for job in jobs:
            job.status = "running"
            job.attempts += 1
            job.lease_owner = owner
            job.lease_expires_at = lease_until
            claimed.append(
                ClaimedJob(
                    id=job.id,
                    workspace_id=job.workspace_id,
                    project_id=job.project_id,
                    session_id=job.session_id,
                    kind=job.kind,
                    payload=dict(job.payload),
                    attempts=job.attempts,
                    max_attempts=job.max_attempts,
                    lease_owner=owner,
                )
            )
        await db.commit()
        return claimed


async def complete_job(job: ClaimedJob) -> None:
    async with get_session_factory()() as db:
        await db.execute(
            update(Job)
            .where(
                Job.id == job.id,
                Job.status == "running",
                Job.lease_owner == job.lease_owner,
            )
            .values(
                status="done",
                completed_at=func.now(),
                lease_owner=None,
                lease_expires_at=None,
                last_error=None,
            )
        )
        await db.commit()


async def retry_job(
    job: ClaimedJob,
    error: BaseException,
    *,
    burn_attempt: bool = True,
) -> None:
    attempts = job.attempts if burn_attempt else max(0, job.attempts - 1)
    failed = burn_attempt and attempts >= job.max_attempts
    delay = min(3600, max(15, 2 ** min(attempts, 11)))
    async with get_session_factory()() as db:
        await db.execute(
            update(Job)
            .where(
                Job.id == job.id,
                Job.status == "running",
                Job.lease_owner == job.lease_owner,
            )
            .values(
                status="failed" if failed else "retry",
                attempts=attempts,
                run_after=dt.datetime.now(dt.UTC) + dt.timedelta(seconds=delay),
                lease_owner=None,
                lease_expires_at=None,
                last_error=f"{type(error).__name__}: {error}"[:16_000],
            )
        )
        await db.commit()


async def _process_embed_record(job: ClaimedJob, providers: ModelProviders) -> None:
    record_id = uuid.UUID(str(job.payload["record_id"]))
    profile_id = uuid.UUID(str(job.payload["profile_id"]))
    async with get_session_factory()() as db:
        profile = await db.scalar(
            select(EmbeddingProfile).where(
                EmbeddingProfile.id == profile_id, EmbeddingProfile.active.is_(True)
            )
        )
        segments = list(
            (
                await db.scalars(
                    select(RecordSegment)
                    .where(
                        RecordSegment.record_id == record_id,
                        RecordSegment.workspace_id == job.workspace_id,
                        RecordSegment.project_id == job.project_id,
                    )
                    .order_by(RecordSegment.ordinal)
                )
            ).all()
        )
        snapshots = [(segment.id, segment.content) for segment in segments]
    if profile is None:
        raise ValueError("embedding profile not found or inactive")
    if not snapshots:
        return

    vectors = await providers.embed_texts([content for _, content in snapshots])
    async with get_session_factory()() as db:
        for (segment_id, _), vector in zip(snapshots, vectors, strict=True):
            stmt = pg_insert(RecordEmbedding).values(
                id=uuid7(),
                workspace_id=job.workspace_id,
                project_id=job.project_id,
                record_id=record_id,
                segment_id=segment_id,
                profile_id=profile_id,
                embedding=vector,
            )
            await db.execute(
                stmt.on_conflict_do_update(
                    index_elements=[
                        RecordEmbedding.segment_id,
                        RecordEmbedding.profile_id,
                    ],
                    set_={
                        "embedding": stmt.excluded.embedding,
                        "created_at": func.now(),
                    },
                )
            )
        await db.commit()


async def _load_extraction_context(
    job: ClaimedJob,
) -> tuple[
    Record,
    str,
    str,
    list[tuple[uuid.UUID, str]],
    list[tuple[str, str]],
    dict[str, uuid.UUID],
    tuple[str, str],
]:
    record_id = uuid.UUID(str(job.payload["record_id"]))
    async with get_session_factory()() as db:
        record = await db.scalar(
            select(Record).where(
                Record.id == record_id,
                Record.workspace_id == job.workspace_id,
                Record.project_id == job.project_id,
            )
        )
        if record is None:
            raise ValueError("record not found")
        author_row = (
            await db.execute(
                select(Peer.name, Peer.kind).where(
                    Peer.id == record.author_peer_id,
                    Peer.workspace_id == job.workspace_id,
                )
            )
        ).one_or_none()
        author_name, author_kind = author_row or (str(record.author_peer_id), "human")
        context_rows = (
            await db.execute(
                select(Peer.name, Record.content)
                .join(
                    Peer,
                    and_(
                        Peer.id == Record.author_peer_id,
                        Peer.workspace_id == Record.workspace_id,
                    ),
                )
                .where(
                    Record.workspace_id == job.workspace_id,
                    Record.project_id == job.project_id,
                    Record.session_id == record.session_id,
                    Record.id != record.id,
                    Record.sequence.between(
                        max(1, record.sequence - 2), record.sequence + 2
                    ),
                )
                .order_by(Record.sequence)
            )
        ).all()
        segment_rows = (
            await db.execute(
                select(RecordSegment.id, RecordSegment.content)
                .where(
                    RecordSegment.record_id == record.id,
                    RecordSegment.workspace_id == job.workspace_id,
                    RecordSegment.project_id == job.project_id,
                )
                .order_by(RecordSegment.ordinal)
            )
        ).all()
        peer_rows = (
            await db.execute(
                select(Peer.id, Peer.name, Peer.external_key).where(
                    Peer.workspace_id == job.workspace_id
                )
            )
        ).all()
        peer_labels: dict[str, uuid.UUID] = {}
        for peer_id, peer_name, external_key in peer_rows:
            peer_labels[peer_name.casefold()] = peer_id
            peer_labels[external_key.casefold()] = peer_id
        project_row = (
            await db.execute(
                select(Project.name, Project.slug).where(
                    Project.id == job.project_id,
                    Project.workspace_id == job.workspace_id,
                )
            )
        ).one()
        db.expunge(record)
        return (
            record,
            author_name,
            author_kind,
            list(segment_rows),
            list(context_rows),
            peer_labels,
            project_row,
        )


async def _process_extract_claims(job: ClaimedJob, providers: ModelProviders) -> None:
    (
        record,
        author_name,
        author_kind,
        segments,
        context,
        peer_labels,
        project_row,
    ) = await _load_extraction_context(job)
    if author_kind not in {"human", "agent"}:
        return
    extracted = await providers.extract_claims(
        author_name=author_name,
        content=record.content,
        occurred_at=record.occurred_at.isoformat(),
        context=context,
    )

    async with get_session_factory()() as db:
        for ordinal, candidate in enumerate(extracted.claims):
            normalized = normalized_claim(candidate.content)
            if not normalized:
                continue
            subject_peer_id = (
                peer_labels.get(candidate.subject_label.casefold())
                if candidate.subject_label
                else None
            )
            claim_id = uuid7()
            insert_claim = (
                pg_insert(Claim.__table__)
                .values(
                    id=claim_id,
                    workspace_id=job.workspace_id,
                    project_id=job.project_id,
                    session_id=record.session_id,
                    asserted_by_peer_id=record.author_peer_id,
                    subject_peer_id=subject_peer_id,
                    content=candidate.content,
                    normalized_content=normalized,
                    derivation_method="llm_extracted",
                    status="active",
                    occurred_at=record.occurred_at,
                    extraction_job_id=job.id,
                    candidate_ordinal=ordinal,
                    metadata={},
                )
                .on_conflict_do_nothing()
                .returning(Claim.id)
            )
            inserted_id = await db.scalar(insert_claim)
            if inserted_id is None:
                inserted_id = await db.scalar(
                    select(Claim.id)
                    .where(
                        Claim.workspace_id == job.workspace_id,
                        Claim.project_id == job.project_id,
                        Claim.extraction_job_id == job.id,
                        Claim.candidate_ordinal == ordinal,
                    )
                    .limit(1)
                )
            if inserted_id is None:
                inserted_id = await db.scalar(
                    select(Claim.id)
                    .where(
                        Claim.workspace_id == job.workspace_id,
                        Claim.project_id == job.project_id,
                        Claim.normalized_content == normalized,
                    )
                    .limit(1)
                )
            if inserted_id is None:
                raise RuntimeError("claim upsert did not return a row")

            source_segment_id = segments[0][0] if segments else None
            exact_quote = candidate.quote
            if exact_quote:
                matching_segment = next(
                    (
                        (segment_id, text)
                        for segment_id, text in segments
                        if exact_quote in text
                    ),
                    None,
                )
                if matching_segment is None:
                    exact_quote = None
                else:
                    source_segment_id = matching_segment[0]

            source_stmt = pg_insert(ClaimSource).values(
                id=uuid7(),
                workspace_id=job.workspace_id,
                project_id=job.project_id,
                claim_id=inserted_id,
                record_id=record.id,
                segment_id=source_segment_id,
                role="states",
                quote=exact_quote,
            )
            await db.execute(source_stmt.on_conflict_do_nothing())

            if inserted_id == claim_id:
                profile_id = await db.scalar(
                    select(EmbeddingProfile.id)
                    .where(EmbeddingProfile.active.is_(True))
                    .order_by(EmbeddingProfile.created_at.desc())
                    .limit(1)
                )
                if profile_id is not None:
                    embed_job = pg_insert(Job).values(
                        id=uuid7(),
                        workspace_id=job.workspace_id,
                        project_id=job.project_id,
                        session_id=record.session_id,
                        kind="embed_claim",
                        dedupe_key=f"embed_claim:{inserted_id}:{profile_id}",
                        payload={
                            "claim_id": str(inserted_id),
                            "profile_id": str(profile_id),
                        },
                        status="pending",
                        max_attempts=job.max_attempts,
                        run_after=dt.datetime.now(dt.UTC),
                    )
                    await db.execute(
                        embed_job.on_conflict_do_nothing(
                            index_elements=[Job.dedupe_key]
                        )
                    )

                if (
                    candidate.subject_label
                    and candidate.predicate
                    and candidate.object_label
                ):
                    project_name, project_slug = project_row
                    subject_label_key = candidate.subject_label.casefold()
                    if subject_peer_id is not None:
                        subject_type = "peer"
                        subject_key = str(subject_peer_id)
                    elif subject_label_key in {
                        project_name.casefold(),
                        project_slug.casefold(),
                    }:
                        subject_type = "project"
                        subject_key = str(job.project_id)
                    else:
                        continue

                    predicate = candidate.predicate.strip().upper().replace(" ", "_")
                    allowed_predicates = {
                        "MEMBER_OF",
                        "USES",
                        "OWNS",
                        "IMPLEMENTS",
                        "DEPENDS_ON",
                        "RELATES_TO",
                        "DECIDED",
                        "HAS_STATUS",
                        "LOCATED_IN",
                        "PREFERS",
                    }
                    if predicate not in allowed_predicates:
                        continue

                    object_label_key = candidate.object_label.casefold()
                    object_peer_id = peer_labels.get(object_label_key)
                    if object_peer_id is not None:
                        object_type = "peer"
                        object_key = str(object_peer_id)
                    elif object_label_key in {
                        project_name.casefold(),
                        project_slug.casefold(),
                    }:
                        object_type = "project"
                        object_key = str(job.project_id)
                    else:
                        object_type = "literal"
                        object_key = normalized_claim(candidate.object_label)[:512]
                        if not object_key:
                            continue
                    edge_stmt = pg_insert(ClaimEdge).values(
                        id=uuid7(),
                        workspace_id=job.workspace_id,
                        project_id=job.project_id,
                        claim_id=inserted_id,
                        subject_type=subject_type,
                        subject_key=subject_key,
                        subject_label=candidate.subject_label,
                        predicate=predicate,
                        object_type=object_type,
                        object_key=object_key,
                        object_label=candidate.object_label,
                    )
                    await db.execute(
                        edge_stmt.on_conflict_do_nothing(
                            index_elements=[
                                ClaimEdge.claim_id,
                                ClaimEdge.subject_key,
                                ClaimEdge.predicate,
                                ClaimEdge.object_key,
                            ]
                        )
                    )
        await db.commit()


async def _process_embed_claim(job: ClaimedJob, providers: ModelProviders) -> None:
    claim_id = uuid.UUID(str(job.payload["claim_id"]))
    profile_id = uuid.UUID(str(job.payload["profile_id"]))
    async with get_session_factory()() as db:
        claim = await db.scalar(
            select(Claim).where(
                Claim.id == claim_id,
                Claim.workspace_id == job.workspace_id,
                Claim.project_id == job.project_id,
                Claim.status == "active",
            )
        )
        if claim is None:
            return
        content = claim.content
    vector = (await providers.embed_texts([content]))[0]
    async with get_session_factory()() as db:
        stmt = pg_insert(ClaimEmbedding).values(
            id=uuid7(),
            workspace_id=job.workspace_id,
            project_id=job.project_id,
            claim_id=claim_id,
            profile_id=profile_id,
            embedding=vector,
        )
        await db.execute(
            stmt.on_conflict_do_update(
                index_elements=[ClaimEmbedding.claim_id, ClaimEmbedding.profile_id],
                set_={"embedding": stmt.excluded.embedding, "created_at": func.now()},
            )
        )
        await db.commit()


async def process_job(job: ClaimedJob, providers: ModelProviders) -> None:
    if job.kind == "embed_record":
        await _process_embed_record(job, providers)
    elif job.kind == "extract_claims":
        await _process_extract_claims(job, providers)
    elif job.kind == "embed_claim":
        await _process_embed_claim(job, providers)
    else:
        raise ValueError(f"unsupported job kind: {job.kind}")


async def run_worker(*, once: bool = False) -> None:
    settings = get_settings()
    logging.basicConfig(level=settings.log_level.upper())
    owner = f"{socket.gethostname()}:{uuid7()}"
    providers = ModelProviders(settings)
    try:
        while True:
            jobs = await claim_jobs(settings, owner)
            if not jobs:
                if once:
                    return
                await asyncio.sleep(settings.worker_poll_seconds)
                continue
            for job in jobs:
                try:
                    await process_job(job, providers)
                except (ProviderUnavailable, TransientProviderError) as error:
                    await retry_job(job, error, burn_attempt=False)
                except Exception as error:
                    logger.exception("job %s failed", job.id)
                    await retry_job(job, error)
                else:
                    await complete_job(job)
            if once:
                return
    finally:
        await dispose_engine()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    asyncio.run(run_worker(once=args.once))


if __name__ == "__main__":
    main()
