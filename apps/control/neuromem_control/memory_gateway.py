from __future__ import annotations

import math
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from .core_client import MemoryCoreClient, MemoryCoreError, get_memory_core_client
from .db import db_session
from .models import (
    FederatedGrantAssignment,
    FederatedProjectGrant,
    Project,
    WikiCitation,
    WikiPage,
    WikiRevision,
    WorkspaceLink,
    WorkspaceMembership,
)
from .schemas import (
    AuthContext,
    ConclusionQuery,
    DynamicContextRequest,
    DynamicContextResponse,
    DynamicContextSection,
    MemoryChatRequest,
    MemoryDreamRequest,
    MemoryProjectEnsure,
    MemoryRecordBatch,
    MemorySearchRequest,
    MemorySessionCreate,
)
from .security import CurrentAuth, require_capability
from .services import audit_auth

router = APIRouter(prefix="/api/v1")
Database = Annotated[Session, Depends(db_session)]
Core = Annotated[MemoryCoreClient, Depends(get_memory_core_client)]


def _scope(
    db: Session,
    auth: CurrentAuth,
    *,
    workspace_id: str,
    project_id: str,
    capability: str,
) -> Project:
    if (
        auth.context.workspace_id != workspace_id
        or auth.context.project_id != project_id
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="authenticated Workspace/Project scope does not match request",
        )
    require_capability(auth, capability)
    project = db.scalar(
        select(Project).where(
            Project.id == project_id,
            Project.workspace_id == workspace_id,
            Project.status == "active",
        )
    )
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


def _core_project_id(project: Project) -> str:
    """Translate the product's stable Project UUID to Core's General sentinel."""

    return "general" if project.is_general else project.id


def _core_context(context: AuthContext, project: Project) -> AuthContext:
    return context.model_copy(update={"project_id": _core_project_id(project)})


def _observer(auth: CurrentAuth, requested: str | None = None) -> str:
    allowed = {
        peer_id
        for peer_id in (auth.context.agent_peer_id, auth.context.human_peer_id)
        if peer_id
    }
    selected = requested or auth.context.agent_peer_id or auth.context.human_peer_id
    if selected is None:
        raise HTTPException(status_code=409, detail="no active observer Peer is bound")
    if selected not in allowed:
        raise HTTPException(
            status_code=403,
            detail="observer Peer must be bound to the authenticated credential",
        )
    return selected


def _provisioning_context(auth: CurrentAuth, *, project: Project) -> AuthContext:
    """Narrowly elevate only the trusted Control-to-Core provisioning call."""

    return auth.context.model_copy(
        update={
            "workspace_id": project.workspace_id,
            "project_id": _core_project_id(project),
            "capabilities": sorted(
                set(auth.context.capabilities)
                | {
                    "workspace.create",
                    "project.create",
                    "project.read",
                    "project.write",
                    "agent.manage",
                }
            ),
        }
    )


def _ensure_core_scope(
    core: MemoryCoreClient,
    auth: CurrentAuth,
    project: Project,
) -> Any:
    """Idempotently provision Workspace, bound Peers, and Project in Core."""

    workspace_id = project.workspace_id
    context = _provisioning_context(auth, project=project)
    core.request(
        method="POST",
        path="/v3/workspaces",
        context=context,
        payload={"id": workspace_id},
        idempotency_key=f"workspace:{workspace_id}",
    )
    for peer_id, kind in (
        (auth.context.human_peer_id, "human"),
        (auth.context.agent_peer_id, "agent"),
    ):
        if not peer_id:
            continue
        core.request(
            method="POST",
            path=f"/v3/workspaces/{workspace_id}/peers",
            context=context,
            payload={
                "id": peer_id,
                "metadata": {"neuromem_peer_kind": kind},
            },
            idempotency_key=f"peer:{workspace_id}:{peer_id}",
        )
    return core.request(
        method="POST",
        path=f"/v3/workspaces/{workspace_id}/projects",
        context=context,
        payload={
            "id": _core_project_id(project),
            "name": project.name,
            "restricted": project.access_policy == "restricted",
            "metadata": {"wiki_id": project.wiki_id},
            "configuration": {},
        },
        idempotency_key=f"project:{workspace_id}:{_core_project_id(project)}",
    )


def _as_items(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("items", "results", "messages", "conclusions"):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    return []


def _normalize_record(
    item: dict[str, Any], *, project_id: str, rank: int
) -> dict[str, Any]:
    metadata = item.get("metadata") if isinstance(item.get("metadata"), dict) else {}
    record_id = metadata.get("neuromem_record_id") or item.get("id")
    content = str(item.get("content") or item.get("matched_content") or "")
    item_project_id = item.get("project_id")
    normalized_project_id = (
        project_id if item_project_id in (None, "general") else str(item_project_id)
    )
    return {
        **item,
        "record_id": str(record_id),
        "project_id": normalized_project_id,
        "content": content,
        "matched_content": str(item.get("matched_content") or content),
        "rank": int(item.get("rank") or rank),
    }


def _normalize_claim(
    item: dict[str, Any], *, project_id: str, rank: int
) -> dict[str, Any]:
    claim_id = item.get("claim_id") or item.get("id")
    evidence_ids = item.get("evidence_ids")
    if not isinstance(evidence_ids, list):
        evidence_ids = []
    item_project_id = item.get("project_id")
    normalized_project_id = (
        project_id if item_project_id in (None, "general") else str(item_project_id)
    )
    return {
        **item,
        "claim_id": str(claim_id),
        "project_id": normalized_project_id,
        "content": str(item.get("content") or item.get("text") or ""),
        "status": str(item.get("status") or "active"),
        "derivation_method": str(item.get("derivation_method") or "explicit"),
        "evidence_ids": evidence_ids,
        "rank": int(item.get("rank") or rank),
    }


def _search_local(
    core: MemoryCoreClient,
    context: AuthContext,
    body: MemorySearchRequest,
    project: Project,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    records: list[dict[str, Any]] = []
    claims: list[dict[str, Any]] = []
    core_project_id = _core_project_id(project)
    core_context = _core_context(context, project)
    filters: dict[str, Any] = {"project_id": core_project_id}
    if body.after:
        filters["created_at"] = {"$gte": body.after.isoformat()}
    if body.before:
        filters.setdefault("created_at", {})["$lte"] = body.before.isoformat()
    if "records" in body.include:
        path = f"/v3/workspaces/{body.workspace_id}/search"
        if body.session_id:
            path = (
                f"/v3/workspaces/{body.workspace_id}/sessions/{body.session_id}/search"
            )
        payload = core.request(
            method="POST",
            path=path,
            context=core_context,
            payload={
                "query": body.query,
                "limit": body.limit,
                "filters": filters,
                "project_id": core_project_id,
                "include_general": body.include_general,
            },
        )
        records = [
            _normalize_record(item, project_id=body.project_id, rank=index)
            for index, item in enumerate(_as_items(payload), start=1)
        ]
    if "claims" in body.include:
        observer = core_context.agent_peer_id or core_context.human_peer_id
        observed = core_context.human_peer_id or observer
        if not observer or not observed:
            raise HTTPException(
                status_code=409,
                detail="Conclusion search requires bound observer and observed Peers",
            )
        payload = core.request(
            method="POST",
            path=f"/v3/workspaces/{body.workspace_id}/conclusions/query",
            context=core_context,
            payload={
                "query": body.query,
                "top_k": body.limit,
                "filters": {
                    **filters,
                    "observer": observer,
                    "observed": observed,
                },
                "project_id": core_project_id,
                "include_general": body.include_general,
            },
        )
        claims = [
            _normalize_claim(item, project_id=body.project_id, rank=index)
            for index, item in enumerate(_as_items(payload), start=1)
        ]
    return records[: body.limit], claims[: body.limit]


def _federated_grants(
    db: Session, auth: CurrentAuth
) -> list[tuple[FederatedProjectGrant, WorkspaceLink]]:
    workspace_id = auth.context.workspace_id
    if workspace_id is None:
        return []
    membership = db.scalar(
        select(WorkspaceMembership).where(
            WorkspaceMembership.workspace_id == workspace_id,
            WorkspaceMembership.principal_id == auth.principal.id,
            WorkspaceMembership.status == "active",
        )
    )
    if membership is None:
        return []
    rows = db.execute(
        select(FederatedProjectGrant, WorkspaceLink)
        .join(
            WorkspaceLink,
            WorkspaceLink.id == FederatedProjectGrant.workspace_link_id,
        )
        .where(
            FederatedProjectGrant.target_workspace_id == workspace_id,
            FederatedProjectGrant.status == "active",
            WorkspaceLink.status == "active",
        )
    ).all()
    visible: list[tuple[FederatedProjectGrant, WorkspaceLink]] = []
    for grant, link in rows:
        assignment = db.scalar(
            select(FederatedGrantAssignment.id).where(
                FederatedGrantAssignment.federated_grant_id == grant.id,
                FederatedGrantAssignment.status == "active",
                (FederatedGrantAssignment.principal_id == auth.principal.id)
                | (FederatedGrantAssignment.role == membership.role),
            )
        )
        if assignment and "search" in grant.capabilities:
            visible.append((grant, link))
    return visible


def _search_federated(
    db: Session,
    core: MemoryCoreClient,
    auth: CurrentAuth,
    body: MemorySearchRequest,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    records: list[dict[str, Any]] = []
    claims: list[dict[str, Any]] = []
    for grant, link in _federated_grants(db, auth):
        source_project = db.scalar(
            select(Project).where(
                Project.id == grant.source_project_id,
                Project.workspace_id == link.source_workspace_id,
                Project.status == "active",
            )
        )
        if source_project is None:
            continue
        source_context = auth.context.model_copy(
            update={
                "workspace_id": link.source_workspace_id,
                "project_id": grant.source_project_id,
                "human_peer_id": None,
                "agent_peer_id": None,
                "capabilities": ["federated.search", "project.read"],
            }
        )
        source_body = body.model_copy(
            update={
                "workspace_id": link.source_workspace_id,
                "project_id": grant.source_project_id,
                "include_general": False,
                "include_federated": False,
            }
        )
        source_records, source_claims = _search_local(
            core, source_context, source_body, source_project
        )
        provenance = {
            "federated": True,
            "federated_grant_id": grant.id,
            "source_workspace_id": link.source_workspace_id,
            "source_project_id": grant.source_project_id,
        }
        records.extend({**item, **provenance} for item in source_records)
        claims.extend({**item, **provenance} for item in source_claims)
    return records, claims


@router.post("/memory/projects/{project_id}:ensure", tags=["memory"])
def ensure_memory_project(
    project_id: str,
    body: MemoryProjectEnsure,
    db: Database,
    auth: CurrentAuth,
    core: Core,
) -> Any:
    workspace_id = auth.context.workspace_id
    if workspace_id is None:
        raise HTTPException(status_code=400, detail="workspace context required")
    project = _scope(
        db,
        auth,
        workspace_id=workspace_id,
        project_id=project_id,
        capability="project.create",
    )
    result = _ensure_core_scope(core, auth, project)
    if body.metadata or body.configuration:
        result = core.request(
            method="PUT",
            path=f"/v3/workspaces/{workspace_id}/projects/{_core_project_id(project)}",
            context=_provisioning_context(auth, project=project),
            payload={
                "metadata": {**body.metadata, "wiki_id": project.wiki_id},
                "configuration": body.configuration,
            },
        )
    return result


@router.post("/memory/sessions", tags=["memory"])
@router.post(
    "/workspaces/{workspace_id}/projects/{project_id}/sessions", tags=["memory"]
)
def create_memory_session(
    request: Request,
    body: MemorySessionCreate,
    db: Database,
    auth: CurrentAuth,
    core: Core,
) -> Any:
    workspace_id = request.path_params.get("workspace_id") or auth.context.workspace_id
    project_id = request.path_params.get("project_id") or auth.context.project_id
    if workspace_id is None or project_id is None:
        raise HTTPException(
            status_code=400, detail="Workspace/Project context required"
        )
    project = _scope(
        db,
        auth,
        workspace_id=workspace_id,
        project_id=project_id,
        capability="project.write",
    )
    _ensure_core_scope(core, auth, project)
    core_project_id = _core_project_id(project)
    return core.request(
        method="POST",
        path=f"/v3/workspaces/{workspace_id}/sessions",
        context=_core_context(auth.context, project),
        params={"project_id": core_project_id},
        payload={
            "id": body.session_id,
            "project_id": core_project_id,
            "metadata": {**body.metadata, "name": body.name},
            "configuration": body.configuration,
        },
        idempotency_key=f"session:{project_id}:{body.session_id}",
    )


@router.post("/memory/sessions/{session_id}/messages", tags=["memory"])
@router.post("/records:batch", status_code=201, tags=["memory"])
def ingest_memory_records(
    request: Request,
    body: MemoryRecordBatch,
    db: Database,
    auth: CurrentAuth,
    core: Core,
) -> Any:
    session_id = request.path_params.get("session_id")
    if session_id is not None and session_id != body.session_id:
        raise HTTPException(status_code=400, detail="session ID mismatch")
    project = _scope(
        db,
        auth,
        workspace_id=body.workspace_id,
        project_id=body.project_id,
        capability="project.write",
    )
    _ensure_core_scope(core, auth, project)
    core_project_id = _core_project_id(project)
    allowed_authors = {
        peer_id
        for peer_id in (auth.context.human_peer_id, auth.context.agent_peer_id)
        if peer_id
    }
    for record in body.records:
        if record.author_key not in allowed_authors:
            raise HTTPException(
                status_code=403,
                detail="record author Peer is not bound to this credential",
            )
    messages = [
        {
            "peer_id": record.author_key,
            "content": record.content,
            "created_at": record.occurred_at.isoformat()
            if record.occurred_at
            else None,
            "metadata": {
                **record.metadata,
                "neuromem_record_id": record.id,
                "author_name": record.author_name,
                "author_kind": record.author_kind,
                "record_kind": record.kind,
                "source_app": record.source_app,
                "project_id": core_project_id,
            },
        }
        for record in body.records
    ]
    result = core.request(
        method="POST",
        path=(
            f"/v3/workspaces/{body.workspace_id}/sessions/{body.session_id}/messages"
        ),
        context=_core_context(auth.context, project),
        params={"project_id": core_project_id},
        payload={"messages": messages, "project_id": core_project_id},
        idempotency_key=body.records[0].id if len(body.records) == 1 else None,
    )
    audit_auth(
        db,
        auth,
        "memory.records_ingested",
        "session",
        body.session_id,
        workspace_id=body.workspace_id,
        details={
            "project_id": body.project_id,
            "record_ids": [record.id for record in body.records],
        },
    )
    db.commit()
    return {
        "record_ids": [record.id for record in body.records],
        "messages": result if isinstance(result, list) else _as_items(result),
    }


@router.post("/memory/search", tags=["memory"])
@router.post("/recall", tags=["memory"])
def search_memory(
    body: MemorySearchRequest,
    db: Database,
    auth: CurrentAuth,
    core: Core,
) -> dict[str, Any]:
    project = _scope(
        db,
        auth,
        workspace_id=body.workspace_id,
        project_id=body.project_id,
        capability="project.read",
    )
    _ensure_core_scope(core, auth, project)
    records, claims = _search_local(core, auth.context, body, project)
    if body.include_federated:
        federated_records, federated_claims = _search_federated(db, core, auth, body)
        records.extend(federated_records)
        claims.extend(federated_claims)
    return {
        "workspace_id": body.workspace_id,
        "project_id": body.project_id,
        "records": records[: body.limit],
        "claims": claims[: body.limit],
        "record_snippets": [],
        "federated_persisted": False,
    }


@router.post("/memory/conclusions", tags=["memory"])
def query_conclusions(
    body: ConclusionQuery,
    db: Database,
    auth: CurrentAuth,
    core: Core,
) -> dict[str, Any]:
    workspace_id = auth.context.workspace_id
    project_id = auth.context.project_id
    if workspace_id is None or project_id is None:
        raise HTTPException(
            status_code=400, detail="Workspace/Project context required"
        )
    project = _scope(
        db,
        auth,
        workspace_id=workspace_id,
        project_id=project_id,
        capability="project.read",
    )
    _ensure_core_scope(core, auth, project)
    core_project_id = _core_project_id(project)
    core_context = _core_context(auth.context, project)
    observer = (
        body.observer_peer_id
        or core_context.agent_peer_id
        or core_context.human_peer_id
    )
    observed = body.observed_peer_id or core_context.human_peer_id or observer
    filters = {**body.filters, "project_id": core_project_id}
    if observer:
        filters["observer"] = observer
    if observed:
        filters["observed"] = observed
    if body.query:
        payload = core.request(
            method="POST",
            path=f"/v3/workspaces/{workspace_id}/conclusions/query",
            context=core_context,
            payload={
                "query": body.query,
                "top_k": body.limit,
                "filters": filters,
                "project_id": core_project_id,
                "include_general": body.include_general,
            },
        )
    else:
        payload = core.request(
            method="POST",
            path=f"/v3/workspaces/{workspace_id}/conclusions/list",
            context=core_context,
            params={"size": body.limit},
            payload={
                "filters": filters,
                "project_id": core_project_id,
                "include_general": body.include_general,
            },
        )
    items = [
        _normalize_claim(item, project_id=project_id, rank=index)
        for index, item in enumerate(_as_items(payload), start=1)
    ]
    return {"items": items[: body.limit], "project_id": project_id}


@router.get("/memory/peers/{peer_id}/representation", tags=["memory"])
@router.get("/peers/{peer_id}/representation", tags=["memory"])
def get_memory_representation(
    peer_id: str,
    db: Database,
    auth: CurrentAuth,
    core: Core,
    workspace_id: Annotated[str, Query()],
    project_id: Annotated[str, Query()],
    include_general: Annotated[bool, Query()] = True,
    search_query: Annotated[str | None, Query()] = None,
) -> dict[str, Any]:
    project = _scope(
        db,
        auth,
        workspace_id=workspace_id,
        project_id=project_id,
        capability="project.read",
    )
    observer = _observer(auth)
    core_project_id = _core_project_id(project)
    payload = core.request(
        method="POST",
        path=f"/v3/workspaces/{workspace_id}/peers/{observer}/representation",
        context=_core_context(auth.context, project),
        payload={
            "target": peer_id,
            "search_query": search_query,
            "project_id": core_project_id,
            "include_general": include_general,
        },
    )
    if not isinstance(payload, dict):
        payload = {"representation": str(payload)}
    return {
        **payload,
        "workspace_id": workspace_id,
        "project_id": project_id,
        "peer_id": peer_id,
        "observer_peer_id": observer,
        "include_general": include_general,
    }


@router.get("/memory/peers/{peer_id}/card", tags=["memory"])
@router.get("/peers/{peer_id}/card", tags=["memory"])
def get_memory_peer_card(
    peer_id: str,
    db: Database,
    auth: CurrentAuth,
    core: Core,
    workspace_id: Annotated[str, Query()],
    project_id: Annotated[str, Query()],
    include_general: Annotated[bool, Query()] = True,
) -> dict[str, Any]:
    project = _scope(
        db,
        auth,
        workspace_id=workspace_id,
        project_id=project_id,
        capability="project.read",
    )
    observer = _observer(auth)
    core_project_id = _core_project_id(project)
    payload = core.request(
        method="GET",
        path=f"/v3/workspaces/{workspace_id}/peers/{observer}/card",
        context=_core_context(auth.context, project),
        params={
            "target": peer_id,
            "project_id": core_project_id,
            "include_general": include_general,
        },
    )
    if not isinstance(payload, dict):
        payload = {"peer_card": payload}
    return {
        **payload,
        "workspace_id": workspace_id,
        "project_id": project_id,
        "peer_id": peer_id,
        "observer_peer_id": observer,
        "include_general": include_general,
    }


@router.get("/memory/sessions/{session_id}/context", tags=["memory"])
@router.get("/sessions/{session_id}/context", tags=["memory"])
def get_memory_session_context(
    session_id: str,
    db: Database,
    auth: CurrentAuth,
    core: Core,
    workspace_id: Annotated[str, Query()],
    project_id: Annotated[str, Query()],
    include_general: Annotated[bool, Query()] = True,
    tokens: Annotated[int | None, Query(ge=128, le=128000)] = None,
) -> dict[str, Any]:
    project = _scope(
        db,
        auth,
        workspace_id=workspace_id,
        project_id=project_id,
        capability="project.read",
    )
    core_project_id = _core_project_id(project)
    payload = core.request(
        method="GET",
        path=f"/v3/workspaces/{workspace_id}/sessions/{session_id}/context",
        context=_core_context(auth.context, project),
        params={
            "tokens": tokens,
            "peer_target": auth.context.human_peer_id,
            "peer_perspective": auth.context.agent_peer_id,
            "project_id": core_project_id,
            "include_general": include_general,
        },
    )
    if not isinstance(payload, dict):
        payload = {"context": payload}
    return {
        **payload,
        "workspace_id": workspace_id,
        "project_id": project_id,
        "session_id": session_id,
    }


@router.post("/memory/chat", tags=["memory"])
@router.post("/chat", tags=["memory"])
def memory_chat(
    body: MemoryChatRequest,
    db: Database,
    auth: CurrentAuth,
    core: Core,
) -> Any:
    project = _scope(
        db,
        auth,
        workspace_id=body.workspace_id,
        project_id=body.project_id,
        capability="project.read",
    )
    if body.include_federated:
        raise HTTPException(
            status_code=422,
            detail="federated Dialectic is not supported; use /context instead",
        )
    observer = _observer(auth, body.observer_peer_id)
    core_project_id = _core_project_id(project)
    return core.request(
        method="POST",
        path=f"/v3/workspaces/{body.workspace_id}/peers/{observer}/chat",
        context=_core_context(auth.context, project),
        payload={
            "query": body.query,
            "target": body.target_peer_id or auth.context.human_peer_id,
            "session_id": body.session_id,
            "reasoning_level": body.reasoning_level,
            "project_id": core_project_id,
            "include_general": body.include_general,
        },
    )


@router.post("/memory/dreams", tags=["memory"])
@router.post("/dreams", tags=["memory"])
def schedule_memory_dream(
    body: MemoryDreamRequest,
    db: Database,
    auth: CurrentAuth,
    core: Core,
) -> Any:
    project = _scope(
        db,
        auth,
        workspace_id=body.workspace_id,
        project_id=body.project_id,
        capability="project.write",
    )
    observer = _observer(auth, body.observer_peer_id)
    core_project_id = _core_project_id(project)
    result = core.request(
        method="POST",
        path=f"/v3/workspaces/{body.workspace_id}/schedule_dream",
        context=_core_context(auth.context, project),
        payload={
            "observer": observer,
            "observed": body.observed_peer_id or auth.context.human_peer_id,
            "dream_type": body.strategy,
            "session_id": body.session_id,
            "project_id": core_project_id,
            "include_general": True,
            "force": body.force,
        },
    )
    audit_auth(
        db,
        auth,
        "memory.dream_scheduled",
        "project",
        body.project_id,
        workspace_id=body.workspace_id,
        details={"observer_peer_id": observer, "strategy": body.strategy},
    )
    db.commit()
    return result


def _estimate_tokens(value: str) -> int:
    if not value:
        return 0
    # Conservative dependency-free budget: two UTF-8 bytes per token.
    return math.ceil(len(value.encode("utf-8")) / 2)


def _fit(value: str, token_budget: int) -> tuple[str, bool]:
    if _estimate_tokens(value) <= token_budget:
        return value, False
    low, high = 0, len(value)
    while low < high:
        middle = (low + high + 1) // 2
        if _estimate_tokens(value[:middle]) <= token_budget:
            low = middle
        else:
            high = middle - 1
    fitted = value[:low].rstrip()
    return fitted, True


def _wiki_material(db: Session, project: Project) -> tuple[str, list[str], list[str]]:
    chunks: list[str] = []
    revision_ids: list[str] = []
    source_ids: list[str] = []
    pages = db.scalars(
        select(WikiPage)
        .where(WikiPage.project_id == project.id)
        .order_by(WikiPage.pinned.desc(), WikiPage.title)
    )
    for page in pages:
        revision = db.scalar(
            select(WikiRevision)
            .where(WikiRevision.page_id == page.id)
            .order_by(WikiRevision.revision_number.desc())
            .limit(1)
        )
        if revision is None:
            continue
        chunks.append(f"### {page.title}\n{revision.content}")
        revision_ids.append(revision.id)
        source_ids.extend(
            db.scalars(
                select(WikiCitation.source_id).where(
                    WikiCitation.revision_id == revision.id
                )
            )
        )
    return "\n\n".join(chunks), revision_ids, sorted(set(source_ids))


class _ContextBuilder:
    def __init__(self, token_budget: int):
        self.token_budget = token_budget
        self.rendered = ""
        self.sections: list[DynamicContextSection] = []

    def add(
        self,
        *,
        layer: str,
        title: str,
        content: str,
        source_ids: list[str] | None = None,
        provenance: dict[str, Any] | None = None,
    ) -> bool:
        if not content.strip():
            return True
        prefix = "\n\n" if self.rendered else ""
        heading = f"## {title}\n"
        fixed = f"{self.rendered}{prefix}{heading}"
        remaining = self.token_budget - _estimate_tokens(fixed)
        if remaining <= 0:
            return False
        fitted, truncated = _fit(content.strip(), remaining)
        if not fitted:
            return False
        candidate = f"{fixed}{fitted}"
        if _estimate_tokens(candidate) > self.token_budget:
            return False
        self.rendered = candidate
        self.sections.append(
            DynamicContextSection(
                layer=layer,
                content=fitted,
                source_ids=source_ids or [],
                estimated_tokens=_estimate_tokens(fitted),
                truncated=truncated,
                provenance=provenance or {},
            )
        )
        return not truncated


@router.post("/context", response_model=DynamicContextResponse, tags=["memory"])
@router.post(
    "/memory/context",
    response_model=DynamicContextResponse,
    tags=["memory"],
)
def compile_dynamic_context(
    body: DynamicContextRequest,
    db: Database,
    auth: CurrentAuth,
    core: Core,
) -> DynamicContextResponse:
    project = _scope(
        db,
        auth,
        workspace_id=body.workspace_id,
        project_id=body.project_id,
        capability="project.read",
    )
    _ensure_core_scope(core, auth, project)
    builder = _ContextBuilder(body.token_budget)
    general = db.scalar(
        select(Project).where(
            Project.workspace_id == body.workspace_id,
            Project.is_general.is_(True),
            Project.status == "active",
        )
    )
    if body.include_general and general:
        content, revisions, sources = _wiki_material(db, general)
        builder.add(
            layer="general_wiki",
            title="General Wiki",
            content=content,
            source_ids=sources,
            provenance={"project_id": general.id, "revision_ids": revisions},
        )
    if not project.is_general:
        content, revisions, sources = _wiki_material(db, project)
        builder.add(
            layer="project_wiki",
            title="Project Wiki",
            content=content,
            source_ids=sources,
            provenance={"project_id": project.id, "revision_ids": revisions},
        )

    observer = _observer(auth, body.observer_peer_id)
    target = body.peer_id or auth.context.human_peer_id
    core_project_id = _core_project_id(project)
    if target:
        try:
            representation_payload = core.request(
                method="POST",
                path=(
                    f"/v3/workspaces/{body.workspace_id}/peers/"
                    f"{observer}/representation"
                ),
                context=_core_context(auth.context, project),
                payload={
                    "target": target,
                    "search_query": body.query,
                    "project_id": core_project_id,
                    "include_general": body.include_general,
                },
            )
            representation = (
                representation_payload.get("representation", "")
                if isinstance(representation_payload, dict)
                else str(representation_payload or "")
            )
            builder.add(
                layer="representation",
                title="Relevant Representation",
                content=str(representation),
                provenance={"observer_peer_id": observer, "target_peer_id": target},
            )
        except MemoryCoreError as error:
            if error.status_code != 404:
                raise

    search_body = MemorySearchRequest(
        workspace_id=body.workspace_id,
        project_id=body.project_id,
        query=body.query,
        include=["records", "claims"],
        limit=body.source_limit,
        include_general=body.include_general,
        include_federated=body.include_federated,
    )
    records, claims = _search_local(core, auth.context, search_body, project)
    if body.include_federated:
        federated_records, federated_claims = _search_federated(
            db, core, auth, search_body
        )
        records.extend(federated_records)
        claims.extend(federated_claims)
    for item in [*records, *claims]:
        federated = bool(item.get("federated"))
        identifier = str(item.get("record_id") or item.get("claim_id") or "")
        if not builder.add(
            layer="federated_source" if federated else "source",
            title="Federated Source" if federated else "Relevant Source",
            content=str(item.get("matched_content") or item.get("content") or ""),
            source_ids=[identifier] if identifier else [],
            provenance={
                key: item[key]
                for key in (
                    "project_id",
                    "federated_grant_id",
                    "source_workspace_id",
                    "source_project_id",
                )
                if key in item
            },
        ):
            break
    return DynamicContextResponse(
        workspace_id=body.workspace_id,
        project_id=body.project_id,
        query=body.query,
        token_budget=body.token_budget,
        estimated_tokens=_estimate_tokens(builder.rendered),
        sections=builder.sections,
        context=builder.rendered,
        federated_persisted=False,
    )
