# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Completion acceptance must govern every dependency consumer."""

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch
import uuid

import pytest

from app.models.agents.reservation import AgentReservation
from app.models.kanban.board import Board
from app.models.kanban.card import Card, CardDependency
from app.models.kanban.column import Column, ColumnType
from app.services.completion import CompletionService
from app.services.kanban.card import CardService
from app.services.scheduling.assignment_service import AssignmentService
from app.utils import utcnow
from tests.test_postmerge_acceptance import (
    MERGED,
    completion_fixture,
    policy,
    status,
    submit,
)

__all__ = ["completion_fixture"]
pytestmark = pytest.mark.slow
SURFACES = (
    "card",
    "board",
    "search",
    "edges",
    "status",
    "scan",
    "reservation",
    "readiness",
)


def manual_policy(**overrides):
    return policy(
        landing_actor="agent",
        source_review="none",
        review_role=None,
        postmerge_validation=None,
        auto_complete=False,
        **overrides,
    )


async def save_policy(client, fixture, **overrides):
    response = await client.put(
        f"{fixture.url}/policy", json={"policy": manual_policy(**overrides)}
    )
    assert response.status_code == 200, response.text


async def accept_source(client, agent_client, fixture, *, release="accepted"):
    await save_policy(client, fixture, dependency_release=release)
    with patch(
        "app.services.kanban.reconciler.board_scoped_pr_status",
        new=AsyncMock(return_value=status()),
    ):
        await submit(agent_client, fixture)
    accepted = await CompletionService(fixture.db).record_merge(
        fixture.board, fixture.card, status(merged=True)
    )
    assert accepted.status == "accepted"
    assert accepted.merge_sha == MERGED
    assert fixture.card.column_id != fixture.done.id
    return accepted


async def add_dependent(client, fixture, *, board=None):
    board = board or fixture.board
    column = Column(
        board_id=board.id,
        name="Ready work",
        position=8192,
        column_type=ColumnType.backlog,
    )
    fixture.db.add(column)
    await fixture.db.flush()
    card = Card(
        board_id=board.id,
        column_id=column.id,
        title="Dependent work",
        position=1024,
        created_by=fixture.card.created_by,
    )
    fixture.db.add(card)
    await fixture.db.flush()
    base = f"/api/workspaces/default/boards/{board.id}"
    url = f"{base}/cards/{card.id}"
    response = await client.post(
        f"{url}/dependencies", json={"depends_on_card_id": str(fixture.card.id)}
    )
    assert response.status_code in (200, 201), response.text
    return SimpleNamespace(card=card, board=board, column=column, base=base, url=url)


def stage_for(dependent):
    return {
        "role": "operator-custom-dependent-role",
        "discover": {
            "strategy": "column_scan",
            "column_type": "backlog",
            "filters": {
                "all_dependencies_done": True,
                "column_id": str(dependent.column.id),
                "require_git_repo": False,
            },
        },
    }


async def assert_surface(client, fixture, dependent, surface, ready):
    if surface == "card":
        response = await client.get(dependent.url)
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["depends_on_count"] == 1
        assert data["dependency_status"] == ("unblocked" if ready else "blocked")
    elif surface == "board":
        response = await client.get(dependent.base)
        assert response.status_code == 200, response.text
        cards = {
            card["id"]: card
            for column in response.json()["columns"]
            for card in column["cards"]
        }
        data = cards[str(dependent.card.id)]
        assert data["depends_on_count"] == 1
        assert data["dependency_status"] == ("unblocked" if ready else "blocked")
    elif surface == "search":
        cards = await CardService(fixture.db).search_cards(
            dependent.board.id,
            workspace_id=fixture.board.workspace_id,
            column_id=dependent.column.id,
            all_dependencies_done=True,
        )
        assert (dependent.card.id in {card.id for card in cards}) is ready
    elif surface == "edges":
        response = await client.get(f"{dependent.url}/dependencies")
        assert response.status_code == 200, response.text
        edges = response.json()["depends_on"]
        assert len(edges) == 1
        assert edges[0]["depends_on_card_id"] == str(fixture.card.id)
        assert edges[0].get("satisfied") is ready
    elif surface == "status":
        response = await client.get(f"{dependent.url}/dependencies/status")
        assert response.status_code == 200, response.text
        assert response.json()["ready"] is ready
    elif surface == "scan":
        cards = await AssignmentService(fixture.db)._candidate_cards(
            workspace_id=fixture.board.workspace_id,
            stage=stage_for(dependent),
            board_filter=dependent.board.id,
            agent_id=fixture.execution.agent_id,
        )
        assert (dependent.card.id in {card.id for card in cards}) is ready
    elif surface == "reservation":
        reservation = AgentReservation(
            agent_id=fixture.execution.agent_id,
            workspace_id=fixture.board.workspace_id,
            board_id=dependent.board.id,
            card_id=dependent.card.id,
            role=stage_for(dependent)["role"],
            expires_at=utcnow() + timedelta(minutes=5),
        )
        actual = await AssignmentService(fixture.db)._reservation_still_eligible(
            reservation,
            [stage_for(dependent)],
            workspace_id=fixture.board.workspace_id,
        )
        assert actual is ready
    elif surface == "readiness":
        response = await client.get(f"{dependent.base}/loop/readiness")
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["ready_count"] == int(ready)
        assert data["blocked_count"] == int(not ready)
        assert data["actionable"] is ready
    else:
        raise AssertionError(f"Unknown dependency consumer {surface}")


@pytest.mark.parametrize("surface", SURFACES)
async def test_accepted_prerequisite_releases_before_manual_done(
    client, agent_client, completion_fixture, surface
):
    f = completion_fixture
    await accept_source(client, agent_client, f)
    dependent = await add_dependent(client, f)
    await assert_surface(client, f, dependent, surface, True)


@pytest.mark.parametrize("surface", SURFACES)
async def test_done_release_requires_acceptance_and_manual_done(
    client, agent_client, completion_fixture, surface
):
    f = completion_fixture
    await accept_source(client, agent_client, f, release="done")
    dependent = await add_dependent(client, f)
    await assert_surface(client, f, dependent, surface, False)
    moved = await client.patch(
        f"{f.url.removesuffix('/completion')}/cards/{f.card.id}/move",
        json={"column_id": str(f.done.id), "position": 1024},
    )
    assert moved.status_code == 200, moved.text
    await assert_surface(client, f, dependent, surface, True)


@pytest.mark.parametrize("surface", SURFACES)
async def test_prepolicy_done_card_has_no_implicit_acceptance(
    client, completion_fixture, surface
):
    f = completion_fixture
    # Represents an existing Done row when the operator opts into a policy.
    f.card.column_id = f.done.id
    await f.db.flush()
    await save_policy(client, f, dependency_release="done")
    assert await CompletionService(f.db).is_accepted(f.board, f.card) is False
    dependent = await add_dependent(client, f)
    await assert_surface(client, f, dependent, surface, False)


@pytest.mark.parametrize("surface", ("card", "search", "scan", "reservation"))
@pytest.mark.parametrize("change", ("policy", "card"))
async def test_stale_acceptance_never_releases_a_done_prerequisite(
    client, agent_client, completion_fixture, surface, change
):
    f = completion_fixture
    await accept_source(client, agent_client, f)
    dependent = await add_dependent(client, f)
    f.card.column_id = f.done.id
    await f.db.flush()
    if change == "policy":
        await save_policy(client, f, dependency_release="done")
        # Restoring a previous policy must not revive its old receipt.
        await save_policy(client, f, dependency_release="accepted")
    else:
        # A legacy writer can race without calling the completion mutation hook.
        f.card.branch_name = "feature/revised-source"
        await f.db.flush()
    assert await CompletionService(f.db).is_accepted(f.board, f.card) is False
    await assert_surface(client, f, dependent, surface, False)


@pytest.mark.parametrize("surface", ("board", "search", "scan", "reservation"))
async def test_cross_board_dependency_uses_prerequisite_policy(
    client, agent_client, completion_fixture, surface
):
    f = completion_fixture
    await accept_source(client, agent_client, f)
    other = Board(
        workspace_id=f.board.workspace_id,
        name="Consumer board",
        slug="consumer-board",
        created_by=f.card.created_by,
        completion_policy=manual_policy(dependency_release="done"),
    )
    f.db.add(other)
    await f.db.flush()
    dependent = await add_dependent(client, f, board=other)
    await assert_surface(client, f, dependent, surface, True)
    await save_policy(client, f, dependency_release="done")
    await assert_surface(client, f, dependent, surface, False)


@pytest.mark.parametrize("surface", ("card", "search", "scan", "reservation"))
async def test_legacy_policy_keeps_done_column_dependency_behavior(
    client, completion_fixture, surface
):
    f = completion_fixture
    response = await client.put(f"{f.url}/policy", json={"policy": None})
    assert response.status_code == 200, response.text
    dependent = await add_dependent(client, f)
    await assert_surface(client, f, dependent, surface, False)
    f.card.column_id = f.done.id
    await f.db.flush()
    await assert_surface(client, f, dependent, surface, True)


@pytest.mark.parametrize("accepted", (False, True))
async def test_graph_conflicts_use_accepted_prerequisite_semantics(
    client, agent_client, completion_fixture, accepted
):
    f = completion_fixture
    if accepted:
        await accept_source(client, agent_client, f)
    else:
        await save_policy(client, f, dependency_release="accepted")
        f.card.column_id = f.done.id
    dependent = await add_dependent(client, f)
    # Inspect historical data; the validator must recognize an invalid Done row.
    dependent.card.column_id = f.done.id
    await f.db.flush()
    response = await client.get(f"{dependent.base}/dependencies/validation")
    assert response.status_code == 200, response.text
    conflicts = response.json()["conflicts"]
    assert bool(conflicts) is (not accepted)
    if conflicts:
        assert conflicts[0]["unsatisfied_dependency_ids"] == [str(f.card.id)]


async def test_search_filters_unsatisfied_receipts_before_limit(
    client, agent_client, completion_fixture
):
    f = completion_fixture
    await accept_source(client, agent_client, f)
    dependent = await add_dependent(client, f)
    unaccepted = Card(
        board_id=f.board.id,
        column_id=f.done.id,
        title="Historical Done without acceptance",
        position=2048,
        created_by=f.card.created_by,
    )
    f.db.add(unaccepted)
    await f.db.flush()
    blocked = Card(
        board_id=f.board.id,
        column_id=dependent.column.id,
        title="Ordered before valid work",
        position=0,
        created_by=f.card.created_by,
    )
    f.db.add(blocked)
    await f.db.flush()
    f.db.add(
        CardDependency(
            card_id=blocked.id,
            depends_on_card_id=unaccepted.id,
            created_by=f.card.created_by,
        )
    )
    await f.db.flush()
    response = await client.get(
        f"{dependent.base}/cards/search",
        params={
            "column_id": str(dependent.column.id),
            "all_dependencies_done": "true",
            "limit": 1,
        },
    )
    assert response.status_code == 200, response.text
    assert [card["id"] for card in response.json()] == [str(dependent.card.id)]


async def test_dependency_status_preserves_board_visibility(client, completion_fixture):
    f = completion_fixture
    dependent = await add_dependent(client, f)
    foreign = Board(
        workspace_id=f.board.workspace_id,
        name="Another board",
        slug="another-board",
        created_by=f.card.created_by,
    )
    f.db.add(foreign)
    await f.db.flush()
    actual = await client.get(f"{dependent.url}/dependencies/status")
    assert actual.status_code == 200, actual.text
    wrong_board = await client.get(
        f"/api/workspaces/default/boards/{foreign.id}/cards/{dependent.card.id}/dependencies/status"
    )
    assert wrong_board.status_code == 404, wrong_board.text
    missing_card = await client.get(
        f"{dependent.base}/cards/{uuid.uuid4()}/dependencies/status"
    )
    assert missing_card.status_code == 404, missing_card.text


async def test_reservation_reloads_policy_after_acquiring_workspace_lock(client, completion_fixture):
    from sqlalchemy import update
    from app.services.kanban.completion_dependencies import CompletionDependencyService
    f = completion_fixture
    response = await client.put(f"{f.url}/policy", json={"policy": None})
    assert response.status_code == 200
    f.card.column_id = f.done.id
    await f.db.flush()
    dependent = await add_dependent(client, f)
    # Simulate another committed writer while this session still retains the
    # board loaded during the candidate scan.
    await f.db.execute(update(Board).where(Board.id == f.board.id).values(
        completion_policy=manual_policy(dependency_release="done"),
    ).execution_options(synchronize_session=False))
    allowed = await CompletionDependencyService(f.db).source_work_allowed(
        dependent.card.id, workspace_id=f.board.workspace_id,
        require_dependencies=True, lock=True,
    )
    assert allowed is False


async def test_accepted_manual_card_is_not_source_work_or_open_pr(client, agent_client, completion_fixture):
    f = completion_fixture
    await accept_source(client, agent_client, f, release="done")
    dependent = await add_dependent(client, f)
    candidates = await AssignmentService(f.db)._candidate_cards(
        workspace_id=f.board.workspace_id,
        stage={"role": "custom-source-role", "discover": {"strategy": "column_scan", "column_type": "review"}},
        board_filter=f.board.id, agent_id=f.execution.agent_id,
    )
    assert f.card.id not in {card.id for card in candidates}
    ready = await client.get(f"{dependent.base}/loop/readiness")
    assert ready.json()["blocked_count"] == 1
    assert ready.json()["awaiting_merge_count"] == 0
    assert ready.json()["review_open_pr_count"] == 0
