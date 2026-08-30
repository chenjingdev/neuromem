from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text

from alembic import command

from .config import get_settings
from .db import get_engine

CORE_TABLES = {
    "workspaces",
    "projects",
    "peers",
    "sessions",
    "session_peers",
    "records",
    "record_segments",
    "claims",
    "claim_sources",
    "claim_relations",
    "claim_edges",
    "embedding_profiles",
    "record_embeddings",
    "claim_embeddings",
    "jobs",
}
REQUIRED_INDEXES = {
    "ix_record_embeddings_embedding_hnsw",
    "ix_claim_embeddings_embedding_hnsw",
    "ix_record_segments_content_trgm",
    "ix_claims_content_trgm",
}
REQUIRED_CONSTRAINTS = {
    "uq_claims_project_normalized",
    "uq_records_scope",
    "uq_record_segments_scope",
    "uq_claims_scope",
    "uq_jobs_scope",
}


@dataclass
class SchemaReport:
    ok: bool
    current_revision: str | None
    target_revision: str
    issues: list[str] = field(default_factory=list)


def alembic_config() -> Config:
    root = Path(__file__).resolve().parents[1]
    cfg = Config(str(root / "alembic.ini"))
    cfg.set_main_option("script_location", str(root / "alembic"))
    cfg.set_main_option("sqlalchemy.url", get_settings().database_url)
    return cfg


def resolve_revision(target: str) -> str:
    script = ScriptDirectory.from_config(alembic_config())
    if target == "head":
        head = script.get_current_head()
        if head is None:
            raise RuntimeError("migration head is missing")
        return head
    revision = script.get_revision(target)
    if revision is None:
        raise RuntimeError(f"unknown migration revision: {target}")
    return revision.revision


def upgrade_schema(target: str = "head") -> None:
    command.upgrade(alembic_config(), target)


async def database_is_blank() -> bool:
    async with get_engine().connect() as connection:
        rows = (
            await connection.execute(
                text(
                    """
                    SELECT tablename
                    FROM pg_catalog.pg_tables
                    WHERE schemaname = current_schema()
                      AND tablename = ANY(:tables)
                    """
                ),
                {"tables": sorted(CORE_TABLES | {"alembic_version"})},
            )
        ).scalars()
        return not list(rows)


def initialize_blank_database() -> None:
    cfg = alembic_config()
    cfg.attributes["initialize_blank_only"] = True
    command.upgrade(cfg, "head")


async def verify_schema(target: str = "head") -> SchemaReport:
    target_revision = resolve_revision(target)
    issues: list[str] = []
    async with get_engine().connect() as connection:
        has_version = await connection.scalar(
            text("SELECT to_regclass(current_schema() || '.alembic_version')")
        )
        current_revision = None
        if has_version:
            current_revision = await connection.scalar(
                text("SELECT version_num FROM alembic_version LIMIT 1")
            )
        if current_revision != target_revision:
            issues.append(
                f"schema revision is {current_revision or 'missing'}, "
                f"expected {target_revision}"
            )

        extension_rows = (
            await connection.execute(
                text(
                    "SELECT extname, extversion FROM pg_extension "
                    "WHERE extname IN ('vector','pg_trgm')"
                )
            )
        ).all()
        extensions = {name for name, _version in extension_rows}
        for extension in sorted({"vector", "pg_trgm"} - extensions):
            issues.append(f"extension missing: {extension}")
        vector_version = next(
            (version for name, version in extension_rows if name == "vector"), None
        )
        if vector_version is not None:
            parts = tuple(int(part) for part in vector_version.split(".")[:2])
            if parts < (0, 8):
                issues.append(
                    f"vector extension is {vector_version}, expected at least 0.8"
                )

        tables = set(
            (
                await connection.execute(
                    text(
                        """
                        SELECT tablename FROM pg_catalog.pg_tables
                        WHERE schemaname = current_schema() AND tablename = ANY(:tables)
                        """
                    ),
                    {"tables": sorted(CORE_TABLES)},
                )
            ).scalars()
        )
        for table in sorted(CORE_TABLES - tables):
            issues.append(f"table missing: {table}")

        vector_types = dict(
            (
                await connection.execute(
                    text(
                        """
                        SELECT c.relname, format_type(a.atttypid, a.atttypmod)
                        FROM pg_attribute a
                        JOIN pg_class c ON c.oid = a.attrelid
                        JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = current_schema()
                          AND c.relname IN ('record_embeddings','claim_embeddings')
                          AND a.attname = 'embedding'
                          AND NOT a.attisdropped
                        """
                    )
                )
            ).all()
        )
        for table in ("record_embeddings", "claim_embeddings"):
            if vector_types.get(table) != "halfvec(2560)":
                issues.append(
                    f"{table}.embedding is "
                    f"{vector_types.get(table) or 'missing'}, expected halfvec(2560)"
                )

        indexes = set(
            (
                await connection.execute(
                    text(
                        "SELECT indexname FROM pg_indexes "
                        "WHERE schemaname = current_schema()"
                    )
                )
            ).scalars()
        )
        for index in sorted(REQUIRED_INDEXES - indexes):
            issues.append(f"index missing: {index}")

        constraints = set(
            (
                await connection.execute(
                    text(
                        """
                        SELECT conname
                        FROM pg_constraint c
                        JOIN pg_namespace n ON n.oid = c.connamespace
                        WHERE n.nspname = current_schema()
                        """
                    )
                )
            ).scalars()
        )
        for constraint in sorted(REQUIRED_CONSTRAINTS - constraints):
            issues.append(f"constraint missing: {constraint}")

    return SchemaReport(
        ok=not issues,
        current_revision=current_revision,
        target_revision=target_revision,
        issues=issues,
    )
