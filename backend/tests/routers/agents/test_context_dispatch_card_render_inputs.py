# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Every advertised CardRead template input belongs to the dispatch revision."""

import json
import uuid
from datetime import datetime, timezone

import pytest
from sqlalchemy import update

from app.models.agents.prompt_config import AgentPromptConfig
from app.models.kanban.card import Card
from tests.routers.agents.context_dispatch_support import (
    _dispatch_case_fixture,  # noqa: F401
    _receipt_case_fixture,  # noqa: F401
    finding_codes,
)
from tests.routers.agents.context_receipts_support import ALIAS

pytestmark = [pytest.mark.slow, pytest.mark.timeout(30)]


async def card_template_case(d, field):
    card_expression = '{{ index .Card "' + field + '" }}'
    context_expression = '{{ index .ContextSources "' + ALIAS + '" }}'
    async with d.case.factory() as db:
        await db.execute(update(AgentPromptConfig).where(
            AgentPromptConfig.id == d.template_id,
        ).values(content="Card input: " + card_expression + "\n" + context_expression))
        await db.commit()
    _, execution, _ = await d.bound()
    snapshot = await d.current(execution)
    value = snapshot["card"][field]
    # These fixtures use one Go map index each. Numeric position's default
    # text/template rendering is decimal without a redundant trailing .0.
    rendered_value = format(value, "g") if isinstance(value, float) else str(value)
    prompt = snapshot["dispatch"]["input_template"].replace(
        card_expression, rendered_value,
    ).replace(context_expression, snapshot["context"][ALIAS])
    assert card_expression not in prompt and "Card input: " + rendered_value in prompt
    return execution, snapshot, d.payload(snapshot, input_prompt=prompt)


@pytest.mark.parametrize("field", ["position", "updated_at", "title"])
async def test_advertised_card_input_change_rejects_previous_preparation(
    dispatch_case, field, record_property,
):
    d = dispatch_case
    execution, before, payload = await card_template_case(d, field)
    replacement = {
        "position": before["card"]["position"] + 17.25,
        "updated_at": datetime(2031, 2, 3, 4, 5, 6, tzinfo=timezone.utc),
        "title": "Current card title é🧪",
    }[field]
    async with d.case.factory() as db:
        await db.execute(update(Card).where(
            Card.id == uuid.UUID(d.case.card_id),
        ).values(**{field: replacement}))
        await db.commit()

    after = await d.current(execution)
    assert after["card"][field] != before["card"][field]
    assert after["dispatch"] == before["dispatch"], "Authored template/policy must stay fixed"
    assert after["context_revision"] == before["context_revision"], "No note/context drift"
    response = await d.prepare(execution, payload)
    history = await d.case.http.get(
        d.case.execution_path(execution["id"]) + "/context-receipts",
        headers=d.headers("recipient"),
    )
    assert history.status_code == 200, history.text
    observation = {
        "advertised_card_field": field,
        "before": before["card"][field], "after": after["card"][field],
        "before_dispatch_revision": before["dispatch_revision"],
        "after_dispatch_revision": after["dispatch_revision"],
        "preparation_status": response.status_code,
        "receipt_count": len(history.json()),
    }
    record_property("card_input_revision_observation", json.dumps(observation, ensure_ascii=False))
    assert response.status_code == 409, json.dumps(observation, ensure_ascii=False)
    assert "execution_dispatch_changed" in finding_codes(response)
    assert after["dispatch_revision"] != before["dispatch_revision"]
    assert history.json() == []


async def test_stable_advertised_card_snapshot_and_exact_retry_remain_usable(dispatch_case):
    d = dispatch_case
    execution, before, payload = await card_template_case(d, "position")
    repeated = await d.current(execution)
    assert repeated["card"] == before["card"]
    assert repeated["dispatch_revision"] == before["dispatch_revision"]
    first = await d.prepare(execution, payload)
    assert first.status_code == 201, first.text
    replay = await d.prepare(execution, payload)
    assert replay.status_code == 200, replay.text
    assert replay.json()["receipt_id"] == first.json()["receipt_id"]
    assert replay.json()["ordinal"] == first.json()["ordinal"]
    detail = await d.case.receipt(execution, first.json()["receipt_id"])
    assert detail.status_code == 200, detail.text
    assert detail.json()["input_prompt"] == payload["input_prompt"]
