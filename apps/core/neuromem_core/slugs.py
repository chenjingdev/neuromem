from __future__ import annotations

import hashlib
import unicodedata


def deterministic_slug(name: str, *, fallback_prefix: str = "item") -> str:
    normalized = unicodedata.normalize("NFKC", name).strip().casefold()
    pieces: list[str] = []
    pending_separator = False
    for character in normalized:
        if character.isalnum():
            if pending_separator and pieces:
                pieces.append("-")
            pieces.append(character)
            pending_separator = False
        else:
            pending_separator = True
    slug = "".join(pieces).strip("-")
    if not slug:
        digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:12]
        slug = f"{fallback_prefix}-{digest}"
    return slug[:128].rstrip("-")
