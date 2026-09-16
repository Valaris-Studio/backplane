# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""One-shot: apply the demo-double-llm split to the live demo workspace.

PIPELINE-UI-CLARITY Phase 5. The new lifecycle-builder UI (Phases 2 + 3) shows
one prompt row per `kind: llm` step on the role card and a header summary of
the step count per role. The platform DEFAULT_PIPELINE_CONFIG ships every role
with exactly one LLM step today, so the new per-step rendering looks identical
to the legacy single-prompt-per-role view.

This script splits the planner role in the demo workspace into TWO
`kind: llm` steps (`scope_llm` -> `plan_llm`) so the new UI demonstrably
surfaces what the legacy view hid. The converter is a pure function (tested
at `tests/services/test_pipeline_config_demo.py`); this script is
the OCC-versioned DB shim around it.

Hardcoded to workspace slug `demo-workspace` — the converter is platform-safe but
the demo intent is workspace-scoped. DEFAULT_PIPELINE_CONFIG is NOT modified.

Usage:
    source .venv/bin/activate

    # Dry-run (default): print before/after diff, no DB write
    python -m scripts.apply_demo_double_llm

    # Apply with interactive confirmation
    python -m scripts.apply_demo_double_llm --apply

    # Non-interactive apply (CI / scripted runs)
    python -m scripts.apply_demo_double_llm --apply --yes

Pre-apply validation: the synthesized config is run through
`validate_pipeline_config` before persistence. A validation failure aborts
the run with exit code 2 — the workspace stays on its pre-apply state.

OCC: reads `WorkspaceConfig.version`, writes `version + 1`. Matches the
`WorkspaceConfigService.update_config` path so concurrent writes raise an
integrity error instead of silently overwriting.

Idempotency: re-running the script after a successful apply detects the
split is already in place (`applied=False, reason="already_applied"`), logs
the no-op, and exits 0 without bumping the version.

Operator note: production runs require pointing `DATABASE_URL` at the prod
Cloud SQL instance via cloud-sql-proxy on port 5434 (matching the convention
used by `backfill_pipeline_config_lifecycle.py`).
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import sys

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings
from app.models.workspace import Workspace
from app.models.workspace_config import WorkspaceConfig
from app.services.pipeline_config_demo import apply_demo_double_llm
from app.services.pipeline_config_validation import (
    canonicalize_pipeline_config,
    validate_pipeline_config,
)

logger = logging.getLogger("apply_demo_double_llm")

# Hardcoded — the script is intentionally workspace-specific. To apply the
# same converter to another workspace, copy this script and change the slug.
# The converter itself is generic and lives in pipeline_config_demo.
_TARGET_SLUG = "demo-workspace"


def _fingerprint(config: dict | None) -> str:
    if config is None:
        return "none"
    raw = json.dumps(config, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


async def _run(*, apply: bool) -> int:
    """Return process exit code: 0 success/no-op, 1 missing workspace,
    2 validation failure, 3 missing pipeline_config row."""
    engine = create_async_engine(settings.DATABASE_URL, pool_pre_ping=True)
    session_factory = async_sessionmaker(engine, expire_on_commit=False)

    try:
        async with session_factory() as session:
            return await _apply_to_demo_workspace(session, apply=apply)
    finally:
        await engine.dispose()


async def _apply_to_demo_workspace(session: AsyncSession, *, apply: bool) -> int:
    workspace = await session.scalar(
        select(Workspace).where(Workspace.slug == _TARGET_SLUG)
    )
    if workspace is None:
        logger.error("workspace slug=%r not found", _TARGET_SLUG)
        return 1

    config_row = await session.scalar(
        select(WorkspaceConfig).where(WorkspaceConfig.workspace_id == workspace.id)
    )
    if config_row is None or config_row.pipeline_config is None:
        # A workspace without a persisted pipeline_config inherits DEFAULT,
        # which doesn't carry the demo split. The script could synthesize a
        # row here, but the safer path is to require the operator to first
        # persist a copy of DEFAULT (via the UI or reset_demo_pipeline_config
        # in reverse) — otherwise a typo in the slug silently creates a row.
        logger.error(
            "workspace %r has no persisted WorkspaceConfig.pipeline_config — "
            "persist a copy of DEFAULT_PIPELINE_CONFIG first (e.g. open the "
            "lifecycle builder UI and save), then re-run",
            _TARGET_SLUG,
        )
        return 3

    old_config = config_row.pipeline_config
    new_config, summary = apply_demo_double_llm(old_config)

    before_fp = _fingerprint(old_config)
    after_fp = _fingerprint(new_config)

    if not summary.applied:
        logger.info(
            "workspace=%s NO-OP reason=%s version=%d fingerprint=%s",
            _TARGET_SLUG,
            summary.reason,
            config_row.version,
            before_fp,
        )
        return 0

    logger.info(
        "workspace=%s WOULD CHANGE reason=%s version=%d before=%s after=%s",
        _TARGET_SLUG,
        summary.reason,
        config_row.version,
        before_fp,
        after_fp,
    )

    canonicalize_pipeline_config(new_config)
    findings = validate_pipeline_config(new_config)
    blocking = [f for f in findings if f.get("severity", "error") == "error"]
    if blocking:
        logger.error(
            "workspace=%s synthesized config FAILED validation; aborting",
            _TARGET_SLUG,
        )
        for err in blocking:
            logger.error("  %s: %s", err.get("field", "?"), err.get("message", ""))
        return 2

    if not apply:
        logger.info("dry-run — pass --apply to persist")
        return 0

    config_row.pipeline_config = new_config
    config_row.version = (config_row.version or 0) + 1
    await session.flush()
    await session.commit()
    logger.info(
        "workspace=%s PERSISTED new_version=%d after=%s",
        _TARGET_SLUG,
        config_row.version,
        after_fp,
    )
    return 0


def _confirm_or_exit() -> None:
    """Interactive guard for --apply runs without --yes. Refuses ambiguous
    answers — operator must type 'yes' verbatim to proceed."""
    answer = input("Apply demo-double-llm split to demo-workspace? Type 'yes' to confirm: ").strip()
    if answer != "yes":
        print("aborted — no changes written", file=sys.stderr)
        raise SystemExit(1)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
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

    logging.basicConfig(level=args.log_level, format="%(levelname)s %(message)s")

    if args.apply and not args.yes:
        _confirm_or_exit()

    raise SystemExit(asyncio.run(_run(apply=args.apply)))


if __name__ == "__main__":
    main()
