# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Re-estimate agent-session usage priced under an older price table.

Every usage row stores the price_table_version it was estimated with. After
`scripts.refresh_price_tables` bumps the vendored tables, this re-prices the
rows whose version differs and refreshes their sessions' cost rollups.
Agent-reported costs are never touched. Safe to rerun.

Usage:
    source .venv/bin/activate
    python -m scripts.reprice_agent_usage            # count stale rows (dry run)
    python -m scripts.reprice_agent_usage --apply    # reprice them
"""

from __future__ import annotations

import argparse
import asyncio

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.config import settings
from app.models.agent_session import AgentSessionUsage
from app.pricing import current_price_table
from app.services.agent_usage import reprice_next_session


async def _run(apply: bool) -> int:
    engine = create_async_engine(settings.DATABASE_URL, pool_pre_ping=True)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    version = current_price_table().version
    try:
        if not apply:
            async with sessions() as db:
                return await db.scalar(
                    select(func.count())
                    .select_from(AgentSessionUsage)
                    .where(
                        or_(
                            AgentSessionUsage.price_table_version.is_(None),
                            AgentSessionUsage.price_table_version != version,
                        )
                    )
                )
        repriced = 0
        while True:
            # One committed transaction per agent session: each holds a
            # single session lock, so it can never deadlock with ingest.
            async with sessions() as db, db.begin():
                count = await reprice_next_session(db)
            if not count:
                return repriced
            repriced += count
    finally:
        await engine.dispose()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--apply", action="store_true", help="reprice (default: count only)"
    )
    args = parser.parse_args(argv)
    count = asyncio.run(_run(args.apply))
    verb = "repriced" if args.apply else "priced under another table (dry run)"
    print(f"{count} usage rows {verb}; current table {current_price_table().version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
