# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""One-shot backfill: synthesize a lifecycle[] for legacy pipeline configs.

The frontend's pipeline builder is moving off the legacy single-`llm`-per-role
shape onto the lifecycle DSL. Workspaces whose `pipeline_config` predates the
2026-05-16 redesign hold a legacy `stages[].llm` block without a companion
`lifecycle[]` array — those render as empty role cards on the new lifecycle
page even though the legacy data is live in the DB.

This script walks every workspace's stored WorkspaceConfig, runs the converter
in `app.services.pipeline_config_backfill`, and persists the changed config
through the existing OCC-versioned update path. Pure-function tests for the
converter live at `tests/services/test_pipeline_config_backfill.py` — this
script is the thin DB shim around them.

Usage:
    source .venv/bin/activate

    # Inspect every workspace (dry-run, default)
    python -m scripts.backfill_pipeline_config_lifecycle

    # Inspect one workspace
    python -m scripts.backfill_pipeline_config_lifecycle --workspace demo-workspace

    # Persist changes for every workspace (interactive confirmation)
    python -m scripts.backfill_pipeline_config_lifecycle --apply

    # Non-interactive apply (CI / scripted runs)
    python -m scripts.backfill_pipeline_config_lifecycle --apply --yes

Pre-apply validation: every synthesized config is run through
`validate_pipeline_config` before persistence; configs that fail validation
are reported and skipped (the workspace stays on its pre-backfill state).

OCC: the script reads `WorkspaceConfig.version` and writes `version + 1`,
matching the WorkspaceConfigService.update_config path. A concurrent write
between read and write raises an integrity error that surfaces in the log.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import sys
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings
from app.models.workspace import Workspace
from app.models.workspace_config import WorkspaceConfig
from app.services.pipeline_config_backfill import backfill_lifecycle
from app.services.pipeline_config_validation import (
    canonicalize_pipeline_config,
    validate_pipeline_config,
)

logger = logging.getLogger("backfill_pipeline_config_lifecycle")


@dataclass
class RunTotals:
    """Cross-workspace tallies printed at the end of the run."""

    workspaces_inspected: int = 0
    workspaces_changed: int = 0
    workspaces_skipped_invalid: int = 0
    stages_migrated: int = 0
    stages_skipped_conservative: int = 0
    stages_already_lifecycle: int = 0
    failures: list[str] = field(default_factory=list)


def _fingerprint(config: dict | None) -> str:
    """Deterministic short hash of a config — for before/after audit lines.

    JSON sort + sha256 truncated to 12 chars. Stable across processes;
    operators can grep the log for the fingerprint to confirm a specific
    revision shipped.
    """
    if config is None:
        return "none"
    raw = json.dumps(config, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


async def _process_workspace(
    session: AsyncSession,
    workspace: Workspace,
    config_row: WorkspaceConfig,
    *,
    apply: bool,
    totals: RunTotals,
) -> None:
    slug = workspace.slug
    old_config = config_row.pipeline_config or {}
    new_config, summary = backfill_lifecycle(old_config)

    totals.stages_migrated += summary.stages_migrated
    totals.stages_skipped_conservative += summary.stages_skipped_conservative
    totals.stages_already_lifecycle += summary.stages_already_lifecycle

    changed = new_config != old_config
    if not changed:
        logger.info(
            "workspace=%s no change (already=%d, conservative=%d)",
            slug,
            summary.stages_already_lifecycle,
            summary.stages_skipped_conservative,
        )
        for note in summary.notes:
            logger.info("  note: %s", note)
        return

    before_fp = _fingerprint(old_config)
    after_fp = _fingerprint(new_config)
    logger.info(
        "workspace=%s WOULD CHANGE migrated=%d skipped=%d already=%d "
        "version=%d before=%s after=%s",
        slug,
        summary.stages_migrated,
        summary.stages_skipped_conservative,
        summary.stages_already_lifecycle,
        config_row.version,
        before_fp,
        after_fp,
    )
    for note in summary.notes:
        logger.info("  note: %s", note)

    # Canonicalize + validate the synthesized config the same way
    # WorkspaceConfigService.update_config does. If validation fails we leave
    # the workspace on its pre-backfill config; persisting an invalid config
    # would break /next-assignment for that workspace.
    canonicalize_pipeline_config(new_config)
    errors = [
        e for e in validate_pipeline_config(new_config)
        if e.get("severity", "error") == "error"
    ]
    if errors:
        totals.workspaces_skipped_invalid += 1
        totals.failures.append(slug)
        logger.error(
            "workspace=%s synthesized config FAILED validation; not persisting",
            slug,
        )
        for err in errors:
            logger.error("  %s: %s", err.get("field", "?"), err.get("message", ""))
        return

    totals.workspaces_changed += 1

    if not apply:
        return

    config_row.pipeline_config = new_config
    config_row.version = (config_row.version or 0) + 1
    await session.flush()
    logger.info(
        "workspace=%s PERSISTED new_version=%d", slug, config_row.version
    )


async def _run(
    *,
    target_slug: str | None,
    apply: bool,
) -> RunTotals:
    engine = create_async_engine(settings.DATABASE_URL, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    totals = RunTotals()

    try:
        async with session_factory() as session:
            # Load every WorkspaceConfig that has a pipeline_config set. Rows
            # without one inherit DEFAULT_PIPELINE_CONFIG at read-time and need
            # no migration — see WorkspaceConfigService.get_config.
            stmt = (
                select(WorkspaceConfig, Workspace)
                .join(Workspace, Workspace.id == WorkspaceConfig.workspace_id)
                .where(WorkspaceConfig.pipeline_config.is_not(None))
            )
            if target_slug is not None:
                stmt = stmt.where(Workspace.slug == target_slug)
            stmt = stmt.order_by(Workspace.slug)

            rows = (await session.execute(stmt)).all()
            if not rows:
                if target_slug:
                    logger.warning(
                        "no workspace found with slug=%s (or no pipeline_config persisted)",
                        target_slug,
                    )
                else:
                    logger.warning("no workspace has a persisted pipeline_config")
                return totals

            for config_row, workspace in rows:
                totals.workspaces_inspected += 1
                await _process_workspace(
                    session,
                    workspace,
                    config_row,
                    apply=apply,
                    totals=totals,
                )

            if apply:
                await session.commit()
            else:
                await session.rollback()
    finally:
        await engine.dispose()

    return totals


def _print_summary(totals: RunTotals, *, apply: bool) -> None:
    mode = "APPLIED" if apply else "DRY-RUN"
    print()
    print(f"=== backfill summary ({mode}) ===")
    print(f"workspaces inspected           : {totals.workspaces_inspected}")
    print(
        f"workspaces {'changed' if apply else 'would change'}     : "
        f"{totals.workspaces_changed}"
    )
    print(f"workspaces skipped (invalid)   : {totals.workspaces_skipped_invalid}")
    print(f"stages migrated                : {totals.stages_migrated}")
    print(f"stages skipped (conservative)  : {totals.stages_skipped_conservative}")
    print(f"stages already lifecycle       : {totals.stages_already_lifecycle}")
    if totals.failures:
        print(f"failed workspaces              : {', '.join(totals.failures)}")


def _confirm_or_exit() -> None:
    """Interactive guard for --apply runs without --yes. Refuses ambiguous
    answers — operator must type 'yes' verbatim to proceed."""
    answer = input("Apply these changes? Type 'yes' to confirm: ").strip()
    if answer != "yes":
        print("aborted — no changes written", file=sys.stderr)
        raise SystemExit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--workspace",
        default=None,
        help="Scope to one workspace slug (default: every workspace)",
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="Persist changes (default: dry-run; print what would change)",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip interactive confirmation when --apply is set",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=("DEBUG", "INFO", "WARNING", "ERROR"),
        help="Log level (default: INFO)",
    )
    args = parser.parse_args()

    logging.basicConfig(
        level=args.log_level,
        format="%(levelname)s %(message)s",
    )

    if args.apply and not args.yes:
        _confirm_or_exit()

    totals = asyncio.run(_run(target_slug=args.workspace, apply=args.apply))
    _print_summary(totals, apply=args.apply)

    # Non-zero exit when any workspace failed validation — the operator's
    # CI hook needs a signal to surface the failure.
    if totals.failures:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
