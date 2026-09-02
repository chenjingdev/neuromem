from __future__ import annotations

import json

from sqlalchemy import select

from neuromem_control.app import app
from neuromem_control.db import get_session_factory
from neuromem_control.models import AuditEvent, ProjectFolderBinding
from neuromem_control.node_manager_client import (
    FolderPickResult,
    FolderSource,
    get_node_manager_client,
)

from .conftest import auth_headers


class FakeNodeManager:
    def __init__(self) -> None:
        self.picks: list[tuple[str, str, str]] = []
        self.detaches: list[tuple[str, str, str]] = []
        self.next_pick = FolderPickResult(
            cancelled=False,
            source=FolderSource(
                source_id="source-local-project-1",
                display_name="neuromem",
                display_path="~/dev/neuromem",
                status="active",
            ),
        )

    def pick_folder(self, *, node_id, context):
        self.picks.append((node_id, context.principal_id, context.project_id))
        return self.next_pick

    def detach_folder(self, *, node_id, context, source_id):
        self.detaches.append((node_id, context.principal_id, source_id))


def _headers(token: str, workspace_id: str, project_id: str) -> dict[str, str]:
    return {
        **auth_headers(token, workspace_id, project_id),
        "host": "localhost:24443",
    }


def _invite(client, owner_token: str, workspace_id: str, *, role: str):
    invitation = client.post(
        f"/api/v1/workspaces/{workspace_id}/invitations",
        headers=auth_headers(owner_token, workspace_id),
        json={"email": f"{role}@example.com", "role": role},
    )
    assert invitation.status_code == 200, invitation.text
    accepted = client.post(
        "/api/v1/auth/invitations:accept",
        json={
            "token": invitation.json()["token"],
            "display_name": role.title(),
            "password": "member-password-123",
        },
    )
    assert accepted.status_code == 200, accepted.text
    return accepted.json()


def test_project_folder_pick_cancel_and_disconnect_are_principal_scoped(
    client, bootstrapped
):
    manager = FakeNodeManager()
    app.dependency_overrides[get_node_manager_client] = lambda: manager
    try:
        token = bootstrapped["recovery_credential"]["token"]
        workspace_id = bootstrapped["workspace"]["id"]
        project_id = bootstrapped["general_project"]["id"]
        headers = _headers(token, workspace_id, project_id)

        empty = client.get(
            f"/api/v1/projects/{project_id}/local-folder", headers=headers
        )
        assert empty.status_code == 200
        assert empty.json() is None

        picked = client.post(
            f"/api/v1/projects/{project_id}/local-folder:pick", headers=headers
        )
        assert picked.status_code == 200, picked.text
        assert picked.json() == {
            "id": picked.json()["id"],
            "project_id": project_id,
            "display_name": "neuromem",
            "display_path": "~/dev/neuromem",
            "status": "active",
            "updated_at": picked.json()["updated_at"],
        }
        assert manager.picks == [
            ("test-physical-node", bootstrapped["principal"]["id"], project_id)
        ]

        manager.next_pick = FolderPickResult(cancelled=True)
        cancelled = client.post(
            f"/api/v1/projects/{project_id}/local-folder:pick", headers=headers
        )
        assert cancelled.status_code == 200
        assert cancelled.json() is None
        persisted = client.get(
            f"/api/v1/projects/{project_id}/local-folder", headers=headers
        )
        assert persisted.json()["display_path"] == "~/dev/neuromem"

        removed = client.delete(
            f"/api/v1/projects/{project_id}/local-folder", headers=headers
        )
        assert removed.status_code == 204
        assert manager.detaches == [
            (
                "test-physical-node",
                bootstrapped["principal"]["id"],
                "source-local-project-1",
            )
        ]
        with get_session_factory()() as db:
            assert db.scalar(select(ProjectFolderBinding)) is None
            audits = list(
                db.scalars(
                    select(AuditEvent).where(AuditEvent.action.like("project_folder.%"))
                )
            )
            assert [item.action for item in audits] == [
                "project_folder.connected",
                "project_folder.disconnected",
            ]
            assert "~/dev/neuromem" not in json.dumps([item.details for item in audits])
    finally:
        app.dependency_overrides.pop(get_node_manager_client, None)


def test_project_folder_picker_requires_local_project_write(client, bootstrapped):
    manager = FakeNodeManager()
    app.dependency_overrides[get_node_manager_client] = lambda: manager
    try:
        owner_token = bootstrapped["recovery_credential"]["token"]
        workspace_id = bootstrapped["workspace"]["id"]
        project_id = bootstrapped["general_project"]["id"]
        viewer = _invite(client, owner_token, workspace_id, role="viewer")
        viewer_headers = _headers(
            viewer["recovery_credential"]["token"], workspace_id, project_id
        )

        visible = client.get(
            f"/api/v1/projects/{project_id}/local-folder",
            headers=viewer_headers,
        )
        assert visible.status_code == 200
        denied = client.post(
            f"/api/v1/projects/{project_id}/local-folder:pick",
            headers=viewer_headers,
        )
        assert denied.status_code == 403

        public = client.post(
            f"/api/v1/projects/{project_id}/local-folder:pick",
            headers={
                **auth_headers(owner_token, workspace_id, project_id),
                "host": "memory.example.test",
            },
        )
        assert public.status_code == 404

        public_origin = client.post(
            f"/api/v1/projects/{project_id}/local-folder:pick",
            headers={
                **auth_headers(owner_token, workspace_id, project_id),
                "host": "127.0.0.1:24443",
                "origin": "https://memory.example.test",
                "x-forwarded-for": "172.18.0.1",
            },
        )
        assert public_origin.status_code == 404
        assert manager.picks == []
    finally:
        app.dependency_overrides.pop(get_node_manager_client, None)
