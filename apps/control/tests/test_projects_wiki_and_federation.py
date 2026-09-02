from __future__ import annotations

import hashlib

from .conftest import auth_headers


def _invite(client, owner_token: str, workspace_id: str, *, email: str, role: str):
    invitation = client.post(
        f"/api/v1/workspaces/{workspace_id}/invitations",
        headers=auth_headers(owner_token, workspace_id),
        json={"email": email, "role": role},
    )
    assert invitation.status_code == 200, invitation.text
    accepted = client.post(
        "/api/v1/auth/invitations:accept",
        json={
            "token": invitation.json()["token"],
            "display_name": email.split("@", 1)[0],
            "password": "member-password-123",
        },
    )
    assert accepted.status_code == 200, accepted.text
    return accepted.json()


def _create_second_workspace(client):
    response = client.post(
        "/api/v1/workspaces",
        json={"slug": "company-team", "name": "Company Team", "kind": "company"},
    )
    assert response.status_code == 200, response.text
    return response.json()


def test_same_principal_gets_distinct_human_peer_per_workspace(client, bootstrapped):
    second = _create_second_workspace(client)
    first_id = bootstrapped["workspace"]["id"]
    first_token = bootstrapped["recovery_credential"]["token"]
    second_bindings = client.get(
        f"/api/v1/workspaces/{second['id']}/peer-bindings",
        headers={"X-Neuromem-Workspace": second["id"]},
    )
    assert second_bindings.status_code == 200, second_bindings.text
    first_bindings = client.get(
        f"/api/v1/workspaces/{first_id}/peer-bindings",
        headers=auth_headers(first_token, first_id),
    )
    first_peer = first_bindings.json()[0]["peer"]["id"]
    second_peer = second_bindings.json()[0]["peer"]["id"]
    assert first_peer != second_peer


def test_restricted_project_requires_explicit_grant(client, bootstrapped):
    token = bootstrapped["recovery_credential"]["token"]
    workspace_id = bootstrapped["workspace"]["id"]
    member = _invite(
        client,
        token,
        workspace_id,
        email="builder@example.com",
        role="contributor",
    )
    created = client.post(
        f"/api/v1/workspaces/{workspace_id}/projects",
        headers=auth_headers(token, workspace_id),
        json={
            "slug": "secret-project",
            "name": "Secret Project",
            "access_policy": "restricted",
        },
    )
    assert created.status_code == 200, created.text
    project_id = created.json()["id"]
    member_token = member["recovery_credential"]["token"]

    before = client.get(
        "/api/v1/me",
        headers=auth_headers(member_token, workspace_id, project_id),
    )
    assert before.status_code == 200
    assert "project.read" not in before.json()["context"]["capabilities"]

    granted = client.post(
        f"/api/v1/projects/{project_id}/grants",
        headers=auth_headers(token, workspace_id),
        json={
            "principal_id": member["principal"]["id"],
            "capabilities": [
                "project.read",
                "project.write",
                "wiki.read",
                "wiki.write",
            ],
        },
    )
    assert granted.status_code == 200, granted.text
    after = client.get(
        "/api/v1/me",
        headers=auth_headers(member_token, workspace_id, project_id),
    )
    assert "project.read" in after.json()["context"]["capabilities"]

    revoked = client.delete(
        f"/api/v1/projects/{project_id}/grants/{granted.json()['id']}",
        headers=auth_headers(token, workspace_id),
    )
    assert revoked.status_code == 204
    denied_again = client.get(
        "/api/v1/me",
        headers=auth_headers(member_token, workspace_id, project_id),
    )
    assert "project.read" not in denied_again.json()["context"]["capabilities"]


def test_wiki_has_stable_id_citations_revisions_and_pinned_protection(
    client, bootstrapped
):
    token = bootstrapped["recovery_credential"]["token"]
    workspace_id = bootstrapped["workspace"]["id"]
    project_id = bootstrapped["general_project"]["id"]
    wiki_id = bootstrapped["general_project"]["wiki_id"]
    headers = auth_headers(token, workspace_id, project_id)
    citation = {
        "sentence_key": "overview-1",
        "source_type": "message",
        "source_id": "message-001",
        "source_workspace_id": workspace_id,
        "source_project_id": project_id,
    }
    created = client.post(
        f"/api/v1/projects/{project_id}/wiki/pages",
        headers=headers,
        json={
            "slug": "overview",
            "title": "Overview",
            "content": "Neuromem is a team memory system.",
            "source": "manual",
            "pinned": True,
            "citations": [citation],
        },
    )
    assert created.status_code == 200, created.text
    page = created.json()
    assert page["wiki_id"] == wiki_id
    revision = page["latest_revision"]
    assert revision["revision_number"] == 1
    assert revision["citations"][0]["source_id"] == "message-001"

    automatic = client.post(
        f"/api/v1/projects/{project_id}/wiki/pages/{page['id']}/revisions",
        headers=headers,
        json={
            "content": "Automatic replacement",
            "source": "automatic",
            "based_on_revision_id": revision["id"],
            "citations": [citation],
        },
    )
    assert automatic.status_code == 409

    external = dict(citation)
    external["source_workspace_id"] = "00000000-0000-7000-8000-000000000001"
    invalid = client.post(
        f"/api/v1/projects/{project_id}/wiki/pages",
        headers=headers,
        json={
            "slug": "external",
            "title": "External",
            "content": "External memory",
            "citations": [external],
        },
    )
    assert invalid.status_code == 400

    fetched = client.get(f"/api/v1/projects/{project_id}/wiki", headers=headers)
    assert fetched.status_code == 200
    assert fetched.json()["wiki_id"] == wiki_id
    assert len(fetched.json()["pages"]) == 1


def test_federation_requires_both_sides_then_can_be_revoked(client, bootstrapped):
    source_id = bootstrapped["workspace"]["id"]
    source_project_id = bootstrapped["general_project"]["id"]
    source_token = bootstrapped["recovery_credential"]["token"]
    target = _create_second_workspace(client)
    target_id = target["id"]

    proposed = client.post(
        "/api/v1/workspace-links",
        headers=auth_headers(source_token, source_id),
        json={"source_workspace_id": source_id, "target_workspace_id": target_id},
    )
    assert proposed.status_code == 200, proposed.text
    assert proposed.json()["status"] == "pending"
    link_id = proposed.json()["id"]

    accepted = client.post(
        f"/api/v1/workspace-links/{link_id}:approve",
        headers={"X-Neuromem-Workspace": target_id},
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "active"

    grant = client.post(
        "/api/v1/federated-project-grants",
        headers=auth_headers(source_token, source_id),
        json={
            "workspace_link_id": link_id,
            "source_project_id": source_project_id,
            "capabilities": ["search", "read_source"],
        },
    )
    assert grant.status_code == 200, grant.text
    assert grant.json()["status"] == "pending"
    grant_id = grant.json()["id"]

    target_accept = client.post(
        f"/api/v1/federated-project-grants/{grant_id}:accept",
        headers={"X-Neuromem-Workspace": target_id},
    )
    assert target_accept.status_code == 200, target_accept.text
    assert target_accept.json()["status"] == "active"

    assignment = client.post(
        f"/api/v1/federated-project-grants/{grant_id}/assignments",
        headers={"X-Neuromem-Workspace": target_id},
        json={"role": "viewer"},
    )
    assert assignment.status_code == 200, assignment.text

    revoked = client.delete(
        f"/api/v1/federated-project-grants/{grant_id}",
        headers=auth_headers(source_token, source_id),
    )
    assert revoked.status_code == 200
    assert revoked.json()["status"] == "revoked"


def test_transfer_has_two_approval_stages_and_import_completion(client, bootstrapped):
    source_id = bootstrapped["workspace"]["id"]
    source_project_id = bootstrapped["general_project"]["id"]
    source_token = bootstrapped["recovery_credential"]["token"]
    target = _create_second_workspace(client)
    target_id = target["id"]
    target_projects = client.get(
        f"/api/v1/workspaces/{target_id}/projects",
        headers={"X-Neuromem-Workspace": target_id},
    )
    target_project_id = target_projects.json()[0]["id"]

    link = client.post(
        "/api/v1/workspace-links",
        headers=auth_headers(source_token, source_id),
        json={"source_workspace_id": source_id, "target_workspace_id": target_id},
    ).json()
    activated = client.post(
        f"/api/v1/workspace-links/{link['id']}:approve",
        headers={"X-Neuromem-Workspace": target_id},
    )
    assert activated.json()["status"] == "active"

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
    )
    assert transfer.status_code == 200, transfer.text
    transfer_id = transfer.json()["id"]
    assert transfer.json()["status"] == "pending_source"

    source_approval = client.post(
        f"/api/v1/transfer-requests/{transfer_id}:approve",
        headers=auth_headers(source_token, source_id),
        json={},
    )
    assert source_approval.json()["status"] == "pending_target"

    target_approval = client.post(
        f"/api/v1/transfer-requests/{transfer_id}:approve",
        headers={"X-Neuromem-Workspace": target_id},
        json={"reviewed_content": "Reviewed source memory"},
    )
    assert target_approval.status_code == 200, target_approval.text
    assert target_approval.json()["status"] == "approved"

    completed = client.post(
        f"/api/v1/transfer-requests/{transfer_id}:complete",
        headers={"X-Neuromem-Workspace": target_id},
        json={"imported_message_id": "target-message-9"},
    )
    assert completed.status_code == 200, completed.text
    assert completed.json()["status"] == "completed"
    assert completed.json()["imported_message_id"] == "target-message-9"

    listed = client.get(
        f"/api/v1/transfer-requests?workspace_id={target_id}",
        headers={"X-Neuromem-Workspace": target_id},
    )
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()] == [transfer_id]


def test_openapi_exposes_team_contract_routes(client):
    paths = client.get("/openapi.json").json()["paths"]
    expected = {
        "/api/v1/node",
        "/api/v1/workspaces/{workspace_id}/members",
        "/api/v1/workspaces/{workspace_id}:select",
        "/api/v1/workspaces/{workspace_id}/peer-bindings",
        "/api/v1/credentials",
        "/api/v1/projects/{project_id}/grants",
        "/api/v1/workspace-links",
        "/api/v1/workspace-shares",
        "/api/v1/workspace-shares/{share_id}:approve",
        "/api/v1/workspace-shares/{share_id}:reject",
        "/api/v1/workspace-shares/{share_id}:revoke",
        "/api/v1/workspace-projections",
        "/api/v1/federated-project-grants",
        "/api/v1/transfer-requests",
        "/api/v1/transfer-requests/{transfer_id}:approve",
        "/api/v1/transfer-requests/{transfer_id}:reject",
        "/api/v1/projects/{project_id}/wiki",
        "/api/v1/internal-context-tokens",
    }
    assert expected <= set(paths)
