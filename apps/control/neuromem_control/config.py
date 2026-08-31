from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="NEUROMEM_CONTROL_",
        env_file=".env",
        extra="ignore",
    )

    database_url: str = "sqlite:///./neuromem-control.db"
    secret_key: str = Field(min_length=32)
    internal_signing_key: str | None = Field(default=None, min_length=32)
    memory_core_url: str | None = None
    memory_core_timeout_seconds: float = Field(default=120.0, gt=0, le=600)
    memory_core_max_response_bytes: int = Field(
        default=16 * 1024 * 1024, ge=1024, le=128 * 1024 * 1024
    )
    auto_create_schema: bool = False
    secure_cookies: bool = True
    invitation_ttl_seconds: int = 7 * 24 * 60 * 60
    credential_ttl_seconds: int = 90 * 24 * 60 * 60
    web_session_idle_seconds: int = 24 * 60 * 60
    web_session_absolute_seconds: int = 7 * 24 * 60 * 60

    @property
    def resolved_internal_signing_key(self) -> str:
        return self.internal_signing_key or self.secret_key


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
