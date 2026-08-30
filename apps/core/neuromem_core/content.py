from __future__ import annotations

import hashlib
import unicodedata


def canonical_content(value: str) -> str:
    """Normalize transport differences without discarding meaningful whitespace."""
    return unicodedata.normalize("NFC", value.replace("\r\n", "\n").replace("\r", "\n"))


def content_hash(value: str) -> str:
    return hashlib.sha256(canonical_content(value).encode("utf-8")).hexdigest()


def normalized_claim(value: str) -> str:
    return " ".join(canonical_content(value).strip().casefold().split())
