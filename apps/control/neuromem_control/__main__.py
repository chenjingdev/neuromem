from __future__ import annotations

import os

import uvicorn


def main() -> None:
    uvicorn.run(
        "neuromem_control.app:app",
        host="0.0.0.0",
        port=int(os.environ.get("NEUROMEM_CONTROL_PORT", "8000")),
    )


if __name__ == "__main__":
    main()
