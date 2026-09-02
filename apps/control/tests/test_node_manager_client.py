from __future__ import annotations

import traceback

import httpx
import pytest

from neuromem_control.node_manager_client import (
    HttpxNodeManagerClient,
    NodeManagerError,
)
from neuromem_control.schemas import AuthContext
from neuromem_control.security import InternalTokenSigner


def test_node_manager_client_signs_project_bound_folder_requests():
    signer = InternalTokenSigner("manager-signing-key-0123456789abcdef")
    context = AuthContext(
        principal_id="principal-1",
        credential_id=None,
        workspace_id="workspace-1",
        project_id="project-1",
        human_peer_id="peer-1",
        agent_peer_id=None,
        capabilities=["project.write"],
        request_id="request-1",
    )
    calls: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        scheme, raw_token = request.headers["authorization"].split(" ", 1)
        assert scheme == "Internal"
        verified = signer.verify(raw_token)
        assert verified.principal_id == context.principal_id
        assert verified.workspace_id == context.workspace_id
        assert verified.project_id == context.project_id
        calls.append((request.method, request.url.path))
        if request.url.path.endswith(":pick"):
            return httpx.Response(
                200,
                json={
                    "cancelled": False,
                    "source": {
                        "source_id": "source-project-1",
                        "display_name": "neuromem",
                        "display_path": "~/dev/neuromem",
                        "status": "active",
                    },
                },
            )
        assert request.read() == b'{"source_id":"source-project-1"}'
        return httpx.Response(200, json={"ok": True})

    http = httpx.Client(
        base_url="http://manager.test",
        transport=httpx.MockTransport(handler),
    )
    manager = HttpxNodeManagerClient(
        base_url="http://manager.test",
        signer=signer,
        client=http,
    )

    picked = manager.pick_folder(node_id="node-1", context=context)
    assert picked.source is not None
    assert picked.source.display_path == "~/dev/neuromem"
    manager.detach_folder(
        node_id="node-1", context=context, source_id="source-project-1"
    )
    assert calls == [
        ("POST", "/v1/internal/nodes/node-1/folder-sources:pick"),
        ("POST", "/v1/internal/nodes/node-1/folder-sources:detach"),
    ]


def _context() -> AuthContext:
    return AuthContext(
        principal_id="principal-1",
        credential_id=None,
        workspace_id="workspace-1",
        project_id="project-1",
        human_peer_id="peer-1",
        agent_peer_id=None,
        capabilities=["project.write"],
        request_id="request-1",
    )


def test_node_manager_client_never_reflects_upstream_error_body():
    absolute_path = "/Users/owner/ProjectThatMustNotLeak"
    upstream_token = "manager-upstream-secret"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            500,
            text=f"failed to read {absolute_path}; token={upstream_token}",
        )

    http = httpx.Client(
        base_url="http://manager.test",
        transport=httpx.MockTransport(handler),
    )
    manager = HttpxNodeManagerClient(
        base_url="http://manager.test",
        signer=InternalTokenSigner("manager-signing-key-0123456789abcdef"),
        client=http,
    )

    with pytest.raises(NodeManagerError) as failure:
        manager.pick_folder(node_id="node-1", context=_context())

    assert failure.value.detail == "Node Manager rejected the folder operation"
    rendered = "".join(traceback.format_exception(failure.value))
    assert absolute_path not in rendered
    assert upstream_token not in rendered


def test_node_manager_client_drops_sensitive_transport_exception_context():
    absolute_path = "/Users/owner/ProjectThatMustNotLeak"
    upstream_token = "manager-upstream-secret"

    def handler(request: httpx.Request) -> httpx.Response:
        sensitive_request = httpx.Request(
            request.method,
            request.url,
            headers={"Authorization": f"Internal {upstream_token}"},
        )
        raise httpx.ConnectError(
            f"failed to read {absolute_path} with {upstream_token}",
            request=sensitive_request,
        )

    http = httpx.Client(
        base_url="http://manager.test",
        transport=httpx.MockTransport(handler),
    )
    manager = HttpxNodeManagerClient(
        base_url="http://manager.test",
        signer=InternalTokenSigner("manager-signing-key-0123456789abcdef"),
        client=http,
    )

    with pytest.raises(NodeManagerError) as failure:
        manager.pick_folder(node_id="node-1", context=_context())

    assert failure.value.__cause__ is None
    assert failure.value.__context__ is None
    rendered = "".join(traceback.format_exception(failure.value))
    assert absolute_path not in rendered
    assert upstream_token not in rendered
