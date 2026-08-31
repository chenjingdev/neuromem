from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from neuromem_control.app import app
from neuromem_control.config import get_settings
from neuromem_control.db import reset_database_caches


@pytest.fixture
def client(tmp_path, monkeypatch):
    reset_database_caches()
    monkeypatch.setenv(
        "NEUROMEM_CONTROL_DATABASE_URL", f"sqlite:///{tmp_path / 'control.db'}"
    )
    monkeypatch.setenv(
        "NEUROMEM_CONTROL_SECRET_KEY",
        "test-control-secret-0123456789abcdef0123456789abcdef",
    )
    monkeypatch.setenv("NEUROMEM_CONTROL_AUTO_CREATE_SCHEMA", "true")
    monkeypatch.setenv("NEUROMEM_CONTROL_SECURE_COOKIES", "false")
    get_settings.cache_clear()
    with TestClient(app) as test_client:
        yield test_client
    reset_database_caches()
    get_settings.cache_clear()


@pytest.fixture
def bootstrapped(client):
    response = client.post(
        "/api/v1/auth/bootstrap",
        json={
            "email": "owner@example.com",
            "display_name": "Owner",
            "password": "owner-password-123",
            "workspace_slug": "owner-home",
            "workspace_name": "Owner Home",
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def auth_headers(token: str, workspace_id: str, project_id: str | None = None):
    headers = {
        "Authorization": f"Bearer {token}",
        "X-Neuromem-Workspace": workspace_id,
    }
    if project_id:
        headers["X-Neuromem-Project"] = project_id
    return headers
