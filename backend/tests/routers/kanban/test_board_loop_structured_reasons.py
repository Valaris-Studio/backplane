# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Structured Board Loop stop reasons remain closed, additive, and retry-safe."""

from math import inf, nan
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient
from pydantic import ValidationError as PydanticValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.models.activity import Activity, ActivityAction, ActivityEntityType
from app.models.kanban.board import Board
from app.models.workspace import Workspace
from app.schemas.kanban.loop import LoopStatePatch
from app.services.loop_config_validation import LOOP_CONFIG_DEFAULTS


BASE_URL = "/api/workspaces/default/boards"


def _loop_url(board: Board) -> str:
    return f"{BASE_URL}/{board.id}/loop"


def _state_url(board: Board) -> str:
    return f"{_loop_url(board)}/state"


async def _configure_enabled(client: AsyncClient, board: Board):
    response = await client.put(
        _loop_url(board),
        json={"enabled": True, "loop_prompt": "keep making progress"},
    )
    assert response.status_code in (200, 201), response.text
    return response


async def _disable_with_max_iterations(
    client: AsyncClient,
    board: Board,
    *,
    maximum: int = 10,
    diagnostic: str = "iteration rail reached by runner",
):
    response = await client.patch(
        _state_url(board),
        json={
            "enabled": False,
            "reason": f"max_iterations reached ({maximum})",
            "reason_code": "max_iterations_reached",
            "reason_params": {"max_iterations": maximum},
            "diagnostic": diagnostic,
        },
    )
    assert response.status_code == 200, response.text
    return response


async def _loop_activity_count(db_session: AsyncSession, board: Board) -> int:
    return (
        await db_session.scalar(
            select(func.count())
            .select_from(Activity)
            .where(
                Activity.entity_type == ActivityEntityType.board,
                Activity.entity_id == board.id,
                Activity.action == ActivityAction.updated,
            )
        )
    ) or 0


async def _store_disabled_loop(
    db_session: AsyncSession,
    board: Board,
    *,
    reason: str,
    reason_code: str,
    reason_params: dict,
    diagnostic: str = "raw runner diagnostic",
) -> None:
    board.loop_config = {
        **LOOP_CONFIG_DEFAULTS,
        "tools": [],
        "disabled_reason": reason,
        "disabled_reason_code": reason_code,
        "disabled_reason_params": reason_params,
        "disabled_diagnostic": diagnostic,
        "version": 7,
        "updated_at": "2026-08-07T12:00:00+00:00",
    }
    await db_session.flush()


async def test_historical_config_serializes_structured_fields_as_null(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
):
    test_board.loop_config = {
        **LOOP_CONFIG_DEFAULTS,
        "tools": [],
        "disabled_reason": "legacy runner stopped",
        "version": 7,
        "updated_at": "2026-08-07T12:00:00+00:00",
    }
    await db_session.flush()

    response = await client.get(_loop_url(test_board))

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["disabled_reason"] == "legacy runner stopped"
    assert data["disabled_reason_code"] is None
    assert data["disabled_reason_params"] is None
    assert data["disabled_diagnostic"] is None


async def test_get_preserves_unknown_future_code_for_frontend_legacy_fallback(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
):
    await _store_disabled_loop(
        db_session,
        test_board,
        reason="future runner fallback EXACT",
        reason_code="future_safety_rail",
        reason_params={"threshold": 12},
        diagnostic="future diagnostic kept verbatim",
    )

    response = await client.get(_loop_url(test_board))

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["disabled_reason"] == "future runner fallback EXACT"
    assert data["disabled_reason_code"] == "future_safety_rail"
    assert data["disabled_reason_params"] == {"threshold": 12}
    assert data["disabled_diagnostic"] == "future diagnostic kept verbatim"


@pytest.mark.parametrize(
    ("reason_code", "reason_params"),
    [
        ("max_iterations_reached", {"max_iterations": 10}),
        ("budget_exhausted", {"spent_usd": 20.5, "budget_usd": 20}),
        ("consecutive_failures", {"count": 3}),
    ],
)
async def test_get_discards_known_metadata_when_legacy_reason_is_not_exact(
    reason_code: str,
    reason_params: dict,
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
    caplog: pytest.LogCaptureFixture,
):
    await _store_disabled_loop(
        db_session,
        test_board,
        reason="legacy bytes changed by an older backend",
        reason_code=reason_code,
        reason_params=reason_params,
    )

    response = await client.get(_loop_url(test_board))

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["disabled_reason"] == "legacy bytes changed by an older backend"
    assert data["disabled_reason_code"] is None
    assert data["disabled_reason_params"] is None
    assert data["disabled_diagnostic"] is None
    assert "discarding stale known loop reason metadata" in caplog.text.lower()


async def test_get_preserves_integral_float_reason_params_from_json_round_trip(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
):
    await _store_disabled_loop(
        db_session,
        test_board,
        reason="max_iterations reached (10)",
        reason_code="max_iterations_reached",
        reason_params={"max_iterations": 10.0},
    )

    response = await client.get(_loop_url(test_board))

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["disabled_reason_code"] == "max_iterations_reached"
    assert data["disabled_reason_params"] == {"max_iterations": 10.0}


@pytest.mark.parametrize(
    ("reason", "reason_code", "reason_params"),
    [
        (
            "max_iterations reached (0)",
            "max_iterations_reached",
            {"max_iterations": 0},
        ),
        (
            "budget_usd exhausted ($5.00 of $20.00)",
            "budget_exhausted",
            {"spent_usd": 5, "budget_usd": 20},
        ),
        (
            "-1 consecutive failed iterations",
            "consecutive_failures",
            {"count": -1},
        ),
    ],
)
async def test_get_discards_semantically_invalid_known_metadata(
    reason: str,
    reason_code: str,
    reason_params: dict,
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
):
    await _store_disabled_loop(
        db_session,
        test_board,
        reason=reason,
        reason_code=reason_code,
        reason_params=reason_params,
    )

    response = await client.get(_loop_url(test_board))

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["disabled_reason"] == reason
    assert data["disabled_reason_code"] is None
    assert data["disabled_reason_params"] is None
    assert data["disabled_diagnostic"] is None


@pytest.mark.parametrize(
    ("reason", "reason_code", "reason_params"),
    [
        (
            "max_iterations reached (10)",
            "max_iterations_reached",
            {"max_iterations": 10},
        ),
        (
            "budget_usd exhausted ($20.50 of $20.00)",
            "budget_exhausted",
            {"spent_usd": 20.5, "budget_usd": 20},
        ),
        (
            "3 consecutive failed iterations",
            "consecutive_failures",
            {"count": 3},
        ),
    ],
)
async def test_patch_disable_round_trips_each_closed_reason_shape(
    reason: str,
    reason_code: str,
    reason_params: dict,
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    await _configure_enabled(client, test_board)

    response = await client.patch(
        _state_url(test_board),
        json={
            "enabled": False,
            "reason": reason,
            "reason_code": reason_code,
            "reason_params": reason_params,
            "diagnostic": "non-localized runner diagnostic",
        },
    )

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["disabled_reason"] == reason
    assert data["disabled_reason_code"] == reason_code
    assert data["disabled_reason_params"] == reason_params
    assert data["disabled_diagnostic"] == "non-localized runner diagnostic"
    current = (await client.get(_loop_url(test_board))).json()
    assert current == data


@pytest.mark.parametrize(
    ("reason", "reason_code", "reason_params"),
    [
        (
            "max_iterations reached (11)",
            "max_iterations_reached",
            {"max_iterations": 10},
        ),
        (
            "budget_usd exhausted ($19.00 of $20.00)",
            "budget_exhausted",
            {"spent_usd": 20.5, "budget_usd": 20},
        ),
        (
            "4 consecutive failed iterations",
            "consecutive_failures",
            {"count": 3},
        ),
    ],
)
async def test_patch_rejects_structured_reason_when_legacy_fallback_is_not_exact(
    reason: str,
    reason_code: str,
    reason_params: dict,
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    await _configure_enabled(client, test_board)

    response = await client.patch(
        _state_url(test_board),
        json={
            "enabled": False,
            "reason": reason,
            "reason_code": reason_code,
            "reason_params": reason_params,
        },
    )

    assert response.status_code == 422, response.text
    current = (await client.get(_loop_url(test_board))).json()
    assert current["enabled"] is True
    assert current["version"] == 1


@pytest.mark.parametrize(
    "payload",
    [
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "unknown_code",
            "reason_params": {},
        },
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "max_iterations_reached",
        },
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "max_iterations_reached",
            "reason_params": {"count": 10},
        },
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "max_iterations_reached",
            "reason_params": {"max_iterations": 10, "extra": 1},
        },
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "max_iterations_reached",
            "reason_params": {"max_iterations": "10"},
        },
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "max_iterations_reached",
            "reason_params": {"max_iterations": 10.0},
        },
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "max_iterations_reached",
            "reason_params": {"max_iterations": True},
        },
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "max_iterations_reached",
            "reason_params": {"max_iterations": 0},
        },
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "max_iterations_reached",
            "reason_params": {"max_iterations": -1},
        },
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "budget_exhausted",
            "reason_params": {"spent_usd": 20},
        },
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "budget_exhausted",
            "reason_params": {"spent_usd": 20, "budget_usd": "20"},
        },
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "budget_exhausted",
            "reason_params": {"spent_usd": False, "budget_usd": 20},
        },
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "budget_exhausted",
            "reason_params": {"spent_usd": -1, "budget_usd": 20},
        },
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "budget_exhausted",
            "reason_params": {"spent_usd": 20, "budget_usd": 0},
        },
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "budget_exhausted",
            "reason_params": {"spent_usd": 20, "budget_usd": -1},
        },
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "budget_exhausted",
            "reason_params": {"spent_usd": 19.99, "budget_usd": 20},
        },
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "consecutive_failures",
            "reason_params": {"count": 3, "extra": 1},
        },
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "consecutive_failures",
            "reason_params": {"count": 0},
        },
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "consecutive_failures",
            "reason_params": {"count": -1},
        },
        {"enabled": False, "reason": "x", "reason_params": {"count": 3}},
        {"enabled": False, "reason": "x", "diagnostic": "orphan detail"},
        {
            "enabled": True,
            "reason": "",
            "reason_code": "consecutive_failures",
            "reason_params": {"count": 3},
        },
        {
            "enabled": False,
            "reason": "x",
            "reason_code": "consecutive_failures",
            "reason_params": [3],
        },
    ],
)
async def test_patch_rejects_invalid_structured_reason_with_422(
    payload: dict,
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    await _configure_enabled(client, test_board)

    response = await client.patch(_state_url(test_board), json=payload)

    assert response.status_code == 422, response.text
    current = (await client.get(_loop_url(test_board))).json()
    assert current["enabled"] is True
    assert current["version"] == 1


@pytest.mark.parametrize("non_finite", [nan, inf, -inf])
def test_schema_rejects_non_finite_budget_params(non_finite: float):
    with pytest.raises(PydanticValidationError):
        LoopStatePatch.model_validate(
            {
                "enabled": False,
                "reason": "budget stopped",
                "reason_code": "budget_exhausted",
                "reason_params": {
                    "spent_usd": non_finite,
                    "budget_usd": 20.0,
                },
            }
        )


async def test_patch_keeps_legacy_reason_required(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    await _configure_enabled(client, test_board)

    response = await client.patch(
        _state_url(test_board),
        json={
            "enabled": False,
            "reason_code": "consecutive_failures",
            "reason_params": {"count": 3},
        },
    )

    assert response.status_code == 422, response.text


async def test_disabled_put_preserves_all_stop_reason_fields(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    await _configure_enabled(client, test_board)
    disabled = await _disable_with_max_iterations(client, test_board)
    original = disabled.json()

    response = await client.put(
        _loop_url(test_board),
        json={"enabled": False, "budget_usd": 15.0},
    )

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["disabled_reason"] == original["disabled_reason"]
    assert data["disabled_reason_code"] == original["disabled_reason_code"]
    assert data["disabled_reason_params"] == original["disabled_reason_params"]
    assert data["disabled_diagnostic"] == original["disabled_diagnostic"]


async def test_enabled_put_clears_all_stop_reason_fields(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    await _configure_enabled(client, test_board)
    await _disable_with_max_iterations(client, test_board)

    response = await client.put(_loop_url(test_board), json={"enabled": True})

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["disabled_reason"] is None
    assert data["disabled_reason_code"] is None
    assert data["disabled_reason_params"] is None
    assert data["disabled_diagnostic"] is None


async def test_enabled_patch_clears_all_stop_reason_fields(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    await _configure_enabled(client, test_board)
    await _disable_with_max_iterations(client, test_board)

    response = await client.patch(
        _state_url(test_board), json={"enabled": True, "reason": ""}
    )

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["disabled_reason"] is None
    assert data["disabled_reason_code"] is None
    assert data["disabled_reason_params"] is None
    assert data["disabled_diagnostic"] is None


async def test_same_state_patch_does_not_replace_structured_reason(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
):
    await _configure_enabled(client, test_board)
    original = (await _disable_with_max_iterations(client, test_board)).json()
    activities_before = await _loop_activity_count(db_session, test_board)

    with patch.object(event_bus, "publish", new_callable=AsyncMock) as mock_publish:
        response = await client.patch(
            _state_url(test_board),
            json={
                "enabled": False,
                "reason": "99 consecutive failed iterations",
                "reason_code": "consecutive_failures",
                "reason_params": {"count": 99},
                "diagnostic": "different diagnostic",
            },
        )

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["version"] == original["version"]
    assert data["disabled_reason"] == original["disabled_reason"]
    assert data["disabled_reason_code"] == original["disabled_reason_code"]
    assert data["disabled_reason_params"] == original["disabled_reason_params"]
    assert data["disabled_diagnostic"] == original["disabled_diagnostic"]
    assert mock_publish.await_count == 0
    assert await _loop_activity_count(db_session, test_board) == activities_before


async def test_known_code_uses_generic_activity_key_without_copy_params(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
):
    await _configure_enabled(client, test_board)
    await _disable_with_max_iterations(client, test_board)

    activity = await db_session.scalar(
        select(Activity)
        .where(
            Activity.entity_type == ActivityEntityType.board,
            Activity.entity_id == test_board.id,
            Activity.summary == "disabled loop: max_iterations reached (10)",
        )
        .order_by(Activity.created_at.desc())
    )

    assert activity is not None
    assert activity.message_key == "activity.board.loop_disabled"
    assert activity.message_params == {}


async def test_free_reason_keeps_activity_fallback_and_null_metadata(
    client: AsyncClient,
    db_session: AsyncSession,
    test_workspace: Workspace,
    test_board: Board,
):
    await _configure_enabled(client, test_board)

    response = await client.patch(
        _state_url(test_board),
        json={"enabled": False, "reason": "operator stopped after customer call"},
    )

    assert response.status_code == 200, response.text
    data = response.json()
    assert data["disabled_reason_code"] is None
    assert data["disabled_reason_params"] is None
    assert data["disabled_diagnostic"] is None
    activity = await db_session.scalar(
        select(Activity).where(
            Activity.entity_type == ActivityEntityType.board,
            Activity.entity_id == test_board.id,
            Activity.summary == "disabled loop: operator stopped after customer call",
        )
    )
    assert activity is not None
    assert activity.message_key is None
    assert activity.message_params is None


async def test_websocket_payload_never_contains_diagnostic(
    client: AsyncClient,
    test_workspace: Workspace,
    test_board: Board,
):
    await _configure_enabled(client, test_board)

    with patch.object(event_bus, "publish", new_callable=AsyncMock) as mock_publish:
        await _disable_with_max_iterations(
            client,
            test_board,
            diagnostic="sensitive operational trace kept out of websocket",
        )

    loop_payload = next(
        call.kwargs["payload"]
        for call in mock_publish.await_args_list
        if call.kwargs.get("event_type") == "board.loop_updated"
    )
    assert "diagnostic" not in loop_payload
    assert "disabled_diagnostic" not in loop_payload
