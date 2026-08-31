from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import (
    APIRouter,
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Query,
    Request,
    Response,
    status,
)
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from . import __version__
from .config import Settings, get_settings
from .core_client import (
    MemoryCoreClient,
    MemoryCoreError,
    get_optional_memory_core_client,
)
from .db import db_session, get_engine
from .ids import uuid7
from .memory_gateway import (
    _core_project_id,
    _ensure_core_scope,
    _provisioning_context,
)
from .memory_gateway import router as memory_router
from .models import (
    AgentPeerOwnership,
    AuditEvent,
    Base,
    Credential,
    FederatedProjectGrant,
    Peer,
    PrincipalPeerLink,
    Project,
    ProjectGrant,
    TransferRequest,
    WikiCitation,
    WikiPage,
    WikiRevision,
    Workspace,
    WorkspaceLink,
    WorkspaceMembership,
    utcnow,
)
from .schemas import (
    AgentPeerCreate,
    AgentPeerTransfer,
    AgentPeerView,
    AuditEventView,
    AuthContext,
    AuthEnvelope,
    BootstrapRequest,
    BootstrapResponse,
    CredentialCreate,
    CredentialCreated,
    CredentialView,
    FederatedAssignmentCreate,
    FederatedAssignmentView,
    FederatedGrantCreate,
    FederatedGrantView,
    InternalContextTokenRequest,
    InternalContextTokenResponse,
    InvitationAccept,
    InvitationAccepted,
    InvitationCreate,
    InvitationCreated,
    InvitationView,
    LoginRequest,
    MembershipUpdate,
    MembershipView,
    PeerBindingView,
    PeerView,
    PrincipalView,
    ProjectCreate,
    ProjectGrantUpsert,
    ProjectGrantView,
    ProjectView,
    TransferApprove,
    TransferComplete,
    TransferCreate,
    TransferReject,
    TransferView,
    WikiCitationView,
    WikiPageCreate,
    WikiPageView,
    WikiRevisionCreate,
    WikiRevisionView,
    WikiView,
    WorkspaceCreate,
    WorkspaceLinkCreate,
    WorkspaceLinkView,
    WorkspaceView,
)
from .security import (
    ROLE_CAPABILITIES,
    SESSION_COOKIE,
    CurrentAuth,
    InternalTokenSigner,
    require_capability,
    require_workspace,
)
from .services import (
    ControlError,
    accept_federated_grant,
    accept_invitation,
    add_revision,
    approve_transfer,
    approve_workspace_link,
    audit_auth,
    bootstrap,
    complete_transfer,
    create_agent_peer,
    create_federated_assignment,
    create_federated_grant,
    create_invitation,
    create_transfer,
    create_workspace_bundle,
    create_workspace_link,
    issue_credential,
    login,
    reject_transfer,
    require_admin_membership,
    revoke_federated_grant,
    transfer_agent_owner,
    update_membership,
    validate_projects,
)


@asynccontextmanager
async def lifespan(_: FastAPI):
    settings = get_settings()
    if settings.auto_create_schema:
        Base.metadata.create_all(get_engine())
    yield


app = FastAPI(
    title="Neuromem Control Plane API",
    version=__version__,
    summary="Sovereign workspace, identity, federation, and Wiki control plane",
    description=(
        "The Apache-2.0 product boundary for native Workspace and Project "
        "authorization in front of the AGPL memory core."
    ),
    lifespan=lifespan,
)
api = APIRouter(prefix="/api/v1")
Database = Annotated[Session, Depends(db_session)]
AppSettings = Annotated[Settings, Depends(get_settings)]


@app.exception_handler(ControlError)
async def control_error_handler(_: Request, error: ControlError) -> JSONResponse:
    return JSONResponse(status_code=error.status_code, content={"detail": error.detail})


@app.exception_handler(IntegrityError)
async def integrity_error_handler(_: Request, _error: IntegrityError) -> JSONResponse:
    return JSONResponse(
        status_code=status.HTTP_409_CONFLICT,
        content={"detail": "resource conflicts with an existing record"},
    )


@app.exception_handler(MemoryCoreError)
async def memory_core_error_handler(_: Request, error: MemoryCoreError) -> JSONResponse:
    outward_status = error.status_code
    if outward_status in {401, 403}:
        outward_status = status.HTTP_502_BAD_GATEWAY
    return JSONResponse(
        status_code=outward_status,
        content={
            "detail": "Memory Core request failed",
            "code": error.code,
            "retryable": error.retryable,
            "upstream": error.detail,
        },
    )


@app.get("/health", tags=["system"])
def health() -> dict[str, str]:
    return {"status": "ok", "version": __version__, "mode": "team"}


def _cookie(response: Response, token: str, settings: Settings) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        token,
        httponly=True,
        secure=settings.secure_cookies,
        samesite="lax",
        max_age=settings.web_session_absolute_seconds,
        path="/",
    )


def _context(
    *,
    principal_id: str,
    workspace_id: str | None,
    human_peer_id: str | None,
    request_id: str,
    capabilities: list[str] | None = None,
) -> AuthContext:
    return AuthContext(
        principal_id=principal_id,
        credential_id=None,
        workspace_id=workspace_id,
        project_id=None,
        human_peer_id=human_peer_id,
        agent_peer_id=None,
        capabilities=capabilities or ["workspace.create"],
        request_id=request_id,
    )


def _credential_created(credential: Credential, raw: str) -> CredentialCreated:
    return CredentialCreated(
        credential=CredentialView.model_validate(credential), token=raw
    )


def _selected_workspace(auth: CurrentAuth, workspace_id: str) -> None:
    require_workspace(auth, workspace_id)


def _project(db: Session, workspace_id: str, project_id: str) -> Project:
    project = db.scalar(
        select(Project).where(
            Project.id == project_id, Project.workspace_id == workspace_id
        )
    )
    if project is None:
        raise HTTPException(status_code=404, detail="project not found")
    return project


def _revision_view(db: Session, revision: WikiRevision) -> WikiRevisionView:
    citations = list(
        db.scalars(
            select(WikiCitation)
            .where(WikiCitation.revision_id == revision.id)
            .order_by(WikiCitation.sentence_key, WikiCitation.id)
        )
    )
    return WikiRevisionView(
        **WikiRevisionView.model_validate(revision).model_dump(exclude={"citations"}),
        citations=[WikiCitationView.model_validate(item) for item in citations],
    )


@api.post("/auth/bootstrap", response_model=BootstrapResponse, tags=["auth"])
def post_bootstrap(
    body: BootstrapRequest,
    response: Response,
    db: Database,
    settings: AppSettings,
    request_id: Annotated[str | None, Header(alias="X-Request-ID")] = None,
) -> BootstrapResponse:
    rid = request_id or str(uuid7())
    (
        principal,
        workspace,
        general,
        peer,
        credential,
        raw_credential,
        _session,
        raw_session,
    ) = bootstrap(
        db,
        settings,
        email=str(body.email),
        display_name=body.display_name,
        password=body.password,
        workspace_slug=body.workspace_slug,
        workspace_name=body.workspace_name,
        request_id=rid,
    )
    _cookie(response, raw_session, settings)
    context = _context(
        principal_id=principal.id,
        workspace_id=workspace.id,
        human_peer_id=peer.id,
        request_id=rid,
        capabilities=sorted(ROLE_CAPABILITIES["owner"]),
    )
    return BootstrapResponse(
        principal=PrincipalView.model_validate(principal),
        workspace=WorkspaceView.model_validate(workspace),
        general_project=ProjectView.model_validate(general),
        human_peer=PeerView.model_validate(peer),
        recovery_credential=_credential_created(credential, raw_credential),
        context=context,
    )


@api.post("/auth/login", response_model=AuthEnvelope, tags=["auth"])
def post_login(
    body: LoginRequest,
    response: Response,
    db: Database,
    settings: AppSettings,
    request_id: Annotated[str | None, Header(alias="X-Request-ID")] = None,
) -> AuthEnvelope:
    rid = request_id or str(uuid7())
    principal, _session, raw = login(
        db,
        settings,
        email=str(body.email),
        password=body.password,
        request_id=rid,
    )
    _cookie(response, raw, settings)
    return AuthEnvelope(
        principal=PrincipalView.model_validate(principal),
        context=_context(
            principal_id=principal.id,
            workspace_id=None,
            human_peer_id=None,
            request_id=rid,
        ),
    )


@api.post("/auth/logout", status_code=204, tags=["auth"])
def post_logout(response: Response, db: Database, auth: CurrentAuth) -> None:
    if auth.web_session:
        auth.web_session.revoked_at = utcnow()
        audit_auth(
            db,
            auth,
            "auth.logout",
            "web_session",
            auth.web_session.id,
        )
        db.commit()
    response.delete_cookie(SESSION_COOKIE, path="/")


@api.get("/me", response_model=AuthEnvelope, tags=["auth"])
def get_me(auth: CurrentAuth) -> AuthEnvelope:
    return AuthEnvelope(
        principal=PrincipalView.model_validate(auth.principal), context=auth.context
    )


@api.post(
    "/internal-context-tokens",
    response_model=InternalContextTokenResponse,
    tags=["gateway"],
)
def post_internal_context_token(
    body: InternalContextTokenRequest,
    auth: CurrentAuth,
    settings: AppSettings,
) -> InternalContextTokenResponse:
    if body.workspace_id != auth.context.workspace_id:
        raise HTTPException(status_code=403, detail="workspace context mismatch")
    if body.project_id != auth.context.project_id:
        raise HTTPException(status_code=403, detail="project context mismatch")
    requested = set(body.requested_capabilities or auth.context.capabilities)
    if not requested <= set(auth.context.capabilities):
        raise HTTPException(status_code=403, detail="capability escalation denied")
    narrowed = auth.context.model_copy(update={"capabilities": sorted(requested)})
    token, expires_at = InternalTokenSigner(
        settings.resolved_internal_signing_key
    ).mint(narrowed)
    return InternalContextTokenResponse(
        token=token, expires_at=expires_at, context=narrowed
    )


@api.get("/workspaces", response_model=list[WorkspaceView], tags=["workspaces"])
def get_workspaces(db: Database, auth: CurrentAuth) -> list[WorkspaceView]:
    rows = db.scalars(
        select(Workspace)
        .join(WorkspaceMembership)
        .where(
            WorkspaceMembership.principal_id == auth.principal.id,
            WorkspaceMembership.status == "active",
        )
        .order_by(Workspace.name)
    )
    return [WorkspaceView.model_validate(row) for row in rows]


@api.post("/workspaces", response_model=WorkspaceView, tags=["workspaces"])
def post_workspace(
    body: WorkspaceCreate, db: Database, auth: CurrentAuth
) -> WorkspaceView:
    if "workspace.create" not in auth.context.capabilities:
        raise HTTPException(
            status_code=403,
            detail="create workspaces from an unscoped web session",
        )
    workspace, _general, _peer, _membership = create_workspace_bundle(
        db,
        principal=auth.principal,
        slug=body.slug,
        name=body.name,
        kind=body.kind,
    )
    audit_auth(
        db,
        auth,
        "workspace.created",
        "workspace",
        workspace.id,
        workspace_id=workspace.id,
    )
    db.commit()
    return WorkspaceView.model_validate(workspace)


@api.get(
    "/workspaces/{workspace_id}/members",
    response_model=list[MembershipView],
    tags=["workspaces"],
)
def get_members(
    workspace_id: str, db: Database, auth: CurrentAuth
) -> list[MembershipView]:
    _selected_workspace(auth, workspace_id)
    require_capability(auth, "workspace.read")
    rows = db.scalars(
        select(WorkspaceMembership)
        .where(WorkspaceMembership.workspace_id == workspace_id)
        .order_by(WorkspaceMembership.created_at)
    )
    return [MembershipView.model_validate(row) for row in rows]


@api.patch(
    "/workspaces/{workspace_id}/members/{membership_id}",
    response_model=MembershipView,
    tags=["workspaces"],
)
def patch_member(
    workspace_id: str,
    membership_id: str,
    body: MembershipUpdate,
    db: Database,
    auth: CurrentAuth,
) -> MembershipView:
    _selected_workspace(auth, workspace_id)
    membership = db.scalar(
        select(WorkspaceMembership).where(
            WorkspaceMembership.id == membership_id,
            WorkspaceMembership.workspace_id == workspace_id,
        )
    )
    if membership is None:
        raise HTTPException(status_code=404, detail="membership not found")
    result = update_membership(
        db,
        auth,
        membership,
        role=body.role,
        membership_status=body.status,
    )
    return MembershipView.model_validate(result)


@api.post(
    "/workspaces/{workspace_id}/invitations",
    response_model=InvitationCreated,
    tags=["invitations"],
)
def post_invitation(
    workspace_id: str,
    body: InvitationCreate,
    db: Database,
    auth: CurrentAuth,
    settings: AppSettings,
) -> InvitationCreated:
    _selected_workspace(auth, workspace_id)
    invitation, raw = create_invitation(
        db,
        settings,
        auth,
        workspace_id=workspace_id,
        email=str(body.email),
        role=body.role,
    )
    return InvitationCreated(
        invitation=InvitationView.model_validate(invitation), token=raw
    )


@api.post(
    "/auth/invitations:accept",
    response_model=InvitationAccepted,
    tags=["invitations"],
)
def post_accept_invitation(
    body: InvitationAccept,
    response: Response,
    db: Database,
    settings: AppSettings,
    request_id: Annotated[str | None, Header(alias="X-Request-ID")] = None,
) -> InvitationAccepted:
    rid = request_id or str(uuid7())
    (
        principal,
        workspace,
        general,
        peer,
        credential,
        raw_credential,
        _session,
        raw_session,
    ) = accept_invitation(
        db,
        settings,
        raw_token=body.token,
        display_name=body.display_name,
        password=body.password,
        request_id=rid,
    )
    membership = db.scalar(
        select(WorkspaceMembership).where(
            WorkspaceMembership.workspace_id == workspace.id,
            WorkspaceMembership.principal_id == principal.id,
        )
    )
    assert membership is not None
    _cookie(response, raw_session, settings)
    context = _context(
        principal_id=principal.id,
        workspace_id=workspace.id,
        human_peer_id=peer.id,
        request_id=rid,
        capabilities=sorted(ROLE_CAPABILITIES[membership.role]),
    )
    return InvitationAccepted(
        principal=PrincipalView.model_validate(principal),
        workspace=WorkspaceView.model_validate(workspace),
        general_project=ProjectView.model_validate(general),
        human_peer=PeerView.model_validate(peer),
        recovery_credential=_credential_created(credential, raw_credential),
        context=context,
    )


@api.get(
    "/workspaces/{workspace_id}/projects",
    response_model=list[ProjectView],
    tags=["projects"],
)
def get_projects(
    workspace_id: str, db: Database, auth: CurrentAuth
) -> list[ProjectView]:
    _selected_workspace(auth, workspace_id)
    require_capability(auth, "workspace.read")
    rows = db.scalars(
        select(Project)
        .where(Project.workspace_id == workspace_id)
        .order_by(Project.is_general.desc(), Project.name)
    )
    return [ProjectView.model_validate(row) for row in rows]


@api.post(
    "/workspaces/{workspace_id}/projects",
    response_model=ProjectView,
    tags=["projects"],
)
def post_project(
    workspace_id: str,
    body: ProjectCreate,
    db: Database,
    auth: CurrentAuth,
) -> ProjectView:
    _selected_workspace(auth, workspace_id)
    require_capability(auth, "project.create")
    project = Project(
        workspace_id=workspace_id,
        slug=body.slug,
        name=body.name,
        access_policy=body.access_policy,
    )
    db.add(project)
    db.flush()
    audit_auth(
        db,
        auth,
        "project.created",
        "project",
        project.id,
        workspace_id=workspace_id,
        details={"access_policy": body.access_policy},
    )
    db.commit()
    return ProjectView.model_validate(project)


@api.put(
    "/workspaces/{workspace_id}/projects/{project_id}/grants",
    response_model=ProjectGrantView,
    tags=["projects"],
)
def put_project_grant(
    workspace_id: str,
    project_id: str,
    body: ProjectGrantUpsert,
    db: Database,
    auth: CurrentAuth,
) -> ProjectGrantView:
    _selected_workspace(auth, workspace_id)
    require_capability(auth, "project.grant")
    project = _project(db, workspace_id, project_id)
    membership = db.scalar(
        select(WorkspaceMembership).where(
            WorkspaceMembership.workspace_id == workspace_id,
            WorkspaceMembership.principal_id == body.principal_id,
            WorkspaceMembership.status == "active",
        )
    )
    if membership is None:
        raise HTTPException(status_code=400, detail="principal is not an active member")
    allowed = {"project.read", "project.write", "wiki.read", "wiki.write"}
    if not set(body.capabilities) <= allowed:
        raise HTTPException(status_code=400, detail="invalid project capability")
    grant = db.scalar(
        select(ProjectGrant).where(
            ProjectGrant.project_id == project.id,
            ProjectGrant.principal_id == body.principal_id,
        )
    )
    if grant is None:
        grant = ProjectGrant(
            project_id=project.id,
            principal_id=body.principal_id,
            capabilities=sorted(set(body.capabilities)),
            granted_by_principal_id=auth.principal.id,
        )
        db.add(grant)
    else:
        grant.capabilities = sorted(set(body.capabilities))
        grant.granted_by_principal_id = auth.principal.id
        grant.status = "active"
    db.flush()
    audit_auth(
        db,
        auth,
        "project_grant.upserted",
        "project_grant",
        grant.id,
        workspace_id=workspace_id,
        details={"principal_id": body.principal_id},
    )
    db.commit()
    return ProjectGrantView.model_validate(grant)


@api.get("/credentials", response_model=list[CredentialView], tags=["credentials"])
def get_credentials(db: Database, auth: CurrentAuth) -> list[CredentialView]:
    if auth.context.workspace_id is None:
        raise HTTPException(status_code=400, detail="workspace context required")
    rows = db.scalars(
        select(Credential)
        .where(
            Credential.workspace_id == auth.context.workspace_id,
            Credential.principal_id == auth.principal.id,
        )
        .order_by(Credential.created_at.desc())
    )
    return [CredentialView.model_validate(row) for row in rows]


@api.post("/credentials", response_model=CredentialCreated, tags=["credentials"])
def post_credential(
    body: CredentialCreate,
    db: Database,
    auth: CurrentAuth,
    settings: AppSettings,
) -> CredentialCreated:
    workspace_id = auth.context.workspace_id
    if workspace_id is None:
        raise HTTPException(status_code=400, detail="workspace context required")
    if not ({"credential.manage", "credential.self"} & set(auth.context.capabilities)):
        raise HTTPException(status_code=403, detail="credential capability required")
    if body.capabilities and not set(body.capabilities) <= set(
        auth.context.capabilities
    ):
        raise HTTPException(status_code=403, detail="capability escalation denied")
    validate_projects(db, workspace_id, body.project_ids)
    if body.agent_peer_id:
        ownership = db.scalar(
            select(AgentPeerOwnership).where(
                AgentPeerOwnership.workspace_id == workspace_id,
                AgentPeerOwnership.agent_peer_id == body.agent_peer_id,
                AgentPeerOwnership.status == "active",
            )
        )
        if ownership is None:
            raise HTTPException(status_code=400, detail="agent peer is unavailable")
        manages_credentials = "credential.manage" in auth.context.capabilities
        if ownership.owner_workspace_id is not None and not manages_credentials:
            raise HTTPException(
                status_code=403,
                detail="workspace-owned agents require credential management",
            )
        if ownership.owner_principal_id not in (None, auth.principal.id) and not (
            manages_credentials
        ):
            raise HTTPException(status_code=403, detail="agent peer is not owned")
    credential, raw = issue_credential(
        db,
        settings,
        principal_id=auth.principal.id,
        workspace_id=workspace_id,
        name=body.name,
        kind=body.kind,
        capabilities=body.capabilities,
        project_ids=body.project_ids,
        agent_peer_id=body.agent_peer_id,
        expires_in_seconds=body.expires_in_seconds,
    )
    audit_auth(
        db,
        auth,
        "credential.created",
        "api_credential",
        credential.id,
        workspace_id=workspace_id,
        details={"kind": body.kind, "agent_peer_id": body.agent_peer_id},
    )
    db.commit()
    return _credential_created(credential, raw)


@api.delete("/credentials", status_code=204, tags=["credentials"])
@api.delete("/credentials/{credential_id}", status_code=204, tags=["credentials"])
def delete_credential(credential_id: str, db: Database, auth: CurrentAuth) -> None:
    credential = db.get(Credential, credential_id)
    if credential is None:
        raise HTTPException(status_code=404, detail="credential not found")
    if credential.workspace_id != auth.context.workspace_id:
        raise HTTPException(status_code=403, detail="credential is foreign")
    if credential.principal_id != auth.principal.id and (
        "credential.manage" not in auth.context.capabilities
    ):
        raise HTTPException(status_code=403, detail="credential management required")
    credential.revoked_at = utcnow()
    audit_auth(
        db,
        auth,
        "credential.revoked",
        "api_credential",
        credential.id,
        workspace_id=credential.workspace_id,
    )
    db.commit()


@api.post(
    "/workspaces/{workspace_id}/agent-peers",
    response_model=AgentPeerView,
    tags=["peers"],
)
def post_agent_peer(
    workspace_id: str,
    body: AgentPeerCreate,
    db: Database,
    auth: CurrentAuth,
) -> AgentPeerView:
    _selected_workspace(auth, workspace_id)
    peer, ownership = create_agent_peer(
        db,
        auth,
        workspace_id=workspace_id,
        name=body.name,
        client=body.client,
        owner=body.owner,
    )
    return AgentPeerView(
        peer=PeerView.model_validate(peer),
        ownership_id=ownership.id,
        owner_principal_id=ownership.owner_principal_id,
        owner_workspace_id=ownership.owner_workspace_id,
        client=ownership.client,
        status=ownership.status,
    )


@api.patch(
    "/workspaces/{workspace_id}/agent-peers/{peer_id}/owner",
    response_model=AgentPeerView,
    tags=["peers"],
)
def patch_agent_owner(
    workspace_id: str,
    peer_id: str,
    body: AgentPeerTransfer,
    db: Database,
    auth: CurrentAuth,
) -> AgentPeerView:
    _selected_workspace(auth, workspace_id)
    ownership = db.scalar(
        select(AgentPeerOwnership).where(
            AgentPeerOwnership.workspace_id == workspace_id,
            AgentPeerOwnership.agent_peer_id == peer_id,
        )
    )
    peer = db.get(Peer, peer_id)
    if ownership is None or peer is None:
        raise HTTPException(status_code=404, detail="agent peer not found")
    ownership = transfer_agent_owner(
        db,
        auth,
        ownership,
        owner_principal_id=body.owner_principal_id,
        owner_workspace_id=body.owner_workspace_id,
    )
    return AgentPeerView(
        peer=PeerView.model_validate(peer),
        ownership_id=ownership.id,
        owner_principal_id=ownership.owner_principal_id,
        owner_workspace_id=ownership.owner_workspace_id,
        client=ownership.client,
        status=ownership.status,
    )


@api.get(
    "/workspaces/{workspace_id}/peer-bindings",
    response_model=list[PeerBindingView],
    tags=["peers"],
)
def get_peer_bindings(
    workspace_id: str, db: Database, auth: CurrentAuth
) -> list[PeerBindingView]:
    _selected_workspace(auth, workspace_id)
    require_capability(auth, "workspace.read")
    result: list[PeerBindingView] = []
    human_rows = db.execute(
        select(PrincipalPeerLink, Peer)
        .join(Peer, Peer.id == PrincipalPeerLink.peer_id)
        .where(PrincipalPeerLink.workspace_id == workspace_id)
        .order_by(Peer.name)
    ).all()
    for link, peer in human_rows:
        result.append(
            PeerBindingView(
                principal_id=link.principal_id,
                peer=PeerView.model_validate(peer),
                kind=link.kind,
                status=link.status,
            )
        )
    agent_rows = db.execute(
        select(AgentPeerOwnership, Peer)
        .join(Peer, Peer.id == AgentPeerOwnership.agent_peer_id)
        .where(AgentPeerOwnership.workspace_id == workspace_id)
        .order_by(Peer.name)
    ).all()
    for ownership, peer in agent_rows:
        result.append(
            PeerBindingView(
                principal_id=None,
                peer=PeerView.model_validate(peer),
                kind="agent_owner",
                client=ownership.client,
                owner_principal_id=ownership.owner_principal_id,
                owner_workspace_id=ownership.owner_workspace_id,
                status=ownership.status,
            )
        )
    return result


@api.get(
    "/projects/{project_id}/grants",
    response_model=list[ProjectGrantView],
    tags=["projects"],
)
def get_project_grants(
    project_id: str, db: Database, auth: CurrentAuth
) -> list[ProjectGrantView]:
    if auth.context.workspace_id is None:
        raise HTTPException(status_code=400, detail="workspace context required")
    project = _project(db, auth.context.workspace_id, project_id)
    require_capability(auth, "project.grant")
    rows = db.scalars(
        select(ProjectGrant)
        .where(ProjectGrant.project_id == project.id)
        .order_by(ProjectGrant.created_at)
    )
    return [ProjectGrantView.model_validate(row) for row in rows]


@api.post(
    "/projects/{project_id}/grants",
    response_model=ProjectGrantView,
    tags=["projects"],
)
def post_project_grant_alias(
    project_id: str,
    body: ProjectGrantUpsert,
    db: Database,
    auth: CurrentAuth,
) -> ProjectGrantView:
    if auth.context.workspace_id is None:
        raise HTTPException(status_code=400, detail="workspace context required")
    return put_project_grant(auth.context.workspace_id, project_id, body, db, auth)


@api.delete(
    "/projects/{project_id}/grants",
    status_code=204,
    tags=["projects"],
)
@api.delete(
    "/projects/{project_id}/grants/{grant_id}",
    status_code=204,
    tags=["projects"],
)
def delete_project_grant(
    project_id: str, grant_id: str, db: Database, auth: CurrentAuth
) -> None:
    if auth.context.workspace_id is None:
        raise HTTPException(status_code=400, detail="workspace context required")
    _project(db, auth.context.workspace_id, project_id)
    require_capability(auth, "project.grant")
    grant = db.scalar(
        select(ProjectGrant).where(
            ProjectGrant.id == grant_id, ProjectGrant.project_id == project_id
        )
    )
    if grant is None:
        raise HTTPException(status_code=404, detail="project grant not found")
    grant.status = "revoked"
    audit_auth(
        db,
        auth,
        "project_grant.revoked",
        "project_grant",
        grant.id,
        details={"project_id": project_id},
    )
    db.commit()


@api.get(
    "/workspace-links",
    response_model=list[WorkspaceLinkView],
    tags=["federation"],
)
def get_workspace_links(db: Database, auth: CurrentAuth) -> list[WorkspaceLinkView]:
    workspace_id = auth.context.workspace_id
    if workspace_id is None:
        raise HTTPException(status_code=400, detail="workspace context required")
    require_capability(auth, "workspace.read")
    rows = db.scalars(
        select(WorkspaceLink)
        .where(
            (WorkspaceLink.source_workspace_id == workspace_id)
            | (WorkspaceLink.target_workspace_id == workspace_id)
        )
        .order_by(WorkspaceLink.created_at.desc())
    )
    return [WorkspaceLinkView.model_validate(row) for row in rows]


@api.post(
    "/workspace-links",
    response_model=WorkspaceLinkView,
    tags=["federation"],
)
def post_workspace_link(
    body: WorkspaceLinkCreate, db: Database, auth: CurrentAuth
) -> WorkspaceLinkView:
    require_capability(auth, "federation.manage")
    link = create_workspace_link(
        db,
        auth,
        source_workspace_id=body.source_workspace_id,
        target_workspace_id=body.target_workspace_id,
    )
    return WorkspaceLinkView.model_validate(link)


@api.post(
    "/workspace-links/{link_id}:approve",
    response_model=WorkspaceLinkView,
    tags=["federation"],
)
def post_approve_workspace_link(
    link_id: str, db: Database, auth: CurrentAuth
) -> WorkspaceLinkView:
    link = db.get(WorkspaceLink, link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="workspace link not found")
    return WorkspaceLinkView.model_validate(approve_workspace_link(db, auth, link))


@api.delete("/workspace-links/{link_id}", status_code=204, tags=["federation"])
def delete_workspace_link(link_id: str, db: Database, auth: CurrentAuth) -> None:
    link = db.get(WorkspaceLink, link_id)
    if link is None:
        raise HTTPException(status_code=404, detail="workspace link not found")
    selected = auth.context.workspace_id
    if selected not in {link.source_workspace_id, link.target_workspace_id}:
        raise HTTPException(status_code=403, detail="linked workspace required")
    require_admin_membership(db, auth.principal.id, selected)
    link.status = "revoked"
    link.revoked_at = utcnow()
    for grant in db.scalars(
        select(FederatedProjectGrant).where(
            FederatedProjectGrant.workspace_link_id == link.id,
            FederatedProjectGrant.status.in_(["pending", "active"]),
        )
    ):
        grant.status = "revoked"
        grant.revoked_at = utcnow()
    audit_auth(
        db,
        auth,
        "workspace_link.revoked",
        "workspace_link",
        link.id,
        workspace_id=selected,
    )
    db.commit()


@api.get(
    "/federated-project-grants",
    response_model=list[FederatedGrantView],
    tags=["federation"],
)
def get_federated_grants(db: Database, auth: CurrentAuth) -> list[FederatedGrantView]:
    workspace_id = auth.context.workspace_id
    if workspace_id is None:
        raise HTTPException(status_code=400, detail="workspace context required")
    visible_links = select(WorkspaceLink.id).where(
        (WorkspaceLink.source_workspace_id == workspace_id)
        | (WorkspaceLink.target_workspace_id == workspace_id)
    )
    rows = db.scalars(
        select(FederatedProjectGrant)
        .where(FederatedProjectGrant.workspace_link_id.in_(visible_links))
        .order_by(FederatedProjectGrant.created_at.desc())
    )
    return [FederatedGrantView.model_validate(row) for row in rows]


@api.post(
    "/federated-project-grants",
    response_model=FederatedGrantView,
    tags=["federation"],
)
def post_federated_grant(
    body: FederatedGrantCreate, db: Database, auth: CurrentAuth
) -> FederatedGrantView:
    link = db.get(WorkspaceLink, body.workspace_link_id)
    project = db.get(Project, body.source_project_id)
    if link is None or project is None:
        raise HTTPException(status_code=404, detail="link or project not found")
    grant = create_federated_grant(
        db,
        auth,
        link=link,
        source_project=project,
        capabilities=list(body.capabilities),
    )
    return FederatedGrantView.model_validate(grant)


@api.post(
    "/federated-project-grants/{grant_id}:accept",
    response_model=FederatedGrantView,
    tags=["federation"],
)
def post_accept_federated_grant(
    grant_id: str, db: Database, auth: CurrentAuth
) -> FederatedGrantView:
    grant = db.get(FederatedProjectGrant, grant_id)
    if grant is None:
        raise HTTPException(status_code=404, detail="federated grant not found")
    return FederatedGrantView.model_validate(accept_federated_grant(db, auth, grant))


@api.delete(
    "/federated-project-grants/{grant_id}",
    response_model=FederatedGrantView,
    tags=["federation"],
)
def delete_federated_grant(
    grant_id: str, db: Database, auth: CurrentAuth
) -> FederatedGrantView:
    grant = db.get(FederatedProjectGrant, grant_id)
    if grant is None:
        raise HTTPException(status_code=404, detail="federated grant not found")
    return FederatedGrantView.model_validate(revoke_federated_grant(db, auth, grant))


@api.post(
    "/federated-project-grants/{grant_id}/assignments",
    response_model=FederatedAssignmentView,
    tags=["federation"],
)
def post_federated_assignment(
    grant_id: str,
    body: FederatedAssignmentCreate,
    db: Database,
    auth: CurrentAuth,
) -> FederatedAssignmentView:
    grant = db.get(FederatedProjectGrant, grant_id)
    if grant is None:
        raise HTTPException(status_code=404, detail="federated grant not found")
    assignment = create_federated_assignment(
        db,
        auth,
        grant,
        principal_id=body.principal_id,
        role=body.role,
    )
    return FederatedAssignmentView.model_validate(assignment)


@api.get(
    "/transfer-requests",
    response_model=list[TransferView],
    tags=["transfers"],
)
def get_transfer_requests(
    db: Database,
    auth: CurrentAuth,
    workspace_id: Annotated[str, Query()],
) -> list[TransferView]:
    _selected_workspace(auth, workspace_id)
    require_capability(auth, "workspace.read")
    rows = db.scalars(
        select(TransferRequest)
        .where(
            (TransferRequest.source_workspace_id == workspace_id)
            | (TransferRequest.target_workspace_id == workspace_id)
        )
        .order_by(TransferRequest.created_at.desc())
    )
    return [TransferView.model_validate(row) for row in rows]


@api.post(
    "/transfer-requests",
    response_model=TransferView,
    tags=["transfers"],
)
def post_transfer_request(
    body: TransferCreate, db: Database, auth: CurrentAuth
) -> TransferView:
    transfer = create_transfer(
        db,
        auth,
        source_workspace_id=body.source_workspace_id,
        source_project_id=body.source_project_id,
        target_workspace_id=body.target_workspace_id,
        target_project_id=body.target_project_id,
        source_record_id=body.source_record_id,
        source_content_hash=body.source_content_hash,
        source_snapshot=body.source_snapshot,
        provenance=body.provenance,
    )
    return TransferView.model_validate(transfer)


@api.post(
    "/transfer-requests/{transfer_id}:approve",
    response_model=TransferView,
    tags=["transfers"],
)
def post_approve_transfer(
    transfer_id: str,
    body: TransferApprove,
    db: Database,
    auth: CurrentAuth,
) -> TransferView:
    transfer = db.get(TransferRequest, transfer_id)
    if transfer is None:
        raise HTTPException(status_code=404, detail="transfer request not found")
    return TransferView.model_validate(
        approve_transfer(db, auth, transfer, reviewed_content=body.reviewed_content)
    )


@api.post(
    "/transfer-requests/{transfer_id}:reject",
    response_model=TransferView,
    tags=["transfers"],
)
def post_reject_transfer(
    transfer_id: str,
    body: TransferReject,
    db: Database,
    auth: CurrentAuth,
) -> TransferView:
    transfer = db.get(TransferRequest, transfer_id)
    if transfer is None:
        raise HTTPException(status_code=404, detail="transfer request not found")
    return TransferView.model_validate(
        reject_transfer(db, auth, transfer, reason=body.reason)
    )


@api.post(
    "/transfer-requests/{transfer_id}:complete",
    response_model=TransferView,
    tags=["transfers"],
)
def post_complete_transfer(
    transfer_id: str,
    body: TransferComplete,
    db: Database,
    auth: CurrentAuth,
    core: Annotated[MemoryCoreClient | None, Depends(get_optional_memory_core_client)],
) -> TransferView:
    transfer = db.get(TransferRequest, transfer_id)
    if transfer is None:
        raise HTTPException(status_code=404, detail="transfer request not found")
    if body.imported_message_id:
        # Kept for compatibility with an already-running trusted import worker.
        imported_message_id = body.imported_message_id
    else:
        if core is None:
            raise HTTPException(
                status_code=503,
                detail="Memory Core is required to complete this transfer",
            )
        if transfer.status != "approved":
            raise HTTPException(
                status_code=409,
                detail="both approvals are required before import",
            )
        if auth.context.workspace_id != transfer.target_workspace_id:
            raise HTTPException(
                status_code=403,
                detail="target workspace must complete the import",
            )
        require_admin_membership(db, auth.principal.id, transfer.target_workspace_id)
        target_project = db.scalar(
            select(Project).where(
                Project.id == transfer.target_project_id,
                Project.workspace_id == transfer.target_workspace_id,
                Project.status == "active",
            )
        )
        if target_project is None:
            raise HTTPException(status_code=404, detail="target project not found")
        _ensure_core_scope(core, auth, target_project)
        core_project_id = _core_project_id(target_project)
        system_peer = db.scalar(
            select(Peer).where(
                Peer.workspace_id == transfer.target_workspace_id,
                Peer.external_key == "system:workspace-transfer",
            )
        )
        if system_peer is None:
            system_peer = Peer(
                workspace_id=transfer.target_workspace_id,
                external_key="system:workspace-transfer",
                name="Workspace Transfer",
                kind="system",
            )
            db.add(system_peer)
            db.flush()
        target_context = _provisioning_context(auth, project=target_project)
        core.request(
            method="POST",
            path=f"/v3/workspaces/{transfer.target_workspace_id}/peers",
            context=target_context,
            payload={
                "id": system_peer.id,
                "metadata": {"system": True, "purpose": "workspace-transfer"},
            },
            idempotency_key=f"transfer-peer:{system_peer.id}",
        )
        session_id = body.session_id or f"transfer-{transfer.id}"
        core.request(
            method="POST",
            path=f"/v3/workspaces/{transfer.target_workspace_id}/sessions",
            context=target_context,
            params={"project_id": core_project_id},
            payload={
                "id": session_id,
                "project_id": core_project_id,
                "metadata": {"transfer_request_id": transfer.id},
                "peers": {system_peer.id: {}},
            },
            idempotency_key=f"transfer-session:{transfer.id}",
        )
        result = core.request(
            method="POST",
            path=(
                f"/v3/workspaces/{transfer.target_workspace_id}/sessions/"
                f"{session_id}/messages"
            ),
            context=target_context,
            params={"project_id": core_project_id},
            payload={
                "project_id": core_project_id,
                "messages": [
                    {
                        "peer_id": system_peer.id,
                        "content": transfer.reviewed_content
                        or transfer.source_snapshot,
                        "metadata": {
                            "transfer_request_id": transfer.id,
                            "source_workspace_id": transfer.source_workspace_id,
                            "source_project_id": transfer.source_project_id,
                            "source_record_id": transfer.source_record_id,
                            "source_content_hash": transfer.source_content_hash,
                            "source_approved_by": (
                                transfer.source_approved_by_principal_id
                            ),
                            "target_approved_by": (
                                transfer.target_approved_by_principal_id
                            ),
                            "provenance": transfer.provenance,
                        },
                    }
                ],
            },
            idempotency_key=f"transfer-message:{transfer.id}",
        )
        messages = result if isinstance(result, list) else []
        if (
            not messages
            or not isinstance(messages[0], dict)
            or not messages[0].get("id")
        ):
            raise HTTPException(
                status_code=502,
                detail="Memory Core did not return the imported Message ID",
            )
        imported_message_id = str(messages[0]["id"])
        transfer.provenance = {
            **transfer.provenance,
            "import_session_id": session_id,
            "import_system_peer_id": system_peer.id,
            "imported_message_id": imported_message_id,
        }
    return TransferView.model_validate(
        complete_transfer(
            db,
            auth,
            transfer,
            imported_message_id=imported_message_id,
        )
    )


@api.get(
    "/projects/{project_id}/wiki",
    response_model=WikiView,
    tags=["wiki"],
)
def get_wiki(project_id: str, db: Database, auth: CurrentAuth) -> WikiView:
    workspace_id = auth.context.workspace_id
    if workspace_id is None:
        raise HTTPException(status_code=400, detail="workspace context required")
    if auth.context.project_id != project_id:
        raise HTTPException(
            status_code=403,
            detail="authenticate with X-Neuromem-Project for Wiki access",
        )
    require_capability(auth, "wiki.read")
    project = _project(db, workspace_id, project_id)
    pages: list[WikiPageView] = []
    sections: list[dict[str, object]] = []
    for page in db.scalars(
        select(WikiPage)
        .where(WikiPage.project_id == project.id)
        .order_by(WikiPage.pinned.desc(), WikiPage.title)
    ):
        latest = db.scalar(
            select(WikiRevision)
            .where(WikiRevision.page_id == page.id)
            .order_by(WikiRevision.revision_number.desc())
            .limit(1)
        )
        pages.append(
            WikiPageView(
                id=page.id,
                wiki_id=page.wiki_id,
                project_id=page.project_id,
                slug=page.slug,
                title=page.title,
                pinned=page.pinned,
                latest_revision=_revision_view(db, latest) if latest else None,
            )
        )
        if latest:
            sections.append(
                {
                    "id": page.id,
                    "slug": page.slug,
                    "title": page.title,
                    "content": latest.content,
                    "revision_id": latest.id,
                    "pinned": page.pinned,
                }
            )
    return WikiView(
        wiki_id=project.wiki_id,
        project_id=project.id,
        pages=pages,
        sections=sections,
    )


@api.post(
    "/projects/{project_id}/wiki/pages",
    response_model=WikiPageView,
    tags=["wiki"],
)
def post_wiki_page(
    project_id: str,
    body: WikiPageCreate,
    db: Database,
    auth: CurrentAuth,
) -> WikiPageView:
    workspace_id = auth.context.workspace_id
    if workspace_id is None or auth.context.project_id != project_id:
        raise HTTPException(status_code=403, detail="project context required")
    require_capability(auth, "wiki.write")
    project = _project(db, workspace_id, project_id)
    page = WikiPage(
        wiki_id=project.wiki_id,
        project_id=project.id,
        slug=body.slug,
        title=body.title,
        pinned=body.pinned,
    )
    db.add(page)
    db.flush()
    revision = add_revision(
        db,
        auth,
        project=project,
        page=page,
        content=body.content,
        source=body.source,
        based_on_revision_id=None,
        citations=body.citations,
    )
    return WikiPageView(
        id=page.id,
        wiki_id=page.wiki_id,
        project_id=page.project_id,
        slug=page.slug,
        title=page.title,
        pinned=page.pinned,
        latest_revision=_revision_view(db, revision),
    )


@api.post(
    "/projects/{project_id}/wiki/pages/{page_id}/revisions",
    response_model=WikiRevisionView,
    tags=["wiki"],
)
def post_wiki_revision(
    project_id: str,
    page_id: str,
    body: WikiRevisionCreate,
    db: Database,
    auth: CurrentAuth,
) -> WikiRevisionView:
    workspace_id = auth.context.workspace_id
    if workspace_id is None or auth.context.project_id != project_id:
        raise HTTPException(status_code=403, detail="project context required")
    project = _project(db, workspace_id, project_id)
    page = db.scalar(
        select(WikiPage).where(
            WikiPage.id == page_id, WikiPage.project_id == project.id
        )
    )
    if page is None:
        raise HTTPException(status_code=404, detail="wiki page not found")
    revision = add_revision(
        db,
        auth,
        project=project,
        page=page,
        content=body.content,
        source=body.source,
        based_on_revision_id=body.based_on_revision_id,
        citations=body.citations,
    )
    return _revision_view(db, revision)


@api.get(
    "/audit-events",
    response_model=list[AuditEventView],
    tags=["audit"],
)
def get_audit_events(
    db: Database,
    auth: CurrentAuth,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> list[AuditEventView]:
    workspace_id = auth.context.workspace_id
    if workspace_id is None:
        raise HTTPException(status_code=400, detail="workspace context required")
    require_capability(auth, "audit.read")
    rows = db.scalars(
        select(AuditEvent)
        .where(AuditEvent.workspace_id == workspace_id)
        .order_by(AuditEvent.created_at.desc())
        .limit(limit)
    )
    return [AuditEventView.model_validate(row) for row in rows]


app.include_router(api)
app.include_router(memory_router)
