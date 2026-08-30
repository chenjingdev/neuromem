from __future__ import annotations

import uuid
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import APIRouter, Depends, FastAPI, HTTPException, Query, Response, status
from fastapi.responses import PlainTextResponse
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from . import __version__
from .config import Settings, get_settings
from .db import db_session, dispose_engine, get_engine
from .models import Job, Project
from .providers import ModelProviders, provider_health
from .queries import (
    claim_evidence,
    graph_view,
    list_claims,
    project_overview,
    recall,
    record_context,
    system_backlog,
    wiki_view,
)
from .schema import verify_schema
from .schemas import (
    ClaimEvidenceResponse,
    ClaimPage,
    FailedJobRetryRequest,
    FailedJobRetryResponse,
    GraphResponse,
    HealthResponse,
    JobView,
    PeerCreate,
    PeerView,
    ProjectCreate,
    ProjectList,
    ProjectOverview,
    ProjectView,
    RecallRequest,
    RecallResponse,
    RecordBatchCreate,
    RecordBatchEnvelope,
    RecordBatchReceipt,
    RecordContextResponse,
    SessionCreate,
    SessionView,
    SystemBacklog,
    WikiResponse,
    WorkspaceCreate,
    WorkspaceList,
    WorkspaceView,
)
from .security import require_bearer
from .services import (
    RecordConflictError,
    ScopeNotFoundError,
    create_peer,
    create_project,
    create_session,
    create_workspace,
    ingest_records,
    list_projects,
    list_workspaces,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    await dispose_engine()


app = FastAPI(
    title="Neuromem Core API",
    version=__version__,
    summary="Project-scoped evidence, claims, retrieval, wiki, and graph data plane",
    lifespan=lifespan,
)
v1 = APIRouter(prefix="/v1", dependencies=[Depends(require_bearer)])
Database = Annotated[AsyncSession, Depends(db_session)]
AppSettings = Annotated[Settings, Depends(get_settings)]


def _not_found(error: ScopeNotFoundError) -> HTTPException:
    return HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(error))


def runtime_status(
    *,
    database: bool,
    embedding_configured: bool,
    extraction_configured: bool,
    job_counts: dict[str, int],
) -> str:
    backlog = sum(
        job_counts.get(state, 0) for state in ("pending", "running", "retry", "failed")
    )
    return (
        "ok"
        if database and embedding_configured and extraction_configured and backlog == 0
        else "degraded"
    )


async def _database_and_jobs() -> tuple[bool, dict[str, int]]:
    try:
        async with get_engine().connect() as connection:
            database = bool(await connection.scalar(text("SELECT 1")))
            has_jobs = await connection.scalar(
                text("SELECT to_regclass(current_schema() || '.jobs')")
            )
            if not has_jobs:
                return database, {}
            rows = (
                await connection.execute(
                    text("SELECT status, count(*) FROM jobs GROUP BY status")
                )
            ).all()
            return database, {job_status: count for job_status, count in rows}
    except Exception:
        return False, {}


@app.get("/health", response_model=HealthResponse, tags=["system"])
async def health(settings: AppSettings) -> HealthResponse:
    database, job_counts = await _database_and_jobs()
    embedding_probe, extraction_probe = provider_health(settings)
    return HealthResponse(
        status=runtime_status(
            database=database,
            embedding_configured=settings.embedding_configured,
            extraction_configured=settings.extraction_configured,
            job_counts=job_counts,
        ),
        database=database,
        embedding_configured=settings.embedding_configured,
        extraction_configured=settings.extraction_configured,
        embedding_provider_status=embedding_probe.status,
        embedding_provider_detail=embedding_probe.detail,
        embedding_last_probe_at=embedding_probe.last_probe_at,
        extraction_provider_status=extraction_probe.status,
        extraction_provider_detail=extraction_probe.detail,
        extraction_last_probe_at=extraction_probe.last_probe_at,
        job_counts=job_counts,
        version=__version__,
    )


@app.get("/ready", response_model=HealthResponse, tags=["system"])
async def ready(response: Response, settings: AppSettings) -> HealthResponse:
    try:
        report = await verify_schema("head")
        database = report.ok
    except Exception:
        database = False
    if not database:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        job_counts: dict[str, int] = {}
    else:
        _database, job_counts = await _database_and_jobs()
    embedding_probe, extraction_probe = provider_health(settings)
    return HealthResponse(
        status=runtime_status(
            database=database,
            embedding_configured=settings.embedding_configured,
            extraction_configured=settings.extraction_configured,
            job_counts=job_counts,
        ),
        database=database,
        embedding_configured=settings.embedding_configured,
        extraction_configured=settings.extraction_configured,
        embedding_provider_status=embedding_probe.status,
        embedding_provider_detail=embedding_probe.detail,
        embedding_last_probe_at=embedding_probe.last_probe_at,
        extraction_provider_status=extraction_probe.status,
        extraction_provider_detail=extraction_probe.detail,
        extraction_last_probe_at=extraction_probe.last_probe_at,
        job_counts=job_counts,
        version=__version__,
    )


@v1.get("/workspaces", response_model=WorkspaceList, tags=["scope"])
async def get_workspaces(db: Database) -> WorkspaceList:
    return WorkspaceList(
        items=[WorkspaceView.model_validate(item) for item in await list_workspaces(db)]
    )


@v1.post("/workspaces", response_model=WorkspaceView, tags=["scope"])
async def post_workspace(body: WorkspaceCreate, db: Database) -> WorkspaceView:
    workspace = await create_workspace(db, body)
    await db.commit()
    return WorkspaceView.model_validate(workspace)


@v1.get(
    "/workspaces/{workspace_id}/projects",
    response_model=ProjectList,
    tags=["scope"],
)
async def get_projects(workspace_id: uuid.UUID, db: Database) -> ProjectList:
    try:
        projects = await list_projects(db, workspace_id)
    except ScopeNotFoundError as error:
        raise _not_found(error) from error
    return ProjectList(items=[ProjectView.model_validate(item) for item in projects])


@v1.post(
    "/workspaces/{workspace_id}/projects",
    response_model=ProjectView,
    tags=["scope"],
)
async def post_project(
    workspace_id: uuid.UUID,
    body: ProjectCreate,
    db: Database,
) -> ProjectView:
    try:
        project = await create_project(db, workspace_id, body)
        await db.commit()
    except ScopeNotFoundError as error:
        raise _not_found(error) from error
    return ProjectView.model_validate(project)


@v1.post(
    "/workspaces/{workspace_id}/peers",
    response_model=PeerView,
    tags=["scope"],
)
async def post_peer(
    workspace_id: uuid.UUID,
    body: PeerCreate,
    db: Database,
) -> PeerView:
    try:
        peer = await create_peer(db, workspace_id, body)
        await db.commit()
    except ScopeNotFoundError as error:
        raise _not_found(error) from error
    return PeerView.model_validate(peer)


@v1.post(
    "/workspaces/{workspace_id}/projects/{project_id}/sessions",
    response_model=SessionView,
    tags=["scope"],
)
async def post_session(
    workspace_id: uuid.UUID,
    project_id: uuid.UUID,
    body: SessionCreate,
    db: Database,
) -> SessionView:
    try:
        session = await create_session(db, workspace_id, project_id, body)
        await db.commit()
    except ScopeNotFoundError as error:
        raise _not_found(error) from error
    return SessionView.model_validate(session)


@v1.post(
    "/workspaces/{workspace_id}/projects/{project_id}/sessions/{session_id}/records:batch",
    response_model=RecordBatchReceipt,
    status_code=status.HTTP_201_CREATED,
    tags=["ingest"],
)
async def post_records_batch(
    workspace_id: uuid.UUID,
    project_id: uuid.UUID,
    session_id: uuid.UUID,
    body: RecordBatchCreate,
    db: Database,
    settings: AppSettings,
) -> RecordBatchReceipt:
    try:
        receipt = await ingest_records(
            db,
            workspace_id=workspace_id,
            project_id=project_id,
            session_id=session_id,
            body=body,
            settings=settings,
        )
        await db.commit()
        return receipt
    except ScopeNotFoundError as error:
        raise _not_found(error) from error
    except RecordConflictError as error:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": str(error),
                "record_ids": [str(record_id) for record_id in error.record_ids],
            },
        ) from error


@v1.post(
    "/records:batch",
    response_model=RecordBatchReceipt,
    status_code=status.HTTP_201_CREATED,
    tags=["ingest"],
    summary="Atomically ingest records and enqueue embedding and extraction work",
)
async def post_records_batch_flat(
    body: RecordBatchEnvelope,
    db: Database,
    settings: AppSettings,
) -> RecordBatchReceipt:
    try:
        receipt = await ingest_records(
            db,
            workspace_id=body.workspace_id,
            project_id=body.project_id,
            session_id=body.session_id,
            body=RecordBatchCreate(records=body.records),
            settings=settings,
        )
        await db.commit()
        return receipt
    except ScopeNotFoundError as error:
        raise _not_found(error) from error
    except RecordConflictError as error:
        await db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": str(error),
                "record_ids": [str(record_id) for record_id in error.record_ids],
            },
        ) from error


@v1.post("/recall", response_model=RecallResponse, tags=["recall"])
async def post_recall(
    body: RecallRequest,
    db: Database,
    settings: AppSettings,
) -> RecallResponse:
    return await recall(db, body, settings=settings, providers=ModelProviders(settings))


@v1.get(
    "/records/{record_id}/context",
    response_model=RecordContextResponse,
    tags=["recall"],
)
async def get_record_context(
    record_id: uuid.UUID,
    workspace_id: uuid.UUID,
    project_id: uuid.UUID,
    db: Database,
    before: int = Query(default=2, ge=0, le=20),
    after: int = Query(default=2, ge=0, le=20),
) -> RecordContextResponse:
    try:
        return await record_context(
            db,
            workspace_id=workspace_id,
            project_id=project_id,
            record_id=record_id,
            before=before,
            after=after,
        )
    except ScopeNotFoundError as error:
        raise _not_found(error) from error


@v1.get(
    "/claims/{claim_id}/evidence",
    response_model=ClaimEvidenceResponse,
    tags=["recall"],
)
async def get_claim_evidence(
    claim_id: uuid.UUID,
    workspace_id: uuid.UUID,
    project_id: uuid.UUID,
    db: Database,
) -> ClaimEvidenceResponse:
    try:
        return await claim_evidence(
            db,
            workspace_id=workspace_id,
            project_id=project_id,
            claim_id=claim_id,
        )
    except ScopeNotFoundError as error:
        raise _not_found(error) from error


@v1.get(
    "/projects/{project_id}/overview",
    response_model=ProjectOverview,
    tags=["project views"],
)
async def get_project_overview(
    project_id: uuid.UUID,
    workspace_id: uuid.UUID,
    db: Database,
    settings: AppSettings,
) -> ProjectOverview:
    try:
        return await project_overview(
            db,
            workspace_id=workspace_id,
            project_id=project_id,
            settings=settings,
        )
    except ScopeNotFoundError as error:
        raise _not_found(error) from error


@v1.get(
    "/projects/{project_id}/claims",
    response_model=ClaimPage,
    tags=["project views"],
)
async def get_project_claims(
    project_id: uuid.UUID,
    workspace_id: uuid.UUID,
    db: Database,
    limit: int = Query(default=50, ge=1, le=100),
    cursor: str | None = None,
) -> ClaimPage:
    try:
        return await list_claims(
            db,
            workspace_id=workspace_id,
            project_id=project_id,
            limit=limit,
            cursor=cursor,
        )
    except ValueError as error:
        raise HTTPException(status_code=400, detail=str(error)) from error


@v1.get(
    "/projects/{project_id}/wiki",
    response_model=WikiResponse,
    responses={200: {"content": {"text/markdown": {}}}},
    tags=["project views"],
)
async def get_project_wiki(
    project_id: uuid.UUID,
    workspace_id: uuid.UUID,
    db: Database,
    format: str = Query(default="json", pattern="^(json|markdown)$"),
) -> WikiResponse | PlainTextResponse:
    wiki = await wiki_view(db, workspace_id=workspace_id, project_id=project_id)
    if format == "markdown":
        lines = [f"# Project memory ({project_id})", ""]
        for section in wiki.sections:
            lines.extend([f"## {section.title}", ""])
            for item in section.claims:
                citations = ", ".join(str(record_id) for record_id in item.evidence_ids)
                lines.append(f"- {item.content} [evidence: {citations}]")
            lines.append("")
        return PlainTextResponse("\n".join(lines), media_type="text/markdown")
    return wiki


@v1.get(
    "/projects/{project_id}/graph",
    response_model=GraphResponse,
    tags=["project views"],
)
async def get_project_graph(
    project_id: uuid.UUID,
    workspace_id: uuid.UUID,
    db: Database,
) -> GraphResponse:
    return await graph_view(db, workspace_id=workspace_id, project_id=project_id)


@v1.get("/jobs/{job_id}", response_model=JobView, tags=["jobs"])
async def get_job(
    job_id: uuid.UUID,
    workspace_id: uuid.UUID,
    project_id: uuid.UUID,
    db: Database,
) -> JobView:
    job = await db.scalar(
        select(Job).where(
            Job.id == job_id,
            Job.workspace_id == workspace_id,
            Job.project_id == project_id,
        )
    )
    if job is None:
        raise HTTPException(status_code=404, detail="job not found")
    return JobView.model_validate(job)


@v1.post("/jobs:retry-failed", response_model=FailedJobRetryResponse, tags=["jobs"])
async def retry_failed_jobs(
    body: FailedJobRetryRequest,
    db: Database,
) -> FailedJobRetryResponse:
    project = await db.scalar(
        select(Project.id).where(
            Project.id == body.project_id,
            Project.workspace_id == body.workspace_id,
        )
    )
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    query = (
        select(Job.id)
        .where(
            Job.workspace_id == body.workspace_id,
            Job.project_id == body.project_id,
            Job.status == "failed",
        )
        .order_by(Job.updated_at, Job.id)
        .limit(body.limit)
    )
    if body.kinds:
        query = query.where(Job.kind.in_(body.kinds))
    job_ids = list((await db.scalars(query)).all())
    retried = 0
    if job_ids:
        result = await db.execute(
            update(Job)
            .where(Job.id.in_(job_ids), Job.status == "failed")
            .values(
                status="retry",
                attempts=0,
                run_after=func.now(),
                lease_owner=None,
                lease_expires_at=None,
                last_error=None,
                completed_at=None,
            )
        )
        await db.commit()
        retried = result.rowcount or 0
    return FailedJobRetryResponse(retried=retried)


@v1.get("/system/backlog", response_model=SystemBacklog, tags=["system"])
async def get_system_backlog(
    db: Database,
) -> SystemBacklog:
    return await system_backlog(db)


app.include_router(v1)
