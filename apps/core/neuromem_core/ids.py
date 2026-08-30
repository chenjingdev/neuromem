from __future__ import annotations

import secrets
import threading
import time
import uuid

_lock = threading.Lock()
_last_ms = -1
_last_random = 0
_RANDOM_MASK = (1 << 74) - 1


def uuid7() -> uuid.UUID:
    """Return a monotonic UUIDv7 value as defined by RFC 9562."""
    global _last_ms, _last_random

    now_ms = time.time_ns() // 1_000_000
    with _lock:
        if now_ms > _last_ms:
            _last_ms = now_ms
            _last_random = secrets.randbits(74)
        else:
            now_ms = _last_ms
            _last_random = (_last_random + 1) & _RANDOM_MASK
            if _last_random == 0:
                _last_ms += 1
                now_ms = _last_ms

        rand_a = (_last_random >> 62) & 0xFFF
        rand_b = _last_random & ((1 << 62) - 1)
        value = (
            ((now_ms & ((1 << 48) - 1)) << 80)
            | (0x7 << 76)
            | (rand_a << 64)
            | (0b10 << 62)
            | rand_b
        )
    return uuid.UUID(int=value)


def uuid7_timestamp_ms(value: uuid.UUID) -> int:
    if value.version != 7:
        raise ValueError("UUID is not version 7")
    return value.int >> 80
