from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated, Any, Protocol
from urllib.parse import quote

import httpx
from fastapi import Depends, HTTPException, status

from .config import Settings, get_settings
from .schemas import AuthContext
from .security import InternalTokenSigner


class NodeManagerError(Exception):
    def __init__(self, *, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class FolderSource:
    source_id: str
    display_name: str
    display_path: str
    status: str


@dataclass(frozen=True)
class FolderPickResult:
    cancelled: bool
    source: FolderSource | None = None


class NodeManagerClient(Protocol):
    def pick_folder(
        self, *, node_id: str, context: AuthContext
    ) -> FolderPickResult: ...

    def detach_folder(
        self, *, node_id: str, context: AuthContext, source_id: str
    ) -> None: ...


class HttpxNodeManagerClient:
    def __init__(
        self,
        *,
        base_url: str,
        signer: InternalTokenSigner,
        timeout_seconds: float = 600.0,
        client: httpx.Client | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.signer = signer
        self.timeout_seconds = timeout_seconds
        self.client = client

    def pick_folder(self, *, node_id: str, context: AuthContext) -> FolderPickResult:
        payload = self._request(
            node_id=node_id,
            action="pick",
            context=context,
        )
        if payload.get("cancelled") is True:
            return FolderPickResult(cancelled=True)
        source = payload.get("source")
        if payload.get("cancelled") is not False or not isinstance(source, dict):
            raise NodeManagerError(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Node Manager returned an invalid folder selection",
            )
        return FolderPickResult(cancelled=False, source=_folder_source(source))

    def detach_folder(
        self, *, node_id: str, context: AuthContext, source_id: str
    ) -> None:
        payload = self._request(
            node_id=node_id,
            action="detach",
            context=context,
            body={"source_id": source_id},
        )
        if payload.get("ok") is not True:
            raise NodeManagerError(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Node Manager did not detach the folder",
            )

    def _request(
        self,
        *,
        node_id: str,
        action: str,
        context: AuthContext,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        token, _ = self.signer.mint(context)
        path = f"/v1/internal/nodes/{quote(node_id, safe='')}/folder-sources:{action}"
        owns_client = self.client is None
        client = self.client or httpx.Client(
            base_url=self.base_url,
            timeout=self.timeout_seconds,
            follow_redirects=False,
        )
        transport_failure: NodeManagerError | None = None
        response: httpx.Response | None = None
        try:
            response = client.post(
                path,
                headers={
                    "Authorization": f"Internal {token}",
                    "Accept": "application/json",
                    "X-Request-ID": context.request_id,
                },
                json=body,
            )
        except httpx.HTTPError:
            transport_failure = NodeManagerError(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="로컬 Node Manager의 폴더 선택창에 연결하지 못했습니다.",
            )
        finally:
            if owns_client:
                client.close()
        if transport_failure is not None:
            # The original httpx request contains the signed Authorization
            # header, so do not retain it in the public exception chain.
            raise transport_failure from None
        assert response is not None

        if response.status_code >= 400:
            # Manager responses can contain host-only diagnostics and paths.
            # Preserve only the status needed for the existing Control UX.
            raise NodeManagerError(
                status_code=response.status_code,
                detail="Node Manager rejected the folder operation",
            )
        if len(response.content) > 64 * 1024:
            raise NodeManagerError(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Node Manager returned an oversized response",
            )
        json_failure: NodeManagerError | None = None
        payload: Any = None
        try:
            payload = response.json()
        except ValueError:
            json_failure = NodeManagerError(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Node Manager returned invalid JSON",
            )
        if json_failure is not None:
            # JSONDecodeError retains the rejected response document. Raise
            # after leaving the except block so it cannot leak through context.
            raise json_failure from None
        if not isinstance(payload, dict):
            raise NodeManagerError(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Node Manager returned an invalid response",
            )
        return payload


def _folder_source(payload: dict[str, Any]) -> FolderSource:
    source_id = payload.get("source_id")
    display_name = payload.get("display_name")
    display_path = payload.get("display_path")
    source_status = payload.get("status")
    if (
        not isinstance(source_id, str)
        or not 8 <= len(source_id) <= 128
        or any(character in source_id for character in "\r\n\0")
        or not isinstance(display_name, str)
        or not 1 <= len(display_name) <= 256
        or not isinstance(display_path, str)
        or not 1 <= len(display_path) <= 1024
        or source_status not in {"active", "unavailable"}
    ):
        raise NodeManagerError(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Node Manager returned an invalid folder source",
        )
    return FolderSource(
        source_id=source_id,
        display_name=display_name,
        display_path=display_path,
        status=source_status,
    )


def get_node_manager_client(
    settings: Annotated[Settings, Depends(get_settings)],
) -> NodeManagerClient:
    if not settings.node_manager_url:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="NEUROMEM_CONTROL_NODE_MANAGER_URL is not configured",
        )
    return HttpxNodeManagerClient(
        base_url=settings.node_manager_url,
        signer=InternalTokenSigner(settings.resolved_internal_signing_key),
        timeout_seconds=settings.node_manager_timeout_seconds,
    )
