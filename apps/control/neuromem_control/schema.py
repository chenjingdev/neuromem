from __future__ import annotations

from .db import get_engine
from .models import Base


def main() -> None:
    """Initialize a new Control Plane schema without touching Memory Core data."""
    Base.metadata.create_all(get_engine())


if __name__ == "__main__":
    main()
