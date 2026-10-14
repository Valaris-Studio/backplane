# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Ready the database for code from before rich capture (migration 119),
keeping the schema and every stored body.

The previous release fails to read any row naming the level `rich` or a
heartbeat with a rich_capture member, and its startup migration stops at a
revision it does not know. In one transaction this rewrites them exactly as
migration 119's downgrade does, without its drops, and stamps the previous
head (119 -> 118, only in a database 119 built). Safe to rerun.

The full runbook is in alembic/versions/119_session_contents.py. In short:
deploy the current image with rich capture off and min = max instances (set
in that deploy, so no later instance applies 119 again), run this (in
production a one-off Cloud Run job on that image), check alembic_version
reads 118, deploy the previous image at once; on "Can't locate revision
'119'", repeat. Deploying the new image again rolls forward.

Usage:
    source .venv/bin/activate
    python -m scripts.forget_rich           # what would change (dry run)
    python -m scripts.forget_rich --apply   # rewrite it
"""

from __future__ import annotations

import argparse
import asyncio
import importlib.util
from pathlib import Path

from app.config import settings
from app.database import build_engine

MIGRATION = (
    Path(__file__).resolve().parents[1] / "alembic/versions/119_session_contents.py"
)


def _migration():
    spec = importlib.util.spec_from_file_location(MIGRATION.stem, MIGRATION)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def _ready_for_previous_release(connection) -> dict[str, int]:
    migration = _migration()
    changed = migration.forget_rich(connection)
    changed["alembic head"] = migration.stamp_previous_release(connection)
    return changed


async def _run(apply: bool) -> dict[str, int]:
    # build_engine hides bound parameters, so captured values never reach
    # SQL diagnostics.
    engine = build_engine(settings.DATABASE_URL)
    try:
        async with engine.connect() as connection:
            transaction = await connection.begin()
            changed = await connection.run_sync(_ready_for_previous_release)
            if apply:
                await transaction.commit()
            else:
                await transaction.rollback()
            return changed
    finally:
        await engine.dispose()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--apply", action="store_true", help="commit the rewrite")
    args = parser.parse_args(argv)
    changed = asyncio.run(_run(args.apply))
    verb = "rewrote" if args.apply else "would rewrite"
    print(", ".join(f"{verb} {count} {name}" for name, count in changed.items()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
