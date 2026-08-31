from __future__ import annotations

import datetime as dt
from collections.abc import Iterable
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .config import Settings
from .models import (
    AgentPeerOwnership,
    AuditEvent,
    Credential,
    FederatedGrantAssignment,
    FederatedProjectGrant,
    Invitation,
    Peer,
    Principal,
    PrincipalPeerLink,
    Project,
    SystemState,
    TransferRequest,
    WebSession,
    WikiCitation,
    WikiPage,
    WikiRevision,
    Workspace,
    WorkspaceLink,
    WorkspaceMembership,
    new_id,
    utcnow,
)
from .security import (
    Authenticated,
    generate_secret,
    hash_password,
    require_capability,
    token_digest,
    verify_password,
)


class ControlError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def fail(status_code: int, detail: str) -> None:
    raise ControlError(status_code, detail)


def audit(
    db: Session,
    *,
    action: str,
    target_type: str,
    target_id: str | None,
    request_id: str,
    workspace_id: str | None = None,
    actor_principal_id: str | None = None,
    actor_credential_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> AuditEvent:
    event = AuditEvent(
        workspace_id=workspace_id,
        actor_principal_id=actor_principal_id,
        actor_credential_id=actor_credential_id,
        action=action,
        target_type=target_type,
        target_id=target_id,
        request_id=request_id,
        details=details or {},
    )
    db.add(event)
    return event


def audit_auth(
    db: Session,
    auth: Authenticated,
    action: str,
    target_type: str,
    target_id: str | None,
    *,
    workspace_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    audit(
        db,
        action=action,
        target_type=target_type,
        target_id=target_id,
        request_id=auth.context.request_id,
        workspace_id=workspace_id or auth.context.workspace_id,
        actor_principal_id=auth.principal.id,
        actor_credential_id=auth.context.credential_id,
        details=details,
    )


def create_general_project(db: Session, workspace: Workspace) -> Project:
    project = Project(
        workspace_id=workspace.id,
        slug="general",
        name="General",
        access_policy="inherited",
        is_general=True,
    )
    db.add(project)
    db.flush()
    return project


def ensure_human_peer(db: Session, workspace: Workspace, principal: Principal) -> Peer:
    existing_link = db.scalar(
        select(PrincipalPeerLink).where(
            PrincipalPeerLink.workspace_id == workspace.id,
            PrincipalPeerLink.principal_id == principal.id,
            PrincipalPeerLink.kind == "primary_human",
        )
    )
    if existing_link:
        existing_link.status = "active"
        peer = db.get(Peer, existing_link.peer_id)
        if peer is None:
            fail(409, "principal peer link is corrupt")
        peer.status = "active"
        return peer

    peer = Peer(
        workspace_id=workspace.id,
        external_key=f"human:{principal.id}",
        name=principal.display_name,
        kind="human",
    )
    db.add(peer)
    db.flush()
    db.add(
        PrincipalPeerLink(
            workspace_id=workspace.id,
            principal_id=principal.id,
            peer_id=peer.id,
        )
    )
    db.flush()
    return peer


def create_workspace_bundle(
    db: Session,
    *,
    principal: Principal,
    slug: str,
    name: str,
    kind: str,
) -> tuple[Workspace, Project, Peer, WorkspaceMembership]:
    workspace = Workspace(slug=slug, name=name, kind=kind)
    db.add(workspace)
    db.flush()
    membership = WorkspaceMembership(
        workspace_id=workspace.id,
        principal_id=principal.id,
        role="owner",
    )
    db.add(membership)
    project = create_general_project(db, workspace)
    peer = ensure_human_peer(db, workspace, principal)
    db.flush()
    return workspace, project, peer, membership


def issue_credential(
    db: Session,
    settings: Settings,
    *,
    principal_id: str,
    workspace_id: str,
    name: str,
    kind: str,
    capabilities: list[str],
    project_ids: list[str] | None = None,
    agent_peer_id: str | None = None,
    expires_in_seconds: int | None = None,
) -> tuple[Credential, str]:
    raw, prefix = generate_secret(kind)
    ttl = expires_in_seconds or settings.credential_ttl_seconds
    credential = Credential(
        principal_id=principal_id,
        workspace_id=workspace_id,
        agent_peer_id=agent_peer_id,
        name=name,
        kind=kind,
        token_prefix=prefix,
        token_digest=token_digest(raw, settings.secret_key),
        capabilities=sorted(set(capabilities)),
        project_ids=sorted(set(project_ids or [])),
        expires_at=utcnow() + dt.timedelta(seconds=ttl),
    )
    db.add(credential)
    db.flush()
    return credential, raw


def issue_web_session(
    db: Session, settings: Settings, *, principal_id: str
) -> tuple[WebSession, str]:
    now = utcnow()
    raw, prefix = generate_secret("web")
    absolute = now + dt.timedelta(seconds=settings.web_session_absolute_seconds)
    web_session = WebSession(
        principal_id=principal_id,
        token_prefix=prefix,
        token_digest=token_digest(raw, settings.secret_key),
        last_seen_at=now,
        idle_expires_at=min(
            now + dt.timedelta(seconds=settings.web_session_idle_seconds), absolute
        ),
        absolute_expires_at=absolute,
    )
    db.add(web_session)
    db.flush()
    return web_session, raw


def bootstrap(
    db: Session,
    settings: Settings,
    *,
    email: str,
    display_name: str,
    password: str,
    workspace_slug: str,
    workspace_name: str,
    request_id: str,
) -> tuple[Principal, Workspace, Project, Peer, Credential, str, WebSession, str]:
    if db.get(SystemState, "bootstrap") or db.scalar(
        select(func.count()).select_from(Principal)
    ):
        fail(409, "bootstrap has already been completed")
    db.add(SystemState(key="bootstrap", value={"request_id": request_id}))
    db.flush()
    principal = Principal(
        email=email.lower(),
        display_name=display_name,
        password_hash=hash_password(password),
    )
    db.add(principal)
    db.flush()
    workspace, general, peer, _ = create_workspace_bundle(
        db,
        principal=principal,
        slug=workspace_slug,
        name=workspace_name,
        kind="personal",
    )
    credential, raw_credential = issue_credential(
        db,
        settings,
        principal_id=principal.id,
        workspace_id=workspace.id,
        name="initial recovery key",
        kind="recovery",
        capabilities=[],
    )
    web_session, raw_session = issue_web_session(
        db, settings, principal_id=principal.id
    )
    audit(
        db,
        action="system.bootstrap",
        target_type="workspace",
        target_id=workspace.id,
        request_id=request_id,
        workspace_id=workspace.id,
        actor_principal_id=principal.id,
    )
    db.commit()
    return (
        principal,
        workspace,
        general,
        peer,
        credential,
        raw_credential,
        web_session,
        raw_session,
    )


def login(
    db: Session, settings: Settings, *, email: str, password: str, request_id: str
) -> tuple[Principal, WebSession, str]:
    principal = db.scalar(select(Principal).where(Principal.email == email.lower()))
    if (
        principal is None
        or principal.status != "active"
        or not verify_password(password, principal.password_hash)
    ):
        fail(401, "invalid email or password")
    session, raw = issue_web_session(db, settings, principal_id=principal.id)
    audit(
        db,
        action="auth.login",
        target_type="principal",
        target_id=principal.id,
        request_id=request_id,
        actor_principal_id=principal.id,
    )
    db.commit()
    return principal, session, raw


def require_admin_membership(
    db: Session, principal_id: str, workspace_id: str
) -> WorkspaceMembership:
    membership = db.scalar(
        select(WorkspaceMembership).where(
            WorkspaceMembership.workspace_id == workspace_id,
            WorkspaceMembership.principal_id == principal_id,
            WorkspaceMembership.status == "active",
            WorkspaceMembership.role.in_(["owner", "admin"]),
        )
    )
    if membership is None:
        fail(403, "workspace owner or admin required")
    return membership


def update_membership(
    db: Session,
    auth: Authenticated,
    membership: WorkspaceMembership,
    *,
    role: str | None,
    membership_status: str | None,
) -> WorkspaceMembership:
    require_capability(auth, "workspace.admin")
    actor_membership = db.scalar(
        select(WorkspaceMembership).where(
            WorkspaceMembership.workspace_id == membership.workspace_id,
            WorkspaceMembership.principal_id == auth.principal.id,
            WorkspaceMembership.status == "active",
        )
    )
    if actor_membership is None:
        fail(403, "active workspace membership required")
    if actor_membership.role != "owner" and (
        membership.role == "owner" or role == "owner"
    ):
        fail(403, "only an owner can create or modify another owner")
    removes_owner = membership.role == "owner" and (
        (role is not None and role != "owner")
        or (membership_status is not None and membership_status != "active")
    )
    if removes_owner:
        db.scalar(
            select(Workspace)
            .where(Workspace.id == membership.workspace_id)
            .with_for_update()
        )
        owner_count = db.scalar(
            select(func.count())
            .select_from(WorkspaceMembership)
            .where(
                WorkspaceMembership.workspace_id == membership.workspace_id,
                WorkspaceMembership.role == "owner",
                WorkspaceMembership.status == "active",
            )
        )
        if owner_count is None or owner_count <= 1:
            fail(409, "the last active owner cannot be removed or demoted")
    if role is not None:
        membership.role = role
    if membership_status is not None:
        membership.status = membership_status
        link = db.scalar(
            select(PrincipalPeerLink).where(
                PrincipalPeerLink.workspace_id == membership.workspace_id,
                PrincipalPeerLink.principal_id == membership.principal_id,
            )
        )
        if link:
            link.status = "active" if membership_status == "active" else "inactive"
            peer = db.get(Peer, link.peer_id)
            if peer:
                peer.status = link.status
    audit_auth(
        db,
        auth,
        "membership.updated",
        "workspace_membership",
        membership.id,
        workspace_id=membership.workspace_id,
        details={"role": membership.role, "status": membership.status},
    )
    db.commit()
    return membership


def validate_projects(
    db: Session, workspace_id: str, project_ids: Iterable[str]
) -> list[Project]:
    ids = sorted(set(project_ids))
    if not ids:
        return []
    rows = list(
        db.scalars(
            select(Project).where(
                Project.workspace_id == workspace_id,
                Project.id.in_(ids),
                Project.status == "active",
            )
        )
    )
    if len(rows) != len(ids):
        fail(400, "one or more projects are outside the selected workspace")
    return rows


def create_invitation(
    db: Session,
    settings: Settings,
    auth: Authenticated,
    *,
    workspace_id: str,
    email: str,
    role: str,
) -> tuple[Invitation, str]:
    require_capability(auth, "invitation.manage")
    if role == "owner":
        actor = require_admin_membership(db, auth.principal.id, workspace_id)
        if actor.role != "owner":
            fail(403, "only an owner can invite another owner")
    raw, prefix = generate_secret("invite")
    invitation = Invitation(
        workspace_id=workspace_id,
        email=email.lower(),
        role=role,
        token_prefix=prefix,
        token_digest=token_digest(raw, settings.secret_key),
        invited_by_principal_id=auth.principal.id,
        expires_at=utcnow() + dt.timedelta(seconds=settings.invitation_ttl_seconds),
    )
    db.add(invitation)
    db.flush()
    audit_auth(
        db,
        auth,
        "invitation.created",
        "invitation",
        invitation.id,
        workspace_id=workspace_id,
        details={"email": invitation.email, "role": role},
    )
    db.commit()
    return invitation, raw


def accept_invitation(
    db: Session,
    settings: Settings,
    *,
    raw_token: str,
    display_name: str,
    password: str,
    request_id: str,
) -> tuple[Principal, Workspace, Project, Peer, Credential, str, WebSession, str]:
    from .security import token_prefix, verify_token

    prefix = token_prefix(raw_token)
    invitation = (
        db.scalar(select(Invitation).where(Invitation.token_prefix == prefix))
        if prefix
        else None
    )
    now = utcnow()
    if (
        invitation is None
        or invitation.accepted_at is not None
        or invitation.revoked_at is not None
        or invitation.expires_at <= now
        or not verify_token(raw_token, invitation.token_digest, settings.secret_key)
    ):
        fail(400, "invitation is invalid, expired, or already used")
    principal = db.scalar(select(Principal).where(Principal.email == invitation.email))
    if principal is None:
        principal = Principal(
            email=invitation.email,
            display_name=display_name,
            password_hash=hash_password(password),
        )
        db.add(principal)
        db.flush()
    elif not verify_password(password, principal.password_hash):
        fail(401, "existing account password is incorrect")
    workspace = db.get(Workspace, invitation.workspace_id)
    if workspace is None or workspace.status != "active":
        fail(409, "invitation workspace is unavailable")
    membership = db.scalar(
        select(WorkspaceMembership).where(
            WorkspaceMembership.workspace_id == workspace.id,
            WorkspaceMembership.principal_id == principal.id,
        )
    )
    if membership is None:
        membership = WorkspaceMembership(
            workspace_id=workspace.id,
            principal_id=principal.id,
            role=invitation.role,
        )
        db.add(membership)
    elif membership.status == "active":
        fail(409, "principal is already an active workspace member")
    else:
        membership.role = invitation.role
        membership.status = "active"
    peer = ensure_human_peer(db, workspace, principal)
    general = db.scalar(
        select(Project).where(
            Project.workspace_id == workspace.id, Project.is_general.is_(True)
        )
    )
    if general is None:
        fail(409, "workspace has no General project")
    credential, raw_credential = issue_credential(
        db,
        settings,
        principal_id=principal.id,
        workspace_id=workspace.id,
        name="invitation recovery key",
        kind="recovery",
        capabilities=[],
    )
    web_session, raw_session = issue_web_session(
        db, settings, principal_id=principal.id
    )
    invitation.accepted_at = now
    invitation.accepted_by_principal_id = principal.id
    audit(
        db,
        action="invitation.accepted",
        target_type="invitation",
        target_id=invitation.id,
        request_id=request_id,
        workspace_id=workspace.id,
        actor_principal_id=principal.id,
        details={"role": membership.role},
    )
    db.commit()
    return (
        principal,
        workspace,
        general,
        peer,
        credential,
        raw_credential,
        web_session,
        raw_session,
    )


def create_agent_peer(
    db: Session,
    auth: Authenticated,
    *,
    workspace_id: str,
    name: str,
    client: str,
    owner: str,
) -> tuple[Peer, AgentPeerOwnership]:
    if owner == "workspace":
        require_capability(auth, "agent.manage")
        owner_principal_id = None
        owner_workspace_id = workspace_id
    else:
        if not ({"agent.manage", "agent.self"} & set(auth.context.capabilities)):
            fail(403, "agent management capability required")
        owner_principal_id = auth.principal.id
        owner_workspace_id = None
    peer = Peer(
        workspace_id=workspace_id,
        external_key=f"agent:{client}:{new_id()}",
        name=name,
        kind="agent",
    )
    # Replace the generated external suffix with the actual peer id after flush.
    db.add(peer)
    db.flush()
    peer.external_key = f"agent:{client}:{peer.id}"
    ownership = AgentPeerOwnership(
        workspace_id=workspace_id,
        agent_peer_id=peer.id,
        owner_principal_id=owner_principal_id,
        owner_workspace_id=owner_workspace_id,
        client=client,
    )
    db.add(ownership)
    db.flush()
    audit_auth(
        db,
        auth,
        "agent_peer.created",
        "peer",
        peer.id,
        workspace_id=workspace_id,
        details={"client": client, "owner": owner},
    )
    db.commit()
    return peer, ownership


def transfer_agent_owner(
    db: Session,
    auth: Authenticated,
    ownership: AgentPeerOwnership,
    *,
    owner_principal_id: str | None,
    owner_workspace_id: str | None,
) -> AgentPeerOwnership:
    require_capability(auth, "agent.manage")
    if owner_workspace_id is not None and owner_workspace_id != ownership.workspace_id:
        fail(400, "workspace-owned agents must remain in their workspace")
    if owner_principal_id is not None:
        membership = db.scalar(
            select(WorkspaceMembership).where(
                WorkspaceMembership.workspace_id == ownership.workspace_id,
                WorkspaceMembership.principal_id == owner_principal_id,
                WorkspaceMembership.status == "active",
            )
        )
        if membership is None:
            fail(400, "new owner is not an active workspace member")
    previous = {
        "owner_principal_id": ownership.owner_principal_id,
        "owner_workspace_id": ownership.owner_workspace_id,
    }
    ownership.owner_principal_id = owner_principal_id
    ownership.owner_workspace_id = owner_workspace_id
    audit_auth(
        db,
        auth,
        "agent_peer.owner_transferred",
        "agent_peer_ownership",
        ownership.id,
        workspace_id=ownership.workspace_id,
        details={
            "previous": previous,
            "owner_principal_id": owner_principal_id,
            "owner_workspace_id": owner_workspace_id,
        },
    )
    db.commit()
    return ownership


def create_workspace_link(
    db: Session,
    auth: Authenticated,
    *,
    source_workspace_id: str,
    target_workspace_id: str,
) -> WorkspaceLink:
    if source_workspace_id == target_workspace_id:
        fail(400, "workspace link endpoints must be distinct")
    if auth.context.workspace_id not in {source_workspace_id, target_workspace_id}:
        fail(403, "authenticate as one of the linked workspaces")
    require_admin_membership(db, auth.principal.id, auth.context.workspace_id)
    if not db.get(Workspace, source_workspace_id) or not db.get(
        Workspace, target_workspace_id
    ):
        fail(404, "workspace not found")
    link = WorkspaceLink(
        source_workspace_id=source_workspace_id,
        target_workspace_id=target_workspace_id,
        initiated_by_principal_id=auth.principal.id,
    )
    now = utcnow()
    if auth.context.workspace_id == source_workspace_id:
        link.source_approved_by_principal_id = auth.principal.id
        link.source_approved_at = now
    else:
        link.target_approved_by_principal_id = auth.principal.id
        link.target_approved_at = now
    db.add(link)
    db.flush()
    audit_auth(
        db,
        auth,
        "workspace_link.proposed",
        "workspace_link",
        link.id,
        workspace_id=auth.context.workspace_id,
    )
    db.commit()
    return link


def approve_workspace_link(
    db: Session, auth: Authenticated, link: WorkspaceLink
) -> WorkspaceLink:
    if link.status != "pending":
        fail(409, "workspace link is not pending")
    selected = auth.context.workspace_id
    if selected not in {link.source_workspace_id, link.target_workspace_id}:
        fail(403, "authenticate as one of the linked workspaces")
    require_admin_membership(db, auth.principal.id, selected)
    now = utcnow()
    if selected == link.source_workspace_id:
        link.source_approved_by_principal_id = auth.principal.id
        link.source_approved_at = now
    else:
        link.target_approved_by_principal_id = auth.principal.id
        link.target_approved_at = now
    if link.source_approved_at and link.target_approved_at:
        link.status = "active"
    audit_auth(
        db,
        auth,
        "workspace_link.approved",
        "workspace_link",
        link.id,
        workspace_id=selected,
        details={"status": link.status},
    )
    db.commit()
    return link


def create_federated_grant(
    db: Session,
    auth: Authenticated,
    *,
    link: WorkspaceLink,
    source_project: Project,
    capabilities: list[str],
) -> FederatedProjectGrant:
    if link.status != "active":
        fail(409, "workspace link must be active")
    if auth.context.workspace_id != link.source_workspace_id:
        fail(403, "source workspace admin must propose the grant")
    require_admin_membership(db, auth.principal.id, link.source_workspace_id)
    if source_project.workspace_id != link.source_workspace_id:
        fail(400, "source project is not in the source workspace")
    grant = FederatedProjectGrant(
        workspace_link_id=link.id,
        source_project_id=source_project.id,
        target_workspace_id=link.target_workspace_id,
        capabilities=sorted(set(capabilities)),
        proposed_by_principal_id=auth.principal.id,
    )
    db.add(grant)
    db.flush()
    audit_auth(
        db,
        auth,
        "federated_grant.proposed",
        "federated_project_grant",
        grant.id,
        workspace_id=link.source_workspace_id,
        details={"capabilities": grant.capabilities},
    )
    db.commit()
    return grant


def accept_federated_grant(
    db: Session, auth: Authenticated, grant: FederatedProjectGrant
) -> FederatedProjectGrant:
    if grant.status != "pending":
        fail(409, "federated grant is not pending")
    if auth.context.workspace_id != grant.target_workspace_id:
        fail(403, "target workspace admin must accept the grant")
    require_admin_membership(db, auth.principal.id, grant.target_workspace_id)
    grant.status = "active"
    grant.accepted_at = utcnow()
    grant.accepted_by_principal_id = auth.principal.id
    audit_auth(
        db,
        auth,
        "federated_grant.accepted",
        "federated_project_grant",
        grant.id,
        workspace_id=grant.target_workspace_id,
    )
    db.commit()
    return grant


def revoke_federated_grant(
    db: Session, auth: Authenticated, grant: FederatedProjectGrant
) -> FederatedProjectGrant:
    link = db.get(WorkspaceLink, grant.workspace_link_id)
    if link is None or auth.context.workspace_id not in {
        link.source_workspace_id,
        link.target_workspace_id,
    }:
        fail(403, "linked workspace admin required")
    require_admin_membership(db, auth.principal.id, auth.context.workspace_id)
    grant.status = "revoked"
    grant.revoked_at = utcnow()
    for assignment in db.scalars(
        select(FederatedGrantAssignment).where(
            FederatedGrantAssignment.federated_grant_id == grant.id,
            FederatedGrantAssignment.status == "active",
        )
    ):
        assignment.status = "revoked"
    audit_auth(
        db,
        auth,
        "federated_grant.revoked",
        "federated_project_grant",
        grant.id,
        workspace_id=auth.context.workspace_id,
    )
    db.commit()
    return grant


def create_federated_assignment(
    db: Session,
    auth: Authenticated,
    grant: FederatedProjectGrant,
    *,
    principal_id: str | None,
    role: str | None,
) -> FederatedGrantAssignment:
    if grant.status != "active":
        fail(409, "federated grant must be active")
    if auth.context.workspace_id != grant.target_workspace_id:
        fail(403, "target workspace admin must assign the grant")
    require_admin_membership(db, auth.principal.id, grant.target_workspace_id)
    if principal_id:
        membership = db.scalar(
            select(WorkspaceMembership).where(
                WorkspaceMembership.workspace_id == grant.target_workspace_id,
                WorkspaceMembership.principal_id == principal_id,
                WorkspaceMembership.status == "active",
            )
        )
        if membership is None:
            fail(400, "assignment principal is not an active target member")
    assignment = FederatedGrantAssignment(
        federated_grant_id=grant.id,
        principal_id=principal_id,
        role=role,
        assigned_by_principal_id=auth.principal.id,
    )
    db.add(assignment)
    db.flush()
    audit_auth(
        db,
        auth,
        "federated_assignment.created",
        "federated_grant_assignment",
        assignment.id,
        workspace_id=grant.target_workspace_id,
        details={"principal_id": principal_id, "role": role},
    )
    db.commit()
    return assignment


def create_transfer(
    db: Session,
    auth: Authenticated,
    *,
    source_workspace_id: str,
    source_project_id: str,
    target_workspace_id: str,
    target_project_id: str,
    source_record_id: str,
    source_content_hash: str,
    source_snapshot: str,
    provenance: dict[str, Any],
) -> TransferRequest:
    if auth.context.workspace_id != source_workspace_id:
        fail(403, "transfer must be requested from the source workspace")
    if not ({"transfer.manage", "transfer.request"} & set(auth.context.capabilities)):
        fail(403, "transfer capability required")
    source_project = db.get(Project, source_project_id)
    target_project = db.get(Project, target_project_id)
    if source_project is None or source_project.workspace_id != source_workspace_id:
        fail(400, "source project does not belong to source workspace")
    if target_project is None or target_project.workspace_id != target_workspace_id:
        fail(400, "target project does not belong to target workspace")
    link = db.scalar(
        select(WorkspaceLink).where(
            WorkspaceLink.source_workspace_id == source_workspace_id,
            WorkspaceLink.target_workspace_id == target_workspace_id,
            WorkspaceLink.status == "active",
        )
    )
    if link is None:
        fail(409, "an active workspace link is required")
    transfer = TransferRequest(
        source_workspace_id=source_workspace_id,
        source_project_id=source_project_id,
        target_workspace_id=target_workspace_id,
        target_project_id=target_project_id,
        requested_by_principal_id=auth.principal.id,
        source_record_id=source_record_id,
        source_content_hash=source_content_hash,
        source_snapshot=source_snapshot,
        provenance=provenance,
    )
    db.add(transfer)
    db.flush()
    audit_auth(
        db,
        auth,
        "transfer.requested",
        "transfer_request",
        transfer.id,
        workspace_id=source_workspace_id,
        details={"target_workspace_id": target_workspace_id},
    )
    db.commit()
    return transfer


def approve_transfer(
    db: Session,
    auth: Authenticated,
    transfer: TransferRequest,
    *,
    reviewed_content: str | None,
) -> TransferRequest:
    selected = auth.context.workspace_id
    if transfer.status == "pending_source":
        if selected != transfer.source_workspace_id:
            fail(403, "source workspace admin approval required")
        require_admin_membership(db, auth.principal.id, selected)
        transfer.source_approved_by_principal_id = auth.principal.id
        transfer.source_approved_at = utcnow()
        transfer.status = "pending_target"
    elif transfer.status == "pending_target":
        if selected != transfer.target_workspace_id:
            fail(403, "target workspace admin approval required")
        require_admin_membership(db, auth.principal.id, selected)
        transfer.target_approved_by_principal_id = auth.principal.id
        transfer.target_approved_at = utcnow()
        transfer.reviewed_content = reviewed_content or transfer.source_snapshot
        transfer.status = "approved"
    else:
        fail(409, "transfer is not awaiting approval")
    audit_auth(
        db,
        auth,
        "transfer.approved",
        "transfer_request",
        transfer.id,
        workspace_id=selected,
        details={"status": transfer.status},
    )
    db.commit()
    return transfer


def reject_transfer(
    db: Session,
    auth: Authenticated,
    transfer: TransferRequest,
    *,
    reason: str,
) -> TransferRequest:
    expected_workspace = {
        "pending_source": transfer.source_workspace_id,
        "pending_target": transfer.target_workspace_id,
    }.get(transfer.status)
    if expected_workspace is None:
        fail(409, "transfer is not awaiting approval")
    if auth.context.workspace_id != expected_workspace:
        fail(403, "current workspace cannot reject this approval stage")
    require_admin_membership(db, auth.principal.id, expected_workspace)
    transfer.status = "rejected"
    transfer.rejected_by_principal_id = auth.principal.id
    transfer.rejection_reason = reason
    audit_auth(
        db,
        auth,
        "transfer.rejected",
        "transfer_request",
        transfer.id,
        workspace_id=expected_workspace,
        details={"reason": reason},
    )
    db.commit()
    return transfer


def complete_transfer(
    db: Session,
    auth: Authenticated,
    transfer: TransferRequest,
    *,
    imported_message_id: str,
) -> TransferRequest:
    if transfer.status != "approved":
        fail(409, "both approvals are required before import completion")
    if auth.context.workspace_id != transfer.target_workspace_id:
        fail(403, "target workspace must complete the import")
    require_admin_membership(db, auth.principal.id, transfer.target_workspace_id)
    transfer.imported_message_id = imported_message_id
    transfer.status = "completed"
    audit_auth(
        db,
        auth,
        "transfer.completed",
        "transfer_request",
        transfer.id,
        workspace_id=transfer.target_workspace_id,
        details={"imported_message_id": imported_message_id},
    )
    db.commit()
    return transfer


def validate_wiki_citations(
    db: Session,
    *,
    project: Project,
    citations: Iterable[Any],
) -> None:
    citations = list(citations)
    if not citations:
        fail(422, "at least one source citation is required for every revision")
    allowed_projects = {project.id}
    general_id = db.scalar(
        select(Project.id).where(
            Project.workspace_id == project.workspace_id,
            Project.is_general.is_(True),
        )
    )
    if general_id:
        allowed_projects.add(general_id)
    for citation in citations:
        if (
            citation.source_workspace_id != project.workspace_id
            or citation.source_project_id not in allowed_projects
            or citation.federated_grant_id is not None
        ):
            fail(
                400,
                "wiki citations must be local to General/current Project; "
                "federated memory must be transferred first",
            )


def add_revision(
    db: Session,
    auth: Authenticated,
    *,
    project: Project,
    page: WikiPage,
    content: str,
    source: str,
    based_on_revision_id: str | None,
    citations: Iterable[Any],
) -> WikiRevision:
    require_capability(auth, "wiki.write")
    validate_wiki_citations(db, project=project, citations=citations)
    latest = db.scalar(
        select(WikiRevision)
        .where(WikiRevision.page_id == page.id)
        .order_by(WikiRevision.revision_number.desc())
        .limit(1)
    )
    if page.pinned and source == "automatic":
        fail(409, "automatic revisions cannot overwrite a pinned page")
    if based_on_revision_id is not None and (
        latest is None or latest.id != based_on_revision_id
    ):
        fail(409, "wiki revision is based on a stale version")
    revision = WikiRevision(
        page_id=page.id,
        revision_number=1 if latest is None else latest.revision_number + 1,
        content=content,
        source=source,
        authored_by_principal_id=auth.principal.id,
        based_on_revision_id=based_on_revision_id,
    )
    db.add(revision)
    db.flush()
    for item in citations:
        db.add(
            WikiCitation(
                revision_id=revision.id,
                sentence_key=item.sentence_key,
                source_type=item.source_type,
                source_id=item.source_id,
                source_workspace_id=item.source_workspace_id,
                source_project_id=item.source_project_id,
                federated_grant_id=item.federated_grant_id,
            )
        )
    db.flush()
    audit_auth(
        db,
        auth,
        "wiki.revision_created",
        "wiki_revision",
        revision.id,
        workspace_id=project.workspace_id,
        details={"page_id": page.id, "source": source},
    )
    db.commit()
    return revision


def get_revision_view_data(
    db: Session, revision: WikiRevision
) -> tuple[WikiRevision, list[WikiCitation]]:
    citations = list(
        db.scalars(
            select(WikiCitation)
            .where(WikiCitation.revision_id == revision.id)
            .order_by(WikiCitation.sentence_key, WikiCitation.id)
        )
    )
    return revision, citations
