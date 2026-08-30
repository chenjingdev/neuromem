from __future__ import annotations

import uuid
from functools import lru_cache

from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .ids import uuid7


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="NEUROMEM_",
        env_file=".env",
        extra="ignore",
    )

    database_url: str = Field(
        default="postgresql+asyncpg://neuromem:neuromem@127.0.0.1:5432/neuromem",
        validation_alias=AliasChoices("DATABASE_URL", "NEUROMEM_DATABASE_URL"),
    )
    node_id: uuid.UUID = Field(default_factory=uuid7)
    api_token: SecretStr = Field(min_length=32)
    db_pool_enabled: bool = True
    log_level: str = "INFO"
    mcp_public_url: str | None = None

    embedding_base_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "EMBEDDING_BASE_URL", "NEUROMEM_EMBEDDING_BASE_URL"
        ),
    )
    embedding_api_key: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "EMBEDDING_API_KEY", "NEUROMEM_EMBEDDING_API_KEY"
        ),
    )
    embedding_model: str | None = Field(
        default=None,
        validation_alias=AliasChoices("EMBEDDING_MODEL", "NEUROMEM_EMBEDDING_MODEL"),
    )
    embedding_dimensions: int = Field(default=2560, ge=2560, le=2560)
    embedding_send_dimensions: bool = False
    embedding_query_instruction: str | None = None
    embedding_profile_name: str = "qwen3-embedding-4b-halfvec2560"

    generation_base_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "GENERATION_BASE_URL", "NEUROMEM_GENERATION_BASE_URL"
        ),
    )
    generation_api_key: SecretStr | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "GENERATION_API_KEY", "NEUROMEM_GENERATION_API_KEY"
        ),
    )
    generation_model: str | None = Field(
        default=None,
        validation_alias=AliasChoices("GENERATION_MODEL", "NEUROMEM_GENERATION_MODEL"),
    )

    segment_max_tokens: int = Field(default=8000, ge=128, le=8192)
    segment_overlap_ratio: float = Field(default=0.2, ge=0, lt=0.5)
    worker_poll_seconds: float = Field(default=1.0, gt=0, le=60)
    worker_batch_size: int = Field(default=8, ge=1, le=100)
    worker_lease_seconds: int = Field(default=600, ge=30, le=3600)
    worker_max_attempts: int = Field(default=12, ge=1, le=100)
    hnsw_ef_search: int = Field(default=100, ge=1, le=1000)
    exact_similarity_threshold: float = Field(default=0.12, ge=0, le=1)

    @field_validator("node_id")
    @classmethod
    def require_uuid7_node_id(cls, value: uuid.UUID) -> uuid.UUID:
        if value.version != 7:
            raise ValueError("node_id must be UUIDv7")
        return value

    @property
    def embedding_configured(self) -> bool:
        return bool(self.embedding_base_url and self.embedding_model)

    @property
    def extraction_configured(self) -> bool:
        return bool(self.generation_base_url and self.generation_model)


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
