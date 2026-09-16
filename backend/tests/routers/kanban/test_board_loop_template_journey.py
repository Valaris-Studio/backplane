# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""One workspace template's whole life, through the real routers, in order.

Every other loop-template suite pins ONE seam. This one exists because the
bugs that shipped all lived BETWEEN seams, and each assertion here is about
what the *previous* step left behind:

  create → patch draft → publish v1 → bind → fit → apply → publish v2
         → re-render → detach

  step 4→7  a workspace template republished UNDERNEATH a live binding — the
            re-render must move the binding to v2 and swap the running prompts
            (B1: `LoopBindingService.content_for` returning None instead of
            exploding on an unreconstructable snapshot).
  step 5    a fit report read while an unpublished edit sits in the draft half
            must judge the DRAFT, not the published snapshot (B4).
  negative  pairing workspace A's slug with workspace B's board id on
            `POST /executions` is a 404 that leaves no row (B2).

A WORKSPACE template, not a system slug: `test_board_loop_template_binding.py`
already covers the system path with its patched-in double, and the
publish-a-second-version-under-a-binding case only exists for workspace rows,
whose versions live in the database rather than the binary.

Every mutation goes through `client`. The only direct DB reads are the two
facts no router surfaces: the binding row's version, and the absence of an
execution row after the tenancy 404.
"""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.agents.execution import AgentExecution
from app.models.config_template import BoardLoopTemplateBinding, ConfigTemplateVersion
from app.models.kanban.board import Board
from app.models.kanban.column import ColumnType
from app.models.workspace import Workspace

pytestmark = pytest.mark.anyio

TEMPLATES_URL = "/api/workspaces/default/loop-templates"
BOARDS_URL = "/api/workspaces/default/boards"

# The off-switch tool is what `validate_template` insists on, so a fixture
# without it turns every "publish succeeds" step into an accidental 422 test.
OFF_SWITCH = "mcp__valaris__set_board_loop"

# v1 and v2 differ in loop_prompt PROSE, not in slot grammar: the re-render at
# step 7 must be a content swap the assertions can see, without also tripping
# the new-required-slot guard, which is a different card's contract.
V1_LOOP_PROMPT = "Advance <<RUN_LABEL>> the careful way."
V2_LOOP_PROMPT = "Advance <<RUN_LABEL>> the FAST way."

# The draft-only edit at step 2, published at step 3. It is deliberately
# unlike V1_LOOP_PROMPT so a step that reads the wrong half is visibly wrong
# rather than accidentally right.
SEED_LOOP_PROMPT = "Placeholder, never published."


def _content(*, loop_prompt: str, required_column: str | None = None) -> dict:
    """A template that renders, publishes clean, and asks a board for one thing.

    `setup_contract` is what gives the fit report something to say; without it
    steps 5 and 6 would assert against an empty checklist.
    """
    setup_contract: dict = {"requires_run_label": True}
    if required_column is not None:
        setup_contract["required_column_types"] = [required_column]
    return {
        "system_prompt": "You work on <<RUN_LABEL>>.",
        "loop_prompt": loop_prompt,
        "slots": [
            {
                "name": "RUN_LABEL",
                "kind": "scalar",
                "label": "Run label",
                "required": True,
            }
        ],
        "rails_defaults": {"max_iterations": 5},
        "tools": [OFF_SWITCH],
        "setup_contract": setup_contract,
        "derived_rails": {},
    }


SLOT_VALUES = {"RUN_LABEL": "journey"}


# --- the request vocabulary, one line per step in the test bodies -----------


async def _create(client: AsyncClient, *, slug: str = "journey-loop") -> dict:
    response = await client.post(
        TEMPLATES_URL,
        json={
            "slug": slug,
            "name": "Journey loop",
            "profile": {"emoji": "🧭", "tagline": "One template's whole life"},
            "content": _content(loop_prompt=SEED_LOOP_PROMPT),
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _read(client: AsyncClient, ref: str, *, draft: bool = False) -> dict:
    response = await client.get(f"{TEMPLATES_URL}/{ref}", params={"draft": draft})
    assert response.status_code == 200, response.text
    return response.json()


async def _patch_draft(
    client: AsyncClient,
    ref: str,
    *,
    content: dict,
    expected_updated_at: str | None = None,
):
    body: dict = {"content": content}
    if expected_updated_at is not None:
        body["expected_updated_at"] = expected_updated_at
    return await client.patch(f"{TEMPLATES_URL}/{ref}", json=body)


async def _publish(
    client: AsyncClient, ref: str, *, expected_version: int | None = None
):
    body: dict = {}
    if expected_version is not None:
        body["expected_version"] = expected_version
    return await client.post(f"{TEMPLATES_URL}/{ref}/publish", json=body)


async def _bind(client: AsyncClient, board: Board, ref: str, **extra):
    return await client.put(
        f"{BOARDS_URL}/{board.id}/loop",
        json={
            "template": {"source": "workspace", "ref": ref, "slot_values": SLOT_VALUES},
            **extra,
        },
    )


async def _detach(client: AsyncClient, board: Board):
    return await client.put(f"{BOARDS_URL}/{board.id}/loop", json={"template": {}})


async def _fit(client: AsyncClient, board: Board, ref: str):
    return await client.get(f"{BOARDS_URL}/{board.id}/loop-templates/{ref}/fit")


async def _apply(client: AsyncClient, board: Board, ref: str, fix_ids: list[str]):
    return await client.post(
        f"{BOARDS_URL}/{board.id}/loop-templates/{ref}/fit/apply",
        json={"fix_ids": fix_ids},
    )


def _one(checks: list[dict], check_id: str) -> dict:
    """The single check with this id, or a failure that names what WAS there.

    A `next(..., None)` here would turn a renamed check id into a silent
    `None`, and the assertion after it into a vacuous comparison.
    """
    matches = [check for check in checks if check["id"] == check_id]
    assert len(matches) == 1, f"{check_id} not found in {[c['id'] for c in checks]}"
    return matches[0]


async def _binding(db: AsyncSession, board: Board) -> BoardLoopTemplateBinding | None:
    return await db.scalar(
        select(BoardLoopTemplateBinding).where(
            BoardLoopTemplateBinding.board_id == board.id
        )
    )


# --- the journey -----------------------------------------------------------


async def test_a_workspace_template_lives_its_whole_life(
    client: AsyncClient, db_session: AsyncSession, test_board: Board
):
    # 1. Create — a draft is version 0 and nothing is published yet.
    created = await _create(client)
    ref = created["id"]
    assert created["version"] == 0
    assert created["is_draft"] is True

    # 2. Autosave the draft. The published half must NOT move: a `?draft=true`
    #    read and a paramless read disagreeing is the whole point of the two
    #    halves, and an unpublished row serves its draft either way — so the
    #    real divergence assertion waits until after step 3's publish.
    patched = await _patch_draft(
        client, ref, content=_content(loop_prompt=V1_LOOP_PROMPT)
    )
    assert patched.status_code == 200, patched.text
    assert (await _read(client, ref, draft=True))["content"]["loop_prompt"] == (
        V1_LOOP_PROMPT
    )

    # 3. Publish — version 1, and the published half now matches the draft.
    published = await _publish(client, ref)
    assert published.status_code == 200, published.text
    assert published.json()["version"] == 1
    assert (await _read(client, ref))["content"]["loop_prompt"] == V1_LOOP_PROMPT

    # 4. Bind. The board's running prompts become the render of (v1, slots),
    #    with the slot substituted — proving the strings the runner reads come
    #    from the template and not from anything the caller typed.
    bound = await _bind(client, test_board, ref)
    assert bound.status_code == 200, bound.text
    loop = bound.json()
    assert loop["loop_prompt"] == "Advance journey the careful way."
    assert loop["system_prompt"] == "You work on journey."
    assert loop["tools"] == [OFF_SWITCH]
    assert loop["max_iterations"] == 5
    assert loop["template"]["version"] == 1
    assert (await _binding(db_session, test_board)).version == 1

    # 5. Edit the draft WITHOUT publishing, then fit. The report must judge
    #    what the operator is looking at — the draft — even though the board is
    #    running v1. (B4: fit/apply resolve with draft=True.)
    draft_only = _content(loop_prompt=V2_LOOP_PROMPT, required_column="review")
    assert (await _patch_draft(client, ref, content=draft_only)).status_code == 200

    fit = await _fit(client, test_board, ref)
    assert fit.status_code == 200, fit.text
    report = fit.json()
    #    v1 — what the board is RUNNING — asks for no columns at all, so a
    #    `column:review` check can only have come from the unpublished draft.
    #    The report also still names v1, because `version` is the row's
    #    published number even when the content judged is the draft half.
    review_check = _one(report["checks"], "column:review")
    assert review_check["status"] == "missing", report["checks"]
    assert review_check["fix_id"] == "create_column:review"
    assert report["template"] == {"ref": ref, "version": 1}

    # 6. Apply the fix the report advertised, and get a fresh report back that
    #    no longer asks for it.
    applied = await _apply(client, test_board, ref, [review_check["fix_id"]])
    assert applied.status_code == 200, applied.text
    after = applied.json()
    assert [r["outcome"] for r in after["applied"]] == ["applied"]
    assert _one(after["checks"], "column:review")["status"] == "ok", after["checks"]

    #    The fix is a real board mutation, not a report-only recalculation:
    #    the column shows up on the board's own detail read.
    detail = await client.get(f"{BOARDS_URL}/{test_board.id}")
    assert detail.status_code == 200, detail.text
    assert ColumnType.review.value in [
        column["column_type"] for column in detail.json()["columns"]
    ]

    # 7. Publish the draft that has been sitting there since step 5 → v2, and
    #    re-render the LIVE binding onto it. This is the step that only exists
    #    for workspace templates, and the one B1 was about: the binding moves
    #    1 → 2 and the running prompt becomes v2's.
    republished = await _publish(client, ref)
    assert republished.status_code == 200, republished.text
    assert republished.json()["version"] == 2

    #    Prune the v1 snapshot the board is still bound to before re-rendering.
    #    This is the ONE shape that reaches B1's guard from a workspace
    #    template (`content_for(v1)` is now None): without it the journey
    #    passes with the guard reverted, and B1's net would live only in the
    #    binding suite. Verified by mutation: `if False:` at the guard fails here.
    await db_session.execute(
        delete(ConfigTemplateVersion).where(
            ConfigTemplateVersion.template_id == uuid.UUID(ref),
            ConfigTemplateVersion.version == 1,
        )
    )
    await db_session.flush()

    rerendered = await _bind(client, test_board, ref)
    assert rerendered.status_code == 200, rerendered.text
    assert rerendered.json()["template"]["version"] == 2
    assert rerendered.json()["loop_prompt"] == "Advance journey the FAST way."
    assert (await _binding(db_session, test_board)).version == 2

    # 8. Detach. The binding row is gone; the prompts it rendered stay behind
    #    as ordinary raw text, so the loop keeps running exactly what it ran.
    detached = await _detach(client, test_board)
    assert detached.status_code == 200, detached.text
    assert detached.json()["template"] is None
    assert detached.json()["loop_prompt"] == "Advance journey the FAST way."
    assert await _binding(db_session, test_board) is None


# --- the negatives ---------------------------------------------------------


async def test_a_foreign_board_id_under_our_slug_is_404_and_writes_nothing(
    client: AsyncClient, db_session: AsyncSession, test_workspace: Workspace
):
    """B2: the slug and the board id arrive from the SAME caller.

    Pairing "default" with another workspace's board used to write the
    execution row under `default` while reading the FOREIGN board's binding —
    leaking which template another tenant runs. A board that does not exist and
    a board someone else owns must be indistinguishable from out here.
    """
    made = await client.post(
        "/api/workspaces", json={"name": "Other", "slug": "other-ws"}
    )
    assert made.status_code == 201, made.text

    foreign_board = await client.post(
        "/api/workspaces/other-ws/boards", json={"name": "Foreign board"}
    )
    assert foreign_board.status_code == 201, foreign_board.text
    foreign_board_id = foreign_board.json()["id"]

    agent = await client.post(
        "/api/agents",
        json={
            "name": "journey-runner",
            "agent_type": "coding",
            "description": "tenancy negative",
            "allowed_workspaces": ["default", "other-ws"],
        },
    )
    assert agent.status_code == 201, agent.text

    response = await client.post(
        f"/api/agents/{agent.json()['id']}/executions",
        json={
            "workspace_slug": "default",
            "board_id": foreign_board_id,
            "action": "loop_iteration",
            "input_summary": "iteration under someone else's board",
        },
    )

    assert response.status_code == 404, response.text
    # Name the board, not the slug: without `test_workspace` this route 404s
    # with "Workspace 'default' not found" and the assertion above passes
    # while proving nothing about tenancy at all.
    assert str(foreign_board_id) in response.json()["detail"], response.text
    assert (
        await db_session.scalar(select(func.count()).select_from(AgentExecution)) == 0
    )


async def test_publishing_against_a_stale_expected_version_is_409_and_writes_nothing(
    client: AsyncClient, test_workspace: Workspace
):
    """Validation runs BEFORE anything is written, so a rejected publish must
    leave the row at exactly the version the caller was told about."""
    ref = (await _create(client))["id"]
    assert (await _publish(client, ref)).json()["version"] == 1

    response = await _publish(client, ref, expected_version=0)

    assert response.status_code == 409, response.text
    body = response.json()
    assert body["error_code"] == "stale_version"
    assert body["context"]["current_version"] == 1
    assert (await _read(client, ref))["version"] == 1


async def test_autosaving_against_a_stale_lock_token_is_409_and_writes_nothing(
    client: AsyncClient, test_workspace: Workspace
):
    """The second editor's token was minted before the first editor's save.

    The token is compared as the STRING the API handed out — reconstructing a
    datetime would lose the tzinfo SQLite strips and silently compare equal.
    """
    ref = (await _create(client))["id"]
    stale_token = (await _read(client, ref, draft=True))["draft_updated_at"]
    assert stale_token is not None

    first = await _patch_draft(
        client, ref, content=_content(loop_prompt=V1_LOOP_PROMPT)
    )
    assert first.status_code == 200, first.text

    response = await _patch_draft(
        client,
        ref,
        content=_content(loop_prompt=V2_LOOP_PROMPT),
        expected_updated_at=stale_token,
    )

    assert response.status_code == 409, response.text
    assert response.json()["error_code"] == "stale_draft"
    assert (await _read(client, ref, draft=True))["content"]["loop_prompt"] == (
        V1_LOOP_PROMPT
    )
