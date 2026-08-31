from __future__ import annotations

from typing import Annotated, Any, Protocol

import httpx
from fastapi import Depends, HTTPException, status

from .config import Settings, get_settings
from .schemas import AuthContext
from .security import InternalTokenSigner


class MemoryCoreError(Exception):
    def __init__(
        self,
        *,
        code: str,
        status_code: int,
        retryable: bool,
        detail: Any = None,
    ):
        super().__init__(code)
        self.code = code
        self.status_code = status_code
        self.retryable = retryable
        self.detail = detail


class MemoryCoreClient(Protocol):
    """Bounded, signed transport from the Control Plane to Memory Core."""

    def request(
        self,
        *,
        method: str,
        path: str,
        context: AuthContext,
        payload: Any = None,
        params: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> Any: ...


class HttpxMemoryCoreClient:
    def __init__(
        self,
        *,
        base_url: str,
        signer: InternalTokenSigner,
        timeout_seconds: float = 120.0,
        max_response_bytes: int = 16 * 1024 * 1024,
        client: httpx.Client | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.signer = signer
        self.timeout_seconds = timeout_seconds
        self.max_response_bytes = max_response_bytes
        self.client = client

    def request(
        self,
        *,
        method: str,
        path: str,
        context: AuthContext,
        payload: Any = None,
        params: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> Any:
        if not path.startswith("/") or path.startswith("//"):
            raise ValueError("Memory Core path must be an absolute local path")
        token, _ = self.signer.mint(context)
        headers = {
            "Authorization": f"Internal {token}",
            "Accept": "application/json",
            "X-Request-ID": context.request_id,
        }
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key

        owns_client = self.client is None
        client = self.client or httpx.Client(
            base_url=self.base_url,
            timeout=self.timeout_seconds,
            follow_redirects=False,
        )
        try:
            response = client.request(
                method.upper(),
                path,
                headers=headers,
                params={k: v for k, v in (params or {}).items() if v is not None},
                json=payload,
            )
        except (httpx.TimeoutException, httpx.NetworkError) as error:
            raise MemoryCoreError(
                code="memory_core_unavailable",
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                retryable=True,
                detail=str(error),
            ) from error
        finally:
            if owns_client:
                client.close()

        content = response.content
        if len(content) > self.max_response_bytes:
            raise MemoryCoreError(
                code="memory_core_response_too_large",
                status_code=status.HTTP_502_BAD_GATEWAY,
                retryable=False,
            )
        if response.status_code >= 400:
            try:
                detail = response.json()
            except ValueError:
                detail = response.text[:4096]
            raise MemoryCoreError(
                code=f"memory_core_http_{response.status_code}",
                status_code=response.status_code,
                retryable=response.status_code in {408, 425, 429}
                or response.status_code >= 500,
                detail=detail,
            )
        if response.status_code == 204 or not content:
            return None
        try:
            return response.json()
        except ValueError as error:
            raise MemoryCoreError(
                code="memory_core_invalid_json",
                status_code=status.HTTP_502_BAD_GATEWAY,
                retryable=False,
            ) from error


def get_memory_core_client(
    settings: Annotated[Settings, Depends(get_settings)],
) -> MemoryCoreClient:
    if not settings.memory_core_url:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="NEUROMEM_CONTROL_MEMORY_CORE_URL is not configured",
        )
    return HttpxMemoryCoreClient(
        base_url=settings.memory_core_url,
        signer=InternalTokenSigner(settings.resolved_internal_signing_key),
        timeout_seconds=settings.memory_core_timeout_seconds,
        max_response_bytes=settings.memory_core_max_response_bytes,
    )


def get_optional_memory_core_client(
    settings: Annotated[Settings, Depends(get_settings)],
) -> MemoryCoreClient | None:
    if not settings.memory_core_url:
        return None
    return HttpxMemoryCoreClient(
        base_url=settings.memory_core_url,
        signer=InternalTokenSigner(settings.resolved_internal_signing_key),
        timeout_seconds=settings.memory_core_timeout_seconds,
        max_response_bytes=settings.memory_core_max_response_bytes,
    )
