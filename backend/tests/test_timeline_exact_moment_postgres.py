# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import json
import uuid

import pytest
from sqlalchemy import func, select, text

from app.models.timeline import TimelineCheckpoint, TimelinePreparation
from tests.test_timeline_generations_postgres import establish, insert_old_writer
from tests.test_timeline_generations_postgres import postgres_history  # noqa: F401

pytestmark = [pytest.mark.slow, pytest.mark.timeout(20)]


async def retained_work(factory, generation_id):
    identity = uuid.UUID(generation_id)
    async with factory() as db:
        return {
            "checkpoints": await db.scalar(
                select(func.count()).select_from(TimelineCheckpoint).where(
                    TimelineCheckpoint.generation_id == identity
                )
            ),
            "preparations": await db.scalar(
                select(func.count()).select_from(TimelinePreparation).where(
                    TimelinePreparation.generation_id == identity
                )
            ),
        }


async def test_exact_equality_cannot_admit_a_late_commit_invisible_to_the_generation(
    postgres_history,  # noqa: F811 — imported pytest fixture injection
):
    fixture = postgres_history
    async with fixture["factory"]() as lower_writer:
        lower = await insert_old_writer(
            lower_writer, fixture["values"], "late lower sequence, safe synthetic text"
        )
        async with fixture["factory"].begin() as upper_writer:
            upper = await insert_old_writer(
                upper_writer, fixture["values"], "visible when generation was opened"
            )
        assert lower.seq < upper.seq
        frozen = await establish(fixture)
        assert frozen["event_count"] == "1"
        assert frozen["first_seq"] == frozen["head_seq"] == str(upper.seq)
        await lower_writer.commit()

    async with fixture["factory"]() as inspection:
        evidence = (await inspection.execute(text("""
            SELECT a.seq,
                   pg_visible_in_snapshot(
                       a.recorded_transaction,
                       CAST(g.source_snapshot AS pg_snapshot)
                   ) AS visible
            FROM activities a CROSS JOIN timeline_generations g
            WHERE a.id = :activity_id AND g.id = :generation_id
        """), {
            "activity_id": lower.id,
            "generation_id": uuid.UUID(frozen["id"]),
        })).one()
    assert evidence.seq == lower.seq
    assert evidence.visible is False

    path = f"{fixture['base']}/generations/{frozen['id']}/window"
    approximate = await fixture["client"].get(
        path, params={"at_seq": str(lower.seq), "limit": 1}
    )
    assert approximate.status_code == 200, approximate.text
    assert [row["seq"] for row in approximate.json()["events"]] == [str(upper.seq)]
    visible_exact = await fixture["client"].get(
        path, params={"at_seq": str(upper.seq), "exact": "true", "limit": 1}
    )
    assert visible_exact.status_code == 200, visible_exact.text
    assert [row["id"] for row in visible_exact.json()["events"]] == [str(upper.id)]

    # A fresh observation is allowed to see the committed lower event. This
    # rules out a nonexistent-row fixture and a blanket rejection of its ID.
    refreshed = await establish(fixture)
    assert refreshed["event_count"] == "2"
    available = await fixture["client"].get(
        f"{fixture['base']}/generations/{refreshed['id']}/window",
        params={"at_seq": str(lower.seq), "exact": "true", "limit": 1},
    )
    assert available.status_code == 200, available.text
    assert [row["id"] for row in available.json()["events"]] == [str(lower.id)]

    before = await retained_work(fixture["factory"], frozen["id"])
    assert before == {"checkpoints": 0, "preparations": 0}
    response = await fixture["client"].get(
        path, params={"at_seq": str(lower.seq), "exact": "true", "limit": 1}
    )
    after = await retained_work(fixture["factory"], frozen["id"])
    print("A05_EXACT_POSTGRES_RECEIPT " + json.dumps({
        "lower_seq": str(lower.seq), "upper_seq": str(upper.seq),
        "frozen_head": frozen["head_seq"], "visible_in_frozen_snapshot": evidence.visible,
        "status": response.status_code, "error_code": response.json().get("error_code"),
        "before": before, "after": after,
    }, sort_keys=True))
    assert response.status_code == 404, response.text
    assert response.json()["error_code"] == "timeline_event_not_found"
    assert "events" not in response.json()
    assert after == before
