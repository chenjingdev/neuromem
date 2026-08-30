from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

import tiktoken


@dataclass(frozen=True)
class TextChunk:
    ordinal: int
    content: str
    token_start: int
    token_end: int
    token_count: int


@lru_cache(maxsize=1)
def _encoding() -> tiktoken.Encoding:
    return tiktoken.get_encoding("cl100k_base")


def chunk_text(
    value: str,
    *,
    max_tokens: int = 8000,
    overlap_ratio: float = 0.2,
) -> list[TextChunk]:
    if not value.strip():
        return []
    if max_tokens < 1:
        raise ValueError("max_tokens must be positive")
    if not 0 <= overlap_ratio < 0.5:
        raise ValueError("overlap_ratio must be in [0, 0.5)")

    encoding = _encoding()
    tokens = encoding.encode(value)
    if not tokens:
        return []

    overlap = int(max_tokens * overlap_ratio)
    step = max_tokens - overlap
    chunks: list[TextChunk] = []
    for ordinal, start in enumerate(range(0, len(tokens), step)):
        end = min(start + max_tokens, len(tokens))
        chunks.append(
            TextChunk(
                ordinal=ordinal,
                content=encoding.decode(tokens[start:end]),
                token_start=start,
                token_end=end,
                token_count=end - start,
            )
        )
        if end == len(tokens):
            break
    return chunks
