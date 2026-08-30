from __future__ import annotations

import datetime as dt
import uuid
from typing import Any

from pgvector.sqlalchemy import HALFVEC
from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from .ids import uuid7


class Base(DeclarativeBase):
    pass


class Timestamped:
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )


class Workspace(Timestamped, Base):
    __tablename__ = "workspaces"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid7
    )
    slug: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    extra_metadata: Mapped[dict[str, Any]] = mapped_column(
        "metadata",
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )


class Project(Timestamped, Base):
    __tablename__ = "projects"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid7
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
    )
    slug: Mapped[str] = mapped_column(String(128), nullable=False)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    extra_metadata: Mapped[dict[str, Any]] = mapped_column(
        "metadata",
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )

    __table_args__ = (
        UniqueConstraint("workspace_id", "slug", name="uq_projects_workspace_slug"),
        UniqueConstraint("id", "workspace_id", name="uq_projects_id_workspace"),
    )


class Peer(Timestamped, Base):
    __tablename__ = "peers"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid7
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
    )
    external_key: Mapped[str] = mapped_column(String(256), nullable=False)
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    kind: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default="human"
    )
    extra_metadata: Mapped[dict[str, Any]] = mapped_column(
        "metadata",
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )

    __table_args__ = (
        UniqueConstraint("workspace_id", "external_key", name="uq_peers_workspace_key"),
        UniqueConstraint("id", "workspace_id", name="uq_peers_id_workspace"),
        CheckConstraint(
            "kind IN ('human','agent','automation','service')", name="ck_peers_kind"
        ),
    )


class Session(Timestamped, Base):
    __tablename__ = "sessions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid7
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    external_key: Mapped[str] = mapped_column(String(512), nullable=False)
    name: Mapped[str] = mapped_column(String(512), nullable=False)
    source_app: Mapped[str | None] = mapped_column(String(64))
    next_record_sequence: Mapped[int] = mapped_column(
        BigInteger, nullable=False, default=1, server_default="1"
    )
    extra_metadata: Mapped[dict[str, Any]] = mapped_column(
        "metadata",
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )

    __table_args__ = (
        ForeignKeyConstraint(
            ["project_id", "workspace_id"],
            ["projects.id", "projects.workspace_id"],
            ondelete="CASCADE",
        ),
        UniqueConstraint(
            "project_id", "external_key", name="uq_sessions_project_external_key"
        ),
        UniqueConstraint("id", "project_id", "workspace_id", name="uq_sessions_scope"),
    )


class SessionPeer(Base):
    __tablename__ = "session_peers"

    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    peer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    role: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default="participant"
    )
    joined_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    left_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        ForeignKeyConstraint(
            ["session_id", "project_id", "workspace_id"],
            ["sessions.id", "sessions.project_id", "sessions.workspace_id"],
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["peer_id", "workspace_id"],
            ["peers.id", "peers.workspace_id"],
            ondelete="CASCADE",
        ),
    )


class Record(Timestamped, Base):
    __tablename__ = "records"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    session_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    author_peer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    sequence: Mapped[int] = mapped_column(BigInteger, nullable=False)
    kind: Mapped[str] = mapped_column(
        String(32), nullable=False, server_default="message"
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    occurred_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    source_app: Mapped[str | None] = mapped_column(String(64))
    extra_metadata: Mapped[dict[str, Any]] = mapped_column(
        "metadata",
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )

    __table_args__ = (
        ForeignKeyConstraint(
            ["session_id", "project_id", "workspace_id"],
            ["sessions.id", "sessions.project_id", "sessions.workspace_id"],
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["author_peer_id", "workspace_id"],
            ["peers.id", "peers.workspace_id"],
        ),
        UniqueConstraint("session_id", "sequence", name="uq_records_session_sequence"),
        UniqueConstraint("id", "project_id", "workspace_id", name="uq_records_scope"),
        CheckConstraint(
            "kind IN ('message','file','commit','tool_result','correction','note')",
            name="ck_records_kind",
        ),
        Index("ix_records_project_created", "project_id", "created_at"),
    )


class RecordSegment(Timestamped, Base):
    __tablename__ = "record_segments"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid7
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    record_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    ordinal: Mapped[int] = mapped_column(Integer, nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    token_start: Mapped[int] = mapped_column(Integer, nullable=False)
    token_end: Mapped[int] = mapped_column(Integer, nullable=False)
    token_count: Mapped[int] = mapped_column(Integer, nullable=False)

    __table_args__ = (
        ForeignKeyConstraint(
            ["record_id", "project_id", "workspace_id"],
            ["records.id", "records.project_id", "records.workspace_id"],
            ondelete="CASCADE",
        ),
        UniqueConstraint("record_id", "ordinal", name="uq_record_segments_ordinal"),
        UniqueConstraint(
            "id", "project_id", "workspace_id", name="uq_record_segments_scope"
        ),
        Index("ix_record_segments_record", "record_id"),
        Index(
            "ix_record_segments_content_trgm",
            "content",
            postgresql_using="gin",
            postgresql_ops={"content": "gin_trgm_ops"},
        ),
    )


class Claim(Timestamped, Base):
    __tablename__ = "claims"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid7
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    asserted_by_peer_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    subject_peer_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    content: Mapped[str] = mapped_column(Text, nullable=False)
    normalized_content: Mapped[str] = mapped_column(Text, nullable=False)
    derivation_method: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(
        String(24), nullable=False, server_default="active"
    )
    occurred_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    valid_from: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    valid_to: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))
    extraction_job_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    candidate_ordinal: Mapped[int | None] = mapped_column(Integer)
    extra_metadata: Mapped[dict[str, Any]] = mapped_column(
        "metadata",
        JSONB,
        nullable=False,
        default=dict,
        server_default=text("'{}'::jsonb"),
    )

    __table_args__ = (
        ForeignKeyConstraint(
            ["project_id", "workspace_id"],
            ["projects.id", "projects.workspace_id"],
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["session_id", "project_id", "workspace_id"],
            ["sessions.id", "sessions.project_id", "sessions.workspace_id"],
        ),
        ForeignKeyConstraint(
            ["asserted_by_peer_id", "workspace_id"],
            ["peers.id", "peers.workspace_id"],
        ),
        ForeignKeyConstraint(
            ["subject_peer_id", "workspace_id"],
            ["peers.id", "peers.workspace_id"],
        ),
        ForeignKeyConstraint(
            ["extraction_job_id", "project_id", "workspace_id"],
            ["jobs.id", "jobs.project_id", "jobs.workspace_id"],
        ),
        UniqueConstraint("id", "project_id", "workspace_id", name="uq_claims_scope"),
        UniqueConstraint(
            "workspace_id",
            "project_id",
            "normalized_content",
            name="uq_claims_project_normalized",
        ),
        UniqueConstraint(
            "extraction_job_id", "candidate_ordinal", name="uq_claims_job_ordinal"
        ),
        CheckConstraint(
            "derivation_method IN ('human','llm_extracted','deductive','inductive')",
            name="ck_claims_derivation",
        ),
        CheckConstraint(
            "status IN ('proposed','active','superseded','rejected','disputed')",
            name="ck_claims_status",
        ),
        Index("ix_claims_project_status_created", "project_id", "status", "created_at"),
        Index(
            "ix_claims_content_trgm",
            "content",
            postgresql_using="gin",
            postgresql_ops={"content": "gin_trgm_ops"},
        ),
    )


class ClaimSource(Base):
    __tablename__ = "claim_sources"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid7
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    claim_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    record_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    segment_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    role: Mapped[str] = mapped_column(
        String(24), nullable=False, server_default="states"
    )
    quote: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        ForeignKeyConstraint(
            ["claim_id", "project_id", "workspace_id"],
            ["claims.id", "claims.project_id", "claims.workspace_id"],
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["record_id", "project_id", "workspace_id"],
            ["records.id", "records.project_id", "records.workspace_id"],
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["segment_id", "project_id", "workspace_id"],
            [
                "record_segments.id",
                "record_segments.project_id",
                "record_segments.workspace_id",
            ],
        ),
        UniqueConstraint(
            "claim_id", "record_id", "segment_id", "role", name="uq_claim_source"
        ),
        Index(
            "uq_claim_source_null_safe",
            "claim_id",
            "record_id",
            "segment_id",
            "role",
            unique=True,
            postgresql_nulls_not_distinct=True,
        ),
        CheckConstraint(
            "role IN ('states','supports','contradicts','corrects','derived_from')",
            name="ck_claim_sources_role",
        ),
    )


class ClaimRelation(Base):
    __tablename__ = "claim_relations"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid7
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    source_claim_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    target_claim_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), nullable=False
    )
    relation: Mapped[str] = mapped_column(String(32), nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        ForeignKeyConstraint(
            ["source_claim_id", "project_id", "workspace_id"],
            ["claims.id", "claims.project_id", "claims.workspace_id"],
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["target_claim_id", "project_id", "workspace_id"],
            ["claims.id", "claims.project_id", "claims.workspace_id"],
            ondelete="CASCADE",
        ),
        UniqueConstraint(
            "source_claim_id", "target_claim_id", "relation", name="uq_claim_relation"
        ),
        CheckConstraint(
            "relation IN ('equivalent_to','supports','contradicts','supersedes',"
            "'retracts','refines','derived_from')",
            name="ck_claim_relations_type",
        ),
    )


class ClaimEdge(Base):
    __tablename__ = "claim_edges"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid7
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    claim_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    subject_type: Mapped[str] = mapped_column(String(32), nullable=False)
    subject_key: Mapped[str] = mapped_column(String(512), nullable=False)
    subject_label: Mapped[str] = mapped_column(String(512), nullable=False)
    predicate: Mapped[str] = mapped_column(String(128), nullable=False)
    object_type: Mapped[str] = mapped_column(String(32), nullable=False)
    object_key: Mapped[str] = mapped_column(String(512), nullable=False)
    object_label: Mapped[str] = mapped_column(String(512), nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        ForeignKeyConstraint(
            ["claim_id", "project_id", "workspace_id"],
            ["claims.id", "claims.project_id", "claims.workspace_id"],
            ondelete="CASCADE",
        ),
        UniqueConstraint(
            "claim_id", "subject_key", "predicate", "object_key", name="uq_claim_edge"
        ),
        Index("ix_claim_edges_project", "project_id"),
    )


class EmbeddingProfile(Timestamped, Base):
    __tablename__ = "embedding_profiles"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid7
    )
    name: Mapped[str] = mapped_column(String(128), nullable=False, unique=True)
    model: Mapped[str] = mapped_column(String(256), nullable=False)
    dimensions: Mapped[int] = mapped_column(Integer, nullable=False)
    storage: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="halfvec"
    )
    normalized: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default="true"
    )
    query_instruction: Mapped[str | None] = mapped_column(Text)
    active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="true")

    __table_args__ = (
        CheckConstraint("dimensions = 2560", name="ck_embedding_profiles_dimensions"),
        CheckConstraint("storage = 'halfvec'", name="ck_embedding_profiles_storage"),
    )


class RecordEmbedding(Base):
    __tablename__ = "record_embeddings"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid7
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    record_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    segment_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    profile_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("embedding_profiles.id"), nullable=False
    )
    embedding: Mapped[Any] = mapped_column(HALFVEC(2560), nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        ForeignKeyConstraint(
            ["record_id", "project_id", "workspace_id"],
            ["records.id", "records.project_id", "records.workspace_id"],
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["segment_id", "project_id", "workspace_id"],
            [
                "record_segments.id",
                "record_segments.project_id",
                "record_segments.workspace_id",
            ],
            ondelete="CASCADE",
        ),
        UniqueConstraint("segment_id", "profile_id", name="uq_record_embedding"),
        Index("ix_record_embeddings_scope", "workspace_id", "project_id", "profile_id"),
        Index(
            "ix_record_embeddings_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_with={"m": 16, "ef_construction": 64},
            postgresql_ops={"embedding": "halfvec_cosine_ops"},
        ),
    )


class ClaimEmbedding(Base):
    __tablename__ = "claim_embeddings"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid7
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    claim_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    profile_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("embedding_profiles.id"), nullable=False
    )
    embedding: Mapped[Any] = mapped_column(HALFVEC(2560), nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (
        ForeignKeyConstraint(
            ["claim_id", "project_id", "workspace_id"],
            ["claims.id", "claims.project_id", "claims.workspace_id"],
            ondelete="CASCADE",
        ),
        UniqueConstraint("claim_id", "profile_id", name="uq_claim_embedding"),
        Index("ix_claim_embeddings_scope", "workspace_id", "project_id", "profile_id"),
        Index(
            "ix_claim_embeddings_embedding_hnsw",
            "embedding",
            postgresql_using="hnsw",
            postgresql_with={"m": 16, "ef_construction": 64},
            postgresql_ops={"embedding": "halfvec_cosine_ops"},
        ),
    )


class Job(Timestamped, Base):
    __tablename__ = "jobs"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid7
    )
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        nullable=False,
    )
    project_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    kind: Mapped[str] = mapped_column(String(32), nullable=False)
    dedupe_key: Mapped[str] = mapped_column(String(512), nullable=False, unique=True)
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(
        String(16), nullable=False, server_default="pending"
    )
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    max_attempts: Mapped[int] = mapped_column(
        Integer, nullable=False, server_default="12"
    )
    run_after: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    lease_owner: Mapped[str | None] = mapped_column(String(256))
    lease_expires_at: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True)
    )
    last_error: Mapped[str | None] = mapped_column(Text)
    completed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        ForeignKeyConstraint(
            ["project_id", "workspace_id"],
            ["projects.id", "projects.workspace_id"],
            ondelete="CASCADE",
        ),
        ForeignKeyConstraint(
            ["session_id", "project_id", "workspace_id"],
            ["sessions.id", "sessions.project_id", "sessions.workspace_id"],
        ),
        UniqueConstraint("id", "project_id", "workspace_id", name="uq_jobs_scope"),
        CheckConstraint(
            "kind IN ('embed_record','extract_claims','embed_claim')",
            name="ck_jobs_kind",
        ),
        CheckConstraint(
            "status IN ('pending','running','retry','failed','done')",
            name="ck_jobs_status",
        ),
        Index("ix_jobs_runnable", "status", "run_after", "lease_expires_at"),
        Index("ix_jobs_project_status", "project_id", "status"),
    )
