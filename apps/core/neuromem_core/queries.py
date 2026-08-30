from __future__ import annotations

import base64
import datetime as dt
import json
import uuid
from collections import defaultdict

from sqlalchemy import and_, case, distinct, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from .config import Settings
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
    Session,
)
from .providers import ModelProviders
from .ranking import reciprocal_rank_fusion
from .schemas import (
    ClaimEvidenceItem,
    ClaimEvidenceResponse,
    ClaimHit,
    ClaimListItem,
    ClaimPage,
    ClaimView,
    GraphEdge,
    GraphNode,
    GraphResponse,
    ProjectOverview,
    RecallRequest,
    RecallResponse,
    RecordContextResponse,
    RecordHit,
    RecordSnippet,
    RecordView,
    SystemBacklog,
    WikiCitation,
    WikiClaim,
    WikiResponse,
    WikiSection,
)
from .services import ScopeNotFoundError


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


async def _active_profile(
    db: AsyncSession, settings: Settings
) -> EmbeddingProfile | None:
    return await db.scalar(
        select(EmbeddingProfile)
        .where(
            EmbeddingProfile.name == settings.embedding_profile_name,
            EmbeddingProfile.active.is_(True),
        )
        .limit(1)
    )


async def configure_vector_scan(
    db: AsyncSession, *, active_vectors: int, settings: Settings
) -> bool:
    """Configure exact scan for small scopes and iterative HNSW for large ones.

    Returns True when planner settings must be restored after the query.
    """
    if active_vectors <= 25_000:
        await db.execute(text("SET LOCAL enable_indexscan = off"))
        await db.execute(text("SET LOCAL enable_bitmapscan = off"))
        return True
    await db.execute(text("SET LOCAL hnsw.iterative_scan = 'relaxed_order'"))
    await db.execute(text(f"SET LOCAL hnsw.ef_search = {settings.hnsw_ef_search}"))
    return False


async def restore_vector_scan(db: AsyncSession, restore: bool) -> None:
    if restore:
        await db.execute(text("SET LOCAL enable_indexscan = on"))
        await db.execute(text("SET LOCAL enable_bitmapscan = on"))


async def recall(
    db: AsyncSession,
    body: RecallRequest,
    *,
    settings: Settings,
    providers: ModelProviders,
) -> RecallResponse:
    query_vector: list[float] | None = None
    if settings.embedding_configured:
        try:
            query_vector = (await providers.embed_texts([body.query], query=True))[0]
        except Exception:
            query_vector = None

    profile = await _active_profile(db, settings) if query_vector is not None else None
    records = (
        await _search_records(db, body, settings, profile, query_vector)
        if "records" in body.include
        else []
    )
    claims = (
        await _search_claims(db, body, settings, profile, query_vector)
        if "claims" in body.include
        else []
    )
    snippets = await _record_snippets(db, records, before=2, after=2)
    return RecallResponse(
        query=body.query,
        records=records,
        record_snippets=snippets,
        claims=claims,
        embedding_used=query_vector is not None and profile is not None,
    )


async def _search_records(
    db: AsyncSession,
    body: RecallRequest,
    settings: Settings,
    profile: EmbeddingProfile | None,
    query_vector: list[float] | None,
) -> list[RecordHit]:
    escaped = _escape_like(body.query)
    substring = RecordSegment.content.ilike(f"%{escaped}%", escape="\\")
    similarity = func.similarity(RecordSegment.content, body.query)
    scope = [
        Record.workspace_id == body.workspace_id,
        Record.project_id == body.project_id,
    ]
    if body.session_id is not None:
        scope.append(Record.session_id == body.session_id)
    if body.after is not None:
        scope.append(Record.occurred_at >= body.after)
    if body.before is not None:
        scope.append(Record.occurred_at <= body.before)

    lexical_rows = (
        await db.execute(
            select(
                Record,
                RecordSegment.id,
                RecordSegment.content,
                similarity.label("score"),
            )
            .join(
                RecordSegment,
                and_(
                    RecordSegment.record_id == Record.id,
                    RecordSegment.workspace_id == Record.workspace_id,
                    RecordSegment.project_id == Record.project_id,
                ),
            )
            .where(
                *scope,
                or_(substring, similarity >= settings.exact_similarity_threshold),
            )
            .order_by(
                case((substring, 1), else_=0).desc(),
                similarity.desc(),
                Record.created_at.desc(),
            )
            .limit(body.limit * 4)
        )
    ).all()
    lexical_ids: list[uuid.UUID] = []
    lexical_best: dict[uuid.UUID, tuple[Record, uuid.UUID, str]] = {}
    for record, segment_id, segment_content, _score in lexical_rows:
        if record.id not in lexical_best:
            lexical_ids.append(record.id)
            lexical_best[record.id] = (record, segment_id, segment_content)

    vector_ids: list[uuid.UUID] = []
    vector_best: dict[uuid.UUID, tuple[Record, uuid.UUID, str, float]] = {}
    if query_vector is not None and profile is not None:
        vector_count = int(
            await db.scalar(
                select(func.count(RecordEmbedding.id)).where(
                    RecordEmbedding.workspace_id == body.workspace_id,
                    RecordEmbedding.project_id == body.project_id,
                    RecordEmbedding.profile_id == profile.id,
                )
            )
            or 0
        )
        restore_scan = await configure_vector_scan(
            db, active_vectors=vector_count, settings=settings
        )
        distance = RecordEmbedding.embedding.cosine_distance(query_vector)
        vector_rows = (
            await db.execute(
                select(
                    Record,
                    RecordSegment.id,
                    RecordSegment.content,
                    distance.label("distance"),
                )
                .join(
                    RecordEmbedding,
                    and_(
                        RecordEmbedding.record_id == Record.id,
                        RecordEmbedding.workspace_id == Record.workspace_id,
                        RecordEmbedding.project_id == Record.project_id,
                        RecordEmbedding.profile_id == profile.id,
                    ),
                )
                .join(
                    RecordSegment,
                    and_(
                        RecordSegment.id == RecordEmbedding.segment_id,
                        RecordSegment.workspace_id == Record.workspace_id,
                        RecordSegment.project_id == Record.project_id,
                    ),
                )
                .where(*scope)
                .order_by(distance)
                .limit(body.limit * 4)
            )
        ).all()
        await restore_vector_scan(db, restore_scan)
        for record, segment_id, segment_content, row_distance in vector_rows:
            if record.id not in vector_best:
                vector_ids.append(record.id)
                vector_best[record.id] = (
                    record,
                    segment_id,
                    segment_content,
                    float(row_distance),
                )

    fused = reciprocal_rank_fusion([lexical_ids, vector_ids], limit=body.limit)
    results: list[RecordHit] = []
    node_id = settings.node_id
    for rank, (record_id, score) in enumerate(fused, start=1):
        if record_id in vector_best:
            record, segment_id, matched, distance_value = vector_best[record_id]
        else:
            record, segment_id, matched = lexical_best[record_id]
            distance_value = None
        results.append(
            RecordHit(
                result_id=record.id,
                node_id=node_id,
                workspace_id=record.workspace_id,
                project_id=record.project_id,
                session_id=record.session_id,
                record_id=record.id,
                segment_id=segment_id,
                content=record.content,
                matched_content=matched,
                created_at=record.created_at,
                rank=rank,
                rrf_score=score,
                distance=distance_value,
            )
        )
    return results


async def _record_snippets(
    db: AsyncSession,
    hits: list[RecordHit],
    *,
    before: int,
    after: int,
) -> list[RecordSnippet]:
    if not hits:
        return []
    hit_ids = [hit.record_id for hit in hits]
    workspace_id = hits[0].workspace_id
    project_id = hits[0].project_id
    target_rows = (
        await db.execute(
            select(Record.id, Record.session_id, Record.sequence).where(
                Record.id.in_(hit_ids),
                Record.workspace_id == workspace_id,
                Record.project_id == project_id,
            )
        )
    ).all()
    by_session: dict[uuid.UUID, list[tuple[int, int, uuid.UUID]]] = defaultdict(list)
    for record_id, session_id, sequence in target_rows:
        by_session[session_id].append(
            (max(1, sequence - before), sequence + after, record_id)
        )

    snippets: list[RecordSnippet] = []
    for session_id, intervals in by_session.items():
        intervals.sort()
        merged: list[tuple[int, int, list[uuid.UUID]]] = []
        for start, end, record_id in intervals:
            if merged and start <= merged[-1][1] + 1:
                previous_start, previous_end, matched = merged[-1]
                merged[-1] = (
                    previous_start,
                    max(previous_end, end),
                    [*matched, record_id],
                )
            else:
                merged.append((start, end, [record_id]))
        for start, end, matched in merged:
            records = list(
                (
                    await db.scalars(
                        select(Record)
                        .where(
                            Record.session_id == session_id,
                            Record.workspace_id == workspace_id,
                            Record.project_id == project_id,
                            Record.sequence.between(start, end),
                        )
                        .order_by(Record.sequence)
                    )
                ).all()
            )
            snippets.append(
                RecordSnippet(
                    session_id=session_id,
                    matched_record_ids=matched,
                    records=[RecordView.model_validate(record) for record in records],
                )
            )
    return snippets


async def _search_claims(
    db: AsyncSession,
    body: RecallRequest,
    settings: Settings,
    profile: EmbeddingProfile | None,
    query_vector: list[float] | None,
) -> list[ClaimHit]:
    escaped = _escape_like(body.query)
    substring = Claim.content.ilike(f"%{escaped}%", escape="\\")
    similarity = func.similarity(Claim.content, body.query)
    scope = [
        Claim.workspace_id == body.workspace_id,
        Claim.project_id == body.project_id,
        Claim.status == "active",
    ]
    if body.session_id is not None:
        scope.append(Claim.session_id == body.session_id)
    if body.after is not None:
        scope.append(Claim.occurred_at >= body.after)
    if body.before is not None:
        scope.append(Claim.occurred_at <= body.before)

    lexical = list(
        (
            await db.scalars(
                select(Claim)
                .where(
                    *scope,
                    or_(substring, similarity >= settings.exact_similarity_threshold),
                )
                .order_by(
                    case((substring, 1), else_=0).desc(),
                    similarity.desc(),
                    Claim.created_at.desc(),
                )
                .limit(body.limit * 3)
            )
        ).all()
    )
    lexical_ids = [claim.id for claim in lexical]
    by_id = {claim.id: claim for claim in lexical}
    distances: dict[uuid.UUID, float] = {}
    vector_ids: list[uuid.UUID] = []
    if query_vector is not None and profile is not None:
        vector_count = int(
            await db.scalar(
                select(func.count(ClaimEmbedding.id)).where(
                    ClaimEmbedding.workspace_id == body.workspace_id,
                    ClaimEmbedding.project_id == body.project_id,
                    ClaimEmbedding.profile_id == profile.id,
                )
            )
            or 0
        )
        restore_scan = await configure_vector_scan(
            db, active_vectors=vector_count, settings=settings
        )
        distance = ClaimEmbedding.embedding.cosine_distance(query_vector)
        vector_rows = (
            await db.execute(
                select(Claim, distance.label("distance"))
                .join(
                    ClaimEmbedding,
                    and_(
                        ClaimEmbedding.claim_id == Claim.id,
                        ClaimEmbedding.workspace_id == Claim.workspace_id,
                        ClaimEmbedding.project_id == Claim.project_id,
                        ClaimEmbedding.profile_id == profile.id,
                    ),
                )
                .where(*scope)
                .order_by(distance)
                .limit(body.limit * 3)
            )
        ).all()
        await restore_vector_scan(db, restore_scan)
        for claim, row_distance in vector_rows:
            vector_ids.append(claim.id)
            by_id[claim.id] = claim
            distances[claim.id] = float(row_distance)

    fused = reciprocal_rank_fusion([lexical_ids, vector_ids], limit=body.limit)
    claim_ids = [claim_id for claim_id, _ in fused]
    evidence_by_claim: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    if claim_ids:
        for claim_id, record_id in (
            await db.execute(
                select(ClaimSource.claim_id, ClaimSource.record_id).where(
                    ClaimSource.workspace_id == body.workspace_id,
                    ClaimSource.project_id == body.project_id,
                    ClaimSource.claim_id.in_(claim_ids),
                )
            )
        ).all():
            evidence_by_claim[claim_id].append(record_id)

    results: list[ClaimHit] = []
    for rank, (claim_id, score) in enumerate(fused, start=1):
        claim = by_id[claim_id]
        results.append(
            ClaimHit(
                result_id=claim.id,
                node_id=settings.node_id,
                workspace_id=claim.workspace_id,
                project_id=claim.project_id,
                session_id=claim.session_id,
                claim_id=claim.id,
                content=claim.content,
                derivation_method=claim.derivation_method,
                status=claim.status,
                evidence_ids=evidence_by_claim[claim.id],
                created_at=claim.created_at,
                rank=rank,
                rrf_score=score,
                distance=distances.get(claim.id),
            )
        )
    return results


async def record_context(
    db: AsyncSession,
    *,
    workspace_id: uuid.UUID,
    project_id: uuid.UUID,
    record_id: uuid.UUID,
    before: int,
    after: int,
) -> RecordContextResponse:
    target = await db.scalar(
        select(Record).where(
            Record.id == record_id,
            Record.workspace_id == workspace_id,
            Record.project_id == project_id,
        )
    )
    if target is None:
        raise ScopeNotFoundError("record not found")
    records = list(
        (
            await db.scalars(
                select(Record)
                .where(
                    Record.workspace_id == workspace_id,
                    Record.project_id == project_id,
                    Record.session_id == target.session_id,
                    Record.sequence.between(
                        max(1, target.sequence - before), target.sequence + after
                    ),
                )
                .order_by(Record.sequence)
            )
        ).all()
    )
    return RecordContextResponse(
        target_record_id=target.id,
        records=[RecordView.model_validate(record) for record in records],
    )


async def claim_evidence(
    db: AsyncSession,
    *,
    workspace_id: uuid.UUID,
    project_id: uuid.UUID,
    claim_id: uuid.UUID,
) -> ClaimEvidenceResponse:
    claim = await db.scalar(
        select(Claim).where(
            Claim.id == claim_id,
            Claim.workspace_id == workspace_id,
            Claim.project_id == project_id,
        )
    )
    if claim is None:
        raise ScopeNotFoundError("claim not found")
    rows = (
        await db.execute(
            select(ClaimSource, Record)
            .join(
                Record,
                and_(
                    Record.id == ClaimSource.record_id,
                    Record.workspace_id == ClaimSource.workspace_id,
                    Record.project_id == ClaimSource.project_id,
                ),
            )
            .where(
                ClaimSource.claim_id == claim_id,
                ClaimSource.workspace_id == workspace_id,
                ClaimSource.project_id == project_id,
            )
            .order_by(Record.occurred_at, Record.sequence)
        )
    ).all()
    return ClaimEvidenceResponse(
        claim=ClaimView.model_validate(claim),
        evidence=[
            ClaimEvidenceItem(
                source_id=source.id,
                role=source.role,
                quote=source.quote,
                record=RecordView.model_validate(record),
                segment_id=source.segment_id,
            )
            for source, record in rows
        ],
    )


def _encode_cursor(created_at: dt.datetime, claim_id: uuid.UUID) -> str:
    payload = json.dumps(
        {"created_at": created_at.isoformat(), "id": str(claim_id)},
        separators=(",", ":"),
    )
    return base64.urlsafe_b64encode(payload.encode()).decode().rstrip("=")


def _decode_cursor(cursor: str) -> tuple[dt.datetime, uuid.UUID]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded).decode())
        return dt.datetime.fromisoformat(data["created_at"]), uuid.UUID(data["id"])
    except Exception as error:
        raise ValueError("invalid cursor") from error


async def list_claims(
    db: AsyncSession,
    *,
    workspace_id: uuid.UUID,
    project_id: uuid.UUID,
    limit: int,
    cursor: str | None,
) -> ClaimPage:
    stmt = select(Claim).where(
        Claim.workspace_id == workspace_id,
        Claim.project_id == project_id,
    )
    if cursor:
        created_at, claim_id = _decode_cursor(cursor)
        stmt = stmt.where(
            or_(
                Claim.created_at < created_at,
                and_(Claim.created_at == created_at, Claim.id < claim_id),
            )
        )
    claims = list(
        (
            await db.scalars(
                stmt.order_by(Claim.created_at.desc(), Claim.id.desc()).limit(limit + 1)
            )
        ).all()
    )
    has_more = len(claims) > limit
    page = claims[:limit]
    counts = (
        dict(
            (
                await db.execute(
                    select(ClaimSource.claim_id, func.count(ClaimSource.id))
                    .where(
                        ClaimSource.workspace_id == workspace_id,
                        ClaimSource.project_id == project_id,
                        ClaimSource.claim_id.in_([claim.id for claim in page]),
                    )
                    .group_by(ClaimSource.claim_id)
                )
            ).all()
        )
        if page
        else {}
    )
    next_cursor = _encode_cursor(page[-1].created_at, page[-1].id) if has_more else None
    return ClaimPage(
        items=[
            ClaimListItem(
                claim=ClaimView.model_validate(claim),
                evidence_count=counts.get(claim.id, 0),
            )
            for claim in page
        ],
        next_cursor=next_cursor,
    )


async def project_overview(
    db: AsyncSession,
    *,
    workspace_id: uuid.UUID,
    project_id: uuid.UUID,
    settings: Settings,
) -> ProjectOverview:
    project_exists = await db.scalar(
        select(Project.id).where(
            Project.id == project_id, Project.workspace_id == workspace_id
        )
    )
    if project_exists is None:
        raise ScopeNotFoundError("project not found")
    record_count = int(
        await db.scalar(
            select(func.count(Record.id)).where(
                Record.workspace_id == workspace_id, Record.project_id == project_id
            )
        )
        or 0
    )
    claim_count = int(
        await db.scalar(
            select(func.count(Claim.id)).where(
                Claim.workspace_id == workspace_id,
                Claim.project_id == project_id,
                Claim.status == "active",
            )
        )
        or 0
    )
    session_count = int(
        await db.scalar(
            select(func.count(Session.id)).where(
                Session.workspace_id == workspace_id, Session.project_id == project_id
            )
        )
        or 0
    )
    peer_count = int(
        await db.scalar(
            select(func.count(distinct(Record.author_peer_id))).where(
                Record.workspace_id == workspace_id, Record.project_id == project_id
            )
        )
        or 0
    )
    job_rows = (
        await db.execute(
            select(Job.status, func.count(Job.id))
            .where(Job.workspace_id == workspace_id, Job.project_id == project_id)
            .group_by(Job.status)
        )
    ).all()
    last_ingested = await db.scalar(
        select(func.max(Record.created_at)).where(
            Record.workspace_id == workspace_id, Record.project_id == project_id
        )
    )
    return ProjectOverview(
        workspace_id=workspace_id,
        project_id=project_id,
        records=record_count,
        claims=claim_count,
        sessions=session_count,
        peers=peer_count,
        jobs={status: count for status, count in job_rows},
        last_ingested_at=last_ingested,
        embedding_configured=settings.embedding_configured,
        extraction_configured=settings.extraction_configured,
        mcp_url=settings.mcp_public_url,
    )


async def wiki_view(
    db: AsyncSession, *, workspace_id: uuid.UUID, project_id: uuid.UUID
) -> WikiResponse:
    rows = (
        await db.execute(
            select(Claim, Peer.name, func.count(ClaimSource.id))
            .outerjoin(
                Peer,
                and_(
                    Peer.id == Claim.subject_peer_id,
                    Peer.workspace_id == Claim.workspace_id,
                ),
            )
            .outerjoin(
                ClaimSource,
                and_(
                    ClaimSource.claim_id == Claim.id,
                    ClaimSource.workspace_id == Claim.workspace_id,
                    ClaimSource.project_id == Claim.project_id,
                ),
            )
            .where(
                Claim.workspace_id == workspace_id,
                Claim.project_id == project_id,
                Claim.status == "active",
            )
            .group_by(Claim.id, Peer.name)
            .order_by(Peer.name.asc().nullslast(), Claim.updated_at.desc())
        )
    ).all()
    grouped: dict[str, list[WikiClaim]] = defaultdict(list)
    claim_ids = [claim.id for claim, _peer_name, _evidence_count in rows]
    citations: dict[uuid.UUID, list[WikiCitation]] = defaultdict(list)
    if claim_ids:
        for claim_id, record_id, quote in (
            await db.execute(
                select(ClaimSource.claim_id, ClaimSource.record_id, ClaimSource.quote)
                .where(
                    ClaimSource.workspace_id == workspace_id,
                    ClaimSource.project_id == project_id,
                    ClaimSource.claim_id.in_(claim_ids),
                )
                .order_by(ClaimSource.created_at)
            )
        ).all():
            citations[claim_id].append(WikiCitation(record_id=record_id, quote=quote))
    for claim, peer_name, evidence_count in rows:
        grouped[peer_name or "Project memory"].append(
            WikiClaim(
                claim_id=claim.id,
                content=claim.content,
                evidence_count=evidence_count,
                evidence_ids=[citation.record_id for citation in citations[claim.id]],
                citations=citations[claim.id],
                updated_at=claim.updated_at,
            )
        )
    return WikiResponse(
        workspace_id=workspace_id,
        project_id=project_id,
        generated_at=dt.datetime.now(dt.UTC),
        sections=[
            WikiSection(title=title, claims=claims) for title, claims in grouped.items()
        ],
    )


async def graph_view(
    db: AsyncSession, *, workspace_id: uuid.UUID, project_id: uuid.UUID
) -> GraphResponse:
    edges = list(
        (
            await db.scalars(
                select(ClaimEdge)
                .join(Claim, Claim.id == ClaimEdge.claim_id)
                .where(
                    ClaimEdge.workspace_id == workspace_id,
                    ClaimEdge.project_id == project_id,
                    Claim.status == "active",
                )
                .order_by(ClaimEdge.created_at)
            )
        ).all()
    )
    nodes: dict[str, GraphNode] = {}
    response_edges: list[GraphEdge] = []
    for edge in edges:
        source = f"{edge.subject_type}:{edge.subject_key}"
        target = f"{edge.object_type}:{edge.object_key}"
        nodes[source] = GraphNode(
            id=source, type=edge.subject_type, label=edge.subject_label
        )
        nodes[target] = GraphNode(
            id=target, type=edge.object_type, label=edge.object_label
        )
        response_edges.append(
            GraphEdge(
                id=edge.id,
                claim_id=edge.claim_id,
                source=source,
                predicate=edge.predicate,
                target=target,
            )
        )
    return GraphResponse(
        workspace_id=workspace_id,
        project_id=project_id,
        nodes=list(nodes.values()),
        edges=response_edges,
    )


async def system_backlog(db: AsyncSession) -> SystemBacklog:
    rows = (
        await db.execute(select(Job.status, func.count(Job.id)).group_by(Job.status))
    ).all()
    counts = {status: count for status, count in rows}
    oldest = await db.scalar(
        select(func.min(Job.created_at)).where(Job.status.in_(["pending", "retry"]))
    )
    seconds = None
    if oldest is not None:
        seconds = max(0.0, (dt.datetime.now(dt.UTC) - oldest).total_seconds())
    return SystemBacklog(
        counts=counts,
        oldest_pending_at=oldest,
        oldest_pending_seconds=seconds,
        retrying=counts.get("retry", 0),
        failed=counts.get("failed", 0),
    )
