from __future__ import annotations

import uuid
from pathlib import Path

import pytest
from pydantic import ValidationError

from neuromem_core.app import app, runtime_status
from neuromem_core.config import Settings
from neuromem_core.ids import uuid7
from neuromem_core.providers import ExtractionResult, normalize_vector, provider_health
from neuromem_core.schemas import (
    ProjectCreate,
    RecordBatchCreate,
    RecordBatchEnvelope,
    RecordInput,
    WorkspaceCreate,
)


def test_name_only_scope_creation_produces_idempotency_slug() -> None:
    assert WorkspaceCreate(name="My Memory").slug == "my-memory"
    assert ProjectCreate(name="프로젝트 A").slug == "프로젝트-a"


def test_record_batch_requires_scope_and_unique_ids() -> None:
    record_id = uuid7()
    item = RecordInput(id=record_id, author_key="user", content="A fact")
    envelope = RecordBatchEnvelope(
        workspace_id=uuid.uuid4(),
        project_id=uuid.uuid4(),
        session_id=uuid.uuid4(),
        records=[item],
    )
    assert envelope.records[0].id == record_id
    with pytest.raises(ValidationError):
        RecordBatchCreate(records=[item, item])


def test_record_rejects_nul_and_missing_author() -> None:
    with pytest.raises(ValidationError):
        RecordInput(author_key="user", content="bad\x00content")
    with pytest.raises(ValidationError):
        RecordInput(content="no author")


def test_extraction_result_rejects_more_than_eight_claims() -> None:
    with pytest.raises(ValidationError):
        ExtractionResult.model_validate(
            {"claims": [{"content": f"claim {index}"} for index in range(9)]}
        )


def test_generation_compatibility_parses_relation_only_and_safe_aliases() -> None:
    relation = ExtractionResult.model_validate(
        {
            "subject_label": "Neuromem",
            "predicate": "USES",
            "object_label": "PostgreSQL",
            "object_type": "literal",
        }
    )
    assert relation.claims[0].content == "Neuromem USES PostgreSQL"
    alias = ExtractionResult.model_validate({"claims": [{"statement": "A decision"}]})
    assert alias.claims[0].content == "A decision"
    korean = ExtractionResult.model_validate(
        {"claims": [{"content": "뉴로멤은 PostgreSQL을 사용한다"}]}
    )
    assert "뉴로멤" in korean.claims[0].content


def test_embedding_shape_and_norm_are_enforced() -> None:
    with pytest.raises(ValueError):
        normalize_vector([1.0], dimensions=2560)
    vector = normalize_vector([1.0] * 4, dimensions=4)
    assert sum(value * value for value in vector) == pytest.approx(1.0)


def test_api_token_is_fail_closed() -> None:
    with pytest.raises(ValidationError):
        Settings(api_token="short")


def test_configured_provider_without_local_probe_is_not_a_failure() -> None:
    settings = Settings(
        api_token="0123456789abcdef0123456789abcdef",
        embedding_base_url="http://embedding/v1",
        embedding_model="embedding",
        generation_base_url="http://generation/v1",
        generation_model="generation",
    )
    embedding, extraction = provider_health(settings)
    assert embedding.status == "configured"
    assert extraction.status == "configured"
    assert (
        runtime_status(
            database=True,
            embedding_configured=True,
            extraction_configured=True,
            job_counts={},
        )
        == "ok"
    )
    assert (
        runtime_status(
            database=True,
            embedding_configured=True,
            extraction_configured=True,
            job_counts={"retry": 1},
        )
        == "degraded"
    )


def test_database_url_supports_container_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expected = "postgresql+asyncpg://container/db"
    monkeypatch.setenv("DATABASE_URL", expected)
    monkeypatch.setenv("NEUROMEM_DATABASE_URL", "postgresql+asyncpg://fallback/db")
    settings = Settings(api_token="0123456789abcdef0123456789abcdef")
    assert settings.database_url == expected


def test_embedding_dimension_parses_compose_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("NEUROMEM_EMBEDDING_DIMENSIONS", "2560")
    settings = Settings(api_token="0123456789abcdef0123456789abcdef")
    assert settings.embedding_dimensions == 2560


def test_openapi_exposes_required_public_contracts_without_secrets() -> None:
    schema = app.openapi()
    paths = schema["paths"]
    assert "/v1/records:batch" in paths
    assert "/v1/recall" in paths
    assert "/v1/jobs:retry-failed" in paths
    assert "/v1/projects/{project_id}/overview" in paths
    assert "/v1/projects/{project_id}/claims" in paths
    assert "/v1/projects/{project_id}/wiki" in paths
    assert "/v1/projects/{project_id}/graph" in paths
    assert "/v1/system/backlog" in paths
    rendered = str(schema)
    assert "test-token-0123456789abcdef0123456789abcdef" not in rendered


def test_initial_migration_is_model_independent() -> None:
    migration = (
        Path(__file__).parents[1] / "alembic" / "versions" / "0001_initial.py"
    ).read_text()
    assert "Base.metadata" not in migration
    assert "neuromem_core.models" not in migration
    assert "op.create_table" in migration
