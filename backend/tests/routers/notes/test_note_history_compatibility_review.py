# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import re

import pytest

from app.main import create_app


@pytest.mark.parametrize("scope", ["workspace", "board"])
@pytest.mark.parametrize("transport", ["legacy", "atomic_edit"])
@pytest.mark.parametrize("mode", ["append", "section"])
async def test_note_body_mutations_preserve_mode_specific_public_activity_summary(
    scope, transport, mode, client, test_workspace, test_board,
):
    workspace_url = f"/api/workspaces/{test_workspace.slug}"
    board_url = f"{workspace_url}/boards/{test_board.id}"
    created = await client.post(board_url + "/notes", json={
        "title": "Compatibility note", "content": "# Target\n\nOriginal\n\n# Untouched\n\nKeep me",
    })
    assert created.status_code == 201, created.text
    note_id = created.json()["id"]
    note_url = f"{workspace_url if scope == 'workspace' else board_url}/notes/{note_id}"
    body = {"content": "Appended tail" if mode == "append" else "Replacement text"}
    if mode == "section":
        body["anchor_heading"] = " Target "
    if transport == "atomic_edit":
        mutation = await client.post(note_url + "/edit", json={**body, "mode": mode})
    else:
        suffix = "/append" if mode == "append" else "/replace-section"
        mutation = await client.post(note_url + suffix, json=body)
    assert mutation.status_code == 200, mutation.text
    assert mutation.json()["history_revision"] == 2
    assert body["content"] in mutation.json()["content"]
    assert "Keep me" in mutation.json()["content"]

    activity = await client.get(workspace_url + "/history", params={
        "entity_type": "note", "action": "updated",
    })
    timeline = await client.get(board_url + "/timeline")
    assert activity.status_code == timeline.status_code == 200
    activity_rows = [row for row in activity.json() if row["entity_id"] == note_id]
    timeline_rows = [row for row in timeline.json()["events"]
                     if row["entity_id"] == note_id and row["action"] == "updated"]
    assert len(activity_rows) == len(timeline_rows) == 1

    expected_key = "activity.note.appended" if mode == "append" else "activity.note.section_replaced"
    expected_summary = (
        "appended to note 'Compatibility note'" if mode == "append"
        else "replaced section 'Target' in note 'Compatibility note'"
    )
    for row in activity_rows + timeline_rows:
        assert row["board_id"] == str(test_board.id)
        assert row["message_key"] == expected_key
        assert row["message_params"]["note_title"] == "Compatibility note"
        if mode == "section":
            assert row["message_params"]["section_heading"] == "Target"
    # Unknown message keys fall back to this public field, including MCP readers.
    assert [row["summary"] for row in activity_rows + timeline_rows] == [expected_summary] * 2


@pytest.fixture(scope="module")
def actual_openapi_schema():
    return create_app().openapi()


@pytest.mark.parametrize("scope", ["workspace", "board"])
@pytest.mark.parametrize("suffix,method", [
    ("/edit", "post"),
    ("/revisions", "get"),
    ("/revisions/compare", "get"),
    ("/revisions/{revision}", "get"),
])
def test_generated_note_history_schema_declares_every_path_placeholder(
    scope, suffix, method, actual_openapi_schema,
):
    prefix = "/api/workspaces/{slug}"
    if scope == "board":
        prefix += "/boards/{board_id}"
    path = prefix + "/notes/{note_id}" + suffix
    path_item = actual_openapi_schema["paths"][path]
    operation = path_item[method]
    parameters = path_item.get("parameters", []) + operation.get("parameters", [])
    path_parameters = [parameter for parameter in parameters if parameter["in"] == "path"]
    placeholders = set(re.findall(r"\{([^{}]+)\}", path))
    declared = {parameter["name"] for parameter in path_parameters}
    assert declared == placeholders, (
        f"{method.upper()} {path}: declared path parameters {sorted(declared)} "
        f"do not match template placeholders {sorted(placeholders)}"
    )
    assert all(parameter.get("required") is True for parameter in path_parameters)
    assert len(path_parameters) == len(placeholders)
    assert not any(parameter["name"] in placeholders and parameter["in"] != "path"
                   for parameter in parameters)
    if scope == "workspace":
        assert not any(parameter["name"] == "board_id" for parameter in parameters)
