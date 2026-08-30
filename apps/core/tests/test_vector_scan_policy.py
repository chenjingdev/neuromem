from __future__ import annotations

import asyncio
from typing import Any

import pytest

from neuromem_core.config import Settings
from neuromem_core.queries import configure_vector_scan, restore_vector_scan


class RecordingSession:
    def __init__(self) -> None:
        self.statements: list[str] = []

    async def execute(self, statement: Any) -> None:
        self.statements.append(str(statement))


@pytest.fixture
def settings() -> Settings:
    return Settings(
        api_token="0123456789abcdef0123456789abcdef",
        hnsw_ef_search=100,
    )


@pytest.mark.parametrize("family", ["record", "claim"])
def test_small_vector_family_uses_exact_cosine_scan(
    family: str, settings: Settings
) -> None:
    session = RecordingSession()
    restore = asyncio.run(
        configure_vector_scan(
            session,
            active_vectors=25_000,
            settings=settings,  # type: ignore[arg-type]
        )
    )
    asyncio.run(restore_vector_scan(session, restore))  # type: ignore[arg-type]
    rendered = "\n".join(session.statements)
    assert family in {"record", "claim"}
    assert "enable_indexscan = off" in rendered
    assert "enable_indexscan = on" in rendered
    assert "iterative_scan" not in rendered


@pytest.mark.parametrize("family", ["record", "claim"])
def test_large_vector_family_uses_iterative_hnsw(
    family: str, settings: Settings
) -> None:
    session = RecordingSession()
    restore = asyncio.run(
        configure_vector_scan(
            session,
            active_vectors=25_001,
            settings=settings,  # type: ignore[arg-type]
        )
    )
    assert restore is False
    rendered = "\n".join(session.statements)
    assert family in {"record", "claim"}
    assert "iterative_scan" in rendered
    assert "ef_search = 100" in rendered
