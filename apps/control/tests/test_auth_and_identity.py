from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import select

from neuromem_control.config import get_settings
from neuromem_control.db import get_session_factory
from neuromem_control.models import Credential, PrincipalPeerLink
from neuromem_control.schemas import AuthContext
from neuromem_control.security import InternalTokenSigner

from .conftest import auth_headers


def test_bootstrap_creates_uuid7_general_peer_and_hashes_secret(client, bootstrapped):
    workspace = bootstrapped["workspace"]
    project = bootstrapped["general_project"]
    peer = bootstrapped["human_peer"]
    raw = bootstrapped["recovery_credential"]["token"]

    assert uuid.UUID(workspace["id"]).version == 7
    assert uuid.UUID(project["id"]).version == 7
    assert uuid.UUID(project["wiki_id"]).version == 7
    assert project["is_general"] is True
    assert peer["kind"] == "human"
    assert peer["workspace_id"] == workspace["id"]

    with get_session_factory()() as db:
        stored = db.scalar(select(Credential))
        assert stored is not None
        assert stored.token_digest != raw
        assert raw not in stored.token_digest

    second = client.post(
        "/api/v1/auth/bootstrap",
        json={
            "email": "other@example.com",
            "display_name": "Other",
            "password": "other-password-123",
            "workspace_slug": "other-home",
            "workspace_name": "Other Home",
        },
    )
    assert second.status_code == 409


def test_invitation_is_one_time_and_creates_workspace_specific_human_peer(
    client, bootstrapped
):
    owner_token = bootstrapped["recovery_credential"]["token"]
    workspace_id = bootstrapped["workspace"]["id"]
    invitation = client.post(
        f"/api/v1/workspaces/{workspace_id}/invitations",
        headers=auth_headers(owner_token, workspace_id),
        json={"email": "member@example.com", "role": "contributor"},
    )
    assert invitation.status_code == 200, invitation.text
    invite_token = invitation.json()["token"]

    accepted = client.post(
        "/api/v1/auth/invitations:accept",
        json={
            "token": invite_token,
            "display_name": "Member",
            "password": "member-password-123",
        },
    )
    assert accepted.status_code == 200, accepted.text
    data = accepted.json()
    assert data["context"]["workspace_id"] == workspace_id
    assert data["human_peer"]["id"] != bootstrapped["human_peer"]["id"]

    reused = client.post(
        "/api/v1/auth/invitations:accept",
        json={
            "token": invite_token,
            "display_name": "Member",
            "password": "member-password-123",
        },
    )
    assert reused.status_code == 400

    with get_session_factory()() as db:
        links = list(
            db.scalars(
                select(PrincipalPeerLink).where(
                    PrincipalPeerLink.workspace_id == workspace_id
                )
            )
        )
        assert len(links) == 2


def test_last_owner_cannot_be_demoted(client, bootstrapped):
    token = bootstrapped["recovery_credential"]["token"]
    workspace_id = bootstrapped["workspace"]["id"]
    headers = auth_headers(token, workspace_id)
    memberships = client.get(
        f"/api/v1/workspaces/{workspace_id}/members", headers=headers
    ).json()
    owner = next(item for item in memberships if item["role"] == "owner")
    response = client.patch(
        f"/api/v1/workspaces/{workspace_id}/members/{owner['id']}",
        headers=headers,
        json={"role": "admin"},
    )
    assert response.status_code == 409
    assert "last active owner" in response.json()["detail"]


def test_agent_credential_is_bound_server_side(client, bootstrapped):
    token = bootstrapped["recovery_credential"]["token"]
    workspace_id = bootstrapped["workspace"]["id"]
    project_id = bootstrapped["general_project"]["id"]
    headers = auth_headers(token, workspace_id)
    created = client.post(
        f"/api/v1/workspaces/{workspace_id}/agent-peers",
        headers=headers,
        json={"name": "Owner Codex", "client": "codex", "owner": "principal"},
    )
    assert created.status_code == 200, created.text
    peer_id = created.json()["peer"]["id"]
    credential = client.post(
        "/api/v1/credentials",
        headers=headers,
        json={
            "name": "Codex MCP",
            "kind": "mcp",
            "agent_peer_id": peer_id,
            "capabilities": ["project.read", "project.write"],
            "project_ids": [project_id],
        },
    )
    assert credential.status_code == 200, credential.text
    agent_token = credential.json()["token"]
    context = client.get("/api/v1/me", headers=auth_headers(agent_token, workspace_id))
    assert context.status_code == 200
    assert context.json()["context"]["agent_peer_id"] == peer_id
    assert context.json()["context"]["project_id"] == project_id
    assert (
        context.json()["context"]["human_peer_id"] == bootstrapped["human_peer"]["id"]
    )


def test_internal_context_token_is_narrowed_signed_and_expires(client, bootstrapped):
    token = bootstrapped["recovery_credential"]["token"]
    workspace_id = bootstrapped["workspace"]["id"]
    project_id = bootstrapped["general_project"]["id"]
    response = client.post(
        "/api/v1/internal-context-tokens",
        headers=auth_headers(token, workspace_id, project_id),
        json={
            "workspace_id": workspace_id,
            "project_id": project_id,
            "requested_capabilities": ["project.read"],
        },
    )
    assert response.status_code == 200, response.text
    signed = response.json()["token"]
    signer = InternalTokenSigner(get_settings().secret_key)
    context = signer.verify(signed)
    assert isinstance(context, AuthContext)
    assert context.capabilities == ["project.read"]
    assert context.workspace_id == workspace_id

    parts = signed.split(".")
    tampered = f"{parts[0]}.{parts[1]}x.{parts[2]}"
    try:
        signer.verify(tampered)
    except ValueError:
        pass
    else:
        raise AssertionError("tampered token was accepted")

    future = dt.datetime.now(dt.UTC).replace(tzinfo=None) + dt.timedelta(minutes=2)
    try:
        signer.verify(signed, now=future)
    except ValueError:
        pass
    else:
        raise AssertionError("expired token was accepted")
