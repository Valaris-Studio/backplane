# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import pytest

from app.models.notes.note import Note
from tests.test_landing_completion_policy import board_url, completion_url, policy, save_policy
from tests.test_template_completion_contract import templates, bind_body, assert_unbound

__all__ = ["templates"]


def test_changed_context_sources_reports_identity_without_content():
    from app.services.completion_context import changed_context_sources

    before = [{"kind": "note", "id": "note-id", "hash": "before"},
              {"kind": "rendered_context", "id": "board-id", "hash": "before"}]
    after = [{"kind": "note", "id": "note-id", "hash": "after"},
             {"kind": "rendered_context", "id": "board-id", "hash": "after"}]
    assert changed_context_sources(before, after) == [{"kind": "note", "id": "note-id", "change": "changed"}]
    assert changed_context_sources(None, after) == []


async def pinned_note(db, board, user, content):
    note = Note(workspace_id=board.workspace_id, board_id=board.id,
                title="Bound methodology", content=content, pinned=True, created_by=user.id)
    db.add(note)
    await db.flush()
    return note


async def test_preview_measures_exact_utf8_mandatory_context(
    client, db_session, test_board, test_git_repo, test_user,
):
    note = await pinned_note(db_session, test_board, test_user, "é🧭" * 100)
    preview = await client.post(f"{completion_url(test_board)}/policy/preview", json={"policy": policy()})
    assert preview.status_code == 200, preview.text
    report = preview.json()["context_size"]
    await save_policy(client, test_board)
    saved = await client.put(f"{board_url(test_board)}/loop", json={"enabled": False})
    assert saved.status_code == 200, saved.text
    loop = await client.get(f"{board_url(test_board)}/loop")
    assert report["bytes"] == len(loop.json()["completion_context"].encode("utf-8"))
    assert report["limit_bytes"] == 128 * 1024
    assert report["within_limit"] is True
    assert sum(item["bytes"] for item in report["contributors"]) == report["bytes"]
    contributor = next(item for item in report["contributors"] if item.get("id") == str(note.id))
    assert contributor["title"] == note.title
    assert contributor["bytes"] == len(f"NOTE — {note.title}:\n{note.content}".encode("utf-8"))
    assert saved.json()["completion_context_size"]["bytes"] == report["bytes"]


@pytest.mark.parametrize("save_route", ["policy", "loop", "workspace"])
async def test_oversize_policy_preview_blocks_save_without_persisting(
    client, db_session, test_board, test_git_repo, test_user, save_route,
):
    await pinned_note(db_session, test_board, test_user, "🧭" * (33 * 1024))
    preview = await client.post(f"{completion_url(test_board)}/policy/preview", json={"policy": policy()})
    assert preview.status_code == 200, preview.text
    assert any(f["code"] == "completion_context_too_large" for f in preview.json()["incompatibilities"])
    if save_route == "policy":
        saved = await client.put(f"{completion_url(test_board)}/policy", json={"policy": policy()})
    elif save_route == "loop":
        saved = await client.put(f"{board_url(test_board)}/loop", json={"enabled": False, "completion_policy": policy()})
    else:
        saved = await client.patch("/api/workspaces/default/config", json={"completion_policy": policy()})
    assert saved.status_code in (409, 422), saved.text
    read = await client.get(f"{completion_url(test_board)}/policy")
    assert read.json()["effective_policy"] is None


async def test_grown_context_keeps_operator_repair_read_but_blocks_runner(
    client, agent_client, db_session, test_board, test_git_repo, test_user,
):
    await save_policy(client, test_board)
    await client.put(f"{board_url(test_board)}/loop", json={"enabled": False})
    await pinned_note(db_session, test_board, test_user, "x" * (129 * 1024))
    operator = await client.get(f"{board_url(test_board)}/loop")
    assert operator.status_code == 200, operator.text
    assert operator.json()["completion_context_size"]["within_limit"] is False
    assert operator.json()["completion_context"] == ""
    runner = await agent_client.get(f"{board_url(test_board)}/loop", headers={"X-Backplane-Completion-Version": "1"})
    assert runner.status_code == 409, runner.text
    unlinked_runner = await client.get(f"{board_url(test_board)}/loop", headers={"X-Backplane-Completion-Version": "1"})
    assert unlinked_runner.status_code == 409, unlinked_runner.text


async def test_exact_mandatory_boundary_and_inherited_policy_preview(
    client, db_session, test_board, test_git_repo, test_user,
):
    from app.services.completion_context import assemble_mandatory_completion_context, mandatory_completion_context
    from app.exceptions import ConflictError

    inherited = await client.patch("/api/workspaces/default/config", json={"completion_policy": policy()})
    assert inherited.status_code == 200, inherited.text
    note = await pinned_note(db_session, test_board, test_user, "é")
    _, report = await assemble_mandatory_completion_context(db_session, test_board, policy())
    note.content += "a" * (128 * 1024 - report["bytes"])
    await db_session.flush()
    assert len((await mandatory_completion_context(db_session, test_board, policy())).encode("utf-8")) == 128 * 1024
    note.content += "a"
    await db_session.flush()
    with pytest.raises(ConflictError):
        await mandatory_completion_context(db_session, test_board, policy())
    preview = await client.post(f"{completion_url(test_board)}/policy/preview", json={"policy": None, "loop_config": {"enabled": False}})
    assert preview.status_code == 200, preview.text
    assert preview.json()["origin"] == "workspace"
    assert preview.json()["context_size"]["bytes"] == 128 * 1024 + 1
    assert not preview.json()["context_size"]["within_limit"]


@pytest.mark.usefixtures("templates")
async def test_compound_template_preview_and_save_share_context_limit(
    client, db_session, test_board, test_git_repo, test_user,
):
    await pinned_note(db_session, test_board, test_user, "x" * (129 * 1024))
    body = bind_body(completion_policy=policy())
    preview = await client.post(f"{completion_url(test_board)}/policy/preview", json={
        "policy": policy(), "loop_config": {"enabled": False}, "template": body["template"],
    })
    assert preview.status_code == 200, preview.text
    assert preview.json()["template_preview"]
    assert not preview.json()["context_size"]["within_limit"]
    saved = await client.put(f"{board_url(test_board)}/loop", json=body)
    assert saved.status_code == 422, saved.text
    await assert_unbound(db_session, test_board, None)
    assert test_board.completion_policy is None
