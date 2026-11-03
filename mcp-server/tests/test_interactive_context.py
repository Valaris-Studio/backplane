# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

from __future__ import annotations

import copy
import hashlib
import json
from urllib.parse import parse_qs, urlsplit

import pytest

from valaris_mcp.prompts import pickup
from valaris_mcp.server import INSTRUCTIONS, mcp
from valaris_mcp.tools.cards import get_card
from valaris_mcp.tools.context import MAX_PROJECT_CONTEXT_CHARS, get_project_context

CARD_ID = "aaaaaaaa-0000-4000-8000-000000000001"
AUTHOR_ID = "bbbbbbbb-0000-4000-8000-000000000001"


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _pin(index: int, body: str) -> dict:
    return {
        "id": f"cccccccc-0000-4000-8000-{index:012d}",
        "title": f"Directive {index}",
        "pinned": True,
        "created_at": "2026-11-02T12:00:00Z",
        "content": body,
        "author_principal_kind": "user",
        "created_by": AUTHOR_ID,
        "pinned_by": AUTHOR_ID,
        "class": "directive",
        "label": "instruction",
        "sha256": _digest(body),
    }


def _briefing(notes: list[dict]) -> dict:
    return {
        "board": {"id": "b1", "name": "Project", "columns": []},
        "definition": {"scope": "Build the agreed feature", "content": {}},
        "notes": notes,
        "git_repos": [],
        "recent_activity": [],
        "omissions": [],
    }


def _snapshot() -> dict:
    text = "Instruction — card\n\nShip café safely."
    inclusion = {
        "source_kind": "card",
        "entity_type": "card",
        "entity_id": CARD_ID,
        "sha256": _digest(text),
    }
    return {
        "purpose": "bootstrap",
        "principal_kind": "user",
        "blocks": [{**inclusion, "class": "directive", "label": "instruction", "text": text}],
        "manifest": {
            "schema_version": 0,
            "inclusions": [inclusion],
            "omissions": [{"source_kind": "execution_history", "reason": "missing", "count": 0}],
            "limits": {"max_managed_context_bytes": 131072},
        },
    }


@pytest.mark.anyio
@pytest.mark.parametrize("card_ref", [CARD_ID, CARD_ID[:8]])
async def test_get_card_include_context_requests_bootstrap_for_uuid_and_prefix(
    mock_client, ctx, card_ref
):
    snapshot = _snapshot()
    reads = []

    async def read(path, **params):
        query = {**parse_qs(urlsplit(path).query), **params}
        reads.append((path, query))
        wants_context = query.get("include_context") in (True, "true", ["true"])
        card = {"id": CARD_ID, "description": "# Ship café safely"}
        return {**card, "context": copy.deepcopy(snapshot)} if wants_context else card

    mock_client.get.side_effect = read
    result = json.loads(
        await get_card("test", "b1", card_ref, include_context=True, ctx=ctx)
    )

    assert not result.get("error"), result
    assert result["context"] == snapshot
    assert result["description"] == "# Ship café safely"
    assert any(
        query.get("include_context") in (True, "true", ["true"])
        for _, query in reads
    )
    assert all("/cards/" in path for path, _ in reads)
    mock_client.post.assert_not_called()
    mock_client.patch.assert_not_called()


@pytest.mark.anyio
@pytest.mark.parametrize("card_ref", [CARD_ID, CARD_ID[:8]])
async def test_get_card_without_context_keeps_the_existing_read(mock_client, ctx, card_ref):
    card = {"id": CARD_ID, "description": "# Original", "participants": []}
    mock_client.get.return_value = card

    assert json.loads(await get_card("test", "b1", card_ref, ctx=ctx)) == card
    path = mock_client.get.call_args.args[0]
    assert "include_context=true" not in path
    assert mock_client.get.call_count == 1


def test_get_card_catalog_exposes_optional_context_on_existing_tool():
    schema = mcp._tool_manager._tools["get_card"].parameters
    option = schema["properties"].get("include_context")

    assert option is not None, "The existing card read must expose the bootstrap snapshot"
    assert option["type"] == "boolean"
    assert option["default"] is False
    assert "include_context" not in schema.get("required", [])
    assert "get_card_context" not in mcp._tool_manager._tools


@pytest.mark.parametrize(
    "text", [INSTRUCTIONS, pickup("test", "b1", CARD_ID)], ids=["instructions", "pickup"]
)
def test_interactive_claim_guidance_names_the_bootstrap_snapshot_call(text):
    assert "get_card" in text
    assert "include_context=True" in text or "include_context=true" in text
    assert "bootstrap" in text.lower()
    assert "claim" in text.lower()


@pytest.mark.anyio
async def test_project_context_preserves_complete_pinned_body_and_attribution(mock_client, ctx):
    body = "## Human decision\n\nKeep café and 🧭 intact.\n\n```text\nfull body\n```"
    pin = _pin(1, body)
    mock_client.get.return_value = _briefing([copy.deepcopy(pin)])

    result = json.loads(await get_project_context("test", "b1", ctx=ctx))

    assert result["notes"][0] == pin
    assert result["omissions"] == []
    mock_client.get.assert_called_once_with("/workspaces/test/boards/b1/context")


@pytest.mark.anyio
async def test_project_context_drops_oversize_pin_whole_with_identity_and_digest(mock_client, ctx):
    pin = _pin(1, "BEGIN-PIN\n" + "café 🧭 " * 12000 + "\nEND-PIN")
    mock_client.get.return_value = _briefing([copy.deepcopy(pin)])

    rendered = await get_project_context("test", "b1", ctx=ctx)
    result = json.loads(rendered)

    assert len(rendered) <= MAX_PROJECT_CONTEXT_CHARS
    assert "BEGIN-PIN" not in rendered
    assert "END-PIN" not in rendered
    omission = next(
        (item for item in result["omissions"] if item.get("entity_id") == pin["id"]),
        None,
    )
    assert omission is not None, "A dropped pinned body needs an identified omission"
    assert omission["reason"] == "over_budget"
    assert omission["sha256"] == pin["sha256"]
    for note in result.get("notes", []):
        if note["id"] == pin["id"]:
            assert note.get("content") in (None, "")


@pytest.mark.anyio
async def test_project_context_list_cap_declares_dropped_pinned_bodies(mock_client, ctx):
    pins = [_pin(index, f"Complete decision {index}") for index in range(1, 31)]
    mock_client.get.return_value = _briefing(copy.deepcopy(pins))

    rendered = await get_project_context("test", "b1", ctx=ctx)
    result = json.loads(rendered)

    assert len(rendered) <= MAX_PROJECT_CONTEXT_CHARS
    admitted = {note["id"] for note in result["notes"] if note.get("content")}
    omitted = {
        item["entity_id"]: item
        for item in result["omissions"]
        if "entity_id" in item
    }
    assert len(admitted) < len(pins)
    for pin in pins:
        if pin["id"] not in admitted:
            assert pin["id"] in omitted, "The count cap must not silently drop a body"
            assert omitted[pin["id"]]["reason"] == "over_budget"
            assert omitted[pin["id"]]["sha256"] == pin["sha256"]


@pytest.mark.anyio
async def test_project_context_final_backstop_preserves_omission_identities(mock_client, ctx):
    pins = [_pin(index, "BODY-START " + "x" * 3000) for index in range(1, 13)]
    payload = _briefing(copy.deepcopy(pins))
    payload["board"]["description"] = "d" * 100000
    payload["board"]["tags"] = ["t" * 500 for _ in range(80)]
    payload["omissions"] = [{"reason": "unauthorized", "count": 2}]
    mock_client.get.return_value = payload

    rendered = await get_project_context("test", "b1", ctx=ctx)
    result = json.loads(rendered)

    assert len(rendered) <= MAX_PROJECT_CONTEXT_CHARS
    omitted = {
        item["entity_id"]: item
        for item in result["omissions"]
        if "entity_id" in item
    }
    delivered = {note["id"]: note for note in result.get("notes", [])}
    for pin in pins:
        if delivered.get(pin["id"], {}).get("content") == pin["content"]:
            assert delivered[pin["id"]]["sha256"] == pin["sha256"]
            assert delivered[pin["id"]]["label"] == "instruction"
        else:
            assert pin["id"] in omitted
            assert omitted[pin["id"]]["sha256"] == pin["sha256"]
            assert omitted[pin["id"]]["reason"] == "over_budget"
    unauthorized = [item for item in result["omissions"] if item["reason"] == "unauthorized"]
    assert unauthorized == [{"reason": "unauthorized", "count": 2}]


@pytest.mark.anyio
async def test_project_context_legacy_summary_does_not_claim_pinned_body_was_included(
    mock_client, ctx
):
    pin = {"id": "cccccccc-0000-4000-8000-000000000001", "title": "Legacy pin", "pinned": True}
    payload = _briefing([pin])
    payload.pop("omissions")
    mock_client.get.return_value = payload

    result = json.loads(await get_project_context("test", "b1", ctx=ctx))

    omissions = result.get("omissions", [])
    assert any(
        item.get("entity_id") == pin["id"] and item["reason"] in {"missing", "unsupported"}
        for item in omissions
    ), "Older backends need an explicit unsupported/missing pinned-body omission"


@pytest.mark.anyio
@pytest.mark.parametrize("degradation", ["note_limit", "total_budget"])
async def test_project_context_degradation_does_not_identify_withheld_pinned_body(
    mock_client, ctx, degradation
):
    pins = [_pin(index, f"Complete decision {index}") for index in range(1, 28)]
    withheld = {
        **_pin(28, "not delivered by the backend"),
        "content": None,
        "sha256": None,
        "author_principal_kind": "agent",
        "pinned_by": None,
        "class": "agent_working_note",
        "label": "agent working note, not instruction",
    }
    # Place the withheld header on either side of the initial 25-note cap.
    pins.insert(25 if degradation == "note_limit" else 0, withheld)
    actual_body = pins[-1]
    payload = _briefing(copy.deepcopy(pins))
    payload["omissions"] = [{"reason": "unauthorized", "count": 1}]
    if degradation == "total_budget":
        payload["board"]["description"] = "d" * 100000
    mock_client.get.return_value = payload

    rendered = await get_project_context("test", "b1", ctx=ctx)
    result = json.loads(rendered)

    assert len(rendered) <= MAX_PROJECT_CONTEXT_CHARS
    assert not any(
        omission.get("entity_id") == withheld["id"]
        for omission in result["omissions"]
    ), "A null body was already withheld; budget degradation must not identify it"
    assert [
        omission for omission in result["omissions"]
        if omission["reason"] == "unauthorized"
    ] == [{"reason": "unauthorized", "count": 1}]
    assert any(
        omission.get("entity_id") == actual_body["id"]
        and omission["reason"] == "over_budget"
        and omission.get("sha256") == actual_body["sha256"]
        for omission in result["omissions"]
    ), "Budget removal of an actual delivered body still needs identity and digest"


@pytest.mark.anyio
async def test_project_context_preserves_selected_omission_identities_within_total_budget(
    mock_client, ctx
):
    omissions = [
        {
            "entity_type": "note",
            "entity_id": f"dddddddd-0000-4000-8000-{index:012d}",
            "reason": "over_budget",
            "sha256": _digest(f"Complete selected note {index}"),
        }
        for index in range(100)
    ]
    payload = _briefing([])
    payload["omissions"] = copy.deepcopy(omissions)
    assert len(json.dumps(payload, indent=2)) + 2000 < MAX_PROJECT_CONTEXT_CHARS
    payload["board"]["description"] = "d" * 100000
    mock_client.get.return_value = payload

    rendered = await get_project_context("test", "b1", ctx=ctx)
    result = json.loads(rendered)

    assert len(rendered) <= MAX_PROJECT_CONTEXT_CHARS
    assert result["omissions"] == omissions
    assert "_omissions_summary" not in result


@pytest.mark.anyio
async def test_project_context_refuses_when_complete_omission_manifest_exceeds_budget(
    mock_client, ctx
):
    payload = _briefing([])
    payload["omissions"] = [
        {
            "source_kind": "board_notes",
            "entity_type": "note",
            "entity_id": f"eeeeeeee-0000-4000-8000-{index:012d}",
            "reason": "over_budget",
            "sha256": _digest(f"Complete selected note {index}"),
        }
        for index in range(2000)
    ]
    assert len(json.dumps(payload["omissions"])) > MAX_PROJECT_CONTEXT_CHARS
    mock_client.get.return_value = payload

    rendered = await get_project_context("test", "b1", ctx=ctx)
    result = json.loads(rendered)

    assert len(rendered) <= MAX_PROJECT_CONTEXT_CHARS
    assert result.get("error") is True, "An incomplete manifest cannot be a successful briefing"
    assert result["error_code"] == "context_budget_exceeded"
    assert "notes" not in result
    assert "omissions" not in result
