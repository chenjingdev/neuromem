from __future__ import annotations

import hashlib

import httpx

from neuromem_control.app import app
from neuromem_control.core_client import (
    HttpxMemoryCoreClient,
    MemoryCoreError,
    get_memory_core_client,
    get_optional_memory_core_client,
)
from neuromem_control.schemas import AuthContext
from neuromem_control.security import InternalTokenSigner

from .conftest import auth_headers
from .test_projects_wiki_and_federation import _create_second_workspace


class FakeCore:
    def __init__(self):
        self.calls: list[dict] = []

    def request(self, **call):
        self.calls.append(call)
        path = call["path"]
        if path.endswith("/messages"):
            return [{"id": "core-message-1", "content": "stored"}]
        if path.endswith("/search"):
            return [
                {
                    "id": "core-source-1",
                    "content": "Relevant source from the project.",
                    "metadata": {"neuromem_record_id": "record-source-1"},
                }
            ]
        if path.endswith("/conclusions/query"):
            return [
                {
                    "id": "conclusion-1",
                    "content": "Derived project conclusion.",
                    "status": "active",
                    "derivation_method": "deductive",
                }
            ]
        if path.endswith("/representation"):
            return {"representation": "User and project representation."}
        if path.endswith("/card"):
            return {"peer_card": ["Prefers source-grounded answers"]}
        if path.endswith("/context"):
            return {"messages": [], "peer_representation": "context"}
        if path.endswith("/chat"):
            return {"content": "Dialectic answer"}
        if path.endswith("/schedule_dream"):
            return {"status": "scheduled"}
        return {"id": "created"}


def _override_core(fake: FakeCore):
    app.dependency_overrides[get_memory_core_client] = lambda: fake
    app.dependency_overrides[get_optional_memory_core_client] = lambda: fake


def _clear_core_override():
    app.dependency_overrides.pop(get_memory_core_client, None)
    app.dependency_overrides.pop(get_optional_memory_core_client, None)


def test_httpx_core_client_sends_byte_compatible_internal_token():
    signer = InternalTokenSigner("test-internal-signing-key-0123456789")
    context = AuthContext(
        principal_id="principal-1",
        credential_id="credential-1",
        workspace_id="workspace-1",
        project_id="project-1",
        human_peer_id="human-1",
        agent_peer_id="agent-1",
        capabilities=["project.read"],
        request_id="request-1",
    )

    def handler(request: httpx.Request) -> httpx.Response:
        scheme, token = request.headers["authorization"].split(" ", 1)
        assert scheme == "Internal"
        verified = signer.verify(token)
        assert verified == context
        assert request.headers["x-request-id"] == "request-1"
        assert request.url.path == "/v3/workspaces/workspace-1/search"
        return httpx.Response(200, json={"items": [{"id": "message-1"}]})

    client = httpx.Client(
        base_url="http://memory-core",
        transport=httpx.MockTransport(handler),
    )
    core = HttpxMemoryCoreClient(
        base_url="http://memory-core",
        signer=signer,
        client=client,
    )
    result = core.request(
        method="POST",
        path="/v3/workspaces/workspace-1/search",
        context=context,
        payload={"query": "test"},
    )
    assert result["items"][0]["id"] == "message-1"


def test_httpx_core_client_bounds_and_classifies_failures():
    context = AuthContext(
        principal_id="p",
        credential_id=None,
        workspace_id="w",
        project_id="x",
        human_peer_id="h",
        agent_peer_id=None,
        capabilities=[],
        request_id="r",
    )
    client = httpx.Client(
        base_url="http://memory-core",
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(429, json={"detail": "busy"})
        ),
    )
    core = HttpxMemoryCoreClient(
        base_url="http://memory-core",
        signer=InternalTokenSigner("x" * 32),
        client=client,
    )
    try:
        core.request(method="GET", path="/health", context=context)
    except MemoryCoreError as error:
        assert error.status_code == 429
        assert error.retryable is True
    else:
        raise AssertionError("upstream error was not classified")


def test_ingest_search_and_author_spoof_protection(client, bootstrapped):
    fake = FakeCore()
    _override_core(fake)
    try:
        token = bootstrapped["recovery_credential"]["token"]
        workspace_id = bootstrapped["workspace"]["id"]
        project_id = bootstrapped["general_project"]["id"]
        human_peer_id = bootstrapped["human_peer"]["id"]
        headers = auth_headers(token, workspace_id, project_id)
        body = {
            "workspace_id": workspace_id,
            "project_id": project_id,
            "session_id": "codex-session",
            "records": [
                {
                    "id": "01a058c5-c07e-7000-8000-000000000001",
                    "author_key": human_peer_id,
                    "author_name": "Owner",
                    "author_kind": "human",
                    "kind": "message",
                    "content": "Remember this source-grounded decision.",
                    "source_app": "codex",
                    "metadata": {},
                }
            ],
        }
        stored = client.post("/api/v1/records:batch", headers=headers, json=body)
        assert stored.status_code == 201, stored.text
        provision_paths = [call["path"] for call in fake.calls[:-1]]
        assert "/v3/workspaces" in provision_paths
        assert f"/v3/workspaces/{workspace_id}/peers" in provision_paths
        assert f"/v3/workspaces/{workspace_id}/projects" in provision_paths
        project_call = next(
            call
            for call in fake.calls
            if call["path"] == f"/v3/workspaces/{workspace_id}/projects"
        )
        assert project_call["payload"]["id"] == "general"
        assert project_call["context"].project_id == "general"
        assert "workspace.create" in project_call["context"].capabilities
        message_call = fake.calls[-1]
        assert message_call["params"]["project_id"] == "general"
        assert message_call["context"].project_id == "general"
        assert message_call["payload"]["messages"][0]["peer_id"] == human_peer_id

        spoof = dict(body)
        spoof["records"] = [{**body["records"][0], "author_key": "foreign-peer"}]
        denied = client.post("/api/v1/records:batch", headers=headers, json=spoof)
        assert denied.status_code == 403

        recalled = client.post(
            "/api/v1/recall",
            headers=headers,
            json={
                "workspace_id": workspace_id,
                "project_id": project_id,
                "query": "source grounded",
                "include": ["records", "claims"],
            },
        )
        assert recalled.status_code == 200, recalled.text
        assert recalled.json()["records"][0]["record_id"] == "record-source-1"
        assert recalled.json()["claims"][0]["claim_id"] == "conclusion-1"
        assert recalled.json()["record_snippets"] == []
    finally:
        _clear_core_override()


def test_dynamic_context_is_ordered_bounded_and_read_only(client, bootstrapped):
    fake = FakeCore()
    _override_core(fake)
    try:
        token = bootstrapped["recovery_credential"]["token"]
        workspace_id = bootstrapped["workspace"]["id"]
        project_id = bootstrapped["general_project"]["id"]
        headers = auth_headers(token, workspace_id, project_id)
        citation = {
            "sentence_key": "overview-1",
            "source_type": "message",
            "source_id": "wiki-message-1",
            "source_workspace_id": workspace_id,
            "source_project_id": project_id,
        }
        page = client.post(
            f"/api/v1/projects/{project_id}/wiki/pages",
            headers=headers,
            json={
                "slug": "overview",
                "title": "Overview",
                "content": "Neuromem keeps team memory with exact sources.",
                "citations": [citation],
            },
        )
        assert page.status_code == 200, page.text
        compiled = client.post(
            "/api/v1/context",
            headers=headers,
            json={
                "workspace_id": workspace_id,
                "project_id": project_id,
                "query": "What is Neuromem?",
                "token_budget": 256,
                "include_general": True,
                "include_federated": False,
            },
        )
        assert compiled.status_code == 200, compiled.text
        data = compiled.json()
        assert data["estimated_tokens"] <= 256
        assert data["sections"][0]["layer"] == "general_wiki"
        assert data["federated_persisted"] is False
        assert all(not call["path"].endswith("/messages") for call in fake.calls)
    finally:
        _clear_core_override()


def test_named_project_uses_uuid_while_core_overlay_keeps_general_sentinel(
    client, bootstrapped
):
    fake = FakeCore()
    _override_core(fake)
    try:
        token = bootstrapped["recovery_credential"]["token"]
        workspace_id = bootstrapped["workspace"]["id"]
        general_id = bootstrapped["general_project"]["id"]
        created = client.post(
            f"/api/v1/workspaces/{workspace_id}/projects",
            headers=auth_headers(token, workspace_id, general_id),
            json={"slug": "native-project", "name": "Native Project"},
        )
        assert created.status_code == 200, created.text
        project_id = created.json()["id"]
        headers = auth_headers(token, workspace_id, project_id)
        recalled = client.post(
            "/api/v1/recall",
            headers=headers,
            json={
                "workspace_id": workspace_id,
                "project_id": project_id,
                "query": "project overlay",
                "include": ["records", "claims"],
                "include_general": True,
            },
        )
        assert recalled.status_code == 200, recalled.text
        search_call = next(
            call for call in fake.calls if call["path"].endswith("/search")
        )
        assert search_call["context"].project_id == project_id
        assert search_call["payload"]["project_id"] == project_id
        assert search_call["payload"]["include_general"] is True
        conclusion_call = next(
            call for call in fake.calls if call["path"].endswith("/conclusions/query")
        )
        assert conclusion_call["payload"]["filters"]["observer"]
        assert conclusion_call["payload"]["filters"]["observed"]
        assert recalled.json()["records"][0]["project_id"] == project_id
    finally:
        _clear_core_override()


def test_approved_transfer_is_imported_by_gateway_with_provenance(client, bootstrapped):
    fake = FakeCore()
    _override_core(fake)
    try:
        source_id = bootstrapped["workspace"]["id"]
        source_project_id = bootstrapped["general_project"]["id"]
        source_token = bootstrapped["recovery_credential"]["token"]
        target = _create_second_workspace(client)
        target_id = target["id"]
        target_project_id = client.get(
            f"/api/v1/workspaces/{target_id}/projects",
            headers={"X-Neuromem-Workspace": target_id},
        ).json()[0]["id"]
        link = client.post(
            "/api/v1/workspace-links",
            headers=auth_headers(source_token, source_id),
            json={
                "source_workspace_id": source_id,
                "target_workspace_id": target_id,
            },
        ).json()
        client.post(
            f"/api/v1/workspace-links/{link['id']}:approve",
            headers={"X-Neuromem-Workspace": target_id},
        )
        content = "Approved source memory"
        transfer = client.post(
            "/api/v1/transfer-requests",
            headers=auth_headers(source_token, source_id),
            json={
                "source_workspace_id": source_id,
                "source_project_id": source_project_id,
                "target_workspace_id": target_id,
                "target_project_id": target_project_id,
                "source_record_id": "source-message-1",
                "source_content_hash": hashlib.sha256(content.encode()).hexdigest(),
                "source_snapshot": content,
                "provenance": {"author_label": "Owner"},
            },
        ).json()
        client.post(
            f"/api/v1/transfer-requests/{transfer['id']}:approve",
            headers=auth_headers(source_token, source_id),
            json={},
        )
        client.post(
            f"/api/v1/transfer-requests/{transfer['id']}:approve",
            headers={"X-Neuromem-Workspace": target_id},
            json={"reviewed_content": "Reviewed memory"},
        )
        completed = client.post(
            f"/api/v1/transfer-requests/{transfer['id']}:complete",
            headers={
                "X-Neuromem-Workspace": target_id,
                "X-Neuromem-Project": target_project_id,
            },
            json={},
        )
        assert completed.status_code == 200, completed.text
        assert completed.json()["imported_message_id"] == "core-message-1"
        assert completed.json()["provenance"]["imported_message_id"] == (
            "core-message-1"
        )
        message_call = next(
            call for call in fake.calls if call["path"].endswith("/messages")
        )
        assert (
            message_call["context"].agent_peer_id
            == completed.json()["provenance"]["import_system_peer_id"]
        )
        metadata = message_call["payload"]["messages"][0]["metadata"]
        assert (
            metadata["source_content_hash"]
            == hashlib.sha256(content.encode()).hexdigest()
        )
        assert metadata["source_approved_by"]
        assert metadata["target_approved_by"]
    finally:
        _clear_core_override()
