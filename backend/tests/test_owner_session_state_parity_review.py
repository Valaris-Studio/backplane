# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Review controls for capture-state parity and private cursor filter binding."""

from datetime import datetime, timezone

import pytest

from app.models.kanban.board import Board
from tests.session_rows import add_installation, add_mapping, add_session
from tests.test_owner_session_overview import HOUR, MINUTE, OVERVIEW, SESSIONS, ids, page


@pytest.mark.parametrize(
    ("scenario", "expected_state"),
    [
        ("desktop_family_enabled", "active"),
        ("desktop_family_disabled", "paused"),
        ("mapping_disabled", "paused"),
        ("installation_revoked", "disconnected"),
        ("heartbeat_stale", "disconnected"),
        ("ended_with_capture_gaps", "incomplete"),
    ],
)
async def test_global_capture_state_matches_explicit_contract_and_workspace(
    client, db_session, test_user, test_workspace, scenario, expected_state
):
    now = datetime.now(timezone.utc)
    installation_values = {}
    session_values = {}
    last_event_age = MINUTE
    if scenario == "desktop_family_enabled":
        installation_values["enabled_agents"] = ["codex_cli"]
        session_values["harness"] = "codex_desktop"
    elif scenario == "desktop_family_disabled":
        # Naming the child harness alone does not enable its integration family.
        installation_values["enabled_agents"] = ["codex_desktop"]
        session_values["harness"] = "codex_desktop"
    elif scenario == "installation_revoked":
        installation_values["revoked_at"] = now - 2 * MINUTE
        # A disconnected capture can be older than the idle threshold.
        last_event_age = HOUR
    elif scenario == "heartbeat_stale":
        installation_values["last_seen_at"] = now - HOUR
    elif scenario == "ended_with_capture_gaps":
        session_values.update(status="ended", ended_at=now, capture_gaps=True)

    installation = await add_installation(
        db_session, test_user, **installation_values
    )
    if scenario == "mapping_disabled":
        mapping = await add_mapping(
            db_session, installation, test_workspace, enabled=False
        )
        session_values["mapping_id"] = mapping.id
    candidate = await add_session(
        db_session,
        installation,
        test_workspace,
        started=2 * HOUR,
        last=last_event_age,
        **session_values,
    )
    live_installation = await add_installation(db_session, test_user)
    live = await add_session(
        db_session, live_installation, test_workspace, started=HOUR
    )
    expected = {str(candidate.id): expected_state, str(live.id): "active"}

    workspace = await page(client, f"/api/workspaces/{test_workspace.slug}/sessions")
    global_page = await page(client)
    workspace_states = {
        row["id"]: row["display_state"] for row in workspace["items"]
    }
    global_states = {row["id"]: row["display_state"] for row in global_page["items"]}
    # Explicit expectations prevent two matching implementations from masking
    # a shared mistake in state semantics.
    assert workspace_states == expected
    assert global_states == expected

    filtered = await page(client, state=expected_state)
    assert set(ids(filtered["items"])) == {
        session_id for session_id, state in expected.items() if state == expected_state
    }
    overview = await page(client, OVERVIEW)
    assert {row["id"]: row["display_state"] for row in overview["active"]} == {
        session_id: "active"
        for session_id, state in expected.items()
        if state == "active"
    }
    assert {row["id"]: row["display_state"] for row in overview["recent"]} == {
        session_id: state for session_id, state in expected.items() if state != "active"
    }
    assert overview["active_more"] is False
    assert overview["recent_more"] is False


@pytest.mark.parametrize("changed_filter", ["board_id", "status", "since"])
async def test_cursor_rejects_changed_board_status_or_since_instant(
    client, db_session, test_user, test_workspace, test_board, changed_filter
):
    now = datetime.now(timezone.utc)
    other_board = Board(
        workspace_id=test_workspace.id,
        name="Another accessible board",
        slug="another-accessible-board",
        created_by=test_user.id,
    )
    db_session.add(other_board)
    await db_session.flush()
    installation = await add_installation(db_session, test_user)
    sessions = [
        await add_session(
            db_session,
            installation,
            test_workspace,
            started=2 * HOUR,
            last=index * MINUTE,
            board_id=test_board.id,
        )
        for index in range(3)
    ]
    filters = {
        "board_id": str(test_board.id),
        "status": "active",
        "since": (now - 2 * HOUR).isoformat(),
    }
    first = await page(client, limit=1, **filters)
    assert ids(first["items"]) == [str(sessions[0].id)]
    cursor = first["next_cursor"]
    assert cursor is not None
    changed_values = {
        "board_id": str(other_board.id),
        "status": "idle",
        # Both cutoffs include these rows; rejection must bind the instant,
        # rather than depend on the returned dataset accidentally changing.
        "since": (now - HOUR).isoformat(),
    }
    changed = {**filters, changed_filter: changed_values[changed_filter]}
    response = await client.get(
        SESSIONS, params={**changed, "limit": 1, "cursor": cursor}
    )
    assert response.status_code == 422, response.text
    assert response.headers["cache-control"] == "no-store"
    assert cursor not in response.text
    assert isinstance(response.json()["detail"], str)

    # Invalid reuse neither consumes nor invalidates the same private cursor.
    continued = await page(client, limit=1, cursor=cursor, **filters)
    assert ids(continued["items"]) == [str(sessions[1].id)]
    assert continued["next_cursor"] is not None
