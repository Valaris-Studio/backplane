# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""HTTP pin for obstacle #10: an agent writes a checklist as markdown and reads it back.

This is the MCP path — `create_note(content="- [ ] …")`, `get_note(format=
"markdown")`, tick an item, `update_note` — over the real note endpoints.
"""
import json

from httpx import AsyncClient

from app.models.workspace import Workspace

BASE_URL = "/api/workspaces/default/notes"
CHECKLIST = "## Release\n\n- [x] tag\n- [ ] publish\n  - [ ] PyPI\n  - [x] GCS"


async def test_markdown_checklist_is_stored_as_task_nodes_and_read_back_verbatim(
    client: AsyncClient, test_workspace: Workspace
):
    created = await client.post(BASE_URL, json={"title": "Release", "content": CHECKLIST})
    assert created.status_code == 201
    stored = json.loads(created.json()["content"])
    checklist = stored["content"][1]
    assert checklist["type"] == "taskList"
    assert [item["attrs"]["checked"] for item in checklist["content"]] == [True, False]

    read = await client.get(f"{BASE_URL}/{created.json()['id']}?format=markdown")
    assert read.status_code == 200
    assert read.json()["content"] == CHECKLIST


async def test_agent_ticks_an_item_through_a_markdown_round_trip(
    client: AsyncClient, test_workspace: Workspace
):
    created = await client.post(BASE_URL, json={"title": "Release", "content": CHECKLIST})
    note_id = created.json()["id"]

    markdown = (await client.get(f"{BASE_URL}/{note_id}?format=markdown")).json()["content"]
    written = await client.put(
        f"{BASE_URL}/{note_id}", json={"content": markdown.replace("- [ ] PyPI", "- [x] PyPI")}
    )

    assert written.status_code == 200
    publish = json.loads(written.json()["content"])["content"][1]["content"][1]
    nested = publish["content"][1]
    assert nested["type"] == "taskList"
    assert [item["attrs"]["checked"] for item in nested["content"]] == [True, True]
