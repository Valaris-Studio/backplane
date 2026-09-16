# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Loop-template MCP tools — the two-layer parity twin of /loop-templates.

The REST routes are all `{ref}`-keyed (a system slug OR a workspace row UUID);
the card's `template_id` naming predates that, so every tool here takes `ref`.
`archive_loop_template(archived: bool)` is the one tool that fans out to two
routes — the backend splits archive and unarchive, and a single boolean is the
shape an operator actually thinks in.
"""

from __future__ import annotations

import json

import httpx
import pytest


def _api_error(status: int, payload: dict) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "https://example.test/api")
    response = httpx.Response(status, json=payload, request=request)
    return httpx.HTTPStatusError("boom", request=request, response=response)


@pytest.mark.anyio
async def test_list_loop_templates_passes_filters_and_returns_catalog(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import list_loop_templates

    mock_client.get.return_value = {
        "templates": [
            {"id": "coding-loop", "source": "system", "name": "Coding Loop"},
        ],
        "meta": {"runner_vars": ["Workspace", "BoardID"]},
    }
    result = json.loads(
        await list_loop_templates(
            "acme", q="cod", sort="updated_at", include_archived=True, ctx=ctx
        )
    )

    mock_client.get.assert_called_once_with(
        "/workspaces/acme/loop-templates",
        q="cod",
        sort="updated_at",
        include_archived=True,
    )
    assert result["templates"][0]["source"] == "system"
    assert result["meta"]["runner_vars"] == ["Workspace", "BoardID"]


@pytest.mark.anyio
async def test_list_loop_templates_omits_unset_query_params(mock_client, ctx):
    """An omitted `q` must not become `q=None` on the wire — the backend's
    Query(default=None) treats a literal "None" string as a search term."""
    from valaris_mcp.tools.loop_templates import list_loop_templates

    mock_client.get.return_value = {"templates": [], "meta": {}}
    await list_loop_templates("acme", ctx=ctx)

    _, kwargs = mock_client.get.call_args
    assert "q" not in kwargs
    assert kwargs == {"sort": "name", "include_archived": False}


@pytest.mark.anyio
async def test_get_loop_template_requests_draft_half(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import get_loop_template

    mock_client.get.return_value = {"id": "x", "slug": "coding-loop", "version": 3}
    result = json.loads(await get_loop_template("acme", "coding-loop", draft=True, ctx=ctx))

    mock_client.get.assert_called_once_with(
        "/workspaces/acme/loop-templates/coding-loop",
        draft=True,
        include_archived=False,
    )
    assert result["version"] == 3


@pytest.mark.anyio
async def test_get_loop_template_defaults_to_published_half(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import get_loop_template

    mock_client.get.return_value = {"id": "x", "slug": "coding-loop"}
    await get_loop_template("acme", "coding-loop", ctx=ctx)

    mock_client.get.assert_called_once_with(
        "/workspaces/acme/loop-templates/coding-loop",
        draft=False,
        include_archived=False,
    )


@pytest.mark.anyio
async def test_get_loop_template_profile(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import get_loop_template_profile

    mock_client.get.return_value = {
        "id": "x",
        "slug": "coding-loop",
        "boards_using": 2,
        "track_record": {"iterations": 41},
    }
    result = json.loads(await get_loop_template_profile("acme", "coding-loop", ctx=ctx))

    mock_client.get.assert_called_once_with("/workspaces/acme/loop-templates/coding-loop/profile")
    assert result["track_record"]["iterations"] == 41


@pytest.mark.anyio
async def test_create_loop_template_posts_full_body(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import create_loop_template

    mock_client.post.return_value = {"id": "new-id", "slug": "my-loop", "version": 0}
    result = json.loads(
        await create_loop_template(
            "acme",
            slug="my-loop",
            name="My Loop",
            content={"loop_prompt": "do <<THING>>"},
            profile={"emoji": "🌀"},
            ctx=ctx,
        )
    )

    mock_client.post.assert_called_once_with(
        "/workspaces/acme/loop-templates",
        {
            "slug": "my-loop",
            "name": "My Loop",
            "content": {"loop_prompt": "do <<THING>>"},
            "profile": {"emoji": "🌀"},
        },
    )
    assert result["id"] == "new-id"


@pytest.mark.anyio
async def test_create_loop_template_defaults_content_and_profile_to_empty(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import create_loop_template

    mock_client.post.return_value = {"id": "new-id"}
    await create_loop_template("acme", slug="my-loop", name="My Loop", ctx=ctx)

    _, body = mock_client.post.call_args[0]
    assert body["content"] == {}
    assert body["profile"] == {}


@pytest.mark.anyio
async def test_update_loop_template_sends_only_provided_fields(mock_client, ctx):
    """PATCH semantics: an omitted field must be ABSENT, not null. The backend
    uses exclude_unset, so a null `name` would be a real edit attempt."""
    from valaris_mcp.tools.loop_templates import update_loop_template

    mock_client.patch.return_value = {"id": "x", "version": 1}
    await update_loop_template(
        "acme",
        "tpl-uuid",
        content={"loop_prompt": "new"},
        expected_updated_at="2026-08-17T00:00:00Z",
        ctx=ctx,
    )

    mock_client.patch.assert_called_once_with(
        "/workspaces/acme/loop-templates/tpl-uuid",
        {
            "content": {"loop_prompt": "new"},
            "expected_updated_at": "2026-08-17T00:00:00Z",
        },
    )


@pytest.mark.anyio
async def test_update_loop_template_without_lock_omits_it(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import update_loop_template

    mock_client.patch.return_value = {"id": "x"}
    await update_loop_template("acme", "tpl-uuid", name="Renamed", ctx=ctx)

    _, body = mock_client.patch.call_args[0]
    assert body == {"name": "Renamed"}


@pytest.mark.anyio
async def test_update_loop_template_rejects_empty_edit(mock_client, ctx):
    """No field and no lock is not a no-op save — it is a caller mistake, and
    the backend would bump the draft timestamp for nothing."""
    from valaris_mcp.tools.loop_templates import update_loop_template

    result = json.loads(await update_loop_template("acme", "tpl-uuid", ctx=ctx))

    assert "error" in result
    mock_client.patch.assert_not_called()


@pytest.mark.anyio
async def test_publish_loop_template(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import publish_loop_template

    mock_client.post.return_value = {"id": "x", "version": 4}
    result = json.loads(
        await publish_loop_template(
            "acme", "tpl-uuid", expected_version=3, note="ship it", ctx=ctx
        )
    )

    mock_client.post.assert_called_once_with(
        "/workspaces/acme/loop-templates/tpl-uuid/publish",
        {"expected_version": 3, "note": "ship it"},
    )
    assert result["version"] == 4


@pytest.mark.anyio
async def test_publish_loop_template_omits_absent_optionals(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import publish_loop_template

    mock_client.post.return_value = {"id": "x", "version": 1}
    await publish_loop_template("acme", "tpl-uuid", ctx=ctx)

    _, body = mock_client.post.call_args[0]
    assert body == {}


@pytest.mark.anyio
async def test_publish_surfaces_validation_findings(mock_client, ctx):
    """A 422 from publish carries the findings the manager deep-links; the tool
    must pass the payload through rather than flattening it to a message."""
    from valaris_mcp.tools.loop_templates import publish_loop_template

    mock_client.post.side_effect = _api_error(
        422,
        {"detail": [{"code": "slot_undeclared", "field": "loop_prompt"}]},
    )
    result = json.loads(await publish_loop_template("acme", "tpl-uuid", ctx=ctx))

    assert result["status"] == 422
    assert result["message"][0]["code"] == "slot_undeclared"


@pytest.mark.anyio
async def test_duplicate_loop_template_with_new_slug(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import duplicate_loop_template

    mock_client.post.return_value = {"id": "copy-id", "slug": "coding-loop-copy"}
    result = json.loads(
        await duplicate_loop_template("acme", "coding-loop", new_slug="coding-loop-copy", ctx=ctx)
    )

    mock_client.post.assert_called_once_with(
        "/workspaces/acme/loop-templates/coding-loop/duplicate",
        {"new_slug": "coding-loop-copy"},
    )
    assert result["slug"] == "coding-loop-copy"


@pytest.mark.anyio
async def test_duplicate_loop_template_lets_backend_pick_the_slug(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import duplicate_loop_template

    mock_client.post.return_value = {"id": "copy-id"}
    await duplicate_loop_template("acme", "coding-loop", ctx=ctx)

    _, body = mock_client.post.call_args[0]
    assert body == {}


@pytest.mark.anyio
async def test_archive_loop_template_routes_to_archive(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import archive_loop_template

    mock_client.post.return_value = {"id": "x"}
    await archive_loop_template("acme", "tpl-uuid", archived=True, ctx=ctx)

    mock_client.post.assert_called_once_with("/workspaces/acme/loop-templates/tpl-uuid/archive")


@pytest.mark.anyio
async def test_archive_loop_template_routes_to_unarchive(mock_client, ctx):
    """The boolean is the whole point: archived=False must hit a DIFFERENT
    route, not the same one with a body."""
    from valaris_mcp.tools.loop_templates import archive_loop_template

    mock_client.post.return_value = {"id": "x"}
    await archive_loop_template("acme", "tpl-uuid", archived=False, ctx=ctx)

    mock_client.post.assert_called_once_with("/workspaces/acme/loop-templates/tpl-uuid/unarchive")


@pytest.mark.anyio
async def test_list_loop_template_versions(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import list_loop_template_versions

    mock_client.get.return_value = [
        {"version": 2, "published_at": "2026-08-17T00:00:00Z", "note": "second"},
        {"version": 1, "published_at": "2026-08-16T00:00:00Z", "note": None},
    ]
    result = json.loads(await list_loop_template_versions("acme", "tpl-uuid", ctx=ctx))

    mock_client.get.assert_called_once_with("/workspaces/acme/loop-templates/tpl-uuid/versions")
    assert [v["version"] for v in result] == [2, 1]


@pytest.mark.anyio
async def test_restore_loop_template_version(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import restore_loop_template_version

    mock_client.post.return_value = {"id": "x", "version": 2}
    await restore_loop_template_version("acme", "tpl-uuid", version=1, ctx=ctx)

    mock_client.post.assert_called_once_with(
        "/workspaces/acme/loop-templates/tpl-uuid/versions/1/restore"
    )


@pytest.mark.anyio
async def test_mutations_pass_through_the_agent_caller_ban(mock_client, ctx):
    """Template mutations are admin + forbid_agent_callers. The tool must relay
    the backend's 403 as a structured payload, never swallow it into a success."""
    from valaris_mcp.tools.loop_templates import create_loop_template

    mock_client.post.side_effect = _api_error(
        403, {"detail": "agent callers cannot mutate loop templates"}
    )
    result = json.loads(await create_loop_template("acme", slug="s", name="n", ctx=ctx))

    assert result["status"] == 403
    assert result["error"] is True


@pytest.mark.anyio
async def test_get_board_loop_binding(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import get_board_loop_binding_raw

    mock_client.get.return_value = {
        "template": {"source": "system", "ref": "coding-loop", "version": 2},
        "slot_values": {"RUN_LABEL": "loop-8"},
        "drift": {"kind": "template_newer", "current_version": 3},
    }
    result = json.loads(await get_board_loop_binding_raw("acme", "board-1", ctx=ctx))

    mock_client.get.assert_called_once_with("/workspaces/acme/boards/board-1/loop/binding")
    assert result["drift"]["kind"] == "template_newer"


@pytest.mark.anyio
async def test_get_board_loop_binding_relays_not_bound(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import get_board_loop_binding_raw

    mock_client.get.side_effect = _api_error(
        404, {"detail": "not bound", "error_code": "not_bound"}
    )
    result = json.loads(await get_board_loop_binding_raw("acme", "board-1", ctx=ctx))

    assert result["status"] == 404
    assert result["error_code"] == "not_bound"


@pytest.mark.anyio
async def test_publish_hint_points_at_the_bound_boards(mock_client, ctx):
    """Publishing does not touch bound boards — they keep their rendered
    prompts until someone re-renders. That is the non-obvious next action."""
    from valaris_mcp.tools.loop_templates import publish_loop_template

    mock_client.post.return_value = {"id": "x", "version": 4}
    result = json.loads(await publish_loop_template("acme", "tpl-uuid", ctx=ctx))

    assert "re-render" in result["_hint"]


@pytest.mark.anyio
async def test_restore_hint_says_it_did_not_republish(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import restore_loop_template_version

    mock_client.post.return_value = {"id": "x", "version": 2}
    result = json.loads(
        await restore_loop_template_version("acme", "tpl-uuid", version=1, ctx=ctx)
    )

    assert "publish_loop_template" in result["_hint"]


# -- p2-06: fit / preview / binding-diff twins ---------------------------------


@pytest.mark.anyio
async def test_check_loop_template_fit(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import check_loop_template_fit

    mock_client.get.return_value = {
        "template": {"ref": "coding-loop", "version": 2},
        "checks": [
            {
                "id": "done-column",
                "requirement": "A done-typed column exists",
                "status": "missing",
                "evidence": "no column has column_type=done",
                "fix_id": "create_column:done",
            }
        ],
        "autofill": {"RUN_LABEL": {"value": "loop-8", "source": "board.name"}},
        "board_frozen": False,
    }
    result = json.loads(await check_loop_template_fit("acme", "board-1", "coding-loop", ctx=ctx))

    mock_client.get.assert_called_once_with(
        "/workspaces/acme/boards/board-1/loop-templates/coding-loop/fit"
    )
    assert result["checks"][0]["fix_id"] == "create_column:done"
    assert "apply_loop_template_fixes" in result["_hint"]


@pytest.mark.anyio
async def test_check_loop_template_fit_relays_unknown_ref(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import check_loop_template_fit

    mock_client.get.side_effect = _api_error(
        404, {"detail": "no such template", "error_code": "not_found"}
    )
    result = json.loads(await check_loop_template_fit("acme", "board-1", "nope", ctx=ctx))

    assert result["status"] == 404
    assert result["error_code"] == "not_found"


@pytest.mark.anyio
async def test_apply_loop_template_fixes(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import apply_loop_template_fixes

    mock_client.post.return_value = {
        "template": {"ref": "coding-loop", "version": 2},
        "checks": [],
        "autofill": {},
        "board_frozen": False,
        "applied": [
            {"fix_id": "create_column:done", "outcome": "applied", "detail": "created Done"}
        ],
    }
    result = json.loads(
        await apply_loop_template_fixes(
            "acme", "board-1", "coding-loop", fix_ids=["create_column:done"], ctx=ctx
        )
    )

    mock_client.post.assert_called_once_with(
        "/workspaces/acme/boards/board-1/loop-templates/coding-loop/fit/apply",
        {"fix_ids": ["create_column:done"]},
    )
    assert result["applied"][0]["outcome"] == "applied"


@pytest.mark.anyio
async def test_apply_loop_template_fixes_relays_agent_caller_403(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import apply_loop_template_fixes

    mock_client.post.side_effect = _api_error(
        403, {"detail": "agent callers may not mutate", "error_code": "forbidden_agent_caller"}
    )
    result = json.loads(
        await apply_loop_template_fixes("acme", "board-1", "coding-loop", fix_ids=["x"], ctx=ctx)
    )

    assert result["status"] == 403
    assert result["error_code"] == "forbidden_agent_caller"


@pytest.mark.anyio
async def test_preview_loop_template_workspace_scoped(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import preview_loop_template

    mock_client.post.return_value = {
        "template": {"ref": "coding-loop", "version": 2},
        "system_prompt": "SYS BODY",
        "loop_prompt": "LOOP BODY",
        "loop_prompt_with_tools_manifest": "LOOP BODY + manifest",
        "tools": ["get_card"],
        "rails": {"max_iterations": 20},
        "findings": [],
        "missing_required": [],
        "used_values": {"RUN_LABEL": {"value": "loop-8", "source": "explicit"}},
    }
    result = json.loads(
        await preview_loop_template("acme", "coding-loop", slot_values={"RUN_LABEL": "loop-8"}, ctx=ctx)
    )

    mock_client.post.assert_called_once_with(
        "/workspaces/acme/loop-templates/coding-loop/preview",
        {"slot_values": {"RUN_LABEL": "loop-8"}},
    )
    assert result["system_prompt"] == "SYS BODY"
    assert result["loop_prompt_with_tools_manifest"] == "LOOP BODY + manifest"


@pytest.mark.anyio
async def test_preview_loop_template_board_scoped_uses_board_route(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import preview_loop_template

    mock_client.post.return_value = {
        "template": {"ref": "coding-loop", "version": 2},
        "system_prompt": "S",
        "loop_prompt": "L",
        "loop_prompt_with_tools_manifest": "LM",
        "tools": [],
        "rails": {},
        "findings": [],
        "missing_required": [],
        "used_values": {},
    }
    await preview_loop_template("acme", "coding-loop", board_id="board-1", ctx=ctx)

    mock_client.post.assert_called_once_with(
        "/workspaces/acme/boards/board-1/loop-templates/coding-loop/preview",
        {"slot_values": {}},
    )


@pytest.mark.anyio
async def test_preview_include_prompts_false_omits_bodies(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import preview_loop_template

    mock_client.post.return_value = {
        "template": {"ref": "coding-loop", "version": 2},
        "system_prompt": "SECRET SYSTEM BODY",
        "loop_prompt": "SECRET LOOP BODY",
        "loop_prompt_with_tools_manifest": "SECRET MANIFEST BODY",
        "tools": ["get_card"],
        "rails": {"max_iterations": 20},
        "findings": [{"code": "unused_slot", "slot": "FOO"}],
        "missing_required": ["BAR"],
        "used_values": {"RUN_LABEL": {"value": "loop-8", "source": "explicit"}},
    }
    raw = await preview_loop_template("acme", "coding-loop", include_prompts=False, ctx=ctx)
    result = json.loads(raw)

    assert "SECRET" not in raw
    assert "system_prompt" not in result
    assert "loop_prompt" not in result
    assert "loop_prompt_with_tools_manifest" not in result
    # The diagnostics that make a fit decision possible must survive the trim.
    assert result["findings"] == [{"code": "unused_slot", "slot": "FOO"}]
    assert result["missing_required"] == ["BAR"]
    assert result["used_values"] == {"RUN_LABEL": {"value": "loop-8", "source": "explicit"}}
    assert result["rails"] == {"max_iterations": 20}
    assert result["tools"] == ["get_card"]


@pytest.mark.anyio
async def test_preview_include_prompts_true_keeps_bodies_and_manifest(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import preview_loop_template

    mock_client.post.return_value = {
        "template": {"ref": "coding-loop", "version": 2},
        "system_prompt": "SYS",
        "loop_prompt": "LOOP",
        "loop_prompt_with_tools_manifest": "LOOP+MANIFEST",
        "tools": [],
        "rails": {},
        "findings": [],
        "missing_required": [],
        "used_values": {},
    }
    result = json.loads(await preview_loop_template("acme", "coding-loop", ctx=ctx))

    assert result["system_prompt"] == "SYS"
    assert result["loop_prompt"] == "LOOP"
    assert result["loop_prompt_with_tools_manifest"] == "LOOP+MANIFEST"


@pytest.mark.anyio
async def test_get_board_loop_binding_include_diff_fetches_the_diff(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import get_board_loop_binding_raw

    binding = {
        "template": {"ref": "coding-loop", "version": 2},
        "slot_values": {},
        "drift": {"kind": "template_newer", "current_version": 3},
        "diff_available": True,
    }
    diff = {
        "system_prompt": "@@ -1 +1 @@\n-old\n+new",
        "loop_prompt": "",
        "slots_delta": {"added": ["NEW_SLOT"], "removed": []},
    }
    mock_client.get.side_effect = [binding, diff]

    result = json.loads(
        await get_board_loop_binding_raw("acme", "board-1", include_diff=True, ctx=ctx)
    )

    assert [c.args[0] for c in mock_client.get.call_args_list] == [
        "/workspaces/acme/boards/board-1/loop/binding",
        "/workspaces/acme/boards/board-1/loop/binding/diff",
    ]
    assert result["diff"]["slots_delta"]["added"] == ["NEW_SLOT"]
    assert result["drift"]["kind"] == "template_newer"


@pytest.mark.anyio
async def test_get_board_loop_binding_include_diff_skips_when_no_drift(mock_client, ctx):
    """diff_available False means the backend has nothing to diff — asking anyway
    would spend a round-trip to be told the same thing."""
    from valaris_mcp.tools.loop_templates import get_board_loop_binding_raw

    mock_client.get.return_value = {
        "template": {"ref": "coding-loop", "version": 2},
        "slot_values": {},
        "drift": {"kind": "none"},
        "diff_available": False,
    }
    result = json.loads(
        await get_board_loop_binding_raw("acme", "board-1", include_diff=True, ctx=ctx)
    )

    mock_client.get.assert_called_once_with("/workspaces/acme/boards/board-1/loop/binding")
    assert "diff" not in result


@pytest.mark.anyio
async def test_get_board_loop_binding_default_does_not_fetch_diff(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import get_board_loop_binding_raw

    mock_client.get.return_value = {
        "template": {"ref": "coding-loop", "version": 2},
        "slot_values": {},
        "drift": {"kind": "template_newer"},
        "diff_available": True,
    }
    result = json.loads(await get_board_loop_binding_raw("acme", "board-1", ctx=ctx))

    mock_client.get.assert_called_once_with("/workspaces/acme/boards/board-1/loop/binding")
    assert "diff" not in result


@pytest.mark.anyio
async def test_lint_loop_template_returns_findings(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import lint_loop_template

    mock_client.post.return_value = {
        "findings": [
            {
                "code": "url",
                "match": "https://github.com/acme/repo",
                "line": 3,
                "hint": "move into a slot such as <<REPO_URL>>",
            }
        ]
    }

    result = json.loads(await lint_loop_template("acme", "coding-loop", ctx=ctx))

    mock_client.post.assert_called_once_with(
        "/workspaces/acme/loop-templates/coding-loop/lint", {}
    )
    assert result["findings"][0]["code"] == "url"
    assert result["findings"][0]["hint"]


@pytest.mark.anyio
async def test_lint_loop_template_clean_template_is_not_an_error(mock_client, ctx):
    """No findings is a normal 200 — the twin must not invent an error shape."""
    from valaris_mcp.tools.loop_templates import lint_loop_template

    mock_client.post.return_value = {"findings": []}

    result = json.loads(await lint_loop_template("acme", "coding-loop", ctx=ctx))

    assert result["findings"] == []
    assert "error" not in result


# --------------------------------------------------------------- export/import


@pytest.mark.anyio
async def test_export_loop_template_envelope(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import export_loop_template

    mock_client.get.return_value = {
        "schema_version": 1,
        "exported_at": "2026-08-17T00:00:00+00:00",
        "entity_type": "loop_template",
        "source_workspace_slug": "acme",
        "source_board_slug": None,
        "data": {
            "slug": "coding-loop",
            "name": "Coding Loop",
            "kind": "loop_template",
            "version": 2,
            "is_system_origin": True,
            "profile": {"summary": "TDD loop"},
            "content": {"system_prompt": "SYS <<REPO_URL>>"},
            "lineage": {"source": "export", "slug": "coding-loop", "version": 2},
            "leak_findings": [],
        },
    }

    result = json.loads(await export_loop_template("acme", "coding-loop", ctx=ctx))

    mock_client.get.assert_called_once_with(
        "/workspaces/acme/loop-templates/coding-loop/export"
    )
    assert result["entity_type"] == "loop_template"
    assert result["data"]["slug"] == "coding-loop"
    assert result["data"]["is_system_origin"] is True
    # A clean export must not fabricate a leak warning.
    assert "leak" not in result["_hint"].lower()


@pytest.mark.anyio
async def test_export_loop_template_hint_counts_leak_findings(mock_client, ctx):
    """The envelope carries repo facts as warnings; the hint must surface them
    or an operator pastes a workspace-specific loop into a shared template."""
    from valaris_mcp.tools.loop_templates import export_loop_template

    mock_client.get.return_value = {
        "schema_version": 1,
        "entity_type": "loop_template",
        "data": {
            "slug": "acme-loop",
            "leak_findings": [
                {"code": "url", "match": "https://github.com/acme/repo", "line": 3},
                {"code": "sha", "match": "ce4ea8b4", "line": 9},
            ],
        },
    }

    result = json.loads(await export_loop_template("acme", "acme-loop", ctx=ctx))

    assert "2" in result["_hint"]
    assert "leak_findings" in result["_hint"]


@pytest.mark.anyio
async def test_export_loop_template_relays_unknown_ref(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import export_loop_template

    mock_client.get.side_effect = _api_error(
        404, {"detail": "loop template 'nope' not found"}
    )

    result = json.loads(await export_loop_template("acme", "nope", ctx=ctx))

    assert result["status"] == 404
    assert "not found" in json.dumps(result)


@pytest.mark.anyio
async def test_import_loop_template_dry_run_default(mock_client, ctx):
    """Default MUST be dry-run: the destructive half of a share is opt-in."""
    from valaris_mcp.tools.loop_templates import import_loop_template

    bundle = {
        "schema_version": 1,
        "entity_type": "loop_template",
        "data": {"slug": "coding-loop", "content": {"system_prompt": "SYS"}},
    }
    mock_client.post.return_value = {
        "schema_version": 1,
        "dry_run": True,
        "action": "created",
        "slug": "coding-loop",
        "findings": [],
        "diff_summary": ["new template"],
        "leak_findings": [],
        "template_id": None,
    }

    result = json.loads(await import_loop_template("acme", bundle, ctx=ctx))

    mock_client.post.assert_called_once_with(
        "/workspaces/acme/loop-templates/import?dry_run=true", bundle
    )
    assert result["dry_run"] is True
    assert result["template_id"] is None


@pytest.mark.anyio
async def test_import_loop_template_commit_creates_draft(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import import_loop_template

    bundle = {
        "schema_version": 1,
        "entity_type": "loop_template",
        "data": {"slug": "coding-loop", "content": {"system_prompt": "SYS"}},
    }
    mock_client.post.return_value = {
        "schema_version": 1,
        "dry_run": False,
        "action": "created",
        "slug": "coding-loop",
        "findings": [],
        "diff_summary": ["new template"],
        "leak_findings": [],
        "template_id": "11111111-2222-3333-4444-555555555555",
    }

    result = json.loads(await import_loop_template("acme", bundle, dry_run=False, ctx=ctx))

    mock_client.post.assert_called_once_with(
        "/workspaces/acme/loop-templates/import?dry_run=false", bundle
    )
    assert result["template_id"] == "11111111-2222-3333-4444-555555555555"
    # An import lands unpublished — the hint has to say so, AND name the tool
    # that makes it runnable, or an operator believes a running board just
    # changed. Matching the bare word "publish" would be satisfied by
    # "unpublished" in the same sentence, so name the tool.
    hint = result["_hint"].lower()
    assert "draft" in hint
    assert "publish_loop_template" in hint


@pytest.mark.anyio
async def test_import_loop_template_relays_agent_caller_403(mock_client, ctx):
    """Import is admin + forbid_agent_callers on the backend; the twin relays."""
    from valaris_mcp.tools.loop_templates import import_loop_template

    mock_client.post.side_effect = _api_error(
        403,
        {"detail": "agent callers may not mutate", "error_code": "forbidden_agent_caller"},
    )

    result = json.loads(
        await import_loop_template("acme", {"entity_type": "loop_template"}, dry_run=False, ctx=ctx)
    )

    assert result["status"] == 403
    assert result["error_code"] == "forbidden_agent_caller"


@pytest.mark.anyio
async def test_import_loop_template_relays_bad_envelope(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import import_loop_template

    mock_client.post.side_effect = _api_error(
        400, {"detail": "expected entity_type 'loop_template', got 'pipeline_bundle'"}
    )

    result = json.loads(await import_loop_template("acme", {"entity_type": "pipeline_bundle"}, ctx=ctx))

    assert result["status"] == 400
    assert "entity_type" in json.dumps(result)


@pytest.mark.anyio
async def test_get_loop_template_forwards_include_archived(mock_client, ctx):
    """Parity with the REST route, which has accepted `include_archived` since
    archiving shipped. Without it an archived template 404s over MCP while
    resolving fine over HTTP, so a board bound before the archive is
    unreadable to the very agent running it."""
    from valaris_mcp.tools.loop_templates import get_loop_template

    mock_client.get.return_value = {"id": "x", "slug": "retired-loop", "version": 4}
    result = json.loads(
        await get_loop_template("acme", "retired-loop", include_archived=True, ctx=ctx)
    )

    mock_client.get.assert_called_once_with(
        "/workspaces/acme/loop-templates/retired-loop",
        draft=False,
        include_archived=True,
    )
    assert result["version"] == 4


@pytest.mark.anyio
async def test_get_loop_template_defaults_to_excluding_archived(mock_client, ctx):
    from valaris_mcp.tools.loop_templates import get_loop_template

    mock_client.get.return_value = {"id": "x"}
    await get_loop_template("acme", "coding-loop", ctx=ctx)

    _, kwargs = mock_client.get.call_args
    assert kwargs == {"draft": False, "include_archived": False}
