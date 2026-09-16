# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Loop-config `skills_proposal_enabled` flag — Skills Registry W2.

RED phase. The Go runner json.Unmarshal's the served config, and a missing
bool decodes as false — so the flag must exist in LOOP_CONFIG_DEFAULTS and
canonicalize_loop_config must inject it into every legacy stored config;
relying on a Go-side default would silently flip the feature off for every
board saved before this field existed.

Serve-side rail: with the flag off, the config the runner reads must not hand
the session the propose tool at all — the allowlist is stripped on READ, and
the stored row is never mutated by that read.
"""

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.workspace import Workspace
from app.services.kanban.board import BoardService
from app.services.loop_config_validation import (
    LOOP_CONFIG_DEFAULTS,
    OFF_SWITCH_TOOL,
    canonicalize_loop_config,
    validate_loop_config,
)

PROPOSE_TOOL = "mcp__valaris__propose_skill"

# A realistic pre-W2 stored config: written before the flag existed, so the
# key is genuinely absent — the exact shape the injection rail is for.
LEGACY_STORED = {
    "enabled": True,
    "provider": "",
    "model": "mid",
    "system_prompt": "",
    "loop_prompt": "work the board",
    "tools": [],
    "max_iterations": 25,
}


# --- defaults + canonicalization ---------------------------------------------


async def test_loop_config_defaults_skills_proposal_enabled_true():
    assert LOOP_CONFIG_DEFAULTS["skills_proposal_enabled"] is True


async def test_canonicalize_injects_flag_into_legacy_stored_config():
    canonical = canonicalize_loop_config({}, stored=dict(LEGACY_STORED))
    assert canonical["skills_proposal_enabled"] is True


async def test_canonicalize_explicit_false_survives():
    # The is-not-None rule: an explicit False is a value, not "unchanged".
    canonical = canonicalize_loop_config(
        {"skills_proposal_enabled": False}, stored=dict(LEGACY_STORED)
    )
    assert canonical["skills_proposal_enabled"] is False


async def test_canonicalize_stored_false_persists_when_omitted():
    stored = {**LEGACY_STORED, "skills_proposal_enabled": False}
    canonical = canonicalize_loop_config({}, stored=stored)
    assert canonical["skills_proposal_enabled"] is False


async def test_validate_loop_config_flag_must_be_bool():
    base = canonicalize_loop_config({}, stored=None)

    findings = validate_loop_config({**base, "skills_proposal_enabled": "yes"})
    assert any(f["field"] == "skills_proposal_enabled" for f in findings), findings

    for value in (True, False):
        findings = validate_loop_config(
            {**base, "skills_proposal_enabled": value}
        )
        assert not any(
            f["field"] == "skills_proposal_enabled" for f in findings
        ), findings


# --- serve-side strip on the runner read path --------------------------------


def _stored_config(flag: bool, tools: list[str]) -> dict:
    return canonicalize_loop_config(
        {
            "enabled": True,
            "loop_prompt": "work the board",
            "tools": list(tools),
            "skills_proposal_enabled": flag,
        },
        stored=None,
    )


async def test_get_loop_config_flag_false_strips_propose_tool(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board
):
    test_board.loop_config = _stored_config(
        False, [OFF_SWITCH_TOOL, PROPOSE_TOOL, "mcp__valaris__get_card"]
    )
    await db_session.flush()

    served = await BoardService(db_session).get_loop_config(
        test_board.id, test_workspace.id
    )
    assert PROPOSE_TOOL not in served["tools"]
    # Only the propose tool leaves; the rest of the allowlist is untouched.
    assert served["tools"] == [OFF_SWITCH_TOOL, "mcp__valaris__get_card"]


async def test_get_loop_config_flag_true_keeps_propose_tool(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board
):
    test_board.loop_config = _stored_config(True, [OFF_SWITCH_TOOL, PROPOSE_TOOL])
    await db_session.flush()

    served = await BoardService(db_session).get_loop_config(
        test_board.id, test_workspace.id
    )
    assert PROPOSE_TOOL in served["tools"]


async def test_get_loop_config_flag_false_empty_tools_stay_empty(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board
):
    # Documented limitation: an empty allowlist grants the full platform
    # surface — there is nothing to strip from, and the strip must not
    # fabricate a narrower list.
    test_board.loop_config = _stored_config(False, [])
    await db_session.flush()

    served = await BoardService(db_session).get_loop_config(
        test_board.id, test_workspace.id
    )
    assert served["tools"] == []


async def test_get_loop_config_strip_does_not_mutate_stored_config(
    db_session: AsyncSession, test_workspace: Workspace, test_board: Board
):
    test_board.loop_config = _stored_config(False, [OFF_SWITCH_TOOL, PROPOSE_TOOL])
    await db_session.flush()

    await BoardService(db_session).get_loop_config(
        test_board.id, test_workspace.id
    )

    # The read strips only the SERVED copy — in memory and in the DB the
    # stored allowlist still carries the tool for when the flag flips back.
    assert PROPOSE_TOOL in test_board.loop_config["tools"]
    db_session.expire(test_board)
    await db_session.refresh(test_board)
    assert PROPOSE_TOOL in test_board.loop_config["tools"]
