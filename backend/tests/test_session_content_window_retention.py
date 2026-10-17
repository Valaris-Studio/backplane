# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import pytest
from sqlalchemy import delete

from app.models.agent_session import AgentSessionContent
from tests.test_session_content_window import (
    seed_contents as seed_contents,
    window,
)

pytestmark = pytest.mark.usefixtures("content_storage")


@pytest.mark.parametrize(
    "mode,initial,cursor_name",
    [("earlier", "latest", "earlier_cursor"), ("later", "beginning", "later_cursor")],
)
async def test_empty_seek_after_retention_never_replays_the_previous_boundary(
    client, db_session, seed_contents, mode, initial, cursor_name
):
    seeded = await seed_contents(201)
    origin = await window(client, seeded, mode=initial)
    boundary = origin["items"][0 if mode == "earlier" else -1]["id"]
    removed = seeded.rows[:101] if mode == "earlier" else seeded.rows[100:]
    await db_session.execute(
        delete(AgentSessionContent).where(
            AgentSessionContent.id.in_([row["id"] for row in removed])
        )
    )
    await db_session.flush()
    empty = await window(client, seeded, mode=mode, cursor=origin[cursor_name])
    assert empty["items"] == []
    refreshed = await window(
        client, seeded, mode="refresh", cursor=empty["window_cursor"]
    )
    assert refreshed["items"] == [], f"The prior boundary {boundary} is outside this empty window"
    assert refreshed["window_cursor"] == empty["window_cursor"]
    assert refreshed["later_cursor" if mode == "earlier" else "earlier_cursor"]
    recovered = await window(client, seeded, mode=initial)
    assert boundary in [item["id"] for item in recovered["items"]]
