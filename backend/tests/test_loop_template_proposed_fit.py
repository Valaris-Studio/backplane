# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from copy import deepcopy
from unittest.mock import patch

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.kanban.board import Board
from app.models.config_template import ConfigTemplate
from app.models.kanban.card import Card
from app.models.kanban.column import Column, ColumnType
from app.models.notes.note import Note
from app.models.user import User
from app.models.workspace import Workspace
from app.services.loop_template_render import SlotSpec, TemplateContent
from app.services.loop_templates._types import SystemTemplate

pytestmark = pytest.mark.anyio

PROPOSED_TEMPLATE = SystemTemplate(
    slug="test-proposed-fit",
    version=1,
    name="Proposed setup",
    content=TemplateContent(
        system_prompt="Run <<RUN_LABEL>> from <<CARD_BRANCH_PREFIX>>.",
        loop_prompt="Read <<SEED_NOTE_TITLE>> (<<SEED_NOTE_ID>>).",
        slots=[
            SlotSpec(name="RUN_LABEL", kind="scalar", required=True),
            SlotSpec(name="CARD_BRANCH_PREFIX", kind="scalar"),
            SlotSpec(name="SEED_NOTE_TITLE", kind="scalar"),
            SlotSpec(name="SEED_NOTE_ID", kind="scalar"),
        ],
        setup_contract={"requires_run_label": True, "pinned_notes": ["seed"]},
        derived_rails={"completion_query": {"label": "<<RUN_LABEL>>"}},
    ),
    profile={"tagline": "Proposed setup must use the operator's current inputs"},
)


@pytest.fixture(autouse=True)
def proposed_template():
    from app.services import loop_templates as registry

    original = registry.get_system_template

    def lookup(slug: str):
        return PROPOSED_TEMPLATE if slug == PROPOSED_TEMPLATE.slug else original(slug)

    with patch("app.services.loop_template.get_system_template", side_effect=lookup):
        yield


def _preview_url(board: Board) -> str:
    return (
        f"/api/workspaces/default/boards/{board.id}"
        f"/loop-templates/{PROPOSED_TEMPLATE.slug}/preview"
    )


async def _live_labels(db: AsyncSession, board: Board, user: User) -> None:
    backlog = Column(
        board_id=board.id,
        name="Queued work",
        column_type=ColumnType.backlog,
        position=1024,
        color="#6b7280",
    )
    db.add(backlog)
    await db.flush()
    for position, label in enumerate(["busiest-run", "busiest-run", "proposed-run"]):
        db.add(
            Card(
                board_id=board.id,
                column_id=backlog.id,
                title=f"Work {position}",
                labels=[label],
                position=(position + 1) * 1024,
                created_by=user.id,
            )
        )
    await db.flush()


async def _pinned_note(
    db: AsyncSession, workspace: Workspace, board: Board, user: User, title: str
) -> Note:
    note = Note(
        workspace_id=workspace.id,
        board_id=board.id,
        title=title,
        content="",
        pinned=True,
        created_by=user.id,
    )
    db.add(note)
    await db.flush()
    return note


@pytest.mark.parametrize("saved_run_label", [None, "previous-run"])
async def test_board_preview_derives_related_slots_from_proposed_run_label(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
    saved_run_label: str | None,
):
    await _live_labels(db_session, test_board, test_user)
    test_board.loop_config = {
        "enabled": False,
        **(
            {"completion_query": {"label": saved_run_label}}
            if saved_run_label
            else {}
        ),
    }
    await db_session.flush()
    saved = deepcopy(test_board.loop_config)

    response = await client.post(
        _preview_url(test_board), json={"slot_values": {"RUN_LABEL": "proposed-run"}}
    )

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["used_values"]["RUN_LABEL"]["value"] == "proposed-run"
    assert data["used_values"]["CARD_BRANCH_PREFIX"]["value"] == "proposed-run/"
    await db_session.refresh(test_board)
    assert test_board.loop_config == saved


async def test_board_preview_explicit_seed_identity_supplies_its_actual_title(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    test_user: User,
):
    test_board.loop_config = {
        "enabled": False,
        "completion_query": {"label": "proposed-run"},
    }
    await _pinned_note(
        db_session, test_workspace, test_board, test_user, "proposed-run old seed"
    )
    selected = await _pinned_note(
        db_session, test_workspace, test_board, test_user, "Approved acceptance plan"
    )
    await db_session.flush()
    saved = deepcopy(test_board.loop_config)

    response = await client.post(
        _preview_url(test_board),
        json={
            "slot_values": {
                "RUN_LABEL": "proposed-run",
                "SEED_NOTE_ID": str(selected.id),
            }
        },
    )

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["used_values"]["SEED_NOTE_ID"]["value"] == str(selected.id)
    assert data["used_values"]["SEED_NOTE_TITLE"]["value"] == selected.title
    assert "proposed-run old seed" not in data["loop_prompt"]
    await db_session.refresh(test_board)
    assert test_board.loop_config == saved


async def test_board_preview_without_proposal_retains_saved_run_label(
    client: AsyncClient,
    db_session: AsyncSession,
    test_board: Board,
    test_user: User,
):
    await _live_labels(db_session, test_board, test_user)
    test_board.loop_config = {
        "enabled": False,
        "completion_query": {"label": "previous-run"},
    }
    await db_session.flush()

    response = await client.post(_preview_url(test_board), json={})

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["used_values"]["RUN_LABEL"]["value"] == "previous-run"
    assert data["used_values"]["CARD_BRANCH_PREFIX"]["value"] == "previous-run/"


async def test_proposed_fit_reads_unsaved_slots_and_rails_without_mutation(
    client, db_session, test_board, test_user,
):
    await _live_labels(db_session, test_board, test_user)
    test_board.loop_config = {"enabled": False, "completion_query": {"label": "previous-run"}}
    await db_session.flush()
    response = await client.post(
        _preview_url(test_board).removesuffix("preview") + "fit",
        json={"slot_values": {"RUN_LABEL": "proposed-run"}, "loop_config": {"completion_query": {"label": "proposed-run"}}},
    )
    assert response.status_code == 200, response.text
    assert response.json()["autofill"]["RUN_LABEL"]["value"] == "proposed-run"
    assert response.json()["completion_query_matches_run_label"] is True
    await db_session.refresh(test_board)
    assert test_board.loop_config["completion_query"]["label"] == "previous-run"


async def test_proposed_fit_explicit_missing_seed_does_not_fall_back(
    client, db_session, test_board, test_workspace, test_user,
):
    import uuid
    await _pinned_note(db_session, test_workspace, test_board, test_user, "proposed-run decoy")
    response = await client.post(
        _preview_url(test_board).removesuffix("preview") + "fit",
        json={"slot_values": {"RUN_LABEL": "proposed-run", "SEED_NOTE_ID": str(uuid.uuid4())}},
    )
    assert response.status_code == 200, response.text
    assert "SEED_NOTE_TITLE" not in response.json()["autofill"]
    assert any(c["id"] == "seed_note_identity" and c["status"] == "missing" for c in response.json()["checks"])


async def test_board_preview_can_target_published_half_for_binding(
    client, db_session, test_board, test_workspace, test_user,
):
    published = PROPOSED_TEMPLATE.content.model_dump()
    draft = deepcopy(published)
    published["system_prompt"] = "PUBLISHED <<RUN_LABEL>> <<CARD_BRANCH_PREFIX>>"
    draft["system_prompt"] = "DRAFT <<RUN_LABEL>> <<CARD_BRANCH_PREFIX>>"
    template = ConfigTemplate(
        workspace_id=test_workspace.id, name="Published setup", slug="published-setup",
        kind="loop", version=1, content=published, draft_content=draft, draft_profile={},
        created_by_id=test_user.id,
    )
    db_session.add(template)
    await db_session.flush()
    response = await client.post(
        _preview_url(test_board).replace(PROPOSED_TEMPLATE.slug, str(template.id)),
        json={"slot_values": {"RUN_LABEL": "proposed-run"}, "draft": False, "version": 1},
    )
    assert response.status_code == 200, response.text
    assert response.json()["system_prompt"].startswith("PUBLISHED")


async def test_proposed_preview_reports_invalid_scalar_without_crashing(client, test_board):
    response = await client.post(_preview_url(test_board), json={"slot_values": {"RUN_LABEL": ["bad"]}})
    assert response.status_code == 200, response.text
    assert response.json()["findings"]
