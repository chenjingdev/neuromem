from __future__ import annotations

from collections.abc import Hashable, Iterable
from dataclasses import dataclass


@dataclass(frozen=True)
class RankedKey:
    key: Hashable
    score: float
    rank: int


def reciprocal_rank_fusion[K: Hashable](
    ranked_lists: Iterable[Iterable[K]],
    *,
    limit: int,
    k: int = 60,
) -> list[tuple[K, float]]:
    if limit < 1:
        return []
    scores: dict[K, float] = {}
    first_seen: dict[K, int] = {}
    order = 0
    for values in ranked_lists:
        seen_in_list: set[K] = set()
        for rank, key in enumerate(values, start=1):
            if key in seen_in_list:
                continue
            seen_in_list.add(key)
            first_seen.setdefault(key, order)
            order += 1
            scores[key] = scores.get(key, 0.0) + 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda item: (-item[1], first_seen[item[0]]))[
        :limit
    ]
