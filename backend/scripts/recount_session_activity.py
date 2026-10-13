# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Fill agent_sessions.activity_event_count for sessions stored before
migration 115, counting their stored events.

Run once the rollout of 115 has finished, when no pod of the previous release
still ingests. Until then nothing is wrong: reads count uncounted sessions
from their events and the next ingest fills them. `--all` recounts every
session, which repairs one the previous release added activity to after the
new release had counted it. Safe to rerun; one session per transaction, under
the same row lock ingest takes.

Usage:
    source .venv/bin/activate
    python -m scripts.recount_session_activity                # count uncounted (dry run)
    python -m scripts.recount_session_activity --apply        # fill them
    python -m scripts.recount_session_activity --apply --all  # recount every session
"""

from __future__ import annotations

import argparse
import asyncio

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.config import settings
from app.models.agent_session import AgentSession
from app.services.agent_session import recount_next_session_activity


async def _run(apply: bool, every_session: bool) -> int:
    engine = create_async_engine(settings.DATABASE_URL, pool_pre_ping=True)
    sessions = async_sessionmaker(engine, expire_on_commit=False)
    try:
        if not apply:
            async with sessions() as db:
                query = select(func.count()).select_from(AgentSession)
                if not every_session:
                    query = query.where(AgentSession.activity_event_count.is_(None))
                return await db.scalar(query)
        recounted, after = 0, None
        while True:
            async with sessions() as db, db.begin():
                after = await recount_next_session_activity(
                    db, after, only_unknown=not every_session
                )
            if after is None:
                return recounted
            recounted += 1
    finally:
        await engine.dispose()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--apply", action="store_true", help="write (default: count only)"
    )
    parser.add_argument(
        "--all", action="store_true", help="every session, not only uncounted ones"
    )
    args = parser.parse_args(argv)
    count = asyncio.run(_run(args.apply, args.all))
    scope = "sessions" if args.all else "uncounted sessions"
    verb = "recounted" if args.apply else "to recount (dry run)"
    print(f"{count} {scope} {verb}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
