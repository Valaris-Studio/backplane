# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import pytest
from sqlalchemy import event, func, select

from app.models.timeline import TimelineCheckpoint
from tests.routers.test_timeline_generations import (
    activity,
    establish,
    timeline_path,
)
from tests.routers.test_timeline_generations import history_factory  # noqa: F401

pytestmark = pytest.mark.usefixtures("history_factory")


async def test_dense_inline_seeks_do_not_persist_a_full_board_per_event(
    client,
    db_session,
    test_board,
    test_workspace,
    test_user,
):
    db_session.add_all(
        [
            activity(
                test_board, test_workspace, test_user, seq=seq, summary=f"event {seq}"
            )
            for seq in range(1, 9)
        ]
    )
    await db_session.commit()
    base = timeline_path(test_board)
    generation = await establish(client, base)
    for seq in range(1, 9):
        response = await client.get(
            f"{base}/generations/{generation['id']}/window",
            params={"at_seq": str(seq), "limit": 1},
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["events"][0]["seq"] == str(seq)
        assert body["anchor"]["through_seq"] == (str(seq - 1) if seq > 1 else None)
    assert (
        await db_session.scalar(select(func.count()).select_from(TimelineCheckpoint))
        <= 1
    )


async def test_overview_does_not_read_snapshot_payloads(
    client,
    db_session,
    db_engine,
    test_board,
):
    await db_session.commit()
    base = timeline_path(test_board)
    generation = await establish(client, base)
    statements = []

    def capture(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().lower().startswith("select"):
            statements.append(statement.lower())

    event.listen(db_engine.sync_engine, "before_cursor_execute", capture)
    try:
        response = await client.get(f"{base}/generations/{generation['id']}/overview")
        assert response.status_code == 200, response.text
    finally:
        event.remove(db_engine.sync_engine, "before_cursor_execute", capture)
    assert statements
    assert not any(
        field in statement
        for statement in statements
        for field in ("observed_state", "before_state", "after_state")
    )
