from __future__ import annotations

import datetime as dt
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, EmailStr, Field, model_validator

Role = Literal["owner", "admin", "contributor", "viewer"]
WorkspaceKind = Literal["personal", "company"]
AgentClient = Literal["codex", "claude", "custom"]


class APIModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class PrincipalView(APIModel):
    id: str
    email: str
    display_name: str
    kind: str
    status: str


class WorkspaceCreate(BaseModel):
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,126}[a-z0-9]$")
    name: str = Field(min_length=1, max_length=256)
    kind: WorkspaceKind = "company"


class WorkspaceView(APIModel):
    id: str
    slug: str
    name: str
    kind: str
    status: str
    created_at: dt.datetime


class ProjectCreate(BaseModel):
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$|^[a-z0-9]$")
    name: str = Field(min_length=1, max_length=256)
    access_policy: Literal["inherited", "restricted"] = "inherited"


class ProjectView(APIModel):
    id: str
    workspace_id: str
    slug: str
    name: str
    access_policy: str
    is_general: bool
    wiki_id: str
    status: str


class MembershipView(APIModel):
    id: str
    workspace_id: str
    principal_id: str
    role: str
    status: str


class MembershipUpdate(BaseModel):
    role: Role | None = None
    status: Literal["active", "inactive"] | None = None


class ProjectGrantUpsert(BaseModel):
    principal_id: str
    capabilities: list[str] = Field(default_factory=lambda: ["project.read"])


class ProjectGrantView(APIModel):
    id: str
    project_id: str
    principal_id: str
    capabilities: list[str]
    granted_by_principal_id: str
    status: str


class PeerView(APIModel):
    id: str
    workspace_id: str
    external_key: str
    name: str
    kind: str
    status: str


class PeerBindingView(BaseModel):
    principal_id: str | None
    peer: PeerView
    kind: str
    client: str | None = None
    owner_principal_id: str | None = None
    owner_workspace_id: str | None = None
    status: str


class AgentPeerCreate(BaseModel):
    name: str = Field(min_length=1, max_length=256)
    client: AgentClient
    owner: Literal["principal", "workspace"] = "principal"


class AgentPeerView(BaseModel):
    peer: PeerView
    ownership_id: str
    owner_principal_id: str | None
    owner_workspace_id: str | None
    client: str
    status: str


class AgentPeerTransfer(BaseModel):
    owner_principal_id: str | None = None
    owner_workspace_id: str | None = None

    @model_validator(mode="after")
    def one_owner(self) -> AgentPeerTransfer:
        if (self.owner_principal_id is None) == (self.owner_workspace_id is None):
            raise ValueError("exactly one owner must be supplied")
        return self


class InvitationCreate(BaseModel):
    email: EmailStr
    role: Role = "contributor"


class InvitationView(APIModel):
    id: str
    workspace_id: str
    email: str
    role: str
    token_prefix: str
    expires_at: dt.datetime
    accepted_at: dt.datetime | None
    revoked_at: dt.datetime | None


class InvitationCreated(BaseModel):
    invitation: InvitationView
    token: str


class InvitationAccept(BaseModel):
    token: str = Field(min_length=32)
    display_name: str = Field(min_length=1, max_length=256)
    password: str = Field(min_length=12, max_length=1024)


class InvitationAccepted(BaseModel):
    principal: PrincipalView
    workspace: WorkspaceView
    general_project: ProjectView
    human_peer: PeerView
    recovery_credential: CredentialCreated
    context: AuthContext


class CredentialCreate(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    kind: Literal["api", "mcp", "recovery"] = "api"
    capabilities: list[str] = Field(default_factory=list)
    project_ids: list[str] = Field(default_factory=list)
    agent_peer_id: str | None = None
    expires_in_seconds: int | None = Field(default=None, ge=60, le=365 * 86400)


class CredentialView(APIModel):
    id: str
    principal_id: str
    workspace_id: str
    agent_peer_id: str | None
    name: str
    kind: str
    token_prefix: str
    capabilities: list[str]
    project_ids: list[str]
    expires_at: dt.datetime | None
    last_used_at: dt.datetime | None
    revoked_at: dt.datetime | None


class CredentialCreated(BaseModel):
    credential: CredentialView
    token: str


class AuthContext(BaseModel):
    principal_id: str
    credential_id: str | None
    workspace_id: str | None
    project_id: str | None
    human_peer_id: str | None
    agent_peer_id: str | None
    capabilities: list[str]
    request_id: str


class AuthEnvelope(BaseModel):
    principal: PrincipalView
    context: AuthContext


class BootstrapRequest(BaseModel):
    email: EmailStr
    display_name: str = Field(min_length=1, max_length=256)
    password: str = Field(min_length=12, max_length=1024)
    workspace_slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{1,126}[a-z0-9]$")
    workspace_name: str = Field(min_length=1, max_length=256)


class BootstrapResponse(BaseModel):
    principal: PrincipalView
    workspace: WorkspaceView
    general_project: ProjectView
    human_peer: PeerView
    recovery_credential: CredentialCreated
    context: AuthContext


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class WorkspaceLinkCreate(BaseModel):
    source_workspace_id: str
    target_workspace_id: str


class WorkspaceLinkView(APIModel):
    id: str
    source_workspace_id: str
    target_workspace_id: str
    initiated_by_principal_id: str
    source_approved_by_principal_id: str | None
    target_approved_by_principal_id: str | None
    source_approved_at: dt.datetime | None
    target_approved_at: dt.datetime | None
    status: str
    revoked_at: dt.datetime | None


class FederatedGrantCreate(BaseModel):
    workspace_link_id: str
    source_project_id: str
    capabilities: list[Literal["search", "read_source"]] = Field(
        default_factory=lambda: ["search"]
    )


class FederatedGrantView(APIModel):
    id: str
    workspace_link_id: str
    source_project_id: str
    target_workspace_id: str
    capabilities: list[str]
    proposed_by_principal_id: str
    accepted_by_principal_id: str | None
    accepted_at: dt.datetime | None
    status: str
    revoked_at: dt.datetime | None


class FederatedAssignmentCreate(BaseModel):
    principal_id: str | None = None
    role: Role | None = None

    @model_validator(mode="after")
    def one_subject(self) -> FederatedAssignmentCreate:
        if (self.principal_id is None) == (self.role is None):
            raise ValueError("exactly one assignment subject must be supplied")
        return self


class FederatedAssignmentView(APIModel):
    id: str
    federated_grant_id: str
    principal_id: str | None
    role: str | None
    assigned_by_principal_id: str
    status: str


class TransferCreate(BaseModel):
    source_workspace_id: str
    source_project_id: str
    target_workspace_id: str
    target_project_id: str
    source_record_id: str = Field(min_length=1, max_length=128)
    source_content_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    source_snapshot: str = Field(min_length=1)
    provenance: dict[str, Any] = Field(default_factory=dict)


class TransferApprove(BaseModel):
    reviewed_content: str | None = None


class TransferReject(BaseModel):
    reason: str = Field(min_length=1, max_length=2000)


class TransferComplete(BaseModel):
    imported_message_id: str = Field(min_length=1, max_length=128)


class TransferView(APIModel):
    id: str
    source_workspace_id: str
    source_project_id: str
    target_workspace_id: str
    target_project_id: str
    requested_by_principal_id: str
    source_record_id: str
    source_content_hash: str
    source_snapshot: str
    reviewed_content: str | None
    provenance: dict[str, Any]
    source_approved_by_principal_id: str | None
    target_approved_by_principal_id: str | None
    imported_message_id: str | None
    status: str
    rejection_reason: str | None


class WikiCitationCreate(BaseModel):
    sentence_key: str = Field(min_length=1, max_length=128)
    source_type: Literal["message", "conclusion"]
    source_id: str = Field(min_length=1, max_length=128)
    source_workspace_id: str
    source_project_id: str
    federated_grant_id: str | None = None


class WikiCitationView(APIModel):
    id: str
    revision_id: str
    sentence_key: str
    source_type: str
    source_id: str
    source_workspace_id: str
    source_project_id: str
    federated_grant_id: str | None


class WikiRevisionCreate(BaseModel):
    content: str = Field(min_length=1)
    source: Literal["manual", "automatic"] = "manual"
    based_on_revision_id: str | None = None
    citations: list[WikiCitationCreate] = Field(default_factory=list)


class WikiRevisionView(APIModel):
    id: str
    page_id: str
    revision_number: int
    content: str
    source: str
    authored_by_principal_id: str | None
    based_on_revision_id: str | None
    created_at: dt.datetime
    citations: list[WikiCitationView] = Field(default_factory=list)


class WikiPageCreate(BaseModel):
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{0,126}[a-z0-9]$|^[a-z0-9]$")
    title: str = Field(min_length=1, max_length=256)
    content: str = Field(min_length=1)
    source: Literal["manual", "automatic"] = "manual"
    pinned: bool = False
    citations: list[WikiCitationCreate] = Field(default_factory=list)


class WikiPageView(APIModel):
    id: str
    wiki_id: str
    project_id: str
    slug: str
    title: str
    pinned: bool
    latest_revision: WikiRevisionView | None = None


class WikiView(BaseModel):
    wiki_id: str
    project_id: str
    pages: list[WikiPageView]


class AuditEventView(APIModel):
    id: str
    workspace_id: str | None
    actor_principal_id: str | None
    actor_credential_id: str | None
    action: str
    target_type: str
    target_id: str | None
    request_id: str
    details: dict[str, Any]
    created_at: dt.datetime


class InternalContextTokenRequest(BaseModel):
    workspace_id: str
    project_id: str | None = None
    requested_capabilities: list[str] = Field(default_factory=list)


class InternalContextTokenResponse(BaseModel):
    token: str
    expires_at: dt.datetime
    context: AuthContext
