from __future__ import annotations

import datetime as dt
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .ids import uuid7


def new_id() -> str:
    return str(uuid7())


def utcnow() -> dt.datetime:
    # SQLite does not round-trip timezone information consistently. Store UTC.
    return dt.datetime.now(dt.UTC).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


class Timestamped:
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime, nullable=False, default=utcnow
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime, nullable=False, default=utcnow, onupdate=utcnow
    )


class SystemState(Base):
    __tablename__ = "system_state"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    value: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime, nullable=False, default=utcnow
    )


class Principal(Timestamped, Base):
    __tablename__ = "principals"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(320), nullable=False, unique=True)
    display_name: Mapped[str] = mapped_column(String(256), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="human")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")
    password_hash: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        CheckConstraint("kind IN ('human','service')", name="ck_principal_kind"),
        CheckConstraint("status IN ('active','disabled')", name="ck_principal_status"),
    )


class Workspace(Timestamped, Base):
    __tablename__ = "workspaces"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    slug: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False, default="company")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")

    __table_args__ = (
        CheckConstraint("kind IN ('personal','company')", name="ck_workspace_kind"),
        CheckConstraint("status IN ('active','disabled')", name="ck_workspace_status"),
    )


class Peer(Timestamped, Base):
    __tablename__ = "peers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    external_key: Mapped[str] = mapped_column(String(256), nullable=False)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")

    __table_args__ = (
        UniqueConstraint("workspace_id", "external_key", name="uq_peer_external"),
        UniqueConstraint("id", "workspace_id", name="uq_peer_workspace"),
        CheckConstraint(
            "kind IN ('human','agent','service','system')", name="ck_peer_kind"
        ),
        CheckConstraint("status IN ('active','inactive')", name="ck_peer_status"),
    )


class WorkspaceMembership(Timestamped, Base):
    __tablename__ = "workspace_memberships"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    principal_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="RESTRICT"), nullable=False
    )
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")

    __table_args__ = (
        UniqueConstraint(
            "workspace_id", "principal_id", name="uq_membership_principal"
        ),
        CheckConstraint(
            "role IN ('owner','admin','contributor','viewer')",
            name="ck_membership_role",
        ),
        CheckConstraint("status IN ('active','inactive')", name="ck_membership_status"),
    )


class Project(Timestamped, Base):
    __tablename__ = "projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    slug: Mapped[str] = mapped_column(String(128), nullable=False)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    access_policy: Mapped[str] = mapped_column(
        String(16), nullable=False, default="inherited"
    )
    is_general: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    wiki_id: Mapped[str] = mapped_column(
        String(36), nullable=False, unique=True, default=new_id
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")

    __table_args__ = (
        UniqueConstraint("workspace_id", "slug", name="uq_project_slug"),
        UniqueConstraint("id", "workspace_id", name="uq_project_workspace"),
        CheckConstraint(
            "access_policy IN ('inherited','restricted')",
            name="ck_project_access_policy",
        ),
        CheckConstraint("status IN ('active','archived')", name="ck_project_status"),
        Index(
            "uq_project_general_per_workspace",
            "workspace_id",
            unique=True,
            sqlite_where=text("is_general = 1"),
            postgresql_where=text("is_general"),
        ),
    )


class ProjectGrant(Timestamped, Base):
    __tablename__ = "project_grants"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    principal_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="CASCADE"), nullable=False
    )
    capabilities: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    granted_by_principal_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="RESTRICT"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")

    __table_args__ = (
        UniqueConstraint("project_id", "principal_id", name="uq_project_grant"),
        CheckConstraint("status IN ('active','revoked')", name="ck_grant_status"),
    )


class PrincipalPeerLink(Timestamped, Base):
    __tablename__ = "principal_peer_links"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    principal_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="CASCADE"), nullable=False
    )
    peer_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("peers.id", ondelete="RESTRICT"), nullable=False
    )
    kind: Mapped[str] = mapped_column(
        String(32), nullable=False, default="primary_human"
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")

    __table_args__ = (
        UniqueConstraint(
            "workspace_id", "principal_id", "kind", name="uq_principal_peer_kind"
        ),
        UniqueConstraint("workspace_id", "peer_id", name="uq_primary_peer"),
        CheckConstraint("kind = 'primary_human'", name="ck_principal_peer_kind"),
        CheckConstraint(
            "status IN ('active','inactive')", name="ck_principal_peer_status"
        ),
    )


class AgentPeerOwnership(Timestamped, Base):
    __tablename__ = "agent_peer_ownerships"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    agent_peer_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("peers.id", ondelete="RESTRICT"), nullable=False
    )
    owner_principal_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="RESTRICT")
    )
    owner_workspace_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="RESTRICT")
    )
    client: Mapped[str] = mapped_column(String(16), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")

    __table_args__ = (
        UniqueConstraint("workspace_id", "agent_peer_id", name="uq_agent_peer_owner"),
        CheckConstraint(
            "(owner_principal_id IS NOT NULL AND owner_workspace_id IS NULL) OR "
            "(owner_principal_id IS NULL AND owner_workspace_id IS NOT NULL)",
            name="ck_agent_exactly_one_owner",
        ),
        CheckConstraint(
            "client IN ('codex','claude','custom')", name="ck_agent_client"
        ),
        CheckConstraint("status IN ('active','inactive')", name="ck_agent_status"),
    )


class Invitation(Timestamped, Base):
    __tablename__ = "invitations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    email: Mapped[str] = mapped_column(String(320), nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)
    token_prefix: Mapped[str] = mapped_column(String(16), nullable=False, unique=True)
    token_digest: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    invited_by_principal_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="RESTRICT"), nullable=False
    )
    expires_at: Mapped[dt.datetime] = mapped_column(DateTime, nullable=False)
    accepted_at: Mapped[dt.datetime | None] = mapped_column(DateTime)
    accepted_by_principal_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="RESTRICT")
    )
    revoked_at: Mapped[dt.datetime | None] = mapped_column(DateTime)

    __table_args__ = (
        CheckConstraint(
            "role IN ('owner','admin','contributor','viewer')",
            name="ck_invitation_role",
        ),
    )


class Credential(Timestamped, Base):
    __tablename__ = "api_credentials"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    principal_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="CASCADE"), nullable=False
    )
    workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    agent_peer_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("peers.id", ondelete="RESTRICT")
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    token_prefix: Mapped[str] = mapped_column(String(16), nullable=False, unique=True)
    token_digest: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    capabilities: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    project_ids: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    expires_at: Mapped[dt.datetime | None] = mapped_column(DateTime)
    last_used_at: Mapped[dt.datetime | None] = mapped_column(DateTime)
    revoked_at: Mapped[dt.datetime | None] = mapped_column(DateTime)

    __table_args__ = (
        CheckConstraint("kind IN ('api','mcp','recovery')", name="ck_credential_kind"),
    )


class WebSession(Timestamped, Base):
    __tablename__ = "web_sessions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    principal_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="CASCADE"), nullable=False
    )
    token_prefix: Mapped[str] = mapped_column(String(16), nullable=False, unique=True)
    token_digest: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    idle_expires_at: Mapped[dt.datetime] = mapped_column(DateTime, nullable=False)
    absolute_expires_at: Mapped[dt.datetime] = mapped_column(DateTime, nullable=False)
    last_seen_at: Mapped[dt.datetime] = mapped_column(DateTime, nullable=False)
    revoked_at: Mapped[dt.datetime | None] = mapped_column(DateTime)


class AuditEvent(Base):
    __tablename__ = "audit_events"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    workspace_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="SET NULL")
    )
    actor_principal_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="SET NULL")
    )
    actor_credential_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("api_credentials.id", ondelete="SET NULL")
    )
    action: Mapped[str] = mapped_column(String(128), nullable=False)
    target_type: Mapped[str] = mapped_column(String(64), nullable=False)
    target_id: Mapped[str | None] = mapped_column(String(128))
    request_id: Mapped[str] = mapped_column(String(64), nullable=False)
    details: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime, nullable=False, default=utcnow
    )

    __table_args__ = (
        Index("ix_audit_workspace_created", "workspace_id", "created_at"),
    )


class WorkspaceLink(Timestamped, Base):
    __tablename__ = "workspace_links"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    source_workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    target_workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    initiated_by_principal_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="RESTRICT"), nullable=False
    )
    source_approved_by_principal_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="RESTRICT")
    )
    target_approved_by_principal_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="RESTRICT")
    )
    source_approved_at: Mapped[dt.datetime | None] = mapped_column(DateTime)
    target_approved_at: Mapped[dt.datetime | None] = mapped_column(DateTime)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="pending")
    revoked_at: Mapped[dt.datetime | None] = mapped_column(DateTime)

    __table_args__ = (
        UniqueConstraint(
            "source_workspace_id", "target_workspace_id", name="uq_workspace_link"
        ),
        CheckConstraint(
            "source_workspace_id <> target_workspace_id",
            name="ck_workspace_link_distinct",
        ),
        CheckConstraint(
            "status IN ('pending','active','rejected','revoked')",
            name="ck_workspace_link_status",
        ),
    )


class FederatedProjectGrant(Timestamped, Base):
    __tablename__ = "federated_project_grants"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    workspace_link_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspace_links.id", ondelete="CASCADE"), nullable=False
    )
    source_project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    target_workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    capabilities: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    proposed_by_principal_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="RESTRICT"), nullable=False
    )
    accepted_by_principal_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="RESTRICT")
    )
    accepted_at: Mapped[dt.datetime | None] = mapped_column(DateTime)
    status: Mapped[str] = mapped_column(String(24), nullable=False, default="pending")
    revoked_at: Mapped[dt.datetime | None] = mapped_column(DateTime)

    __table_args__ = (
        UniqueConstraint(
            "workspace_link_id", "source_project_id", name="uq_federated_project"
        ),
        CheckConstraint(
            "status IN ('pending','active','rejected','revoked')",
            name="ck_federated_grant_status",
        ),
    )


class FederatedGrantAssignment(Timestamped, Base):
    __tablename__ = "federated_grant_assignments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    federated_grant_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("federated_project_grants.id", ondelete="CASCADE"),
        nullable=False,
    )
    principal_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="CASCADE")
    )
    role: Mapped[str | None] = mapped_column(String(16))
    assigned_by_principal_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="RESTRICT"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="active")

    __table_args__ = (
        CheckConstraint(
            "(principal_id IS NOT NULL AND role IS NULL) OR "
            "(principal_id IS NULL AND role IS NOT NULL)",
            name="ck_federated_assignment_subject",
        ),
        CheckConstraint(
            "role IS NULL OR role IN ('owner','admin','contributor','viewer')",
            name="ck_federated_assignment_role",
        ),
        CheckConstraint(
            "status IN ('active','revoked')", name="ck_federated_assignment_status"
        ),
    )


class TransferRequest(Timestamped, Base):
    __tablename__ = "transfer_requests"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    source_workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="RESTRICT"), nullable=False
    )
    source_project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("projects.id", ondelete="RESTRICT"), nullable=False
    )
    target_workspace_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("workspaces.id", ondelete="RESTRICT"), nullable=False
    )
    target_project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("projects.id", ondelete="RESTRICT"), nullable=False
    )
    requested_by_principal_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="RESTRICT"), nullable=False
    )
    source_record_id: Mapped[str] = mapped_column(String(128), nullable=False)
    source_content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    source_snapshot: Mapped[str] = mapped_column(Text, nullable=False)
    reviewed_content: Mapped[str | None] = mapped_column(Text)
    provenance: Mapped[dict[str, Any]] = mapped_column(
        JSON, nullable=False, default=dict
    )
    source_approved_by_principal_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="RESTRICT")
    )
    target_approved_by_principal_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="RESTRICT")
    )
    source_approved_at: Mapped[dt.datetime | None] = mapped_column(DateTime)
    target_approved_at: Mapped[dt.datetime | None] = mapped_column(DateTime)
    imported_message_id: Mapped[str | None] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="pending_source"
    )
    rejected_by_principal_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="RESTRICT")
    )
    rejection_reason: Mapped[str | None] = mapped_column(Text)

    __table_args__ = (
        UniqueConstraint(
            "source_workspace_id",
            "source_project_id",
            "source_record_id",
            "target_project_id",
            name="uq_transfer_record_target",
        ),
        CheckConstraint(
            "source_workspace_id <> target_workspace_id",
            name="ck_transfer_distinct_workspaces",
        ),
        CheckConstraint(
            "status IN ('pending_source','pending_target','approved',"
            "'completed','rejected')",
            name="ck_transfer_status",
        ),
    )


class WikiPage(Timestamped, Base):
    __tablename__ = "wiki_pages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    wiki_id: Mapped[str] = mapped_column(String(36), nullable=False)
    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("projects.id", ondelete="CASCADE"), nullable=False
    )
    slug: Mapped[str] = mapped_column(String(128), nullable=False)
    title: Mapped[str] = mapped_column(String(256), nullable=False)
    pinned: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    __table_args__ = (
        UniqueConstraint("wiki_id", "slug", name="uq_wiki_page_slug"),
        UniqueConstraint("id", "project_id", name="uq_wiki_page_project"),
    )


class WikiRevision(Base):
    __tablename__ = "wiki_revisions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    page_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("wiki_pages.id", ondelete="CASCADE"), nullable=False
    )
    revision_number: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    source: Mapped[str] = mapped_column(String(16), nullable=False)
    authored_by_principal_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("principals.id", ondelete="SET NULL")
    )
    based_on_revision_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("wiki_revisions.id", ondelete="SET NULL")
    )
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime, nullable=False, default=utcnow
    )

    __table_args__ = (
        UniqueConstraint("page_id", "revision_number", name="uq_wiki_revision"),
        CheckConstraint("source IN ('manual','automatic')", name="ck_wiki_source"),
    )


class WikiCitation(Base):
    __tablename__ = "wiki_citations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    revision_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("wiki_revisions.id", ondelete="CASCADE"), nullable=False
    )
    sentence_key: Mapped[str] = mapped_column(String(128), nullable=False)
    source_type: Mapped[str] = mapped_column(String(16), nullable=False)
    source_id: Mapped[str] = mapped_column(String(128), nullable=False)
    source_workspace_id: Mapped[str] = mapped_column(String(36), nullable=False)
    source_project_id: Mapped[str] = mapped_column(String(36), nullable=False)
    federated_grant_id: Mapped[str | None] = mapped_column(String(36))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime, nullable=False, default=utcnow
    )

    __table_args__ = (
        UniqueConstraint(
            "revision_id",
            "sentence_key",
            "source_type",
            "source_id",
            name="uq_wiki_citation",
        ),
        CheckConstraint(
            "source_type IN ('message','conclusion')", name="ck_citation_type"
        ),
    )
