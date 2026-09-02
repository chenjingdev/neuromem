from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="NEUROMEM_CONTROL_",
        env_file=".env",
        extra="ignore",
    )

    database_url: str = "sqlite:///./neuromem-control.db"
    node_id: str = Field(min_length=1, max_length=128)
    secret_key: str = Field(min_length=32)
    internal_signing_key: str | None = Field(default=None, min_length=32)
    memory_core_url: str | None = None
    memory_core_timeout_seconds: float = Field(default=120.0, gt=0, le=600)
    memory_core_max_response_bytes: int = Field(
        default=16 * 1024 * 1024, ge=1024, le=128 * 1024 * 1024
    )
    node_manager_url: str | None = None
    node_manager_timeout_seconds: float = Field(default=600.0, gt=0, le=900)
    auto_create_schema: bool = False
    secure_cookies: bool = True
    invitation_ttl_seconds: int = 7 * 24 * 60 * 60
    credential_ttl_seconds: int = 90 * 24 * 60 * 60
    web_session_idle_seconds: int = 24 * 60 * 60
    web_session_absolute_seconds: int = 7 * 24 * 60 * 60
    local_test_login_prefill: bool = False
    local_test_login_email: str | None = None
    local_test_login_password: str | None = None

    @field_validator(
        "local_test_login_email", "local_test_login_password", mode="before"
    )
    @classmethod
    def _empty_local_test_login_value(cls, value: object) -> object:
        return None if value == "" else value

    @model_validator(mode="after")
    def _validate_local_test_login(self) -> Settings:
        has_email = self.local_test_login_email is not None
        has_password = self.local_test_login_password is not None
        if not self.local_test_login_prefill and (has_email or has_password):
            raise ValueError(
                "local test login values require the explicit prefill flag"
            )
        if self.local_test_login_prefill and has_email != has_password:
            raise ValueError(
                "local test login email and password must be configured together"
            )
        if self.local_test_login_prefill:
            if not has_email:
                raise ValueError("local test login email and password are required")
            if self.secure_cookies:
                raise ValueError(
                    "local test login prefill requires insecure loopback cookies"
                )
            if len(self.local_test_login_password or "") < 12:
                raise ValueError(
                    "local test login password must contain at least 12 characters"
                )
        return self

    @property
    def resolved_internal_signing_key(self) -> str:
        return self.internal_signing_key or self.secret_key


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
