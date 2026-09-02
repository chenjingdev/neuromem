from __future__ import annotations

from .conftest import auth_headers
from .test_projects_wiki_and_federation import _create_second_workspace


def test_node_has_many_selectable_workspaces(client, bootstrapped):
    token = bootstrapped["recovery_credential"]["token"]
    first_id = bootstrapped["workspace"]["id"]

    health = client.get("/health")
    assert health.json()["scope"] == "node"
    assert "mode" not in health.json()

    initial_node = client.get("/api/v1/node", headers=auth_headers(token, first_id))
    assert initial_node.status_code == 200, initial_node.text
    assert initial_node.json()["id"] == "test-physical-node"
    assert initial_node.json()["workspace_count"] == 1

    second = _create_second_workspace(client)
    selected = client.post(
        f"/api/v1/workspaces/{second['id']}:select",
        headers={"X-Neuromem-Workspace": second["id"]},
    )
    assert selected.status_code == 200, selected.text
    assert selected.json()["workspace"]["id"] == second["id"]
    assert selected.json()["context"]["workspace_id"] == second["id"]
    assert selected.json()["projects"][0]["is_general"] is True

    listed = client.get("/api/v1/workspaces")
    assert {workspace["id"] for workspace in listed.json()} == {
        first_id,
        second["id"],
    }
    assert all("kind" not in workspace for workspace in listed.json())
    node = client.get("/api/v1/node")
    assert node.json()["id"] == initial_node.json()["id"]
    assert node.json()["workspace_count"] == 2


def test_workspace_share_requires_both_owners_and_projects_are_projected(
    client, bootstrapped
):
    source_id = bootstrapped["workspace"]["id"]
    source_token = bootstrapped["recovery_credential"]["token"]
    target = _create_second_workspace(client)
    target_id = target["id"]
    project = client.post(
        f"/api/v1/workspaces/{source_id}/projects",
        headers=auth_headers(source_token, source_id),
        json={"slug": "shared-notes", "name": "Shared Notes"},
    ).json()

    proposed = client.post(
        "/api/v1/workspace-shares",
        headers=auth_headers(source_token, source_id),
        json={
            "recipient_workspace_id": target_id,
            "display_mode": "projects",
            "project_ids": [project["id"]],
        },
    )
    assert proposed.status_code == 200, proposed.text
    share = proposed.json()
    assert share["owner_workspace_id"] == source_id
    assert share["recipient_workspace_id"] == target_id
    assert share["status"] == "proposed"
    assert share["owner_approved_at"]
    assert share["recipient_approved_at"] is None
    assert share["project_refs"] == [{"id": project["id"], "name": "Shared Notes"}]

    hidden = client.get(
        "/api/v1/workspace-projections",
        headers={"X-Neuromem-Workspace": target_id},
    )
    assert hidden.status_code == 200
    assert hidden.json() == []

    invitation = client.post(
        f"/api/v1/workspaces/{target_id}/invitations",
        headers={"X-Neuromem-Workspace": target_id},
        json={"email": "target-admin@example.com", "role": "admin"},
    ).json()
    admin = client.post(
        "/api/v1/auth/invitations:accept",
        json={
            "token": invitation["token"],
            "display_name": "Target Admin",
            "password": "target-admin-password",
        },
    ).json()
    admin_denied = client.post(
        f"/api/v1/workspace-shares/{share['id']}:approve",
        headers=auth_headers(admin["recovery_credential"]["token"], target_id),
    )
    assert admin_denied.status_code == 403
    assert admin_denied.json()["detail"] == "workspace owner required"

    owner_login = client.post(
        "/api/v1/auth/login",
        json={"email": "owner@example.com", "password": "owner-password-123"},
    )
    assert owner_login.status_code == 200
    approved = client.post(
        f"/api/v1/workspace-shares/{share['id']}:approve",
        headers={"X-Neuromem-Workspace": target_id},
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "active"
    assert approved.json()["recipient_approved_at"]

    projection = client.get(
        "/api/v1/workspace-projections",
        headers={"X-Neuromem-Workspace": target_id},
    )
    assert projection.status_code == 200, projection.text
    assert projection.json() == [
        {
            "share_id": share["id"],
            "owner_workspace_id": source_id,
            "owner_workspace_name": bootstrapped["workspace"]["name"],
            "display_mode": "projects",
            "project_refs": [{"id": project["id"], "name": "Shared Notes"}],
        }
    ]

    revoked = client.post(
        f"/api/v1/workspace-shares/{share['id']}:revoke",
        headers={"X-Neuromem-Workspace": target_id},
    )
    assert revoked.status_code == 200, revoked.text
    assert revoked.json()["status"] == "revoked"
    assert (
        client.get(
            "/api/v1/workspace-projections",
            headers={"X-Neuromem-Workspace": target_id},
        ).json()
        == []
    )


def test_workspace_projection_tracks_current_projects_and_reproposal(
    client, bootstrapped
):
    source_id = bootstrapped["workspace"]["id"]
    source_token = bootstrapped["recovery_credential"]["token"]
    target = _create_second_workspace(client)
    target_id = target["id"]

    invalid = client.post(
        "/api/v1/workspace-shares",
        headers=auth_headers(source_token, source_id),
        json={
            "recipient_workspace_id": target_id,
            "display_mode": "projects",
            "project_ids": [],
        },
    )
    assert invalid.status_code == 422

    first = client.post(
        "/api/v1/workspace-shares",
        headers=auth_headers(source_token, source_id),
        json={
            "recipient_workspace_id": target_id,
            "display_mode": "workspace",
            "project_ids": [],
        },
    ).json()
    rejected = client.post(
        f"/api/v1/workspace-shares/{first['id']}:reject",
        headers={"X-Neuromem-Workspace": target_id},
    )
    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["status"] == "rejected"

    second = client.post(
        "/api/v1/workspace-shares",
        headers=auth_headers(source_token, source_id),
        json={
            "recipient_workspace_id": target_id,
            "display_mode": "workspace",
            "project_ids": [],
        },
    )
    assert second.status_code == 200, second.text
    share_id = second.json()["id"]
    client.post(
        f"/api/v1/workspace-shares/{share_id}:approve",
        headers={"X-Neuromem-Workspace": target_id},
    )

    added = client.post(
        f"/api/v1/workspaces/{source_id}/projects",
        headers=auth_headers(source_token, source_id),
        json={"slug": "added-later", "name": "Added Later"},
    )
    assert added.status_code == 200, added.text
    projection = client.get(
        "/api/v1/workspace-projections",
        headers={"X-Neuromem-Workspace": target_id},
    ).json()[0]
    assert projection["display_mode"] == "workspace"
    assert {project["name"] for project in projection["project_refs"]} == {
        "General",
        "Added Later",
    }
