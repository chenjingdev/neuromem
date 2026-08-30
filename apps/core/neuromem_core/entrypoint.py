from __future__ import annotations

import argparse
import asyncio
import logging

import uvicorn

from .config import get_settings
from .db import dispose_engine
from .schema import initialize_blank_database, upgrade_schema, verify_schema
from .worker import run_worker


def _migrate(args: argparse.Namespace) -> None:
    if args.verify:
        report = asyncio.run(verify_schema(args.target))
        if not report.ok:
            for issue in report.issues:
                print(issue)
            raise SystemExit(1)
        print(f"schema verified at {report.current_revision}")
        return
    upgrade_schema(args.target)


async def _verify_runtime_schema():
    try:
        return await verify_schema("head")
    finally:
        await dispose_engine()


def main() -> None:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("api")
    subparsers.add_parser("worker")
    migrate = subparsers.add_parser("migrate")
    migrate.add_argument("--target", required=True)
    migrate.add_argument("--verify", action="store_true")
    args = parser.parse_args()

    settings = get_settings()
    logging.basicConfig(level=settings.log_level.upper())
    if args.command == "migrate":
        _migrate(args)
        return

    initialize_blank_database()
    report = asyncio.run(_verify_runtime_schema())
    if not report.ok:
        for issue in report.issues:
            logging.getLogger(__name__).error(issue)
        raise SystemExit(2)
    if args.command == "worker":
        asyncio.run(run_worker())
        return

    uvicorn.run("neuromem_core.app:app", host="0.0.0.0", port=8000)


if __name__ == "__main__":
    main()
