# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Loop prompt template catalog — GET /api/workspaces/{slug}/loop-templates.

RED phase for card 55a9866b ("Start from template" in the Loop dialog).

The catalog is static and versioned with the app, but served workspace-scoped
for auth consistency (any member, same get_workspace dependency family as the
other workspace routes). These tests pin STRUCTURE and BEHAVIOR of the catalog,
never template prose — the content is data authored later:

  - wire shape: {"templates": [...]} with an exact per-template key set;
  - required ids: coding-loop, revision-loop, triage-loop;
  - membership auth (non-member 403, mirrors test_sensors.py);
  - tool-catalog drift guard: every template tool resolves to a real
    @mcp.tool() decorator (collector reused from test_mcp_catalog_drift);
  - template-var validity: only the runner's Go vars {{.Workspace}},
    {{.BoardID}}, {{.Iteration}} may appear — a typo like {{.Board}} renders
    as a Go template error at loop time, so it must fail here instead;
  - structure contract: every loop_prompt teaches the customize +
    run-log-feedback pattern ([CUSTOMIZE: slot + a Lessons section);
  - coding vs non-coding split: only coding-loop carries repo-PR tools.
"""

import hashlib
import json
import re
import secrets
from dataclasses import replace
from datetime import datetime
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.main import create_app
from app.models.agents.agent import Agent, AgentType
from app.models.agents.execution import AgentExecution, ExecutionStatus
from app.models.api_key import ApiKey
from app.models.kanban.board import Board
from app.models.user import User
from app.models.workspace import Workspace, WorkspaceMember, WorkspaceRole
from app.repositories.config_template import BoardLoopTemplateBindingRepository
from app.services.loop_config_validation import LOOP_RUNNER_VARS, SLOT_PATTERN
from app.services.loop_templates import LOOP_TEMPLATES
from tests.test_mcp_catalog_drift import collect_mcp_tool_names


TEMPLATES_URL = "/api/workspaces/default/loop-templates"

# Track-record fixtures stamp executions with the template key the RUNNER would
# have written, and the profile route counts only rows matching the CURRENT
# version. Deriving both from the catalog keeps a version bump (card B9 moved
# coding-loop to 3) a one-line change in the seed rather than a scavenger hunt
# through these fixtures.
CODING_LOOP_VERSION = next(t.version for t in LOOP_TEMPLATES if t.slug == "coding-loop")
# Retired but versioned: card 1f9f210c bumped it when update_definition left.
CODING_LOOP_V1_VERSION = next(
    t.version for t in LOOP_TEMPLATES if t.slug == "coding-loop-v1"
)
CODING_LOOP_KEY = f"loop-template:system/coding-loop@{CODING_LOOP_VERSION}"

# The exact wire shape of one LISTING entry — set-equality below catches
# silently added fields as loudly as missing ones.
#
# p1-02 turned the listing into SUMMARIES: prompts and tools are heavy and the
# Library page renders none of them, so full content moved behind GET /{ref}.
# The tests below that need prompt or tool text now fetch the detail route,
# which is also the shape the manager's Prompts tab reads.
TEMPLATE_KEYS = {
    "id",
    "source",
    "name",
    "version",
    "is_system",
    "is_draft",
    "has_slots",
    "profile",
    "boards_using",
    "last_used_at",
    "updated_at",
    # The draft contract (card 65714512): `draft_updated_at` is the lock token
    # `expected_updated_at` is compared against, and `has_unpublished_changes`
    # is the published-but-edited state `is_draft` cannot express.
    "draft_updated_at",
    "has_unpublished_changes",
    # P0 fields the shipped Loop dialog still applies from the listing.
    "description",
    "system_prompt",
    "loop_prompt",
    "tools",
}

# The full-content shape served by GET /loop-templates/{ref}.
TEMPLATE_DETAIL_KEYS = {
    "id",
    "slug",
    "source",
    "name",
    "version",
    "is_system",
    "is_draft",
    "profile",
    "content",
    "lineage",
    "updated_at",
    "draft_updated_at",
    "has_unpublished_changes",
}

# The profile page's shape (card 8e4f95ba): the STORED profile alongside the
# DERIVED track record, plus the setup contract the page documents. Kept a
# separate key set from the detail route because the two answer different
# questions — "what is this template" vs "how has it actually done".
PROFILE_KEYS = {
    "id",
    "slug",
    "source",
    "name",
    "version",
    "is_system",
    "profile",
    "boards_using",
    "versions",
    "rails_defaults",
    "tools",
    "slots",
    "setup_contract",
    "track_record",
}

# The maintained, slotted lineage — the only generation the catalog LISTS.
REQUIRED_TEMPLATE_IDS = {
    "coding-loop",
    "revision-loop",
    "triage-loop",
}

# The deprecated lineage: unlisted (card p3-10) but still resolvable by slug, so
# a board bound to one during the transition keeps reporting drift instead of
# 404ing. Reached through the detail route, never through the listing.
UNLISTED_TEMPLATE_IDS = {
    "coding-loop-v1",
    "revision-loop-v1",
    "triage-loop-v1",
}

# Slugs whose prompts still carry free-text `[CUSTOMIZE:` markers rather than
# real `<<SLOT>>`s — the legacy lineage the raw dialog can still apply.
CUSTOMIZE_MARKER_IDS = {"coding-loop-v1", "revision-loop-v1", "triage-loop-v1"}

# The runner's var vocabulary now has ONE definition — app.services
# .loop_config_validation.LOOP_RUNNER_VARS — imported above and drift-tested
# against the runner's own fixture below. The local literal it replaces listed
# three of the five the runner actually fills.
RUNNER_VARS_FIXTURE = (
    Path(__file__).resolve().parents[3]
    / "runner"
    / "internal"
    / "workloop"
    / "testdata"
    / "loop_runner_vars.json"
)

KEBAB_CASE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")

# Template tools may be stored bare ("set_board_loop") or as the full MCP id
# the loop config / ToolPicker use ("mcp__valaris__set_board_loop"). Normalize
# before comparing against the decorator-derived canonical set.
MCP_PREFIX = "mcp__valaris__"


def _bare(tool_name: str) -> str:
    return tool_name.removeprefix(MCP_PREFIX)


async def _get_catalog(client: AsyncClient) -> dict:
    response = await client.get(TEMPLATES_URL)
    assert response.status_code == 200, response.text
    body = response.json()
    # `meta` joined `templates` with the LOOP_RUNNER_VARS card: the palette
    # must render the var vocabulary the SERVER knows, not a frontend literal,
    # so the catalog carries it. Set-equality keeps a third key from appearing
    # unnoticed.
    assert set(body) == {"templates", "meta"}, body
    return body


async def _get_templates(client: AsyncClient) -> list[dict]:
    templates = (await _get_catalog(client))["templates"]
    assert isinstance(templates, list) and templates, templates
    return templates


async def _get_detail(client: AsyncClient, ref: str) -> dict:
    """Full content for one template — prompts, tools, slots, rails."""
    response = await client.get(f"{TEMPLATES_URL}/{ref}")
    assert response.status_code == 200, response.text
    return response.json()


async def _get_details(client: AsyncClient) -> list[dict]:
    """Every system template's full content, via the detail route.

    Listing then fetching mirrors what the manager does and keeps the
    content-shape assertions pointed at the route that actually serves
    content.
    """
    listed = [summary["id"] for summary in await _get_templates(client)]
    # The unlisted lineage is appended explicitly: iterating the LISTING alone
    # would silently drop every v1 content assertion the moment p3-10 unlisted
    # them, turning generation-split pins into single-branch tautologies.
    return [
        await _get_detail(client, tid)
        for tid in [*listed, *sorted(UNLISTED_TEMPLATE_IDS)]
    ]


# --- catalog contents --------------------------------------------------------


async def test_list_loop_templates_returns_required_catalog(
    client: AsyncClient, test_workspace: Workspace
):
    templates = await _get_templates(client)
    assert len(templates) >= 3
    ids = {t["id"] for t in templates}
    missing = REQUIRED_TEMPLATE_IDS - ids
    assert not missing, f"catalog missing required templates: {sorted(missing)}"


async def test_unlisted_v1_resolvable_not_listed(
    client: AsyncClient, test_workspace: Workspace
):
    """The `-v1` lineage leaves the catalog but stays reachable by slug.

    The bind step made the legacy chooser unreachable, so listing the
    deprecated trio only clutters the Library. Deleting it instead of unlisting
    it would 404 the drift lookup for any board bound to a `-v1` slug during
    the transition — hence both halves are pinned here.
    """
    listed = {t["id"] for t in await _get_templates(client)}
    assert not (UNLISTED_TEMPLATE_IDS & listed), sorted(UNLISTED_TEMPLATE_IDS & listed)

    for tid in sorted(UNLISTED_TEMPLATE_IDS):
        assert (await _get_detail(client, tid))["id"] == tid


async def test_list_loop_templates_wire_shape_exact_keys(
    client: AsyncClient, test_workspace: Workspace
):
    for template in await _get_templates(client):
        assert set(template) == TEMPLATE_KEYS, (
            f"template {template.get('id')!r} keys drifted: "
            f"extra={sorted(set(template) - TEMPLATE_KEYS)} "
            f"missing={sorted(TEMPLATE_KEYS - set(template))}"
        )


async def test_list_loop_templates_values_are_well_formed(
    client: AsyncClient, test_workspace: Workspace
):
    templates = await _get_templates(client)
    ids = [t["id"] for t in templates]
    assert len(ids) == len(set(ids)), f"duplicate template ids: {ids}"
    for template in templates:
        tid = template["id"]
        assert KEBAB_CASE.fullmatch(tid), f"id not kebab-case: {tid!r}"
        assert template["name"].strip(), f"{tid}: empty name"
        # `description` moved into `profile.tagline` when the listing became a
        # summary — the Library card renders the profile block, not a
        # standalone string.
        assert template["profile"]["tagline"].strip(), f"{tid}: empty tagline"
        assert template["source"] == "system", f"{tid}: not a system template"
        assert template["is_system"] is True, tid
        assert template["is_draft"] is False, f"{tid}: system template is not a draft"
        assert isinstance(template["boards_using"], int), tid


async def test_loop_template_detail_values_are_well_formed(
    client: AsyncClient, test_workspace: Workspace
):
    """The content facts the listing no longer carries, asserted where they
    now live."""
    for template in await _get_details(client):
        tid = template["id"]
        assert set(template) == TEMPLATE_DETAIL_KEYS, (
            f"template {tid!r} detail keys drifted: "
            f"extra={sorted(set(template) - TEMPLATE_DETAIL_KEYS)} "
            f"missing={sorted(TEMPLATE_DETAIL_KEYS - set(template))}"
        )
        content = template["content"]
        assert isinstance(content["system_prompt"], str)
        assert content["system_prompt"].strip(), f"{tid}: empty system_prompt"
        assert isinstance(content["loop_prompt"], str)
        assert content["loop_prompt"].strip(), f"{tid}: empty loop_prompt"
        assert isinstance(content["tools"], list), f"{tid}: tools not a list"
        assert content["tools"], f"{tid}: empty tools list"
        assert all(
            isinstance(name, str) and name.strip() for name in content["tools"]
        ), f"{tid}: non-string/blank tool name in {content['tools']}"
        # The manager's Slots/Rails tabs read these; a system template that
        # served content without them would render blank editors.
        for field in ("slots", "rails_defaults", "setup_contract", "derived_rails"):
            assert field in content, f"{tid}: detail content missing {field}"


# --- auth --------------------------------------------------------------------


async def test_list_loop_templates_rejects_non_member(
    client: AsyncClient,
    test_user: User,
    second_user: User,
    db_session: AsyncSession,
):
    # second_user creates a workspace the test_user isn't a member of — the
    # static catalog must still be membership-gated like every workspace route.
    foreign = Workspace(name="Foreign", slug="foreign", created_by=second_user.id)
    db_session.add(foreign)
    await db_session.flush()
    db_session.add(
        WorkspaceMember(
            workspace_id=foreign.id, user_id=second_user.id, role=WorkspaceRole.owner
        )
    )
    await db_session.flush()

    response = await client.get("/api/workspaces/foreign/loop-templates")
    assert response.status_code == 403, response.text


async def test_list_loop_templates_unknown_workspace_404(
    client: AsyncClient, test_user: User
):
    response = await client.get("/api/workspaces/does-not-exist/loop-templates")
    assert response.status_code == 404, response.text
    # The app's own not-found shape, not the framework's route-missing default
    # (same pin as test_board_loop.py) — keeps this red until the route exists.
    assert response.json().get("error_code") == "not_found", response.text


# --- drift guards ------------------------------------------------------------


async def test_loop_template_tools_exist_in_mcp_catalog(
    client: AsyncClient, test_workspace: Workspace
):
    """Every tool a template hands to the loop must be a real @mcp.tool() —
    a renamed/removed tool would otherwise ship as a silent no-op grant."""
    canonical = collect_mcp_tool_names()
    assert canonical, "decorator scan returned no tools — collector broke"
    for template in await _get_details(client):
        unknown = sorted(
            name
            for name in template["content"]["tools"]
            if _bare(name) not in canonical
        )
        assert not unknown, (
            f"template {template['id']!r} references tools that don't exist "
            f"in the MCP catalog: {unknown}"
        )


async def test_loop_template_prompts_use_only_runner_vars(
    client: AsyncClient, test_workspace: Workspace
):
    """{{.X}} occurrences must stay within the runner's defined var set —
    {{.Board}} (typo for {{.BoardID}}) would be a Go template error at loop
    time, invisible until a real iteration runs."""
    var_pattern = re.compile(r"\{\{-?\s*\.([A-Za-z_][A-Za-z0-9_]*)")
    allowed = set(LOOP_RUNNER_VARS)
    for template in await _get_details(client):
        for field in ("system_prompt", "loop_prompt"):
            used = set(var_pattern.findall(template["content"][field]))
            unknown = sorted(used - allowed)
            assert not unknown, (
                f"template {template['id']!r} {field} uses undefined "
                f"template vars: {unknown} (allowed: {sorted(allowed)})"
            )


async def test_has_slots_marker(client: AsyncClient, test_workspace: Workspace):
    """`has_slots` marks a template the raw dialog cannot apply.

    A `<<SLOT>>` template copied into the raw textareas would 422
    (`unrendered_slot`) at save — correct, but a dead end. The catalog carries
    the marker so the dialog can disable the option until the bind step ships.

    Since p3-10 the listing carries only the slotted lineage, so the split this
    used to assert across generations now lives in
    `test_has_slots_split_survives_the_unlisted_lineage`, which reaches the
    slot-free v1 templates through the detail route.
    """
    reported = {t["id"]: t["has_slots"] for t in await _get_templates(client)}
    assert reported, reported
    for tid in REQUIRED_TEMPLATE_IDS:
        assert reported[tid] is True, (
            f"system template {tid!r} reports has_slots=False; the maintained "
            "lineage expresses every customization point as a <<SLOT>>"
        )


async def test_has_slots_split_survives_the_unlisted_lineage(
    client: AsyncClient, test_workspace: Workspace
):
    """The generational split `has_slots` encodes, re-pinned where it still
    lives after p3-10: the LISTING is all-slotted, and the unlisted `-v1`
    lineage — reachable only by slug — is slot-free.

    Asserted on the detail route's prompt TEXT rather than a `has_slots` field,
    because the detail payload carries content, not the marker: a hardcoded
    all-true marker in the listing cannot make this pass.
    """
    for tid in sorted(UNLISTED_TEMPLATE_IDS):
        content = (await _get_detail(client, tid))["content"]
        for field in ("system_prompt", "loop_prompt"):
            assert not SLOT_PATTERN.search(content[field] or ""), (
                f"{tid} is the slot-free legacy lineage but its {field} "
                "carries a <<SLOT>>"
            )

    for tid in sorted(REQUIRED_TEMPLATE_IDS):
        content = (await _get_detail(client, tid))["content"]
        assert SLOT_PATTERN.search(content["loop_prompt"] or ""), (
            f"{tid} is the maintained lineage but its loop_prompt has no <<SLOT>>"
        )


async def test_has_slots_is_computed_from_the_prompts_not_hardcoded(
    client: AsyncClient, test_workspace: Workspace, monkeypatch
):
    """The marker reads BOTH prompts through the p0-03 SLOT_PATTERN.

    Each case patches the catalog with one slotted field so a hardcoded
    constant (either direction) fails, and `<<lower>>` / `<< SPACED >>` prove
    the marker uses the real grammar rather than a bare "<<" substring search.
    """
    base = LOOP_TEMPLATES[0]

    cases = [
        ({"system_prompt": "Ship <<CARD_ID>> today."}, True, "slot in system"),
        ({"loop_prompt": "Iterate on <<BOARD>>."}, True, "slot in loop"),
        ({"system_prompt": "Angle brackets << and >> alone."}, False, "not a slot"),
        ({"loop_prompt": "Lowercase <<slot>> is not the grammar."}, False, "lowercase"),
        ({"system_prompt": "<< SPACED >> is not the grammar."}, False, "spaced"),
    ]

    for override, expected, label in cases:
        content = base.content.model_copy(
            update={"system_prompt": "no slots", "loop_prompt": "no slots", **override}
        )
        patched = replace(base, content=content)
        monkeypatch.setattr(
            "app.services.loop_templates.LOOP_TEMPLATES", [patched], raising=True
        )
        templates = await _get_templates(client)
        assert templates[0]["has_slots"] is expected, f"{label}: {override}"


async def test_catalog_meta_runner_vars(client: AsyncClient, test_workspace: Workspace):
    """The catalog serves the var vocabulary so no client has to hardcode it.

    Order is part of the contract: the palette renders the chips in response
    order, and an operator scanning a prompt reads them in the order the
    runner's PromptContext declares them.
    """
    meta = (await _get_catalog(client))["meta"]
    assert set(meta) == {"runner_vars"}, meta
    assert meta["runner_vars"] == list(LOOP_RUNNER_VARS), meta
    assert meta["runner_vars"] == [
        "Workspace",
        "BoardID",
        "AgentID",
        "ExecutionID",
        "Iteration",
    ], meta


def test_runner_vars_match_runner_fixture():
    """LOOP_RUNNER_VARS must equal the runner's own fixture, order included.

    The runner half (TestLoopMode_RunnerVarsFixtureAllFilled) proves loop mode
    FILLS every name in that file; this half proves the backend VALIDATES
    against exactly the same list. Editing one side alone reddens a suite —
    which is the point: before this pair the vocabulary was stated in five
    places and three of them disagreed.
    """
    fixture = json.loads(RUNNER_VARS_FIXTURE.read_text())
    assert fixture == list(LOOP_RUNNER_VARS), (
        f"runner fixture {RUNNER_VARS_FIXTURE} = {fixture} but "
        f"LOOP_RUNNER_VARS = {list(LOOP_RUNNER_VARS)}"
    )


# --- structure contract ------------------------------------------------------


async def test_loop_template_loop_prompts_teach_customize_and_lessons(
    client: AsyncClient, test_workspace: Workspace
):
    """Templates teach the pattern, not just fill fields: every loop_prompt
    carries an operator-editable customization point and a Lessons section for
    run-log feedback.

    The customization point is generation-dependent — the v1 lineage marks it
    with free text (`[CUSTOMIZE:`), while v2 replaced every marker with a real
    `<<SLOT>>`. Requiring the v1 marker everywhere is exactly the pin that
    would make a slotted template unshippable, so each generation is checked
    against its own grammar. Substring pins only — wording is data.
    """
    for template in await _get_details(client):
        loop_prompt = template["content"]["loop_prompt"]
        if template["id"] in CUSTOMIZE_MARKER_IDS:
            assert "[CUSTOMIZE:" in loop_prompt, (
                f"template {template['id']!r} loop_prompt has no [CUSTOMIZE: slot"
            )
            assert not SLOT_PATTERN.search(loop_prompt), (
                f"template {template['id']!r} is v1 but carries a <<SLOT>>"
            )
        else:
            assert SLOT_PATTERN.search(loop_prompt), (
                f"template {template['id']!r} loop_prompt has no <<SLOT>> — a "
                "v2 template with nothing to fill teaches no customization"
            )
            assert "[CUSTOMIZE:" not in loop_prompt, (
                f"template {template['id']!r} is v2 but kept a [CUSTOMIZE: marker"
            )
        # Feedback from previous runs must reach the next one, but the seeds
        # spell that mechanism differently and all three forms are legitimate:
        # the sweeps carry a LESSONS slot the operator promotes findings into,
        # while the coding loop makes the agent WRITE a run log every iteration
        # and read the last few at orient. Pinning the literal word would force
        # a decorative heading onto a battle-tested kernel that already does the
        # richer thing.
        #
        # The slot is checked as a SLOT rather than as prompt text because its
        # "### Lessons from previous runs" heading lives inside the slot value:
        # on a fresh run the value is empty, and a heading left in the prompt
        # would render as a titled empty section — the default first appearance
        # of five of seven templates.
        slot_names = {slot["name"] for slot in template["content"]["slots"]}
        assert (
            "Lessons" in loop_prompt
            or "run log" in loop_prompt
            or "LESSONS" in slot_names
        ), (
            f"template {template['id']!r} carries no channel for run-to-run "
            "feedback — neither a LESSONS slot, a Lessons section, nor a run log"
        )


async def test_coding_loop_tools_include_pr_and_loop_control(
    client: AsyncClient, test_workspace: Workspace
):
    detail = await _get_detail(client, "coding-loop-v1")
    coding_tools = {_bare(name) for name in detail["content"]["tools"]}
    assert "enqueue_pr_for_merge" in coding_tools
    assert "set_board_loop" in coding_tools


async def test_non_coding_loops_exclude_repo_pr_tools(
    client: AsyncClient, test_workspace: Workspace
):
    """The revision and triage loops are non-coding in BOTH generations —
    granting them enqueue_pr_for_merge would let a triage agent land code, and
    the v1→v2 rewrite is exactly where such a grant could slip in."""
    for tid in ("revision-loop", "triage-loop", "revision-loop-v1", "triage-loop-v1"):
        detail = await _get_detail(client, tid)
        bare_tools = {_bare(name) for name in detail["content"]["tools"]}
        assert "enqueue_pr_for_merge" not in bare_tools, (
            f"{tid} is a non-coding loop but carries enqueue_pr_for_merge"
        )


# --- p1-02: the workspace half (CRUD, gating, locks) -------------------------
#
# The catalog above is code-defined and read-only. Everything below drives the
# workspace lineage: drafts, publishing, duplication and the gating matrix that
# keeps authoring out of agent hands.


def _payload(**overrides) -> dict:
    """A draft that publishes clean.

    `validate_template` requires the off-switch tool, so a fixture without it
    turns any "publish succeeds" assertion into an accidental 422 test.
    """
    payload = {
        "slug": "my-loop",
        "name": "My loop",
        "profile": {"emoji": "🔁", "tagline": "A loop", "tags": ["custom"]},
        "content": {
            "system_prompt": "You are a careful agent.",
            "loop_prompt": "Do one thing.",
            "slots": [],
            "rails_defaults": {},
            "tools": ["mcp__valaris__set_board_loop"],
            "setup_contract": {},
            "derived_rails": {},
        },
    }
    payload.update(overrides)
    return payload


async def _create(client: AsyncClient, **overrides) -> dict:
    response = await client.post(TEMPLATES_URL, json=_payload(**overrides))
    assert response.status_code == 201, response.text
    return response.json()


async def test_create_draft_returns_201_at_version_zero(
    client: AsyncClient, test_workspace: Workspace
):
    body = await _create(client)

    assert body["version"] == 0
    assert body["is_draft"] is True
    assert body["source"] == "workspace"


async def test_created_draft_joins_the_listing_below_the_system_block(
    client: AsyncClient, test_workspace: Workspace
):
    await _create(client)

    templates = await _get_templates(client)
    sources = [t["source"] for t in templates]

    assert sources.count("workspace") == 1
    assert sources[-1] == "workspace", sources
    assert set(sources[: -1]) == {"system"}, sources


async def test_create_draft_rejects_a_duplicate_slug(
    client: AsyncClient, test_workspace: Workspace
):
    """Authoring is deliberately NOT idempotent — see the router docstring."""
    await _create(client)

    response = await client.post(TEMPLATES_URL, json=_payload())

    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "slug_taken"


async def test_create_draft_rejects_unknown_fields(
    client: AsyncClient, test_workspace: Workspace
):
    """`extra="forbid"` — a typo'd key must not be silently dropped."""
    response = await client.post(
        TEMPLATES_URL, json={**_payload(), "kind": "pipeline"}
    )

    assert response.status_code == 422, response.text


async def test_patch_draft_rejects_a_stale_expected_updated_at(
    client: AsyncClient, test_workspace: Workspace
):
    created = await _create(client)

    response = await client.patch(
        f"{TEMPLATES_URL}/{created['id']}",
        json={"name": "Renamed", "expected_updated_at": "2020-01-01T00:00:00"},
    )

    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "stale_draft"


async def test_patch_draft_without_a_lock_saves(
    client: AsyncClient, test_workspace: Workspace
):
    """The lock is opt-in; the 409 above must not mean "PATCH never works"."""
    created = await _create(client)

    response = await client.patch(
        f"{TEMPLATES_URL}/{created['id']}", json={"name": "Renamed"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["name"] == "Renamed"


async def _published_with_divergent_draft(client: AsyncClient) -> str:
    """A published template whose draft half has since moved on.

    The only state where `?draft=true` and the paramless GET disagree: before
    the first publish both halves read from the draft, and with a clean draft
    the two halves are equal, so either would make the branch below vacuous.
    """
    created = await _create(client)
    ref = created["id"]
    await client.post(f"{TEMPLATES_URL}/{ref}/publish", json={})

    # Edit `content`, not `name`: `name` is a single shared column (see
    # update_draft), so it has no published half to diverge from.
    draft_content = dict(_payload()["content"], loop_prompt="Draft-only step.")
    patched = await client.patch(
        f"{TEMPLATES_URL}/{ref}", json={"content": draft_content}
    )
    assert patched.status_code == 200, patched.text
    return ref


async def test_detail_without_draft_param_serves_the_published_half(
    client: AsyncClient, test_workspace: Workspace
):
    """`show_draft = draft or not published` — the published branch.

    Pins the half the bind/bound board-dialog views read: a board runs the
    PUBLISHED template, never whatever the author is currently editing.
    """
    ref = await _published_with_divergent_draft(client)

    body = await _get_detail(client, ref)

    assert body["content"]["loop_prompt"] == "Do one thing."
    assert body["has_unpublished_changes"] is True


async def test_detail_with_draft_param_serves_the_draft_half(
    client: AsyncClient, test_workspace: Workspace
):
    """The untested branch that let the manager editor load published content."""
    ref = await _published_with_divergent_draft(client)

    response = await client.get(f"{TEMPLATES_URL}/{ref}", params={"draft": True})

    assert response.status_code == 200, response.text
    assert response.json()["content"]["loop_prompt"] == "Draft-only step."


async def test_publish_then_publish_again_yields_two_versions(
    client: AsyncClient, test_workspace: Workspace
):
    created = await _create(client)
    ref = created["id"]

    first = await client.post(f"{TEMPLATES_URL}/{ref}/publish", json={})
    assert first.status_code == 200, first.text
    await client.patch(f"{TEMPLATES_URL}/{ref}", json={"name": "Second"})
    second = await client.post(
        f"{TEMPLATES_URL}/{ref}/publish", json={"expected_version": 1}
    )
    assert second.status_code == 200, second.text

    versions = await client.get(f"{TEMPLATES_URL}/{ref}/versions")
    assert versions.status_code == 200, versions.text
    assert [v["version"] for v in versions.json()] == [2, 1]
    assert second.json()["version"] == 2
    assert second.json()["is_draft"] is False


async def test_publish_rejects_a_stale_expected_version(
    client: AsyncClient, test_workspace: Workspace
):
    created = await _create(client)
    ref = created["id"]
    await client.post(f"{TEMPLATES_URL}/{ref}/publish", json={})

    response = await client.post(
        f"{TEMPLATES_URL}/{ref}/publish", json={"expected_version": 0}
    )

    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "stale_version"


async def test_publish_of_an_invalid_draft_returns_the_findings(
    client: AsyncClient, test_workspace: Workspace
):
    """422 must carry WHICH rule failed — the manager deep-links the tab."""
    payload = _payload()
    payload["content"]["tools"] = []
    created = await client.post(TEMPLATES_URL, json=payload)
    ref = created.json()["id"]

    response = await client.post(f"{TEMPLATES_URL}/{ref}/publish", json={})

    assert response.status_code == 422, response.text
    codes = {finding["code"] for finding in response.json()["detail"]}
    assert "off_switch_missing" in codes, response.json()


async def test_duplicate_a_system_template_records_lineage(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(f"{TEMPLATES_URL}/coding-loop-v1/duplicate", json={})

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["source"] == "workspace"
    assert body["is_draft"] is True
    assert body["lineage"] == {
        "source": "system",
        "slug": "coding-loop-v1",
        "version": CODING_LOOP_V1_VERSION,
    }


async def test_duplicate_twice_suffixes_rather_than_409ing(
    client: AsyncClient, test_workspace: Workspace
):
    """AC1 through the route: a retried duplicate is a 201, not a conflict."""
    first = await client.post(f"{TEMPLATES_URL}/coding-loop-v1/duplicate", json={})

    second = await client.post(f"{TEMPLATES_URL}/coding-loop-v1/duplicate", json={})

    assert (first.status_code, second.status_code) == (201, 201), second.text
    assert first.json()["slug"] == "coding-loop-v1-copy"
    assert second.json()["slug"] == "coding-loop-v1-copy-2"


async def test_duplicate_a_workspace_template_names_the_copy_from_the_source_slug(
    client: AsyncClient, test_workspace: Workspace
):
    """Over the wire a workspace ref is a UUID — the copy must still be named
    `<source-slug>-copy`, never `<uuid>-copy`."""
    source = await _create(client, slug="my-loop")

    response = await client.post(f"{TEMPLATES_URL}/{source['id']}/duplicate", json={})

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["slug"] == "my-loop-copy"
    assert body["lineage"] == {"source": "workspace", "slug": "my-loop", "version": 0}


async def test_duplicate_a_published_workspace_template_records_its_version(
    client: AsyncClient, test_workspace: Workspace
):
    source = await _create(client, slug="my-loop")
    publish = await client.post(
        f"{TEMPLATES_URL}/{source['id']}/publish", json={"expected_version": 0}
    )
    assert publish.status_code == 200, publish.text

    response = await client.post(f"{TEMPLATES_URL}/{source['id']}/duplicate", json={})

    assert response.status_code == 201, response.text
    assert response.json()["lineage"] == {
        "source": "workspace",
        "slug": "my-loop",
        "version": 1,
    }


async def test_duplicate_a_workspace_template_with_an_explicit_slug_keeps_lineage(
    client: AsyncClient, test_workspace: Workspace
):
    source = await _create(client, slug="my-loop")

    response = await client.post(
        f"{TEMPLATES_URL}/{source['id']}/duplicate", json={"new_slug": "my-fork"}
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["slug"] == "my-fork"
    assert body["lineage"] == {"source": "workspace", "slug": "my-loop", "version": 0}


async def test_duplicate_a_workspace_template_twice_suffixes_the_second_copy(
    client: AsyncClient, test_workspace: Workspace
):
    source = await _create(client, slug="my-loop")
    await client.post(f"{TEMPLATES_URL}/{source['id']}/duplicate", json={})

    response = await client.post(f"{TEMPLATES_URL}/{source['id']}/duplicate", json={})

    assert response.status_code == 201, response.text
    assert response.json()["slug"] == "my-loop-copy-2"


async def test_an_explicit_taken_new_slug_still_409s_with_the_slug_in_error_params(
    client: AsyncClient, test_workspace: Workspace
):
    """AC2. The auto-suffix must NOT swallow an explicit choice — and the body
    has to name the offending slug so the Library can say which one is taken
    instead of a generic "try again"."""
    await _create(client, slug="my-fork")
    source = await _create(client, slug="my-loop")

    response = await client.post(
        f"{TEMPLATES_URL}/{source['id']}/duplicate", json={"new_slug": "my-fork"}
    )

    assert response.status_code == 409, response.text
    body = response.json()
    assert body["error_code"] == "slug_taken"
    assert body["error_params"] == {"slug": "my-fork"}


async def test_duplicate_accepts_an_explicit_new_name(
    client: AsyncClient, test_workspace: Workspace
):
    """AC3 through the route — `new_name` has to survive the request schema,
    which forbids extra keys."""
    source = await _create(client, slug="my-loop")

    response = await client.post(
        f"{TEMPLATES_URL}/{source['id']}/duplicate",
        json={"new_slug": "my-fork", "new_name": "Production Fork"},
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert (body["slug"], body["name"]) == ("my-fork", "Production Fork")


async def test_archive_hides_a_template_then_unarchive_restores_it(
    client: AsyncClient, test_workspace: Workspace
):
    created = await _create(client)
    ref = created["id"]

    assert (await client.post(f"{TEMPLATES_URL}/{ref}/archive", json={})).status_code == 200
    hidden = {t["id"] for t in await _get_templates(client)}
    assert ref not in hidden

    assert (
        await client.post(f"{TEMPLATES_URL}/{ref}/unarchive", json={})
    ).status_code == 200
    visible = {t["id"] for t in await _get_templates(client)}
    assert ref in visible


async def test_archived_template_is_listed_when_explicitly_included(
    client: AsyncClient, test_workspace: Workspace
):
    created = await _create(client)
    ref = created["id"]
    await client.post(f"{TEMPLATES_URL}/{ref}/archive", json={})

    response = await client.get(TEMPLATES_URL, params={"include_archived": True})

    assert response.status_code == 200, response.text
    assert ref in {t["id"] for t in response.json()["templates"]}


async def test_restore_version_stages_a_snapshot_without_republishing(
    client: AsyncClient, test_workspace: Workspace
):
    created = await _create(client)
    ref = created["id"]
    await client.post(f"{TEMPLATES_URL}/{ref}/publish", json={})
    edited = _payload()["content"] | {"loop_prompt": "LATER EDIT"}
    await client.patch(f"{TEMPLATES_URL}/{ref}", json={"content": edited})
    await client.post(f"{TEMPLATES_URL}/{ref}/publish", json={"expected_version": 1})

    response = await client.post(
        f"{TEMPLATES_URL}/{ref}/versions/1/restore", json={}
    )

    assert response.status_code == 200, response.text
    assert response.json()["version"] == 2, "restore must not republish"
    draft = await client.get(f"{TEMPLATES_URL}/{ref}", params={"draft": True})
    assert draft.json()["content"]["loop_prompt"] == "Do one thing."


async def test_search_filters_the_listing(
    client: AsyncClient, test_workspace: Workspace
):
    await _create(client, slug="zebra-loop", name="Zebra loop")

    response = await client.get(TEMPLATES_URL, params={"q": "zebra"})

    assert response.status_code == 200, response.text
    assert [t["name"] for t in response.json()["templates"]] == ["Zebra loop"]


async def test_get_unknown_ref_404s(client: AsyncClient, test_workspace: Workspace):
    response = await client.get(f"{TEMPLATES_URL}/no-such-template")

    assert response.status_code == 404, response.text
    assert response.json()["error_code"] == "not_found"


async def test_mutating_a_system_template_404s(
    client: AsyncClient, test_workspace: Workspace
):
    """A system slug has no row to write to — the mutation must not
    half-succeed by creating one that shadows the code catalog."""
    for path, method in (
        (f"{TEMPLATES_URL}/coding-loop-v1", "patch"),
        (f"{TEMPLATES_URL}/coding-loop-v1/publish", "post"),
        (f"{TEMPLATES_URL}/coding-loop-v1/archive", "post"),
    ):
        response = await getattr(client, method)(path, json={})
        assert response.status_code == 404, (path, response.text)

    # Read back through the DETAIL route, not the listing: `coding-loop-v1` is
    # unlisted (p3-10), so listing-absence would no longer distinguish "still
    # code-defined" from "archived into a shadow row".
    survivor = await _get_detail(client, "coding-loop-v1")
    assert survivor["source"] == "system"
    assert survivor["id"] == "coding-loop-v1"

    # A shadow ROW would surface under the workspace namespace even though the
    # system slug is unlisted — the failure this test exists to catch.
    workspace_rows = [
        t["id"] for t in await _get_templates(client) if t["source"] == "workspace"
    ]
    assert not workspace_rows, workspace_rows


# --- the gating matrix -------------------------------------------------------
#
# The default `client` fixture authenticates as a workspace OWNER, so it can
# never show a 403. These use `role_client` (no get_current_user override) so
# the real dev-tier X-User-Email and Bearer vlr_ paths run, exactly as in prod.


@pytest_asyncio.fixture
async def role_client(db_session: AsyncSession) -> AsyncClient:
    app = create_app()

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


async def _member(db: AsyncSession, workspace: Workspace) -> User:
    user = User(email="member@valaris.dev", name="member")
    db.add(user)
    await db.flush()
    db.add(
        WorkspaceMember(
            workspace_id=workspace.id, user_id=user.id, role=WorkspaceRole.member
        )
    )
    await db.flush()
    return user


async def _mint_agent_key(db: AsyncSession, owner: User) -> str:
    """A real vlr_ key bound to an active agent, owned by the workspace OWNER.

    Binding it to the owner is the point: the caller's ROLE is beyond reproach,
    so a 403 can only come from `forbid_agent_callers` and not from the role
    gate — which is what distinguishes "agents are banned" from "that user
    lacked admin".
    """
    raw = "vlr_" + secrets.token_urlsafe(32)
    api_key = ApiKey(
        user_id=owner.id,
        name="loop-template-key",
        key_hash=hashlib.sha256(raw.encode()).hexdigest(),
        key_prefix=raw[:8],
    )
    db.add(api_key)
    await db.flush()
    db.add(
        Agent(
            name="loop-template-agent",
            agent_type=AgentType.coding,
            description="gating pin",
            created_by_id=owner.id,
            is_active=True,
            api_key_id=api_key.id,
        )
    )
    await db.flush()
    return raw


async def test_member_may_read_but_not_author(
    role_client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    member = await _member(db_session, test_workspace)
    headers = {"X-User-Email": member.email}

    listing = await role_client.get(TEMPLATES_URL, headers=headers)
    assert listing.status_code == 200, listing.text

    created = await role_client.post(TEMPLATES_URL, json=_payload(), headers=headers)
    assert created.status_code == 403, created.text


async def test_agent_key_may_read_but_not_author(
    role_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """A runner resolves templates to render a bound loop, so reads stay open;
    authoring the prompt that governs it must not."""
    raw = await _mint_agent_key(db_session, test_user)
    headers = {"Authorization": f"Bearer {raw}"}

    listing = await role_client.get(TEMPLATES_URL, headers=headers)
    assert listing.status_code == 200, listing.text
    detail = await role_client.get(f"{TEMPLATES_URL}/coding-loop-v1", headers=headers)
    assert detail.status_code == 200, detail.text

    created = await role_client.post(TEMPLATES_URL, json=_payload(), headers=headers)
    assert created.status_code == 403, created.text


async def test_every_mutation_route_bans_agent_callers(
    role_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """One route left unguarded is the whole hole — assert the set, not a
    sample."""
    raw = await _mint_agent_key(db_session, test_user)
    headers = {"Authorization": f"Bearer {raw}"}
    owner_headers = {"X-User-Email": test_user.email}
    created = await role_client.post(
        TEMPLATES_URL, json=_payload(), headers=owner_headers
    )
    ref = created.json()["id"]

    mutations = [
        ("post", TEMPLATES_URL, _payload(slug="other")),
        ("patch", f"{TEMPLATES_URL}/{ref}", {"name": "x"}),
        ("post", f"{TEMPLATES_URL}/{ref}/publish", {}),
        ("post", f"{TEMPLATES_URL}/{ref}/duplicate", {}),
        ("post", f"{TEMPLATES_URL}/{ref}/archive", {}),
        ("post", f"{TEMPLATES_URL}/{ref}/unarchive", {}),
        ("post", f"{TEMPLATES_URL}/{ref}/versions/1/restore", {}),
    ]

    for method, path, body in mutations:
        response = await getattr(role_client, method)(
            path, json=body, headers=headers
        )
        assert response.status_code == 403, (method, path, response.status_code)


async def test_listing_still_carries_what_the_loop_dialog_applies(
    client: AsyncClient, test_workspace: Workspace
):
    """The shipped BoardLoopDialog applies a template from the LISTING.

    It copies system_prompt/loop_prompt/tools into the raw textareas and
    re-derives hasSlots() from the prompt TEXT (frontend
    use-board-loop.ts:124), so a summary-only listing would break template
    selection in production — silently, because the dialog would set empty
    prompts rather than error. The listing is therefore a superset until the
    bind step replaces that dialog.
    """
    for template in await _get_templates(client):
        tid = template["id"]
        assert template["system_prompt"].strip(), f"{tid}: dialog would apply blank"
        assert template["loop_prompt"].strip(), f"{tid}: dialog would apply blank"
        assert template["tools"], f"{tid}: dialog would apply an empty tool set"
        assert isinstance(template["description"], str)

    # And the marker the dialog re-derives must agree with the prompt text it
    # is derived from, or the disable-the-option guard contradicts itself.
    for template in await _get_templates(client):
        derived = bool(
            SLOT_PATTERN.search(template["system_prompt"])
            or SLOT_PATTERN.search(template["loop_prompt"])
        )
        assert template["has_slots"] is derived, template["id"]


async def test_a_workspace_draft_is_applicable_from_the_listing_too(
    client: AsyncClient, test_workspace: Workspace
):
    """The compat fields must come from the DRAFT half for an unpublished row,
    which has no published content to read."""
    created = await _create(client)

    mine = next(
        t for t in await _get_templates(client) if t["id"] == created["id"]
    )

    assert mine["loop_prompt"] == "Do one thing."
    assert mine["tools"] == ["mcp__valaris__set_board_loop"]
    assert mine["description"] == "A loop"


# --- p1-02 follow-up: the draft contract over HTTP (card 65714512) -----------
#
# The service tests pin the semantics; these pin the WIRE, because the P3 draft
# store only ever sees JSON. Before the fix a client that did the obvious thing
# — save, keep the token the response handed back, save again — got a
# `stale_draft` 409 with no second editor anywhere.


async def test_autosave_round_trip_over_http_never_false_409s(
    client: AsyncClient, test_workspace: Workspace
):
    created = await _create(client)
    ref = created["id"]
    token = created["draft_updated_at"]

    for name in ("First", "Second", "Third"):
        response = await client.patch(
            f"{TEMPLATES_URL}/{ref}",
            json={"name": name, "expected_updated_at": token},
        )
        assert response.status_code == 200, response.text
        token = response.json()["draft_updated_at"]

    assert (await _get_detail(client, ref))["name"] == "Third"


async def test_the_get_token_unlocks_a_patch(
    client: AsyncClient, test_workspace: Workspace
):
    """A client that reloads the page and saves must not be told it is stale."""
    ref = (await _create(client))["id"]
    token = (await _get_detail(client, ref))["draft_updated_at"]

    response = await client.patch(
        f"{TEMPLATES_URL}/{ref}",
        json={"name": "Renamed", "expected_updated_at": token},
    )

    assert response.status_code == 200, response.text


async def test_a_superseded_token_over_http_still_409s(
    client: AsyncClient, test_workspace: Workspace
):
    """The lock stays a lock — this is the conflict the banner exists for."""
    created = await _create(client)
    ref = created["id"]
    first_token = created["draft_updated_at"]

    accepted = await client.patch(
        f"{TEMPLATES_URL}/{ref}",
        json={"name": "Other editor", "expected_updated_at": first_token},
    )
    assert accepted.status_code == 200, accepted.text

    rejected = await client.patch(
        f"{TEMPLATES_URL}/{ref}",
        json={"name": "Mine", "expected_updated_at": first_token},
    )

    assert rejected.status_code == 409
    assert rejected.json()["error_code"] == "stale_draft"


async def test_publish_then_edit_then_republish_tracks_dirty_state(
    client: AsyncClient, test_workspace: Workspace
):
    """The full P3 badge lifecycle, in the order the manager drives it."""
    ref = (await _create(client))["id"]
    assert (await _get_detail(client, ref))["has_unpublished_changes"] is False

    published = await client.post(f"{TEMPLATES_URL}/{ref}/publish", json={})
    assert published.status_code == 200, published.text
    assert published.json()["is_draft"] is False
    assert published.json()["has_unpublished_changes"] is False

    edited = await client.patch(
        f"{TEMPLATES_URL}/{ref}",
        json={"content": {**_payload()["content"], "loop_prompt": "Do TWO things."}},
    )
    assert edited.status_code == 200, edited.text
    assert edited.json()["has_unpublished_changes"] is True
    assert edited.json()["is_draft"] is False, "publishing is not undone by editing"

    republished = await client.post(f"{TEMPLATES_URL}/{ref}/publish", json={})
    assert republished.status_code == 200, republished.text
    assert republished.json()["version"] == 2
    assert republished.json()["has_unpublished_changes"] is False


async def test_the_listing_shows_the_dirty_badge_after_a_post_publish_edit(
    client: AsyncClient, test_workspace: Workspace
):
    """The Library renders from the listing, so the listing must carry it too."""
    ref = (await _create(client))["id"]
    await client.post(f"{TEMPLATES_URL}/{ref}/publish", json={})
    await client.patch(
        f"{TEMPLATES_URL}/{ref}",
        json={"content": {**_payload()["content"], "loop_prompt": "Do TWO things."}},
    )

    mine = next(t for t in await _get_templates(client) if t["id"] == ref)

    assert mine["is_draft"] is False
    assert mine["has_unpublished_changes"] is True


async def test_a_system_template_carries_no_lock_token_over_http(
    client: AsyncClient, test_workspace: Workspace
):
    detail = await _get_detail(client, "revision-loop")

    assert detail["draft_updated_at"] is None
    assert detail["has_unpublished_changes"] is False


async def test_a_member_can_still_read_the_draft_contract_fields(
    role_client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    """Spec §6.1: reads stay member-visible. This fix must not narrow the gate.

    Asserted on a system template because a plain member cannot author one to
    read back.
    """
    member = await _member(db_session, test_workspace)

    response = await role_client.get(
        f"{TEMPLATES_URL}/revision-loop", headers={"X-User-Email": member.email}
    )

    assert response.status_code == 200, response.text
    assert "draft_updated_at" in response.json()
    assert "has_unpublished_changes" in response.json()


# --- GET /{ref}/profile — the profile page's data (card 8e4f95ba) -----------
#
# The track record is DERIVED from stamped executions (spec §2.3), so these
# tests seed rows the way `start_execution` stamps them and assert the
# aggregate, never a stored counter.


async def _seed_iteration(
    db_session: AsyncSession,
    *,
    workspace: Workspace,
    board,
    agent: Agent,
    template_key: str | None,
    outcome: str | None = "worked",
    cost_usd: float | None = 1.5,
    duration_seconds: float | None = 30.0,
    started_at: datetime | None = None,
):
    """One loop_iteration row shaped exactly as the runner + stamp leave it."""
    summary = None if outcome is None else f"outcome={outcome} shipped abc123 — a card"
    execution = AgentExecution(
        agent_id=agent.id,
        workspace_id=workspace.id,
        board_id=board.id,
        action="loop_iteration",
        status=ExecutionStatus.completed,
        input_summary="loop iteration 1",
        output_summary=summary,
        prompt_slug=template_key,
        cost_usd=cost_usd,
        duration_seconds=duration_seconds,
        started_at=started_at or datetime(2026, 8, 17, 12, 0, 0),
    )
    db_session.add(execution)
    await db_session.flush()
    return execution


async def _get_profile(client: AsyncClient, ref: str) -> dict:
    response = await client.get(f"{TEMPLATES_URL}/{ref}/profile")
    assert response.status_code == 200, response.text
    return response.json()


async def test_profile_endpoint_shape_and_track_record(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board,
    test_agent: Agent,
):
    """AC3: stored profile + a track record counted off stamped executions,
    with a tokenless summary falling to `unknown`."""
    key = CODING_LOOP_KEY
    for outcome in ("worked", "worked", "objective_complete", "blocked_on_human"):
        await _seed_iteration(
            db_session,
            workspace=test_workspace,
            board=test_board,
            agent=test_agent,
            template_key=key,
            outcome=outcome,
        )
    # A row the runner wrote before the outcome convention existed.
    await _seed_iteration(
        db_session,
        workspace=test_workspace,
        board=test_board,
        agent=test_agent,
        template_key=key,
        outcome=None,
    )
    await db_session.commit()

    body = await _get_profile(client, "coding-loop")

    assert set(body) == PROFILE_KEYS, body
    assert body["id"] == "coding-loop"
    assert body["source"] == "system"
    assert body["version"] == CODING_LOOP_VERSION
    # Stored profile prose travels verbatim — the page renders it, never
    # re-derives it.
    assert body["profile"]["tagline"]

    track = body["track_record"]
    assert track["iterations"] == 5
    assert track["outcomes"] == {
        "worked": 2,
        "objective_complete": 1,
        "blocked_on_human": 1,
        "nothing_ready": 0,
        "unknown": 1,
    }
    assert track["self_terminations"] == 1
    assert track["spent_usd"] == pytest.approx(7.5)
    assert track["duration_seconds_total"] == pytest.approx(150.0)


async def test_profile_outcome_token_is_read_at_the_head_not_anywhere(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board,
    test_agent: Agent,
):
    """The card's named gotcha: outcomes live ONLY as the head token.

    An iteration whose PROSE quotes another outcome ("...the previous
    outcome=worked run...") must not be counted as that outcome, and a token
    that merely starts with an outcome name ("worked_around") is not that
    outcome either. Both fixtures are deliberately hostile — a realistic
    summary cannot tell an anchored match from a substring one.
    """
    key = CODING_LOOP_KEY
    for summary in (
        "blocked_on_human — could not reproduce the outcome=worked run",
        "outcome=worked_around the missing fixture",
        "  outcome=nothing_ready — nothing to do",
        # Case-insensitive to match the SQL mirror (_has_outcome lowercases
        # both sides); the two must never drift onto different rules.
        "OUTCOME=Worked — shouted by some other writer",
    ):
        execution = AgentExecution(
            agent_id=test_agent.id,
            workspace_id=test_workspace.id,
            board_id=test_board.id,
            action="loop_iteration",
            status=ExecutionStatus.completed,
            input_summary="loop iteration 1",
            output_summary=summary,
            prompt_slug=key,
        )
        db_session.add(execution)
    await db_session.commit()

    outcomes = (await _get_profile(client, "coding-loop"))["track_record"]["outcomes"]

    # Rows 3 and 4 carry real head tokens; rows 1 and 2 do not.
    assert outcomes["nothing_ready"] == 1
    assert outcomes["worked"] == 1
    assert outcomes["unknown"] == 2


async def test_profile_track_record_ignores_other_templates_and_actions(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board,
    test_agent: Agent,
):
    """The stats key is exact: another template's runs, an unstamped legacy
    iteration (AC4) and a non-loop action must all stay out."""
    await _seed_iteration(
        db_session,
        workspace=test_workspace,
        board=test_board,
        agent=test_agent,
        template_key=CODING_LOOP_KEY,
    )
    await _seed_iteration(
        db_session,
        workspace=test_workspace,
        board=test_board,
        agent=test_agent,
        template_key="loop-template:system/triage-loop@2",
    )
    await _seed_iteration(
        db_session,
        workspace=test_workspace,
        board=test_board,
        agent=test_agent,
        template_key=None,
    )
    stage = AgentExecution(
        agent_id=test_agent.id,
        workspace_id=test_workspace.id,
        board_id=test_board.id,
        action="implement",
        status=ExecutionStatus.completed,
        input_summary="card work",
        output_summary="outcome=worked did a card",
        prompt_slug=CODING_LOOP_KEY,
        cost_usd=99.0,
    )
    db_session.add(stage)
    await db_session.commit()

    track = (await _get_profile(client, "coding-loop"))["track_record"]

    assert track["iterations"] == 1
    assert track["spent_usd"] == pytest.approx(1.5)


async def test_profile_per_board_split_and_outcomes_apply_the_same_filters(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board,
    test_agent: Agent,
):
    """All three halves of the aggregate — totals, the per-board split and the
    outcome tally — must filter identically.

    Each decoy below is excluded for a different reason (wrong action, wrong
    version, unstamped), and each carries a DISTINCT outcome so a filter that
    leaks into the summaries query shows up in the tally rather than hiding
    behind a matching value.
    """
    key = CODING_LOOP_KEY
    other_board = Board(
        workspace_id=test_workspace.id,
        name="Second Board",
        slug="second-board",
        created_by=test_agent.created_by_id,
    )
    db_session.add(other_board)
    await db_session.flush()

    await _seed_iteration(
        db_session,
        workspace=test_workspace,
        board=test_board,
        agent=test_agent,
        template_key=key,
        outcome="worked",
    )
    await _seed_iteration(
        db_session,
        workspace=test_workspace,
        board=other_board,
        agent=test_agent,
        template_key=key,
        outcome="worked",
    )
    # Decoys, each with an outcome no legitimate row uses.
    decoys = [
        ("implement", key, "objective_complete"),
        ("loop_iteration", "loop-template:system/coding-loop@1", "blocked_on_human"),
        ("loop_iteration", None, "nothing_ready"),
    ]
    for action, slug, outcome in decoys:
        db_session.add(
            AgentExecution(
                agent_id=test_agent.id,
                workspace_id=test_workspace.id,
                board_id=other_board.id,
                action=action,
                status=ExecutionStatus.completed,
                input_summary="decoy",
                output_summary=f"outcome={outcome} decoy",
                prompt_slug=slug,
                cost_usd=50.0,
            )
        )
    await db_session.commit()

    track = (await _get_profile(client, "coding-loop"))["track_record"]

    assert track["iterations"] == 2
    boards = {b["board_id"]: b for b in track["boards"]}
    assert set(boards) == {str(test_board.id), str(other_board.id)}
    assert boards[str(other_board.id)]["iterations"] == 1
    assert boards[str(other_board.id)]["spent_usd"] == pytest.approx(1.5)
    # Every decoy outcome stayed out of the tally.
    assert track["outcomes"] == {
        "worked": 2,
        "nothing_ready": 0,
        "blocked_on_human": 0,
        "objective_complete": 0,
        "unknown": 0,
    }


async def test_profile_track_record_is_scoped_to_the_calling_workspace(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_agent: Agent,
):
    """A system template is shared by every workspace, so its stats MUST be
    tenanted — otherwise one workspace's spend leaks into another's page."""
    other_ws = Workspace(
        name="Other", slug="other-ws", created_by=test_agent.created_by_id
    )
    db_session.add(other_ws)
    await db_session.flush()
    other_board = Board(
        workspace_id=other_ws.id,
        name="Their Board",
        slug="their-board",
        created_by=test_agent.created_by_id,
    )
    db_session.add(other_board)
    await db_session.flush()

    await _seed_iteration(
        db_session,
        workspace=other_ws,
        board=other_board,
        agent=test_agent,
        template_key=CODING_LOOP_KEY,
        outcome="worked",
        cost_usd=99.0,
    )
    await db_session.commit()

    track = (await _get_profile(client, "coding-loop"))["track_record"]

    assert track["iterations"] == 0
    assert track["spent_usd"] == 0
    assert track["boards"] == []
    assert track["outcomes"]["worked"] == 0


async def test_profile_track_record_separates_versions_of_one_template(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board,
    test_agent: Agent,
):
    """A v1 run is not credited to v2 — the version is part of the stamp."""
    await _seed_iteration(
        db_session,
        workspace=test_workspace,
        board=test_board,
        agent=test_agent,
        template_key="loop-template:system/coding-loop@1",
    )
    await _seed_iteration(
        db_session,
        workspace=test_workspace,
        board=test_board,
        agent=test_agent,
        template_key=CODING_LOOP_KEY,
    )
    await db_session.commit()

    track = (await _get_profile(client, "coding-loop"))["track_record"]

    assert track["iterations"] == 1


async def test_profile_boards_using_counts_bindings_not_executions(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board,
    test_agent: Agent,
):
    """AC3: boards_using is the binding count. Executions prove history, a
    binding proves present use — a detached board keeps the former, loses the
    latter."""
    for _ in range(3):
        await _seed_iteration(
            db_session,
            workspace=test_workspace,
            board=test_board,
            agent=test_agent,
            template_key=CODING_LOOP_KEY,
        )
    await db_session.commit()

    assert (await _get_profile(client, "coding-loop"))["boards_using"] == 0

    await BoardLoopTemplateBindingRepository(db_session).upsert(
        board_id=test_board.id,
        template_ref={"source": "system", "slug": "coding-loop"},
        version=2,
        slot_values={},
        rendered_by_id=None,
        rendered_hash=None,
    )
    await db_session.commit()

    # A board bound to a DIFFERENT template must not inflate this count.
    decoy_board = Board(
        workspace_id=test_workspace.id,
        name="Triage Board",
        slug="triage-board",
        created_by=test_agent.created_by_id,
    )
    db_session.add(decoy_board)
    await db_session.flush()
    await BoardLoopTemplateBindingRepository(db_session).upsert(
        board_id=decoy_board.id,
        template_ref={"source": "system", "slug": "triage-loop"},
        version=2,
        slot_values={},
        rendered_by_id=None,
        rendered_hash=None,
    )
    await db_session.commit()

    body = await _get_profile(client, "coding-loop")
    assert body["boards_using"] == 1
    assert [b["board_id"] for b in body["track_record"]["boards"]] == [
        str(test_board.id)
    ]
    assert body["track_record"]["boards"][0]["iterations"] == 3


async def test_profile_counts_a_board_less_iteration_without_a_null_board_row(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board,
    test_agent: Agent,
):
    """board_id is nullable, so the per-board split must skip NULL rather than
    emit a board whose id is None — the page renders that list."""
    key = CODING_LOOP_KEY
    await _seed_iteration(
        db_session,
        workspace=test_workspace,
        board=test_board,
        agent=test_agent,
        template_key=key,
    )
    db_session.add(
        AgentExecution(
            agent_id=test_agent.id,
            workspace_id=test_workspace.id,
            board_id=None,
            action="loop_iteration",
            status=ExecutionStatus.completed,
            input_summary="loop iteration 1",
            output_summary="outcome=worked no board",
            prompt_slug=key,
            cost_usd=1.5,
        )
    )
    await db_session.commit()

    track = (await _get_profile(client, "coding-loop"))["track_record"]

    # The totals still see it; only the per-board split drops it.
    assert track["iterations"] == 2
    assert [b["board_id"] for b in track["boards"]] == [str(test_board.id)]


async def test_profile_of_an_archived_template_still_serves_its_history(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    """A board bound before the archive still links here, and its history is
    the whole reason the page exists — archiving must not 404 it."""
    ref = (await _create(client))["id"]
    archive = await client.post(f"{TEMPLATES_URL}/{ref}/archive")
    assert archive.status_code == 200, archive.text

    body = await _get_profile(client, ref)

    assert body["id"] == ref
    assert body["track_record"]["iterations"] == 0


async def test_profile_of_an_unused_template_is_all_zeroes_not_absent(
    client: AsyncClient, test_workspace: Workspace
):
    """A never-run template still renders a page — empty stats, not a 404."""
    body = await _get_profile(client, "revision-loop")

    track = body["track_record"]
    assert track["iterations"] == 0
    assert track["spent_usd"] == 0
    assert track["last_used_at"] is None
    assert track["boards"] == []
    assert track["outcomes"]["worked"] == 0


async def test_profile_carries_the_setup_contract_rails_tools_and_slots(
    client: AsyncClient, test_workspace: Workspace
):
    """The page documents what the template NEEDS, all from content."""
    body = await _get_profile(client, "coding-loop")

    assert body["rails_defaults"]["max_iterations"]
    assert "mcp__valaris__set_board_loop" in body["tools"]
    assert body["setup_contract"]["required_column_types"]
    assert any(slot["name"] for slot in body["slots"])


async def test_profile_reports_last_used_at_from_the_newest_iteration(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board,
    test_agent: Agent,
):
    for day in (14, 17, 15):
        await _seed_iteration(
            db_session,
            workspace=test_workspace,
            board=test_board,
            agent=test_agent,
            template_key=CODING_LOOP_KEY,
            started_at=datetime(2026, 8, day, 9, 0, 0),
        )
    await db_session.commit()

    last_used = (await _get_profile(client, "coding-loop"))["track_record"][
        "last_used_at"
    ]

    # SQLite strips tz, so compare the components the assertion is about.
    assert last_used.startswith("2026-08-17")


async def test_profile_of_a_workspace_template_is_served_by_uuid(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    """The ref grammar holds here too: workspace templates address by UUID."""
    ref = (await _create(client))["id"]

    body = await _get_profile(client, ref)

    assert body["id"] == ref
    assert body["source"] == "workspace"
    assert body["track_record"]["iterations"] == 0


async def test_profile_of_an_unknown_ref_is_404(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.get(f"{TEMPLATES_URL}/no-such-template/profile")

    assert response.status_code == 404, response.text


async def test_profile_of_a_workspace_template_with_published_versions_lists_them(
    client: AsyncClient, test_workspace: Workspace
):
    """CT-116 console sweep, 2026-08-18: the profile tab 500'd for every
    workspace template that had ever been published — profile() embedded raw
    version ORM rows into a plain BaseModel list. Every per-tab endpoint must
    serve BOTH sources; workspace versions travel as LoopTemplateVersionRead.
    """
    created = await _create(client)
    ref = created["id"]
    assert (
        await client.post(f"{TEMPLATES_URL}/{ref}/publish", json={})
    ).status_code == 200
    await client.patch(f"{TEMPLATES_URL}/{ref}", json={"name": "Second"})
    assert (
        await client.post(
            f"{TEMPLATES_URL}/{ref}/publish", json={"expected_version": 1}
        )
    ).status_code == 200

    body = await _get_profile(client, ref)

    assert [v["version"] for v in body["versions"]] == [2, 1]
    assert all(isinstance(v["published_at"], str) for v in body["versions"])
    assert set(body["versions"][0]) == {"version", "published_at", "note"}


async def test_versions_of_a_system_template_is_an_empty_list(
    client: AsyncClient, test_workspace: Workspace
):
    """CT-116 console sweep, 2026-08-18: the Versions tab 404'd for every
    system template (the most-opened kind). A system template has no version
    rows — that is an empty history, not a missing template; the profile
    endpoint already says so and the two must agree.
    """
    response = await client.get(f"{TEMPLATES_URL}/coding-loop/versions")

    assert response.status_code == 200, response.text
    assert response.json() == []


async def test_profile_is_member_readable(
    role_client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    """Spec §6.1: reads stay member-visible, mutations stay admin."""
    member = await _member(db_session, test_workspace)

    response = await role_client.get(
        f"{TEMPLATES_URL}/coding-loop/profile",
        headers={"X-User-Email": member.email},
    )

    assert response.status_code == 200, response.text


# --- repo-fact leak lint (p4-04) ---------------------------------------------
#
# Warnings, never a refusal: every assertion below pins that publish still
# SUCCEEDS while carrying the findings. A test that let a leak 422 would turn a
# hint into a control and break every author who names a URL on purpose.

_LEAKY_PROMPT = (
    "Clone https://github.com/example/project and reset to "
    "commit ce4ea8b4.\nWork in ~/backplane-runner/repos/loop.\n"
)


def _leaky_payload(**overrides) -> dict:
    payload = _payload(**overrides)
    payload["content"]["loop_prompt"] = _LEAKY_PROMPT
    return payload


async def test_publish_returns_warnings(
    client: AsyncClient, test_workspace: Workspace
):
    created = await client.post(TEMPLATES_URL, json=_leaky_payload())
    ref = created.json()["id"]

    response = await client.post(f"{TEMPLATES_URL}/{ref}/publish", json={})

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["version"] == 1, "a leak must never block the publish"
    codes = {warning["code"] for warning in body["warnings"]}
    assert {"url", "git_ref", "abs_path"} <= codes, body["warnings"]


async def test_publish_of_a_clean_draft_returns_no_warnings(
    client: AsyncClient, test_workspace: Workspace
):
    """The other half of the branch — otherwise `warnings` could be hardcoded."""
    created = await _create(client)
    ref = created["id"]

    response = await client.post(f"{TEMPLATES_URL}/{ref}/publish", json={})

    assert response.status_code == 200, response.text
    assert response.json()["warnings"] == []


async def test_lint_endpoint_member(
    role_client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace,
    test_user: User,
):
    """Members lint (it is a read), mirroring preview — authors need not be admins."""
    owner_headers = {"X-User-Email": test_user.email}
    created = await role_client.post(
        TEMPLATES_URL, json=_leaky_payload(), headers=owner_headers
    )
    ref = created.json()["id"]
    member = await _member(db_session, test_workspace)

    response = await role_client.post(
        f"{TEMPLATES_URL}/{ref}/lint", headers={"X-User-Email": member.email}
    )

    assert response.status_code == 200, response.text
    findings = response.json()["findings"]
    assert {finding["code"] for finding in findings} >= {"url", "git_ref", "abs_path"}
    assert all(
        {"code", "match", "line", "hint"} == set(finding) for finding in findings
    )


async def test_lint_endpoint_lints_the_draft_half(
    client: AsyncClient, test_workspace: Workspace
):
    """The editor lints what it is EDITING; a published half would lag a keystroke."""
    created = await _create(client)
    ref = created["id"]
    await client.post(f"{TEMPLATES_URL}/{ref}/publish", json={})
    await client.patch(
        f"{TEMPLATES_URL}/{ref}",
        json={"content": {**_payload()["content"], "loop_prompt": _LEAKY_PROMPT}},
    )

    response = await client.post(f"{TEMPLATES_URL}/{ref}/lint")

    assert response.status_code == 200, response.text
    assert "url" in {finding["code"] for finding in response.json()["findings"]}


async def test_lint_endpoint_on_a_clean_system_template_is_empty(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(f"{TEMPLATES_URL}/coding-loop/lint")

    assert response.status_code == 200, response.text
    assert response.json()["findings"] == []


async def test_lint_endpoint_unknown_ref_is_404(
    client: AsyncClient, test_workspace: Workspace
):
    response = await client.post(f"{TEMPLATES_URL}/no-such-template/lint")

    assert response.status_code == 404, response.text


async def test_lint_endpoint_is_not_an_agent_banned_mutation(
    role_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """Lint is a READ shaped as a POST (like preview), so the agent ban must NOT
    apply — a runner checking its own bound template is a legitimate caller."""
    raw = await _mint_agent_key(db_session, test_user)

    response = await role_client.post(
        f"{TEMPLATES_URL}/coding-loop/lint",
        headers={"Authorization": f"Bearer {raw}"},
    )

    assert response.status_code == 200, response.text


# --------------------------------------------------------------- p4-01 sharing
#
# Export/import of a template as a portable `loop_template` envelope
# (card 5061acba). The service tests next door pin the envelope's SHAPE; these
# pin the HTTP contract that shape travels over: who may call it, what the file
# is called, and that the mutating half defaults to a preview.


async def test_export_returns_a_named_attachment(
    client: AsyncClient, test_workspace: Workspace
):
    created = await client.post(TEMPLATES_URL, json=_payload())
    ref = created.json()["id"]

    response = await client.get(f"{TEMPLATES_URL}/{ref}/export")

    assert response.status_code == 200, response.text
    # The filename is the contract with the browser's download; a template
    # named by its uuid would be unusable in a folder of exports.
    assert response.headers["content-disposition"] == (
        'attachment; filename="my-loop.loop-template.json"'
    )
    body = response.json()
    assert body["entity_type"] == "loop_template"
    assert body["data"]["slug"] == "my-loop"


async def test_import_defaults_to_a_dry_run(
    client: AsyncClient, test_workspace: Workspace
):
    """The destructive half of a share is opt-IN over HTTP: a POST with no
    query string previews and writes nothing."""
    created = await client.post(TEMPLATES_URL, json=_payload())
    bundle = (
        await client.get(f"{TEMPLATES_URL}/{created.json()['id']}/export")
    ).json()
    bundle["data"]["slug"] = "imported-loop"

    response = await client.post(f"{TEMPLATES_URL}/import", json=bundle)

    assert response.status_code == 200, response.text
    assert response.json()["dry_run"] is True
    assert response.json()["action"] == "created"

    listing = await client.get(TEMPLATES_URL)
    slugs = {t.get("slug") for t in listing.json()["templates"]}
    assert "imported-loop" not in slugs, "a default POST wrote a template"


async def test_import_commits_when_asked(
    client: AsyncClient, test_workspace: Workspace
):
    created = await client.post(TEMPLATES_URL, json=_payload())
    bundle = (
        await client.get(f"{TEMPLATES_URL}/{created.json()['id']}/export")
    ).json()
    bundle["data"]["slug"] = "imported-loop"

    response = await client.post(
        f"{TEMPLATES_URL}/import?dry_run=false", json=bundle
    )

    assert response.status_code == 200, response.text
    assert response.json()["dry_run"] is False
    assert response.json()["template_id"]

    detail = await client.get(f"{TEMPLATES_URL}/{response.json()['template_id']}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["is_draft"] is True, "an import must land unpublished"


async def test_import_wrong_entity_type_is_400(
    client: AsyncClient, test_workspace: Workspace
):
    created = await client.post(TEMPLATES_URL, json=_payload())
    bundle = (
        await client.get(f"{TEMPLATES_URL}/{created.json()['id']}/export")
    ).json()
    bundle["entity_type"] = "pipeline_bundle"

    response = await client.post(
        f"{TEMPLATES_URL}/import?dry_run=false", json=bundle
    )
    assert response.status_code == 400, response.text


async def test_import_of_an_unrenderable_template_is_422(
    client: AsyncClient, test_workspace: Workspace
):
    created = await client.post(TEMPLATES_URL, json=_payload())
    bundle = (
        await client.get(f"{TEMPLATES_URL}/{created.json()['id']}/export")
    ).json()
    bundle["data"]["slug"] = "broken-loop"
    bundle["data"]["content"]["loop_prompt"] = "Advance <<MISSING>> and stop."

    response = await client.post(
        f"{TEMPLATES_URL}/import?dry_run=false", json=bundle
    )
    assert response.status_code == 422, response.text


async def test_a_member_may_export_but_not_import(
    role_client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace,
    test_user: User,
):
    """Reading a template out is a member act; writing someone else's file into
    the workspace is not."""
    owner_headers = {"X-User-Email": test_user.email}
    created = await role_client.post(
        TEMPLATES_URL, json=_payload(), headers=owner_headers
    )
    ref = created.json()["id"]
    bundle = (
        await role_client.get(
            f"{TEMPLATES_URL}/{ref}/export", headers=owner_headers
        )
    ).json()

    member = await _member(db_session, test_workspace)
    headers = {"X-User-Email": member.email}

    exported = await role_client.get(f"{TEMPLATES_URL}/{ref}/export", headers=headers)
    assert exported.status_code == 200, exported.text

    imported = await role_client.post(
        f"{TEMPLATES_URL}/import", json=bundle, headers=headers
    )
    assert imported.status_code == 403, imported.text


async def test_an_agent_key_may_export_but_not_import(
    role_client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_user: User,
):
    """Same split as every other mutation on this router: a runner may read the
    template it runs, but authoring one stays out of agent hands."""
    owner_headers = {"X-User-Email": test_user.email}
    created = await role_client.post(
        TEMPLATES_URL, json=_payload(), headers=owner_headers
    )
    ref = created.json()["id"]
    bundle = (
        await role_client.get(
            f"{TEMPLATES_URL}/{ref}/export", headers=owner_headers
        )
    ).json()

    raw = await _mint_agent_key(db_session, test_user)
    headers = {"Authorization": f"Bearer {raw}"}

    exported = await role_client.get(f"{TEMPLATES_URL}/{ref}/export", headers=headers)
    assert exported.status_code == 200, exported.text

    imported = await role_client.post(
        f"{TEMPLATES_URL}/import", json=bundle, headers=headers
    )
    assert imported.status_code == 403, imported.text
