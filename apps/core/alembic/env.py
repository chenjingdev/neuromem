from __future__ import annotations

import asyncio
from logging.config import fileConfig

from sqlalchemy import pool, text
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from alembic import context
from neuromem_core.config import get_settings
from neuromem_core.models import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)
config.set_main_option("sqlalchemy.url", get_settings().database_url)
target_metadata = Base.metadata


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        compare_type=True,
        transaction_per_migration=True,
    )
    with context.begin_transaction():
        connection.execute(
            text("SELECT pg_advisory_xact_lock(hashtext('neuromem-core-migration'))")
        )
        if config.attributes.get("initialize_blank_only"):
            core_tables = connection.execute(
                text(
                    """
                    SELECT count(*)
                    FROM pg_catalog.pg_tables
                    WHERE schemaname = current_schema()
                      AND tablename = ANY(:tables)
                    """
                ),
                {
                    "tables": [
                        "workspaces",
                        "projects",
                        "peers",
                        "sessions",
                        "records",
                        "claims",
                        "jobs",
                    ]
                },
            ).scalar_one()
            if core_tables:
                return
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    supplied_connection = config.attributes.get("connection")
    if supplied_connection is not None:
        do_run_migrations(supplied_connection)
    else:
        asyncio.run(run_async_migrations())


run_migrations_online()
