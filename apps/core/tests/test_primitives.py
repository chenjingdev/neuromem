from __future__ import annotations

import asyncio
import uuid
from types import SimpleNamespace

import httpx
import pytest
from openai import APIConnectionError

from neuromem_core.chunking import chunk_text
from neuromem_core.config import Settings
from neuromem_core.content import canonical_content, content_hash, normalized_claim
from neuromem_core.ids import uuid7, uuid7_timestamp_ms
from neuromem_core.providers import ModelProviders, TransientProviderError
from neuromem_core.ranking import reciprocal_rank_fusion
from neuromem_core.slugs import deterministic_slug


def test_uuid7_is_ordered_and_rfc_shaped() -> None:
    values = [uuid7() for _ in range(100)]
    assert values == sorted(values)
    assert all(value.version == 7 for value in values)
    assert all(value.variant == uuid.RFC_4122 for value in values)
    assert all(uuid7_timestamp_ms(value) > 0 for value in values)


def test_uuid7_timestamp_rejects_other_versions() -> None:
    with pytest.raises(ValueError):
        uuid7_timestamp_ms(uuid.uuid4())


def test_content_hash_normalizes_transport_only() -> None:
    assert canonical_content("caf\u00e9\r\nnext") == "caf\u00e9\nnext"
    assert content_hash("cafe\u0301\r\nnext") == content_hash("caf\u00e9\nnext")
    assert content_hash(" value ") != content_hash("value")
    assert normalized_claim("  A\n  DECISION ") == "a decision"


def test_chunking_is_deterministic_and_overlapping() -> None:
    text = " ".join(f"token-{index}" for index in range(500))
    first = chunk_text(text, max_tokens=128, overlap_ratio=0.2)
    second = chunk_text(text, max_tokens=128, overlap_ratio=0.2)
    assert first == second
    assert len(first) > 1
    assert first[1].token_start < first[0].token_end
    assert all(chunk.token_count <= 128 for chunk in first)
    assert [chunk.ordinal for chunk in first] == list(range(len(first)))


def test_blank_content_has_no_search_segments() -> None:
    assert chunk_text("   ") == []


def test_rrf_deduplicates_within_each_ranked_list() -> None:
    fused = reciprocal_rank_fusion([["a", "a", "b"], ["b", "c", "a"]], limit=3, k=60)
    assert [key for key, _score in fused] == ["a", "b", "c"]


def test_unicode_slug_is_stable() -> None:
    assert deterministic_slug("뉴로멤 개인") == "뉴로멤-개인"
    assert deterministic_slug("***", fallback_prefix="project").startswith("project-")


def test_provider_network_failure_is_retryable_without_burning_job_attempts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FailingEmbeddings:
        async def create(self, **_: object) -> None:
            raise APIConnectionError(
                request=httpx.Request("POST", "http://model/v1/embeddings")
            )

    monkeypatch.setattr(
        ModelProviders,
        "_embedding_client",
        lambda _self: SimpleNamespace(embeddings=FailingEmbeddings()),
    )
    provider = ModelProviders(
        Settings(
            api_token="0123456789abcdef0123456789abcdef",
            embedding_base_url="http://model/v1",
            embedding_model="embedding-model",
        )
    )
    with pytest.raises(TransientProviderError):
        asyncio.run(provider.embed_texts(["retry me"]))
