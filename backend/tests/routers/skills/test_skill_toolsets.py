# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Skills declare their toolsets — wire contract (MCP #3, card 3c690fb6).

RED phase. A skill's SKILL.md may declare `toolsets:`; the platform validates
the ids (422 naming the valid list), surfaces `toolsets` everywhere a skill is
read (detail, listing, version detail, catalog, board effective set, raw
bindings), reports `lint_warnings` on the skill detail when the playbook
prose names tools outside its hand, and flags `uncovered_toolsets` on a
board whose loop grant cannot cover a bound skill's declared toolsets.

Toolsets ENFORCE (the server lists and allows), skills GUIDE — nothing here
restricts tools client-side. The allowed-tools passthrough pin in
test_workspace_skills.py stays untouched: `toolsets` is the ONE key Backplane
defines.
"""

import json
from pathlib import Path

from httpx import AsyncClient

from app.models.kanban.board import Board
from app.models.workspace import Workspace
from tests.routers.skills.conftest import skill_md


SKILLS_URL = "/api/workspaces/default/skills"
CATALOG_URL = "/api/workspaces/default/skill-catalog"
BOARDS_URL = "/api/workspaces/default/boards"

REPO_ROOT = Path(__file__).resolve().parents[4]
SERVER_SURFACE = (
    REPO_ROOT
    / "frontend/src/pages/documentation/mcp-reference/data/server-surface.json"
)

# The loop PUT shape test_board_loop.py proves round-trips; only `tools`
# varies per test. An ENABLED loop's non-empty grant must carry the off-switch
# (set_board_loop) or the PUT is a 422, so every partial grant includes it.
OFF_SWITCH = "mcp__valaris__set_board_loop"
LOOP_BODY = {
    "enabled": True,
    "provider": "codex-cli",
    "model": "premium",
    "system_prompt": "You are the maintenance agent for {{.Workspace}}.",
    "loop_prompt": "Iteration {{.Iteration}}: make progress, or turn the loop off.",
    "max_iterations": 10,
    "iteration_delay_seconds": 5,
    "iteration_timeout_seconds": 600,
    "budget_usd": 7.5,
    "max_consecutive_failures": 2,
}


def _surface_toolset(toolset_id: str) -> dict:
    surface = json.loads(SERVER_SURFACE.read_text())
    return next(t for t in surface["toolsets"] if t["id"] == toolset_id)


def _files(toolsets: str | None, body: str = "## Steps\n\n1. Read the card.\n", name: str = "Toolset Probe"):
    extra = f"toolsets: {toolsets}" if toolsets is not None else ""
    return [{"path": "SKILL.md", "content": skill_md(name=name, extra_frontmatter=extra, body=body)}]


async def _create(client: AsyncClient, slug: str, files: list[dict]) -> dict:
    response = await client.post(SKILLS_URL, json={"slug": slug, "files": files})
    assert response.status_code == 201, response.text
    return response.json()


async def _publish(client: AsyncClient, slug: str, version: int = 1) -> None:
    response = await client.post(f"{SKILLS_URL}/{slug}/versions/{version}/publish")
    assert response.status_code == 200, response.text


async def _bind(client: AsyncClient, board: Board, slug: str) -> None:
    response = await client.put(f"{BOARDS_URL}/{board.id}/skills/{slug}", json={})
    assert response.status_code == 200, response.text


async def _set_loop_tools(client: AsyncClient, board: Board, tools: list[str]) -> None:
    response = await client.put(
        f"{BOARDS_URL}/{board.id}/loop", json={**LOOP_BODY, "tools": tools}
    )
    assert response.status_code in (200, 201), response.text
    assert response.json()["tools"] == tools


async def _effective(client: AsyncClient, board: Board) -> list[dict]:
    response = await client.get(f"{BOARDS_URL}/{board.id}/skills")
    assert response.status_code == 200, response.text
    return response.json()["skills"]


async def _bindings(client: AsyncClient, board: Board) -> list[dict]:
    response = await client.get(f"{BOARDS_URL}/{board.id}/skills/bindings")
    assert response.status_code == 200, response.text
    return response.json()["bindings"]


# --- create / detail ---------------------------------------------------------


async def test_create_skill_with_toolsets_echoes_them(
    client: AsyncClient, test_workspace: Workspace
):
    data = await _create(client, "declared", _files("[cards, notes]"))
    assert data["toolsets"] == ["cards", "notes"]
    # A clean playbook lints clean.
    assert data["lint_warnings"] == []


async def test_create_skill_without_toolsets_is_empty_list(
    client: AsyncClient, test_workspace: Workspace
):
    data = await _create(client, "undeclared", _files(None))
    assert data["toolsets"] == []
    assert data["lint_warnings"] == []


async def test_create_skill_dedupes_declared_toolsets(
    client: AsyncClient, test_workspace: Workspace
):
    data = await _create(client, "dupes", _files("[notes, cards, notes]"))
    assert data["toolsets"] == ["notes", "cards"]


async def test_create_skill_unknown_toolset_is_422_naming_id_and_valid_ids(
    client: AsyncClient, test_workspace: Workspace
):
    from app.services.skills.toolsets import TOOLSET_IDS

    response = await client.post(
        SKILLS_URL, json={"slug": "bad-hand", "files": _files("[cards, not-a-toolset]")}
    )
    assert response.status_code == 422, response.text
    detail = json.dumps(response.json()["detail"])
    assert "not-a-toolset" in detail
    assert "valid" in detail
    for toolset_id in TOOLSET_IDS:
        assert toolset_id in detail, toolset_id
    # The rejected create left nothing behind.
    listing = await client.get(SKILLS_URL)
    assert listing.json()["count"] == 0


async def test_get_skill_detail_carries_toolsets(
    client: AsyncClient, test_workspace: Workspace
):
    await _create(client, "declared", _files("[cards]"))
    response = await client.get(f"{SKILLS_URL}/declared")
    assert response.status_code == 200, response.text
    assert response.json()["toolsets"] == ["cards"]


async def test_skill_detail_toolsets_prefer_latest_published_version(
    client: AsyncClient, test_workspace: Workspace
):
    """Detail/listing resolve like the effective set: latest PUBLISHED wins,
    else the newest version, else []."""
    await _create(client, "evolving", _files("[cards]"))
    # Nothing published yet → newest version (v1) speaks.
    assert (await client.get(f"{SKILLS_URL}/evolving")).json()["toolsets"] == ["cards"]

    await _publish(client, "evolving", 1)
    v2 = await client.post(
        f"{SKILLS_URL}/evolving/versions", json={"files": _files("[notes]")}
    )
    assert v2.status_code == 201, v2.text

    # v2 is a draft: the published v1 still speaks for the skill.
    assert (await client.get(f"{SKILLS_URL}/evolving")).json()["toolsets"] == ["cards"]

    await _publish(client, "evolving", 2)
    assert (await client.get(f"{SKILLS_URL}/evolving")).json()["toolsets"] == ["notes"]


# --- listing -----------------------------------------------------------------


async def test_list_skills_items_carry_toolsets(
    client: AsyncClient, test_workspace: Workspace
):
    await _create(client, "declared", _files("[cards, notes]"))
    await _create(client, "undeclared", _files(None))

    response = await client.get(SKILLS_URL)
    assert response.status_code == 200, response.text
    by_slug = {item["slug"]: item for item in response.json()["skills"]}
    assert by_slug["declared"]["toolsets"] == ["cards", "notes"]
    assert by_slug["undeclared"]["toolsets"] == []
    # Still metadata only — the manifest is parsed server-side, never shipped.
    assert '"files"' not in response.text


# --- version detail ----------------------------------------------------------


async def test_get_skill_version_carries_its_own_toolsets(
    client: AsyncClient, test_workspace: Workspace
):
    await _create(client, "versioned", _files("[cards]"))
    v2 = await client.post(
        f"{SKILLS_URL}/versioned/versions", json={"files": _files("[notes]")}
    )
    assert v2.status_code == 201, v2.text

    one = await client.get(f"{SKILLS_URL}/versioned/versions/1")
    assert one.status_code == 200, one.text
    assert one.json()["toolsets"] == ["cards"]
    two = await client.get(f"{SKILLS_URL}/versioned/versions/2")
    assert two.json()["toolsets"] == ["notes"]


async def test_create_skill_version_unknown_toolset_is_422(
    client: AsyncClient, test_workspace: Workspace
):
    await _create(client, "versioned", _files("[cards]"))
    response = await client.post(
        f"{SKILLS_URL}/versioned/versions", json={"files": _files("[nope]")}
    )
    assert response.status_code == 422, response.text
    assert "nope" in json.dumps(response.json()["detail"])
    # No version was stacked by the rejected request.
    assert (await client.get(f"{SKILLS_URL}/versioned/versions/2")).status_code == 404


# --- lint warnings -----------------------------------------------------------


async def test_create_skill_reports_prose_outside_toolsets_as_lint_warnings(
    client: AsyncClient, test_workspace: Workspace
):
    files = _files(
        "[cards]",
        body="## Steps\n\n1. Read the card.\n2. Never call delete_workspace.\n",
    )
    data = await _create(client, "leaky", files)
    # Warn, never reject: the skill is created, and the response says why the
    # prose and the hand disagree.
    assert data["toolsets"] == ["cards"]
    assert data["lint_warnings"] == ["delete_workspace"]

    detail = await client.get(f"{SKILLS_URL}/leaky")
    assert detail.json()["lint_warnings"] == ["delete_workspace"]


async def test_new_version_lint_warnings_follow_the_resolving_version(
    client: AsyncClient, test_workspace: Workspace
):
    await _create(client, "drifting", _files("[cards]"))
    leaky = _files("[cards]", body="Run whoami, then get_card.\n")
    response = await client.post(f"{SKILLS_URL}/drifting/versions", json={"files": leaky})
    assert response.status_code == 201, response.text
    # Shape choice (design §5 says every authoring path "carries
    # lint_warnings"): the new-version response is SkillVersionRead, so it
    # carries the warnings for THAT version.
    assert response.json()["lint_warnings"] == ["whoami"]

    # Nothing published → the newest version (v2) speaks for the skill.
    detail = await client.get(f"{SKILLS_URL}/drifting")
    assert detail.json()["lint_warnings"] == ["whoami"]


async def test_lint_is_skipped_when_no_toolsets_declared(
    client: AsyncClient, test_workspace: Workspace
):
    data = await _create(
        client, "quiet", _files(None, body="delete_workspace and whoami, freely.\n")
    )
    assert data["toolsets"] == []
    assert data["lint_warnings"] == []


# --- catalog -----------------------------------------------------------------


async def test_list_skill_catalog_entries_carry_toolsets(
    client: AsyncClient, test_workspace: Workspace
):
    from app.services.skills.toolsets import TOOLSET_IDS

    response = await client.get(CATALOG_URL)
    assert response.status_code == 200, response.text
    entries = response.json()["entries"]
    assert entries
    for entry in entries:
        assert isinstance(entry["toolsets"], list), entry["catalog_id"]
        assert entry["toolsets"], f"{entry['catalog_id']}: declares no toolset"
        assert set(entry["toolsets"]) <= set(TOOLSET_IDS), entry["catalog_id"]


async def test_activated_catalog_skill_keeps_its_toolsets(
    client: AsyncClient, test_workspace: Workspace
):
    entry = (await client.get(CATALOG_URL)).json()["entries"][0]
    activated = await client.post(f"{CATALOG_URL}/{entry['catalog_id']}/activate")
    assert activated.status_code == 201, activated.text
    assert activated.json()["toolsets"] == entry["toolsets"]
    # Catalog prose is lint-clean by contract (test_skill_catalog_toolsets).
    assert activated.json()["lint_warnings"] == []


# --- board coverage ----------------------------------------------------------


async def test_effective_skill_carries_toolsets_and_no_uncovered_without_loop(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _create(client, "review-ritual", _files("[cards, notes]"))
    await _publish(client, "review-ritual")
    await _bind(client, test_board, "review-ritual")

    items = await _effective(client, test_board)
    assert len(items) == 1
    assert items[0]["toolsets"] == ["cards", "notes"]
    # No loop config at all = full surface: nothing is uncovered.
    assert items[0]["uncovered_toolsets"] == []


async def test_effective_skill_empty_grant_covers_everything(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _create(client, "review-ritual", _files("[cards]"))
    await _publish(client, "review-ritual")
    await _bind(client, test_board, "review-ritual")
    await _set_loop_tools(client, test_board, [])

    items = await _effective(client, test_board)
    assert items[0]["uncovered_toolsets"] == []


async def test_effective_skill_partial_grant_reports_uncovered_toolsets(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _create(client, "review-ritual", _files("[cards]"))
    await _publish(client, "review-ritual")
    await _bind(client, test_board, "review-ritual")
    # get_card alone: cards needs its whole category, so cards is uncovered.
    assert len(_surface_toolset("cards")["tools"]) > 1
    await _set_loop_tools(client, test_board, ["mcp__valaris__get_card", OFF_SWITCH])

    items = await _effective(client, test_board)
    assert items[0]["toolsets"] == ["cards"]
    assert items[0]["uncovered_toolsets"] == ["cards"]


async def test_effective_skill_full_grant_of_declared_toolset_is_covered(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _create(client, "review-ritual", _files("[cards]"))
    await _publish(client, "review-ritual")
    await _bind(client, test_board, "review-ritual")
    grant = [f"mcp__valaris__{t}" for t in _surface_toolset("cards")["tools"]]
    if OFF_SWITCH not in grant:
        grant.append(OFF_SWITCH)
    await _set_loop_tools(client, test_board, grant)

    items = await _effective(client, test_board)
    assert items[0]["uncovered_toolsets"] == []


async def test_effective_skill_reports_only_the_uncovered_toolsets(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _create(client, "review-ritual", _files("[cards, notes]"))
    await _publish(client, "review-ritual")
    await _bind(client, test_board, "review-ritual")
    grant = [f"mcp__valaris__{t}" for t in _surface_toolset("cards")["tools"]]
    if OFF_SWITCH not in grant:
        grant.append(OFF_SWITCH)
    await _set_loop_tools(client, test_board, grant)

    items = await _effective(client, test_board)
    assert items[0]["toolsets"] == ["cards", "notes"]
    assert items[0]["uncovered_toolsets"] == ["notes"]


async def test_effective_skill_without_declaration_is_never_uncovered(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    await _create(client, "undeclared", _files(None))
    await _publish(client, "undeclared")
    await _bind(client, test_board, "undeclared")
    await _set_loop_tools(client, test_board, ["mcp__valaris__get_card", OFF_SWITCH])

    items = await _effective(client, test_board)
    assert items[0]["toolsets"] == []
    assert items[0]["uncovered_toolsets"] == []


async def test_effective_skill_coverage_uses_the_resolved_version(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """The pinned version's declaration is what the runner materializes, so
    coverage is judged against IT — not the latest published."""
    await _create(client, "pinned", _files("[cards]"))
    await _publish(client, "pinned", 1)
    v2 = await client.post(f"{SKILLS_URL}/pinned/versions", json={"files": _files("[notes]")})
    assert v2.status_code == 201, v2.text
    await _publish(client, "pinned", 2)
    bound = await client.put(
        f"{BOARDS_URL}/{test_board.id}/skills/pinned", json={"pinned_version": 1}
    )
    assert bound.status_code == 200, bound.text
    await _set_loop_tools(client, test_board, ["mcp__valaris__get_card", OFF_SWITCH])

    items = await _effective(client, test_board)
    assert items[0]["version"] == 1
    assert items[0]["toolsets"] == ["cards"]
    assert items[0]["uncovered_toolsets"] == ["cards"]


async def test_list_bindings_rows_carry_toolsets_and_uncovered(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """The board-settings dialog renders the RAW rows — the drift banner path."""
    await _create(client, "review-ritual", _files("[cards]"))
    await _publish(client, "review-ritual")
    await _bind(client, test_board, "review-ritual")

    rows = await _bindings(client, test_board)
    assert len(rows) == 1
    assert rows[0]["toolsets"] == ["cards"]
    assert rows[0]["uncovered_toolsets"] == []

    await _set_loop_tools(client, test_board, ["mcp__valaris__get_card", OFF_SWITCH])
    rows = await _bindings(client, test_board)
    assert rows[0]["uncovered_toolsets"] == ["cards"]

    await _set_loop_tools(client, test_board, [])
    rows = await _bindings(client, test_board)
    assert rows[0]["uncovered_toolsets"] == []


async def test_list_bindings_disabled_row_still_reports_coverage(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Disabled bindings resolve (resolved_version) and therefore also carry
    coverage — the operator sees the drift BEFORE re-enabling."""
    await _create(client, "muted", _files("[cards]"))
    await _publish(client, "muted")
    response = await client.put(
        f"{BOARDS_URL}/{test_board.id}/skills/muted", json={"enabled": False}
    )
    assert response.status_code == 200, response.text
    await _set_loop_tools(client, test_board, ["mcp__valaris__get_card", OFF_SWITCH])

    rows = await _bindings(client, test_board)
    assert rows[0]["enabled"] is False
    assert rows[0]["toolsets"] == ["cards"]
    assert rows[0]["uncovered_toolsets"] == ["cards"]


async def test_list_bindings_draft_only_row_has_empty_toolsets(
    client: AsyncClient, test_workspace: Workspace, test_board: Board
):
    """Shape choice: a binding that resolves to NOTHING (no publish, no pin)
    has no manifest to read, so both lists are empty rather than null."""
    await _create(client, "draft-only", _files("[cards]"))
    await _bind(client, test_board, "draft-only")

    rows = await _bindings(client, test_board)
    assert rows[0]["resolved_version"] is None
    assert rows[0]["toolsets"] == []
    assert rows[0]["uncovered_toolsets"] == []
