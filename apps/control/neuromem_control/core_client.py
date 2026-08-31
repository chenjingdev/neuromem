from __future__ import annotations

from typing import Any, Protocol

from .schemas import AuthContext
from .security import InternalTokenSigner


class MemoryCoreClient(Protocol):
    """Boundary implemented by the deployment-specific Memory Core adapter."""

    def request(
        self,
        *,
        method: str,
        path: str,
        context: AuthContext,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]: ...


class SignedMemoryCoreClient:
    """Small adapter seam; transport is injected and therefore unit-testable."""

    def __init__(self, signer: InternalTokenSigner, transport):
        self.signer = signer
        self.transport = transport

    def request(
        self,
        *,
        method: str,
        path: str,
        context: AuthContext,
        payload: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        token, _ = self.signer.mint(context)
        return self.transport(
            method=method,
            path=path,
            headers={"Authorization": f"Internal {token}"},
            json=payload,
        )
