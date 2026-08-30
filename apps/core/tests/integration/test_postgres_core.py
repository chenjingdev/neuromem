from __future__ import annotations

import asyncio
import os
import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, text

from neuromem_core.app import app
from neuromem_core.config import get_settings
from neuromem_core.db import dispose_engine, get_session_factory
from neuromem_core.ids import uuid7
from neuromem_core.models import Claim, ClaimSource, Job, Record, RecordSegment
from neuromem_core.providers import ExtractedClaim, ExtractionResult
from neuromem_core.queries import claim_evidence, recall, record_context
from neuromem_core.schema import upgrade_schema, verify_schema
from neuromem_core.schemas import (
    ProjectCreate,
    RecallRequest,
    RecordBatchCreate,
    RecordInput,
    SessionCreate,
    WorkspaceCreate,
)
from neuromem_core.services import (
    RecordConflictError,
    ScopeNotFoundError,
    create_project,
    create_session,
    create_workspace,
    ingest_records,
)
from neuromem_core.worker import ClaimedJob, process_job, run_worker

pytestmark = pytest.mark.postgres


@pytest.fixture(scope="module", autouse=True)
def postgres_database() -> None:
    database_url = os.getenv("NEUROMEM_TEST_DATABASE_URL")
    if not database_url:
        pytest.skip("NEUROMEM_TEST_DATABASE_URL is not configured")
    os.environ["NEUROMEM_DATABASE_URL"] = database_url
    os.environ["NEUROMEM_DB_POOL_ENABLED"] = "false"
    get_settings.cache_clear()
    asyncio.run(dispose_engine())
    upgrade_schema("head")
    yield
    asyncio.run(dispose_engine())


class FakeProviders:
    async def extract_claims(self, **_: object) -> ExtractionResult:
        return ExtractionResult(
            claims=[ExtractedClaim(content="The release target is Friday")]
        )

    async def embed_texts(self, *_: object, **__: object) -> list[list[float]]:
        raise AssertionError("embedding should not run in this test")


class SequenceProviders:
    def __init__(self, results: list[ExtractionResult]) -> None:
        self.results = results
        self.calls = 0

    async def extract_claims(self, **_: object) -> ExtractionResult:
        result = self.results[min(self.calls, len(self.results) - 1)]
        self.calls += 1
        return result


class CountingProviders:
    def __init__(self) -> None:
        self.calls = 0

    async def extract_claims(self, **_: object) -> ExtractionResult:
        self.calls += 1
        return ExtractionResult(claims=[])


class FailingEmbeddingProviders:
    async def embed_texts(self, *_: object, **__: object) -> list[list[float]]:
        raise RuntimeError("provider offline")


async def _scope() -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    async with get_session_factory()() as db:
        workspace = await create_workspace(
            db, WorkspaceCreate(name=f"ws-{uuid.uuid4()}")
        )
        project = await create_project(db, workspace.id, ProjectCreate(name="Project"))
        session = await create_session(
            db,
            workspace.id,
            project.id,
            SessionCreate(external_key=str(uuid.uuid4()), name="Session"),
        )
        await db.commit()
        return workspace.id, project.id, session.id


@pytest.mark.asyncio
async def test_schema_has_halfvec_indexes_and_constraints() -> None:
    report = await verify_schema("head")
    assert report.ok, report.issues


@pytest.mark.asyncio
async def test_ingest_is_idempotent_and_content_conflict_is_atomic() -> None:
    workspace_id, project_id, session_id = await _scope()
    record_id = uuid7()
    body = RecordBatchCreate(
        records=[RecordInput(id=record_id, author_key="user", content="first")]
    )
    async with get_session_factory()() as db:
        first = await ingest_records(
            db,
            workspace_id=workspace_id,
            project_id=project_id,
            session_id=session_id,
            body=body,
        )
        await db.commit()
    assert first.records[0].created is True
    assert first.jobs_created == 2

    async with get_session_factory()() as db:
        second = await ingest_records(
            db,
            workspace_id=workspace_id,
            project_id=project_id,
            session_id=session_id,
            body=body,
        )
        await db.commit()
    assert second.records[0].created is False
    assert second.jobs_created == 0

    async with get_session_factory()() as db:
        with pytest.raises(RecordConflictError):
            await ingest_records(
                db,
                workspace_id=workspace_id,
                project_id=project_id,
                session_id=session_id,
                body=RecordBatchCreate(
                    records=[
                        RecordInput(
                            id=record_id, author_key="user", content="different"
                        )
                    ]
                ),
            )
        await db.rollback()


@pytest.mark.asyncio
async def test_concurrent_normalized_claim_upsert_keeps_both_sources() -> None:
    workspace_id, project_id, session_id = await _scope()
    record_ids = [uuid7(), uuid7()]
    async with get_session_factory()() as db:
        await ingest_records(
            db,
            workspace_id=workspace_id,
            project_id=project_id,
            session_id=session_id,
            body=RecordBatchCreate(
                records=[
                    RecordInput(id=record_ids[0], author_key="user", content="Friday"),
                    RecordInput(
                        id=record_ids[1], author_key="user", content="Friday again"
                    ),
                ]
            ),
        )
        await db.commit()
        jobs = list(
            (
                await db.scalars(
                    select(Job)
                    .where(
                        Job.workspace_id == workspace_id,
                        Job.project_id == project_id,
                        Job.kind == "extract_claims",
                    )
                    .order_by(Job.created_at.desc())
                    .limit(2)
                )
            ).all()
        )

    claimed = [
        ClaimedJob(
            id=job.id,
            workspace_id=job.workspace_id,
            project_id=job.project_id,
            session_id=job.session_id,
            kind=job.kind,
            payload=job.payload,
            attempts=1,
            max_attempts=12,
            lease_owner="test",
        )
        for job in jobs
    ]
    await asyncio.gather(*(process_job(job, FakeProviders()) for job in claimed))
    async with get_session_factory()() as db:
        claim_count = int(
            await db.scalar(
                select(func.count(Claim.id)).where(
                    Claim.workspace_id == workspace_id,
                    Claim.project_id == project_id,
                    Claim.normalized_content == "the release target is friday",
                )
            )
            or 0
        )
        source_count = int(
            await db.scalar(
                select(func.count(ClaimSource.id))
                .join(Claim, Claim.id == ClaimSource.claim_id)
                .where(
                    Claim.workspace_id == workspace_id,
                    Claim.project_id == project_id,
                    Claim.normalized_content == "the release target is friday",
                )
            )
            or 0
        )
        assert claim_count == 1
        assert source_count == 2


@pytest.mark.asyncio
async def test_model_configuration_absence_leaves_jobs_retryable() -> None:
    await run_worker(once=True)
    async with get_session_factory()() as db:
        pending = int(
            await db.scalar(
                select(func.count(Job.id)).where(Job.status.in_(["pending", "retry"]))
            )
            or 0
        )
        assert pending > 0
        attempts = list(
            (
                await db.scalars(
                    select(Job.attempts).where(Job.status == "retry").limit(10)
                )
            ).all()
        )
        assert attempts and all(value == 0 for value in attempts)
        assert await db.scalar(text("SELECT 1")) == 1


@pytest.mark.asyncio
async def test_flat_ingest_http_contract_and_bearer() -> None:
    token = get_settings().api_token.get_secret_value()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        ready_response = await client.get("/ready")
        assert ready_response.status_code == 200
        assert ready_response.json()["status"] == "degraded"
        assert ready_response.json()["embedding_provider_status"] == "unconfigured"
        unauthorized = await client.get("/v1/workspaces")
        assert unauthorized.status_code == 401
        headers = {"Authorization": f"Bearer {token}"}
        workspace_response = await client.post(
            "/v1/workspaces", json={"name": f"HTTP {uuid.uuid4()}"}, headers=headers
        )
        assert workspace_response.status_code == 200
        workspace_id = workspace_response.json()["id"]
        project_response = await client.post(
            f"/v1/workspaces/{workspace_id}/projects",
            json={"name": "HTTP Project"},
            headers=headers,
        )
        assert project_response.status_code == 200
        project_id = project_response.json()["id"]
        session_response = await client.post(
            f"/v1/workspaces/{workspace_id}/projects/{project_id}/sessions",
            json={"external_key": str(uuid.uuid4()), "name": "HTTP Session"},
            headers=headers,
        )
        assert session_response.status_code == 200
        session_id = session_response.json()["id"]
        ingest_response = await client.post(
            "/v1/records:batch",
            json={
                "workspace_id": workspace_id,
                "project_id": project_id,
                "session_id": session_id,
                "records": [
                    {
                        "id": str(uuid7()),
                        "author_key": "http-user",
                        "content": "HTTP ingestion works",
                    }
                ],
            },
            headers=headers,
        )
        assert ingest_response.status_code == 201
        assert ingest_response.json()["jobs_created"] == 2


@pytest.mark.asyncio
async def test_one_hundred_concurrent_retries_create_one_record_bundle() -> None:
    workspace_id, project_id, session_id = await _scope()
    record_id = uuid7()
    body = RecordBatchCreate(
        records=[RecordInput(id=record_id, author_key="retry-user", content="one")]
    )
    semaphore = asyncio.Semaphore(20)

    async def ingest_once() -> None:
        async with semaphore:
            async with get_session_factory()() as db:
                await ingest_records(
                    db,
                    workspace_id=workspace_id,
                    project_id=project_id,
                    session_id=session_id,
                    body=body,
                )
                await db.commit()

    await asyncio.gather(*(ingest_once() for _ in range(100)))
    async with get_session_factory()() as db:
        record_count = int(
            await db.scalar(select(func.count(Record.id)).where(Record.id == record_id))
            or 0
        )
        segment_count = int(
            await db.scalar(
                select(func.count(RecordSegment.id)).where(
                    RecordSegment.record_id == record_id
                )
            )
            or 0
        )
        jobs = dict(
            (
                await db.execute(
                    select(Job.kind, func.count(Job.id))
                    .where(Job.payload["record_id"].astext == str(record_id))
                    .group_by(Job.kind)
                )
            ).all()
        )
        assert record_count == 1
        assert segment_count == 1
        assert jobs["embed_record"] == 1
        assert jobs["extract_claims"] == 1


@pytest.mark.asyncio
async def test_extraction_replay_with_changed_output_is_idempotent() -> None:
    workspace_id, project_id, session_id = await _scope()
    record_id = uuid7()
    async with get_session_factory()() as db:
        await ingest_records(
            db,
            workspace_id=workspace_id,
            project_id=project_id,
            session_id=session_id,
            body=RecordBatchCreate(
                records=[
                    RecordInput(
                        id=record_id,
                        author_key="replay-user",
                        content="Alpha and beta were approved",
                    )
                ]
            ),
        )
        await db.commit()
        job = await db.scalar(
            select(Job).where(
                Job.workspace_id == workspace_id,
                Job.project_id == project_id,
                Job.kind == "extract_claims",
                Job.payload["record_id"].astext == str(record_id),
            )
        )
        assert job is not None
    claimed = ClaimedJob(
        id=job.id,
        workspace_id=job.workspace_id,
        project_id=job.project_id,
        session_id=job.session_id,
        kind=job.kind,
        payload=job.payload,
        attempts=1,
        max_attempts=12,
        lease_owner="replay",
    )
    providers = SequenceProviders(
        [
            ExtractionResult(
                claims=[
                    ExtractedClaim(content="Alpha was approved"),
                    ExtractedClaim(content="Beta was approved"),
                ]
            ),
            ExtractionResult(
                claims=[
                    ExtractedClaim(content="Beta approval was confirmed"),
                    ExtractedClaim(content="Alpha was approved"),
                ]
            ),
        ]
    )
    await process_job(claimed, providers)
    await process_job(claimed, providers)
    async with get_session_factory()() as db:
        claims = list(
            (
                await db.scalars(
                    select(Claim).where(
                        Claim.workspace_id == workspace_id,
                        Claim.project_id == project_id,
                    )
                )
            ).all()
        )
        sources = list(
            (
                await db.scalars(
                    select(ClaimSource).where(
                        ClaimSource.workspace_id == workspace_id,
                        ClaimSource.project_id == project_id,
                    )
                )
            ).all()
        )
        assert len(claims) == 2
        assert len(sources) == 2
        assert {source.claim_id for source in sources} == {claim.id for claim in claims}


@pytest.mark.asyncio
async def test_cross_project_direct_ids_are_not_visible() -> None:
    workspace_id, project_id, session_id = await _scope()
    record_id = uuid7()
    async with get_session_factory()() as db:
        second_project = await create_project(
            db, workspace_id, ProjectCreate(name=f"Other {uuid.uuid4()}")
        )
        await ingest_records(
            db,
            workspace_id=workspace_id,
            project_id=project_id,
            session_id=session_id,
            body=RecordBatchCreate(
                records=[
                    RecordInput(id=record_id, author_key="scope-user", content="Scoped")
                ]
            ),
        )
        await db.commit()
        extract_job = await db.scalar(
            select(Job).where(
                Job.project_id == project_id,
                Job.kind == "extract_claims",
                Job.payload["record_id"].astext == str(record_id),
            )
        )
        assert extract_job is not None
    await process_job(
        ClaimedJob(
            id=extract_job.id,
            workspace_id=workspace_id,
            project_id=project_id,
            session_id=session_id,
            kind="extract_claims",
            payload=extract_job.payload,
            attempts=1,
            max_attempts=12,
            lease_owner="scope",
        ),
        FakeProviders(),
    )
    async with get_session_factory()() as db:
        claim_id = await db.scalar(
            select(Claim.id).where(Claim.project_id == project_id).limit(1)
        )
        assert claim_id is not None
        with pytest.raises(ScopeNotFoundError):
            await record_context(
                db,
                workspace_id=workspace_id,
                project_id=second_project.id,
                record_id=record_id,
                before=2,
                after=2,
            )
        with pytest.raises(ScopeNotFoundError):
            await claim_evidence(
                db,
                workspace_id=workspace_id,
                project_id=second_project.id,
                claim_id=claim_id,
            )

    transport = ASGITransport(app=app)
    headers = {"Authorization": f"Bearer {get_settings().api_token.get_secret_value()}"}
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get(
            f"/v1/jobs/{extract_job.id}",
            params={
                "workspace_id": str(workspace_id),
                "project_id": str(second_project.id),
            },
            headers=headers,
        )
        assert response.status_code == 404


@pytest.mark.asyncio
async def test_automation_and_lexical_provider_fallback() -> None:
    workspace_id, project_id, session_id = await _scope()
    records = [
        RecordInput(id=uuid7(), author_key="human", content="context one"),
        RecordInput(id=uuid7(), author_key="human", content="needle two"),
        RecordInput(id=uuid7(), author_key="human", content="context three"),
        RecordInput(id=uuid7(), author_key="human", content="needle four"),
        RecordInput(id=uuid7(), author_key="human", content="context five"),
        RecordInput(
            id=uuid7(),
            author_key="automation",
            author_kind="automation",
            content="automated output",
        ),
    ]
    async with get_session_factory()() as db:
        await ingest_records(
            db,
            workspace_id=workspace_id,
            project_id=project_id,
            session_id=session_id,
            body=RecordBatchCreate(records=records),
        )
        await db.commit()
        automation_job = await db.scalar(
            select(Job).where(
                Job.kind == "extract_claims",
                Job.payload["record_id"].astext == str(records[-1].id),
            )
        )
        assert automation_job is not None

    counting = CountingProviders()
    await process_job(
        ClaimedJob(
            id=automation_job.id,
            workspace_id=workspace_id,
            project_id=project_id,
            session_id=session_id,
            kind="extract_claims",
            payload=automation_job.payload,
            attempts=1,
            max_attempts=12,
            lease_owner="automation",
        ),
        counting,
    )
    assert counting.calls == 0

    settings = get_settings().model_copy(
        update={
            "embedding_base_url": "http://offline.invalid/v1",
            "embedding_model": "offline",
        }
    )
    async with get_session_factory()() as db:
        result = await recall(
            db,
            RecallRequest(
                workspace_id=workspace_id,
                project_id=project_id,
                query="needle",
                include={"records"},
                limit=10,
            ),
            settings=settings,
            providers=FailingEmbeddingProviders(),
        )
    assert result.embedding_used is False
    assert len(result.records) == 2
    assert len(result.record_snippets) == 1
    assert len(result.record_snippets[0].records) == 6


@pytest.mark.asyncio
async def test_failed_jobs_can_be_requeued_after_model_configuration_is_fixed() -> None:
    workspace_id, project_id, session_id = await _scope()
    async with get_session_factory()() as db:
        await ingest_records(
            db,
            workspace_id=workspace_id,
            project_id=project_id,
            session_id=session_id,
            body=RecordBatchCreate(
                records=[RecordInput(author_key="user", content="retry this record")]
            ),
        )
        job = await db.scalar(
            select(Job)
            .where(
                Job.workspace_id == workspace_id,
                Job.project_id == project_id,
                Job.kind == "extract_claims",
            )
            .order_by(Job.created_at.desc())
            .limit(1)
        )
        assert job is not None
        job.status = "failed"
        job.attempts = job.max_attempts
        job.last_error = "invalid model"
        job_id = job.id
        await db.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.post(
            "/v1/jobs:retry-failed",
            headers={
                "Authorization": f"Bearer {get_settings().api_token.get_secret_value()}"
            },
            json={
                "workspace_id": str(workspace_id),
                "project_id": str(project_id),
                "kinds": ["extract_claims"],
            },
        )
    assert response.status_code == 200
    assert response.json() == {"retried": 1}
    async with get_session_factory()() as db:
        refreshed = await db.get(Job, job_id)
        assert refreshed is not None
        assert refreshed.status == "retry"
        assert refreshed.attempts == 0
        assert refreshed.last_error is None
