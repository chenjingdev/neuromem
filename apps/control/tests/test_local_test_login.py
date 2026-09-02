from __future__ import annotations

from fastapi.testclient import TestClient

from neuromem_control.config import get_settings


def test_local_test_login_prefill_is_disabled_by_default(
    client: TestClient,
) -> None:
    response = client.get(
        "/api/v1/auth/local-test-prefill",
        headers={"host": "localhost:24443"},
    )

    assert response.status_code == 404


def test_local_test_login_prefill_is_loopback_only_and_not_cached(
    client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setenv("NEUROMEM_CONTROL_LOCAL_TEST_LOGIN_PREFILL", "true")
    monkeypatch.setenv("NEUROMEM_CONTROL_LOCAL_TEST_LOGIN_EMAIL", "tester@example.com")
    monkeypatch.setenv(
        "NEUROMEM_CONTROL_LOCAL_TEST_LOGIN_PASSWORD",
        "local-test-password-123",
    )
    get_settings.cache_clear()

    response = client.get(
        "/api/v1/auth/local-test-prefill",
        headers={
            "host": "localhost:24443",
            "origin": "http://127.0.0.1:24443",
            "x-forwarded-for": "192.168.65.1",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "email": "tester@example.com",
        "password": "local-test-password-123",
    }
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["pragma"] == "no-cache"

    public_response = client.get(
        "/api/v1/auth/local-test-prefill",
        headers={"host": "memory.example.test"},
    )
    assert public_response.status_code == 404

    public_origin = client.get(
        "/api/v1/auth/local-test-prefill",
        headers={
            "host": "127.0.0.1:24443",
            "origin": "https://memory.example.test",
            "x-forwarded-for": "172.18.0.1",
        },
    )
    assert public_origin.status_code == 404

    spoofed_forwarded_for = client.get(
        "/api/v1/auth/local-test-prefill",
        headers={
            "host": "memory.example.test",
            "x-forwarded-for": "127.0.0.1, 203.0.113.9",
        },
    )
    assert spoofed_forwarded_for.status_code == 404

    assert (
        "/api/v1/auth/local-test-prefill"
        not in client.get("/openapi.json").json()["paths"]
    )
