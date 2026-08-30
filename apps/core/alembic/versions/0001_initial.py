"""Create the fixed Neuromem core schema."""

from __future__ import annotations

import sqlalchemy as sa
from pgvector.sqlalchemy import HALFVEC
from sqlalchemy.dialects import postgresql

from alembic import op

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None

UUID = postgresql.UUID(as_uuid=True)
JSON = postgresql.JSONB(astext_type=sa.Text())


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    ]


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.create_table(
        "workspaces",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("slug", sa.String(128), nullable=False),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column(
            "metadata", JSON, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        *_timestamps(),
        sa.UniqueConstraint("slug", name="uq_workspaces_slug"),
    )
    op.create_table(
        "projects",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("workspace_id", UUID, nullable=False),
        sa.Column("slug", sa.String(128), nullable=False),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column(
            "metadata", JSON, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        *_timestamps(),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            ondelete="CASCADE",
            name="fk_projects_workspace",
        ),
        sa.UniqueConstraint("workspace_id", "slug", name="uq_projects_workspace_slug"),
        sa.UniqueConstraint("id", "workspace_id", name="uq_projects_id_workspace"),
    )
    op.create_table(
        "peers",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("workspace_id", UUID, nullable=False),
        sa.Column("external_key", sa.String(256), nullable=False),
        sa.Column("name", sa.String(256), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False, server_default="human"),
        sa.Column(
            "metadata", JSON, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        *_timestamps(),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            ondelete="CASCADE",
            name="fk_peers_workspace",
        ),
        sa.UniqueConstraint(
            "workspace_id", "external_key", name="uq_peers_workspace_key"
        ),
        sa.UniqueConstraint("id", "workspace_id", name="uq_peers_id_workspace"),
        sa.CheckConstraint(
            "kind IN ('human','agent','automation','service')", name="ck_peers_kind"
        ),
    )
    op.create_table(
        "sessions",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("workspace_id", UUID, nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("external_key", sa.String(512), nullable=False),
        sa.Column("name", sa.String(512), nullable=False),
        sa.Column("source_app", sa.String(64)),
        sa.Column(
            "next_record_sequence", sa.BigInteger(), nullable=False, server_default="1"
        ),
        sa.Column(
            "metadata", JSON, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        *_timestamps(),
        sa.ForeignKeyConstraint(
            ["project_id", "workspace_id"],
            ["projects.id", "projects.workspace_id"],
            ondelete="CASCADE",
            name="fk_sessions_project_scope",
        ),
        sa.UniqueConstraint(
            "project_id", "external_key", name="uq_sessions_project_external_key"
        ),
        sa.UniqueConstraint(
            "id", "project_id", "workspace_id", name="uq_sessions_scope"
        ),
    )
    op.create_table(
        "session_peers",
        sa.Column("session_id", UUID, nullable=False),
        sa.Column("peer_id", UUID, nullable=False),
        sa.Column("workspace_id", UUID, nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("role", sa.String(32), nullable=False, server_default="participant"),
        sa.Column(
            "joined_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("left_at", sa.DateTime(timezone=True)),
        sa.PrimaryKeyConstraint("session_id", "peer_id", name="pk_session_peers"),
        sa.ForeignKeyConstraint(
            ["session_id", "project_id", "workspace_id"],
            ["sessions.id", "sessions.project_id", "sessions.workspace_id"],
            ondelete="CASCADE",
            name="fk_session_peers_session_scope",
        ),
        sa.ForeignKeyConstraint(
            ["peer_id", "workspace_id"],
            ["peers.id", "peers.workspace_id"],
            ondelete="CASCADE",
            name="fk_session_peers_peer_scope",
        ),
    )
    op.create_table(
        "records",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("workspace_id", UUID, nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("session_id", UUID, nullable=False),
        sa.Column("author_peer_id", UUID, nullable=False),
        sa.Column("sequence", sa.BigInteger(), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False, server_default="message"),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("source_app", sa.String(64)),
        sa.Column(
            "metadata", JSON, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        *_timestamps(),
        sa.ForeignKeyConstraint(
            ["session_id", "project_id", "workspace_id"],
            ["sessions.id", "sessions.project_id", "sessions.workspace_id"],
            ondelete="CASCADE",
            name="fk_records_session_scope",
        ),
        sa.ForeignKeyConstraint(
            ["author_peer_id", "workspace_id"],
            ["peers.id", "peers.workspace_id"],
            name="fk_records_author_scope",
        ),
        sa.UniqueConstraint(
            "session_id", "sequence", name="uq_records_session_sequence"
        ),
        sa.UniqueConstraint(
            "id", "project_id", "workspace_id", name="uq_records_scope"
        ),
        sa.CheckConstraint(
            "kind IN ('message','file','commit','tool_result','correction','note')",
            name="ck_records_kind",
        ),
    )
    op.create_index(
        "ix_records_project_created", "records", ["project_id", "created_at"]
    )
    op.create_table(
        "record_segments",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("workspace_id", UUID, nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("record_id", UUID, nullable=False),
        sa.Column("ordinal", sa.Integer(), nullable=False),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("content_hash", sa.String(64), nullable=False),
        sa.Column("token_start", sa.Integer(), nullable=False),
        sa.Column("token_end", sa.Integer(), nullable=False),
        sa.Column("token_count", sa.Integer(), nullable=False),
        *_timestamps(),
        sa.ForeignKeyConstraint(
            ["record_id", "project_id", "workspace_id"],
            ["records.id", "records.project_id", "records.workspace_id"],
            ondelete="CASCADE",
            name="fk_record_segments_record_scope",
        ),
        sa.UniqueConstraint("record_id", "ordinal", name="uq_record_segments_ordinal"),
        sa.UniqueConstraint(
            "id", "project_id", "workspace_id", name="uq_record_segments_scope"
        ),
    )
    op.create_index("ix_record_segments_record", "record_segments", ["record_id"])
    op.create_index(
        "ix_record_segments_content_trgm",
        "record_segments",
        ["content"],
        postgresql_using="gin",
        postgresql_ops={"content": "gin_trgm_ops"},
    )
    op.create_table(
        "embedding_profiles",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("model", sa.String(256), nullable=False),
        sa.Column("dimensions", sa.Integer(), nullable=False),
        sa.Column("storage", sa.String(16), nullable=False, server_default="halfvec"),
        sa.Column(
            "normalized", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        sa.Column("query_instruction", sa.Text()),
        sa.Column(
            "active", sa.Boolean(), nullable=False, server_default=sa.text("true")
        ),
        *_timestamps(),
        sa.UniqueConstraint("name", name="uq_embedding_profiles_name"),
        sa.CheckConstraint(
            "dimensions = 2560", name="ck_embedding_profiles_dimensions"
        ),
        sa.CheckConstraint("storage = 'halfvec'", name="ck_embedding_profiles_storage"),
    )
    op.create_table(
        "jobs",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("workspace_id", UUID, nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("session_id", UUID),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("dedupe_key", sa.String(512), nullable=False),
        sa.Column("payload", JSON, nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="12"),
        sa.Column(
            "run_after",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("lease_owner", sa.String(256)),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True)),
        sa.Column("last_error", sa.Text()),
        sa.Column("completed_at", sa.DateTime(timezone=True)),
        *_timestamps(),
        sa.ForeignKeyConstraint(
            ["workspace_id"],
            ["workspaces.id"],
            ondelete="CASCADE",
            name="fk_jobs_workspace",
        ),
        sa.ForeignKeyConstraint(
            ["project_id", "workspace_id"],
            ["projects.id", "projects.workspace_id"],
            ondelete="CASCADE",
            name="fk_jobs_project_scope",
        ),
        sa.ForeignKeyConstraint(
            ["session_id", "project_id", "workspace_id"],
            ["sessions.id", "sessions.project_id", "sessions.workspace_id"],
            name="fk_jobs_session_scope",
        ),
        sa.UniqueConstraint("dedupe_key", name="uq_jobs_dedupe_key"),
        sa.UniqueConstraint("id", "project_id", "workspace_id", name="uq_jobs_scope"),
        sa.CheckConstraint(
            "kind IN ('embed_record','extract_claims','embed_claim')",
            name="ck_jobs_kind",
        ),
        sa.CheckConstraint(
            "status IN ('pending','running','retry','failed','done')",
            name="ck_jobs_status",
        ),
    )
    op.create_index(
        "ix_jobs_runnable", "jobs", ["status", "run_after", "lease_expires_at"]
    )
    op.create_index("ix_jobs_project_status", "jobs", ["project_id", "status"])
    op.create_table(
        "claims",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("workspace_id", UUID, nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("session_id", UUID),
        sa.Column("asserted_by_peer_id", UUID),
        sa.Column("subject_peer_id", UUID),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("normalized_content", sa.Text(), nullable=False),
        sa.Column("derivation_method", sa.String(32), nullable=False),
        sa.Column("status", sa.String(24), nullable=False, server_default="active"),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("valid_from", sa.DateTime(timezone=True)),
        sa.Column("valid_to", sa.DateTime(timezone=True)),
        sa.Column("extraction_job_id", UUID),
        sa.Column("candidate_ordinal", sa.Integer()),
        sa.Column(
            "metadata", JSON, nullable=False, server_default=sa.text("'{}'::jsonb")
        ),
        *_timestamps(),
        sa.ForeignKeyConstraint(
            ["project_id", "workspace_id"],
            ["projects.id", "projects.workspace_id"],
            ondelete="CASCADE",
            name="fk_claims_project_scope",
        ),
        sa.ForeignKeyConstraint(
            ["session_id", "project_id", "workspace_id"],
            ["sessions.id", "sessions.project_id", "sessions.workspace_id"],
            name="fk_claims_session_scope",
        ),
        sa.ForeignKeyConstraint(
            ["asserted_by_peer_id", "workspace_id"],
            ["peers.id", "peers.workspace_id"],
            name="fk_claims_asserted_by_scope",
        ),
        sa.ForeignKeyConstraint(
            ["subject_peer_id", "workspace_id"],
            ["peers.id", "peers.workspace_id"],
            name="fk_claims_subject_scope",
        ),
        sa.ForeignKeyConstraint(
            ["extraction_job_id", "project_id", "workspace_id"],
            ["jobs.id", "jobs.project_id", "jobs.workspace_id"],
            name="fk_claims_extraction_job_scope",
        ),
        sa.UniqueConstraint("id", "project_id", "workspace_id", name="uq_claims_scope"),
        sa.UniqueConstraint(
            "workspace_id",
            "project_id",
            "normalized_content",
            name="uq_claims_project_normalized",
        ),
        sa.UniqueConstraint(
            "extraction_job_id", "candidate_ordinal", name="uq_claims_job_ordinal"
        ),
        sa.CheckConstraint(
            "derivation_method IN ('human','llm_extracted','deductive','inductive')",
            name="ck_claims_derivation",
        ),
        sa.CheckConstraint(
            "status IN ('proposed','active','superseded','rejected','disputed')",
            name="ck_claims_status",
        ),
    )
    op.create_index(
        "ix_claims_project_status_created",
        "claims",
        ["project_id", "status", "created_at"],
    )
    op.create_index(
        "ix_claims_content_trgm",
        "claims",
        ["content"],
        postgresql_using="gin",
        postgresql_ops={"content": "gin_trgm_ops"},
    )
    op.create_table(
        "claim_sources",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("workspace_id", UUID, nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("claim_id", UUID, nullable=False),
        sa.Column("record_id", UUID, nullable=False),
        sa.Column("segment_id", UUID),
        sa.Column("role", sa.String(24), nullable=False, server_default="states"),
        sa.Column("quote", sa.Text()),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["claim_id", "project_id", "workspace_id"],
            ["claims.id", "claims.project_id", "claims.workspace_id"],
            ondelete="CASCADE",
            name="fk_claim_sources_claim_scope",
        ),
        sa.ForeignKeyConstraint(
            ["record_id", "project_id", "workspace_id"],
            ["records.id", "records.project_id", "records.workspace_id"],
            ondelete="CASCADE",
            name="fk_claim_sources_record_scope",
        ),
        sa.ForeignKeyConstraint(
            ["segment_id", "project_id", "workspace_id"],
            [
                "record_segments.id",
                "record_segments.project_id",
                "record_segments.workspace_id",
            ],
            name="fk_claim_sources_segment_scope",
        ),
        sa.UniqueConstraint(
            "claim_id", "record_id", "segment_id", "role", name="uq_claim_source"
        ),
        sa.CheckConstraint(
            "role IN ('states','supports','contradicts','corrects','derived_from')",
            name="ck_claim_sources_role",
        ),
    )
    op.create_index(
        "uq_claim_source_null_safe",
        "claim_sources",
        ["claim_id", "record_id", "segment_id", "role"],
        unique=True,
        postgresql_nulls_not_distinct=True,
    )
    op.create_table(
        "claim_relations",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("workspace_id", UUID, nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("source_claim_id", UUID, nullable=False),
        sa.Column("target_claim_id", UUID, nullable=False),
        sa.Column("relation", sa.String(32), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["source_claim_id", "project_id", "workspace_id"],
            ["claims.id", "claims.project_id", "claims.workspace_id"],
            ondelete="CASCADE",
            name="fk_claim_relations_source_scope",
        ),
        sa.ForeignKeyConstraint(
            ["target_claim_id", "project_id", "workspace_id"],
            ["claims.id", "claims.project_id", "claims.workspace_id"],
            ondelete="CASCADE",
            name="fk_claim_relations_target_scope",
        ),
        sa.UniqueConstraint(
            "source_claim_id", "target_claim_id", "relation", name="uq_claim_relation"
        ),
        sa.CheckConstraint(
            "relation IN ('equivalent_to','supports','contradicts','supersedes',"
            "'retracts','refines','derived_from')",
            name="ck_claim_relations_type",
        ),
    )
    op.create_table(
        "claim_edges",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("workspace_id", UUID, nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("claim_id", UUID, nullable=False),
        sa.Column("subject_type", sa.String(32), nullable=False),
        sa.Column("subject_key", sa.String(512), nullable=False),
        sa.Column("subject_label", sa.String(512), nullable=False),
        sa.Column("predicate", sa.String(128), nullable=False),
        sa.Column("object_type", sa.String(32), nullable=False),
        sa.Column("object_key", sa.String(512), nullable=False),
        sa.Column("object_label", sa.String(512), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["claim_id", "project_id", "workspace_id"],
            ["claims.id", "claims.project_id", "claims.workspace_id"],
            ondelete="CASCADE",
            name="fk_claim_edges_claim_scope",
        ),
        sa.UniqueConstraint(
            "claim_id", "subject_key", "predicate", "object_key", name="uq_claim_edge"
        ),
    )
    op.create_index("ix_claim_edges_project", "claim_edges", ["project_id"])
    op.create_table(
        "record_embeddings",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("workspace_id", UUID, nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("record_id", UUID, nullable=False),
        sa.Column("segment_id", UUID, nullable=False),
        sa.Column("profile_id", UUID, nullable=False),
        sa.Column("embedding", HALFVEC(2560), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["record_id", "project_id", "workspace_id"],
            ["records.id", "records.project_id", "records.workspace_id"],
            ondelete="CASCADE",
            name="fk_record_embeddings_record_scope",
        ),
        sa.ForeignKeyConstraint(
            ["segment_id", "project_id", "workspace_id"],
            [
                "record_segments.id",
                "record_segments.project_id",
                "record_segments.workspace_id",
            ],
            ondelete="CASCADE",
            name="fk_record_embeddings_segment_scope",
        ),
        sa.ForeignKeyConstraint(
            ["profile_id"],
            ["embedding_profiles.id"],
            name="fk_record_embeddings_profile",
        ),
        sa.UniqueConstraint("segment_id", "profile_id", name="uq_record_embedding"),
    )
    op.create_index(
        "ix_record_embeddings_scope",
        "record_embeddings",
        ["workspace_id", "project_id", "profile_id"],
    )
    op.create_index(
        "ix_record_embeddings_embedding_hnsw",
        "record_embeddings",
        ["embedding"],
        postgresql_using="hnsw",
        postgresql_with={"m": 16, "ef_construction": 64},
        postgresql_ops={"embedding": "halfvec_cosine_ops"},
    )
    op.create_table(
        "claim_embeddings",
        sa.Column("id", UUID, primary_key=True),
        sa.Column("workspace_id", UUID, nullable=False),
        sa.Column("project_id", UUID, nullable=False),
        sa.Column("claim_id", UUID, nullable=False),
        sa.Column("profile_id", UUID, nullable=False),
        sa.Column("embedding", HALFVEC(2560), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.ForeignKeyConstraint(
            ["claim_id", "project_id", "workspace_id"],
            ["claims.id", "claims.project_id", "claims.workspace_id"],
            ondelete="CASCADE",
            name="fk_claim_embeddings_claim_scope",
        ),
        sa.ForeignKeyConstraint(
            ["profile_id"],
            ["embedding_profiles.id"],
            name="fk_claim_embeddings_profile",
        ),
        sa.UniqueConstraint("claim_id", "profile_id", name="uq_claim_embedding"),
    )
    op.create_index(
        "ix_claim_embeddings_scope",
        "claim_embeddings",
        ["workspace_id", "project_id", "profile_id"],
    )
    op.create_index(
        "ix_claim_embeddings_embedding_hnsw",
        "claim_embeddings",
        ["embedding"],
        postgresql_using="hnsw",
        postgresql_with={"m": 16, "ef_construction": 64},
        postgresql_ops={"embedding": "halfvec_cosine_ops"},
    )


def downgrade() -> None:
    op.drop_table("claim_embeddings")
    op.drop_table("record_embeddings")
    op.drop_table("claim_edges")
    op.drop_table("claim_relations")
    op.drop_table("claim_sources")
    op.drop_table("claims")
    op.drop_table("jobs")
    op.drop_table("embedding_profiles")
    op.drop_table("record_segments")
    op.drop_table("records")
    op.drop_table("session_peers")
    op.drop_table("sessions")
    op.drop_table("peers")
    op.drop_table("projects")
    op.drop_table("workspaces")
