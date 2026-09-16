# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Wipe a workspace's persisted WorkspaceConfig row so it inherits the
platform DEFAULT_PIPELINE_CONFIG on the next read.

Operator tool for smoke-prep — see docs/pipeline-design/02-role-redesign.md
"Resolved decisions" #8: the pilot workspace had the only persisted
v3 config, byte-for-byte equal to the legacy 3-role default plus a single
`cleanup_review_notes` drift. After the 5-role redesign deploys, this script
deletes the row so the workspace adopts the new default.

Defaults to the demo workspace (slug `demo-workspace`). Parameterised so
any workspace can be reset by slug.

Usage:
    # Activate venv and run from backend/ directory
    source .venv/bin/activate

    # Dry run — show what would be deleted
    python -m scripts.reset_demo_pipeline_config --slug demo-workspace

    # Apply
    python -m scripts.reset_demo_pipeline_config --slug demo-workspace --yes

The script connects via app.config.settings.DATABASE_URL (same env the
backend uses). Idempotent: running twice is a no-op the second time.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings
from app.models.workspace import Workspace
from app.models.workspace_config import WorkspaceConfig


async def _reset_one(session: AsyncSession, slug: str, confirmed: bool) -> int:
    workspace = await session.scalar(select(Workspace).where(Workspace.slug == slug))
    if workspace is None:
        print(f"workspace slug={slug!r} not found", file=sys.stderr)
        return 2

    config = await session.scalar(
        select(WorkspaceConfig).where(WorkspaceConfig.workspace_id == workspace.id)
    )
    if config is None:
        print(f"workspace {slug!r}: no persisted WorkspaceConfig row — already inheriting defaults")
        return 0

    print(
        f"workspace {slug!r} (id={workspace.id}): persisted WorkspaceConfig "
        f"version={config.version}, pipeline_config_present={config.pipeline_config is not None}"
    )

    if not confirmed:
        print("dry run — pass --yes to actually delete the row")
        return 0

    await session.delete(config)
    await session.commit()
    print(f"workspace {slug!r}: WorkspaceConfig row deleted — will inherit DEFAULT_PIPELINE_CONFIG on next read")
    return 0


async def _main(slug: str, confirmed: bool) -> int:
    engine = create_async_engine(settings.DATABASE_URL, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with session_factory() as session:
            return await _reset_one(session, slug, confirmed)
    finally:
        await engine.dispose()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--slug",
        default="demo-workspace",
        help="workspace slug to reset (default: demo-workspace)",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="actually delete the row (default: dry run)",
    )
    args = parser.parse_args()
    raise SystemExit(asyncio.run(_main(args.slug, args.yes)))


if __name__ == "__main__":
    main()
