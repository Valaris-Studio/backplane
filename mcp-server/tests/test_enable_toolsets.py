# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""`enable_toolsets` widens a session's hand at runtime (MCP #6).

The hand is a mutable `HandState` on the lifespan context: toolset ids +
resolved toolset hand + the runner allowlist, composed by intersection. The
tool unions further toolsets into the toolset layer (widen-only, `all` lifts
that layer), the allowlist is a ceiling it never lifts, `install_hand` reads
the composed hand at every list/call so the change is visible immediately,
and the server notifies `tools/list_changed` only when something was added.

Every count is derived from the catalog — nothing is typed.
"""
from __future__ import annotations

import contextlib
import dataclasses
import inspect
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from mcp.server.fastmcp import FastMCP
from mcp.shared.context import RequestContext

from tests.conftest import make_ctx
from valaris_mcp.allowlist import ALLOWLIST_ENV, compose_hand, listed_tools
from valaris_mcp.catalog import TOOL_META, compact_listing_bytes, live_tool_names, tool_annotations
from valaris_mcp.server import AppContext, app_lifespan, mcp
from valaris_mcp.toolsets import (
    ALL,
    DEFAULT,
    TOOLSETS_ENV,
    default_hand,
    resolve_hand,
    toolset_ids,
    tools_in_toolset,
)

pytestmark = pytest.mark.anyio

TOOL = "enable_toolsets"
SERVER_INFO_TOOLSET = "server-info"
AUTONOMOUS = "autonomous-operations"
RESULT_KEYS = {
    "loaded",
    "added_tools",
    "added_count",
    "enabled_tool_count",
    "listing_bytes",
    "list_changed_sent",
    "client_catalog_status",
    "restart_env",
    "_hint",
}


def _hand_state():
    from valaris_mcp.hand import HandState

    return HandState


def _default_state():
    return _hand_state()([DEFAULT], default_hand(), None)


def _state(ids: list[str], allowlist: frozenset[str] | None = None):
    return _hand_state()(list(ids), resolve_hand(list(ids)), allowlist)


def _snapshot(state) -> tuple:
    return (
        None if state.toolset_ids is None else list(state.toolset_ids),
        state.toolset_hand,
        state.allowlist,
    )


async def _listing_bytes_for(composed: frozenset[str] | None) -> int:
    return compact_listing_bytes(listed_tools(await mcp.list_tools(), composed))


# ---------- HandState.composed ----------


def test_hand_state_composed_is_compose_hand_of_its_two_layers():
    allowlist = frozenset({"get_card", "create_note"})
    state = _state(["cards"], allowlist)
    assert state.composed == compose_hand(resolve_hand(["cards"]), allowlist)
    assert state.composed == frozenset({"get_card"})


def test_hand_state_unrestricted_composes_to_none():
    assert _hand_state()(None, None, None).composed is None


def test_hand_state_allowlist_only_composes_to_the_allowlist():
    allowlist = frozenset({"get_card"})
    assert _hand_state()(None, None, allowlist).composed == allowlist


def test_hand_state_is_a_dataclass_with_the_three_layers():
    fields = [field.name for field in dataclasses.fields(_hand_state())]
    assert fields == ["toolset_ids", "toolset_hand", "allowlist"]


# ---------- HandState.widen ----------


def test_widen_adds_a_toolset_to_the_hand_and_returns_the_new_names():
    state = _default_state()
    added = state.widen([AUTONOMOUS])
    expected_new = tools_in_toolset(AUTONOMOUS) - default_hand()
    assert expected_new  # guard the premise: the group is not in the default hand
    assert isinstance(added, frozenset)
    assert added == expected_new
    assert state.toolset_ids == [DEFAULT, AUTONOMOUS]
    assert state.toolset_hand == resolve_hand([DEFAULT, AUTONOMOUS])
    assert state.composed == state.toolset_hand


def test_widen_reinstates_a_default_exclusion_when_its_toolset_is_named():
    state = _default_state()
    assert "delete_board" not in default_hand()
    added = state.widen(["boards"])
    assert added == tools_in_toolset("boards") - default_hand()
    assert "delete_board" in added


def test_widen_returns_only_names_not_already_listed():
    state = _state(["cards"])
    already = state.toolset_hand
    added = state.widen(["work-management"])
    assert not added & already
    assert added == tools_in_toolset("work-management") - already


def test_widen_twice_with_the_same_id_is_a_no_op():
    state = _default_state()
    state.widen([AUTONOMOUS])
    before = _snapshot(state)
    assert state.widen([AUTONOMOUS]) == frozenset()
    assert _snapshot(state) == before


def test_widen_keeps_toolset_ids_in_first_seen_order_without_duplicates():
    state = _default_state()
    state.widen(["cards", "boards"])
    state.widen(["boards", "notes", "cards"])
    assert state.toolset_ids == [DEFAULT, "cards", "boards", "notes"]


def test_widen_never_narrows_the_hand():
    state = _default_state()
    before = state.toolset_hand
    state.widen(["cards"])
    assert before <= state.toolset_hand
    state.widen(["search"])
    assert before <= state.toolset_hand


def test_widen_default_from_a_narrow_hand_adds_the_default_hand():
    state = _state(["cards"])
    narrow = state.toolset_hand
    added = state.widen([DEFAULT])
    assert added == default_hand() - narrow
    assert state.toolset_ids == ["cards", DEFAULT]
    assert state.toolset_hand == resolve_hand(["cards", DEFAULT])


def test_widen_all_lifts_the_toolset_layer_and_keeps_the_allowlist():
    allowlist = frozenset({"get_card", "list_agents"})
    state = _default_state()
    state.allowlist = allowlist
    assert "list_agents" not in default_hand()  # guard the premise
    added = state.widen([ALL])
    assert added == frozenset({"list_agents"})
    assert state.toolset_ids is None
    assert state.toolset_hand is None
    assert state.allowlist == allowlist
    assert state.composed == allowlist


def test_widen_all_without_an_allowlist_adds_everything_outside_the_old_hand():
    state = _default_state()
    added = state.widen([ALL])
    assert frozenset(live_tool_names()) - default_hand() <= added
    assert not added & default_hand()
    assert added <= frozenset(TOOL_META)
    assert state.composed is None


def test_widen_all_mixed_with_other_ids_still_lifts_the_layer():
    state = _default_state()
    state.widen(["cards", ALL])
    assert state.toolset_ids is None
    assert state.toolset_hand is None


def test_widen_after_all_is_a_no_op():
    state = _default_state()
    state.widen([ALL])
    assert state.widen(["cards"]) == frozenset()
    assert state.widen([ALL]) == frozenset()
    assert _snapshot(state) == (None, None, None)


def test_widen_on_an_unrestricted_toolset_layer_is_a_no_op():
    state = _hand_state()(None, None, None)
    assert state.widen(["cards"]) == frozenset()
    assert _snapshot(state) == (None, None, None)


def test_widen_on_an_allowlist_only_hand_is_a_no_op():
    # The runner shape: every toolset loaded, the allowlist is the hand.
    allowlist = frozenset({"get_card"})
    state = _hand_state()(None, None, allowlist)
    assert state.widen([AUTONOMOUS]) == frozenset()
    assert _snapshot(state) == (None, None, allowlist)


def test_widen_never_exceeds_the_allowlist_ceiling():
    allowlist = frozenset({"get_card", TOOL})
    state = _state(["start-here"], allowlist)
    assert "get_card" not in resolve_hand(["start-here"])  # guard the premise
    added = state.widen(["cards"])
    assert added == frozenset({"get_card"})
    assert state.composed <= allowlist
    assert state.widen([AUTONOMOUS]) == frozenset()
    assert state.composed <= allowlist
    state.widen([ALL])
    assert state.composed == allowlist


def test_widen_unknown_id_raises_listing_the_available_ids_and_changes_nothing():
    state = _default_state()
    before = _snapshot(state)
    with pytest.raises(ValueError) as excinfo:
        state.widen(["bogus"])
    message = str(excinfo.value)
    assert "bogus" in message
    assert ALL in message and DEFAULT in message
    for toolset_id in toolset_ids():
        assert toolset_id in message
    assert _snapshot(state) == before


def test_widen_mixed_known_and_unknown_ids_is_rejected_whole():
    state = _default_state()
    before = _snapshot(state)
    with pytest.raises(ValueError, match="bogus"):
        state.widen(["cards", "bogus"])
    assert _snapshot(state) == before


def test_widen_empty_list_raises_and_changes_nothing():
    state = _default_state()
    before = _snapshot(state)
    with pytest.raises(ValueError):
        state.widen([])
    assert _snapshot(state) == before


def test_widen_rejects_a_tool_name_that_is_not_a_toolset():
    state = _default_state()
    with pytest.raises(ValueError, match="get_card"):
        state.widen(["get_card"])


def test_widen_is_case_sensitive_like_the_env_var():
    state = _default_state()
    with pytest.raises(ValueError, match="Cards"):
        state.widen(["Cards"])


# ---------- load_hand (env) ----------


def test_load_hand_unset_env_is_the_default_hand(monkeypatch):
    from valaris_mcp.hand import load_hand

    monkeypatch.delenv(TOOLSETS_ENV, raising=False)
    monkeypatch.delenv(ALLOWLIST_ENV, raising=False)
    assert _snapshot(load_hand()) == ([DEFAULT], default_hand(), None)


def test_load_hand_explicit_toolsets_and_allowlist_fill_both_layers(monkeypatch):
    from valaris_mcp.hand import load_hand

    monkeypatch.setenv(TOOLSETS_ENV, "cards, notes")
    monkeypatch.setenv(ALLOWLIST_ENV, "get_card,create_note")
    state = load_hand()
    assert _snapshot(state) == (
        ["cards", "notes"],
        resolve_hand(["cards", "notes"]),
        frozenset({"get_card", "create_note"}),
    )
    assert state.composed == frozenset({"get_card", "create_note"})


def test_load_hand_allowlist_alone_is_the_runner_shape(monkeypatch):
    from valaris_mcp.hand import load_hand

    monkeypatch.delenv(TOOLSETS_ENV, raising=False)
    monkeypatch.setenv(ALLOWLIST_ENV, "get_card,list_agents")
    assert _snapshot(load_hand()) == (None, None, frozenset({"get_card", "list_agents"}))


def test_load_hand_all_is_unrestricted(monkeypatch):
    from valaris_mcp.hand import load_hand

    monkeypatch.setenv(TOOLSETS_ENV, "all")
    monkeypatch.delenv(ALLOWLIST_ENV, raising=False)
    assert _snapshot(load_hand()) == (None, None, None)


def test_load_hand_unknown_toolset_fails_closed(monkeypatch):
    from valaris_mcp.hand import load_hand

    monkeypatch.setenv(TOOLSETS_ENV, "cards,bogus")
    with pytest.raises(RuntimeError, match="bogus"):
        load_hand()


# ---------- install_hand: list filter and call gate read the live state ----------


class _FakeToolManager:
    def __init__(self, names: list[str], call_tool):
        self._names = names
        self.call_tool = call_tool

    def list_tools(self):
        return [SimpleNamespace(name=name) for name in self._names]


class _FakeServer:
    def __init__(self, names: list[str], call_tool):
        self._tool_manager = _FakeToolManager(names, call_tool)


# Registration order matters for the listing; every name is a real live tool
# so the toolset ids that widen the hand are catalog ids.
REGISTRY = ["get_card", "create_note", "list_agents", "delete_board", "get_server_info", TOOL]


def _installed(state):
    from valaris_mcp.allowlist import install_hand

    original = AsyncMock(return_value="ok")
    server = _FakeServer(REGISTRY, original)
    install_hand(server, state)
    return server, original


def _listed(server) -> list[str]:
    return [tool.name for tool in server._tool_manager.list_tools()]


async def _denial(server, name: str) -> dict:
    with pytest.raises(PermissionError) as excinfo:
        await server._tool_manager.call_tool(name, {})
    return json.loads(str(excinfo.value))


async def test_install_hand_unrestricted_leaves_the_manager_untouched():
    from valaris_mcp.allowlist import install_hand

    original = AsyncMock(return_value="ok")
    server = _FakeServer(REGISTRY, original)
    install_hand(server, _hand_state()(None, None, None))
    assert server._tool_manager.call_tool is original
    # No instance-level override: the class method is still what answers list_tools.
    assert "list_tools" not in vars(server._tool_manager)


async def test_install_hand_filters_the_listing_to_the_composed_hand():
    server, _ = _installed(_state(["cards"]))
    assert _listed(server) == ["get_card", "get_server_info", TOOL]


async def test_install_hand_denies_a_call_outside_the_composed_hand():
    state = _state(["cards"])
    server, original = _installed(state)
    denial = await _denial(server, "create_note")
    assert denial["error"] == "tool_not_allowed"
    assert denial["tool"] == "create_note"
    assert denial["allowlist"] == sorted(state.composed)
    assert denial["toolsets"] == ["cards"]
    original.assert_not_called()


async def test_install_hand_lets_a_call_inside_the_composed_hand_through():
    server, original = _installed(_state(["cards"]))
    assert await server._tool_manager.call_tool("get_card", {"card_id": "x"}) == "ok"
    original.assert_awaited_once_with("get_card", {"card_id": "x"})


async def test_install_hand_listing_sees_a_later_widen():
    state = _state(["cards"])
    server, _ = _installed(state)
    assert "create_note" not in _listed(server)
    state.widen(["notes"])
    assert _listed(server) == ["get_card", "create_note", "get_server_info", TOOL]


async def test_install_hand_call_gate_sees_a_later_widen():
    state = _state(["cards"])
    server, original = _installed(state)
    await _denial(server, "list_agents")
    state.widen([AUTONOMOUS])
    assert await server._tool_manager.call_tool("list_agents", {}) == "ok"
    original.assert_awaited_once_with("list_agents", {})
    # Still outside every loaded toolset: the gate holds for the rest.
    await _denial(server, "delete_board")


async def test_install_hand_denial_echoes_the_widened_toolset_ids():
    state = _state(["cards"])
    server, _ = _installed(state)
    state.widen(["notes"])
    denial = await _denial(server, "delete_board")
    assert denial["toolsets"] == ["cards", "notes"]
    assert denial["allowlist"] == sorted(state.composed)


async def test_install_hand_widen_to_all_lifts_the_gate_but_keeps_the_allowlist():
    allowlist = frozenset({"get_card", "list_agents"})
    state = _state(["cards"], allowlist)
    server, _ = _installed(state)
    assert _listed(server) == ["get_card"]
    state.widen([ALL])
    assert _listed(server) == ["get_card", "list_agents"]
    assert await server._tool_manager.call_tool("list_agents", {}) == "ok"
    denial = await _denial(server, "delete_board")
    assert denial["allowlist"] == sorted(allowlist)
    assert "toolsets" not in denial


async def test_install_hand_listing_stays_within_the_allowlist_after_widening():
    allowlist = frozenset({"get_card", TOOL})
    state = _state(["start-here"], allowlist)
    server, _ = _installed(state)
    assert _listed(server) == [TOOL]
    state.widen(["cards"])
    assert _listed(server) == ["get_card", TOOL]
    state.widen([AUTONOMOUS])
    assert set(_listed(server)) <= allowlist
    await _denial(server, "list_agents")
    state.widen([ALL])
    assert set(_listed(server)) <= allowlist
    await _denial(server, "list_agents")


async def test_install_hand_deny_all_sentinel_lists_nothing_even_after_widening():
    state = _state(["cards"], frozenset({"__none__"}))
    server, _ = _installed(state)
    assert _listed(server) == []
    state.widen([ALL])
    assert _listed(server) == []
    await _denial(server, "get_card")


# ---------- AppContext and the lifespan ----------


def test_app_context_carries_the_hand_state():
    assert "hand" in {field.name for field in dataclasses.fields(AppContext)}
    state = _hand_state()(None, None, None)
    app = AppContext(client=AsyncMock(), tracker=AsyncMock(), hand=state)
    assert app.hand is state


def test_make_ctx_defaults_to_an_unrestricted_hand(mock_client):
    ctx = make_ctx(mock_client)
    assert _snapshot(ctx.request_context.lifespan_context.hand) == (None, None, None)


def test_make_ctx_accepts_a_hand(mock_client):
    state = _default_state()
    ctx = make_ctx(mock_client, hand=state)
    assert ctx.request_context.lifespan_context.hand is state


async def test_lifespan_installs_a_hand_the_context_can_widen(monkeypatch):
    from valaris_mcp.tools.agents import list_agents
    from valaris_mcp.tools.cards import get_card
    from valaris_mcp.tools.notes import create_note

    monkeypatch.setenv(TOOLSETS_ENV, "cards")
    monkeypatch.delenv(ALLOWLIST_ENV, raising=False)
    server = FastMCP("t")
    for fn in (get_card, create_note, list_agents):
        server.add_tool(fn)

    async with app_lifespan(server) as app:
        assert app.hand.toolset_ids == ["cards"]
        assert app.hand.composed == resolve_hand(["cards"])
        assert [tool.name for tool in await server.list_tools()] == ["get_card"]
        # The context holds the very state the manager was patched with.
        app.hand.widen(["notes", AUTONOMOUS])
        assert [tool.name for tool in await server.list_tools()] == [
            "get_card",
            "create_note",
            "list_agents",
        ]


# ---------- the tool ----------


def _tool_ctx(mock_client, state):
    mock_client.get.return_value = {"status": "ok"}
    ctx = make_ctx(mock_client, hand=state)
    return ctx, ctx.request_context.session


async def _call(ctx, ids: list[str]) -> dict:
    from valaris_mcp.tools.server_info import enable_toolsets

    return json.loads(await enable_toolsets(toolset_ids=ids, ctx=ctx))


async def test_enable_toolsets_widens_the_session_hand_and_reports_the_growth(mock_client):
    state = _default_state()
    ctx, session = _tool_ctx(mock_client, state)
    out = await _call(ctx, [AUTONOMOUS])

    expected_new = tools_in_toolset(AUTONOMOUS) - default_hand()
    assert set(out) == RESULT_KEYS
    assert out["loaded"] == [DEFAULT, AUTONOMOUS]
    assert out["added_tools"] == sorted(expected_new)
    assert out["added_count"] == len(expected_new)
    assert out["enabled_tool_count"] == len(resolve_hand([DEFAULT, AUTONOMOUS]))
    assert out["listing_bytes"] == await _listing_bytes_for(state.composed)
    assert out["listing_bytes"] > await _listing_bytes_for(default_hand())
    assert out["list_changed_sent"] is True
    assert isinstance(out["_hint"], str) and out["_hint"]
    assert state.toolset_hand == resolve_hand([DEFAULT, AUTONOMOUS])
    session.send_tool_list_changed.assert_awaited_once_with()


async def test_enable_toolsets_repeated_call_adds_nothing_and_sends_no_notification(mock_client):
    ctx, session = _tool_ctx(mock_client, _default_state())
    first = await _call(ctx, [AUTONOMOUS])
    second = await _call(ctx, [AUTONOMOUS])
    assert second["added_tools"] == []
    assert second["added_count"] == 0
    assert second["list_changed_sent"] is False
    assert second["loaded"] == first["loaded"] == [DEFAULT, AUTONOMOUS]
    assert second["enabled_tool_count"] == first["enabled_tool_count"]
    assert second["listing_bytes"] == first["listing_bytes"]
    session.send_tool_list_changed.assert_awaited_once()


async def test_enable_toolsets_already_covered_toolset_sends_no_notification(mock_client):
    # `search` is inside the default hand already: nothing grows, no notice.
    assert tools_in_toolset("search") <= default_hand()
    ctx, session = _tool_ctx(mock_client, _default_state())
    out = await _call(ctx, ["search"])
    assert out["added_count"] == 0
    assert out["list_changed_sent"] is False
    assert out["loaded"] == [DEFAULT, "search"]
    session.send_tool_list_changed.assert_not_awaited()


async def test_enable_toolsets_all_reports_loaded_all(mock_client):
    state = _default_state()
    ctx, session = _tool_ctx(mock_client, state)
    out = await _call(ctx, [ALL])
    assert out["loaded"] == [ALL]
    assert set(out["added_tools"]) >= frozenset(live_tool_names()) - default_hand()
    assert out["added_count"] == len(out["added_tools"]) > 0
    assert out["enabled_tool_count"] >= len(live_tool_names())
    assert out["listing_bytes"] == await _listing_bytes_for(None)
    assert out["list_changed_sent"] is True
    assert state.composed is None
    session.send_tool_list_changed.assert_awaited_once()


async def test_enable_toolsets_several_ids_in_one_call(mock_client):
    state = _default_state()
    ctx, _ = _tool_ctx(mock_client, state)
    out = await _call(ctx, [AUTONOMOUS, "boards"])
    expected_new = (tools_in_toolset(AUTONOMOUS) | tools_in_toolset("boards")) - default_hand()
    assert out["loaded"] == [DEFAULT, AUTONOMOUS, "boards"]
    assert out["added_tools"] == sorted(expected_new)
    assert state.toolset_hand == resolve_hand([DEFAULT, AUTONOMOUS, "boards"])


async def test_enable_toolsets_default_from_a_narrow_hand(mock_client):
    state = _state(["cards"])
    narrow = state.toolset_hand
    ctx, _ = _tool_ctx(mock_client, state)
    out = await _call(ctx, [DEFAULT])
    assert out["loaded"] == ["cards", DEFAULT]
    assert out["added_tools"] == sorted(default_hand() - narrow)
    assert out["enabled_tool_count"] == len(resolve_hand(["cards", DEFAULT]))


async def test_enable_toolsets_on_an_unrestricted_session_is_a_no_op(mock_client):
    ctx, session = _tool_ctx(mock_client, _hand_state()(None, None, None))
    out = await _call(ctx, [AUTONOMOUS])
    assert out["loaded"] == [ALL]
    assert out["added_tools"] == []
    assert out["added_count"] == 0
    assert out["list_changed_sent"] is False
    assert out["enabled_tool_count"] >= len(live_tool_names())
    assert "error" not in out
    session.send_tool_list_changed.assert_not_awaited()


async def test_enable_toolsets_unknown_id_returns_the_house_error_and_changes_nothing(mock_client):
    state = _default_state()
    before = _snapshot(state)
    ctx, session = _tool_ctx(mock_client, state)
    out = await _call(ctx, ["bogus"])
    assert out["error"] is True
    assert "bogus" in out["message"]
    for toolset_id in toolset_ids():
        assert toolset_id in out["message"]
    assert _snapshot(state) == before
    session.send_tool_list_changed.assert_not_awaited()


async def test_enable_toolsets_mixed_known_and_unknown_ids_applies_nothing(mock_client):
    state = _default_state()
    before = _snapshot(state)
    ctx, session = _tool_ctx(mock_client, state)
    out = await _call(ctx, [AUTONOMOUS, "bogus"])
    assert out["error"] is True
    assert _snapshot(state) == before
    session.send_tool_list_changed.assert_not_awaited()


async def test_enable_toolsets_empty_list_returns_the_house_error(mock_client):
    state = _default_state()
    before = _snapshot(state)
    ctx, session = _tool_ctx(mock_client, state)
    out = await _call(ctx, [])
    assert out["error"] is True
    assert isinstance(out["message"], str) and out["message"]
    assert _snapshot(state) == before
    session.send_tool_list_changed.assert_not_awaited()


async def test_enable_toolsets_reports_names_the_allowlist_clips(mock_client):
    allowlist = frozenset({"get_card", TOOL})
    state = _state(["start-here"], allowlist)
    ctx, session = _tool_ctx(mock_client, state)
    out = await _call(ctx, ["cards"])
    assert out["added_tools"] == ["get_card"]
    assert out["added_count"] == 1
    assert out["allowlist_clipped"] == sorted(tools_in_toolset("cards") - allowlist)
    assert out["enabled_tool_count"] == len(state.composed) == len(allowlist)
    assert out["listing_bytes"] == await _listing_bytes_for(allowlist)
    assert out["list_changed_sent"] is True
    session.send_tool_list_changed.assert_awaited_once()


async def test_enable_toolsets_omits_allowlist_clipped_when_nothing_is_clipped(mock_client):
    allowlist = tools_in_toolset("cards") | {TOOL}
    state = _state(["start-here"], allowlist)
    ctx, _ = _tool_ctx(mock_client, state)
    out = await _call(ctx, ["cards"])
    assert "allowlist_clipped" not in out
    assert set(out["added_tools"]) == tools_in_toolset("cards")


async def test_enable_toolsets_omits_allowlist_clipped_without_an_allowlist(mock_client):
    ctx, _ = _tool_ctx(mock_client, _default_state())
    out = await _call(ctx, ["boards"])
    assert "allowlist_clipped" not in out


async def test_enable_toolsets_fully_clipped_widen_sends_no_notification(mock_client):
    allowlist = frozenset({TOOL})
    state = _state(["start-here"], allowlist)
    ctx, session = _tool_ctx(mock_client, state)
    out = await _call(ctx, ["cards"])
    assert out["added_tools"] == []
    assert out["added_count"] == 0
    assert out["list_changed_sent"] is False
    assert out["allowlist_clipped"] == sorted(tools_in_toolset("cards"))
    assert out["loaded"] == ["start-here", "cards"]
    assert state.composed == allowlist
    session.send_tool_list_changed.assert_not_awaited()


async def test_enable_toolsets_all_under_an_allowlist_reports_the_clip(mock_client):
    allowlist = frozenset({"get_card", TOOL})
    state = _state(["start-here"], allowlist)
    ctx, _ = _tool_ctx(mock_client, state)
    out = await _call(ctx, [ALL])
    assert out["loaded"] == [ALL]
    assert out["added_tools"] == ["get_card"]
    assert out["enabled_tool_count"] == len(allowlist)
    assert state.composed == allowlist
    assert "allowlist_clipped" in out
    assert "get_card" not in out["allowlist_clipped"]
    assert "list_agents" in out["allowlist_clipped"]


# ---------- get_server_info reads the lifespan hand ----------


async def _server_info(ctx) -> dict:
    from valaris_mcp.tools.server_info import get_server_info

    return json.loads(await get_server_info(ctx=ctx))


async def test_get_server_info_reflects_a_widened_hand(mock_client, monkeypatch):
    monkeypatch.delenv(TOOLSETS_ENV, raising=False)
    monkeypatch.delenv(ALLOWLIST_ENV, raising=False)
    state = _default_state()
    ctx, _ = _tool_ctx(mock_client, state)
    before = await _server_info(ctx)
    await _call(ctx, [AUTONOMOUS])
    after = await _server_info(ctx)

    widened = resolve_hand([DEFAULT, AUTONOMOUS])
    assert before["toolsets"]["loaded"] == [DEFAULT]
    assert after["toolsets"]["loaded"] == [DEFAULT, AUTONOMOUS]
    assert after["toolsets"]["resolved_tool_count"] == len(widened)
    assert after["enabled_tools"] == sorted(widened)
    assert after["listing_bytes"] == await _listing_bytes_for(widened)
    assert after["listing_bytes"] > before["listing_bytes"]
    assert after["tool_count"] == before["tool_count"]


async def test_get_server_info_reads_the_lifespan_hand_not_the_env(mock_client, monkeypatch):
    # The env says `all`; the session state says cards ∩ a two-name allowlist.
    monkeypatch.setenv(TOOLSETS_ENV, "all")
    monkeypatch.delenv(ALLOWLIST_ENV, raising=False)
    allowlist = frozenset({"get_card", "create_note"})
    ctx, _ = _tool_ctx(mock_client, _state(["cards"], allowlist))
    info = await _server_info(ctx)
    assert info["toolsets"]["loaded"] == ["cards"]
    assert info["toolsets"]["resolved_tool_count"] == len(resolve_hand(["cards"]))
    assert info["allowlist"] == sorted(allowlist)
    assert info["enabled_tools"] == ["get_card"]
    assert info["allowlist_outside_toolsets"] == ["create_note"]
    assert info["listing_bytes"] == await _listing_bytes_for(frozenset({"get_card"}))


async def test_get_server_info_after_all_reports_the_full_hand(mock_client, monkeypatch):
    monkeypatch.delenv(TOOLSETS_ENV, raising=False)
    monkeypatch.delenv(ALLOWLIST_ENV, raising=False)
    ctx, _ = _tool_ctx(mock_client, _default_state())
    await _call(ctx, [ALL])
    info = await _server_info(ctx)
    assert info["toolsets"]["loaded"] == [ALL]
    assert info["enabled_tools"] == info["tools"]
    assert info["toolsets"]["resolved_tool_count"] == info["tool_count"]
    assert info["listing_bytes"] == await _listing_bytes_for(None)


async def test_get_server_info_hint_names_enable_toolsets(mock_client, monkeypatch):
    monkeypatch.delenv(TOOLSETS_ENV, raising=False)
    monkeypatch.delenv(ALLOWLIST_ENV, raising=False)
    ctx, _ = _tool_ctx(mock_client, _default_state())
    assert TOOL in (await _server_info(ctx))["toolsets"]["hint"]


async def test_get_server_info_hint_names_enable_toolsets_under_the_runner_shape(
    mock_client, monkeypatch
):
    monkeypatch.delenv(TOOLSETS_ENV, raising=False)
    monkeypatch.setenv(ALLOWLIST_ENV, "get_card")
    ctx, _ = _tool_ctx(mock_client, _hand_state()(None, None, frozenset({"get_card"})))
    assert TOOL in (await _server_info(ctx))["toolsets"]["hint"]


# ---------- catalog, registration, instructions, handshake ----------


def test_enable_toolsets_is_registered():
    assert TOOL in mcp._tool_manager._tools
    assert TOOL in live_tool_names()


def test_enable_toolsets_meta_is_an_idempotent_server_info_write():
    meta = TOOL_META[TOOL]
    assert meta.category == SERVER_INFO_TOOLSET
    assert meta.kind == "write"
    assert meta.destructive is False
    assert meta.idempotent is True
    assert meta.read_only is False
    assert meta.deprecated_for is None


def test_enable_toolsets_annotations_follow_its_meta():
    annotations = tool_annotations(TOOL, TOOL_META[TOOL])
    assert annotations.readOnlyHint is False
    assert annotations.destructiveHint is False
    assert annotations.idempotentHint is True
    assert mcp._tool_manager._tools[TOOL].annotations == annotations


def test_enable_toolsets_is_in_the_server_info_toolset_and_the_default_hand():
    assert TOOL in tools_in_toolset(SERVER_INFO_TOOLSET)
    assert TOOL in default_hand()


@pytest.mark.parametrize("toolset_id", toolset_ids() + [DEFAULT])
def test_enable_toolsets_rides_on_every_explicit_hand(toolset_id: str):
    assert TOOL in resolve_hand([toolset_id])


def test_enable_toolsets_schema_takes_a_list_of_toolset_ids():
    parameters = mcp._tool_manager._tools[TOOL].parameters
    properties = parameters["properties"]
    assert set(properties) == {"toolset_ids"}
    assert properties["toolset_ids"]["type"] == "array"
    assert properties["toolset_ids"]["items"] == {"type": "string"}
    assert parameters.get("required") == ["toolset_ids"]
    assert properties["toolset_ids"].get("description")


def test_enable_toolsets_signature_ends_with_ctx():
    from valaris_mcp.tools.server_info import enable_toolsets

    parameters = list(inspect.signature(enable_toolsets).parameters)
    assert parameters == ["toolset_ids", "ctx"]


def test_enable_toolsets_description_tells_the_model_it_widens_the_hand():
    description = mcp._tool_manager._tools[TOOL].description
    assert "toolset" in description.lower()
    assert "widen" in description.lower() or "enable" in description.lower()


def test_instructions_mention_enable_toolsets():
    assert TOOL in (mcp.instructions or "")


def test_handshake_advertises_tool_list_changed():
    capabilities = mcp._mcp_server.create_initialization_options().capabilities
    assert capabilities.tools is not None
    assert capabilities.tools.listChanged is True


# ---------- one wrapper per process, the request's own hand per call ----------
#
# Under streamable-http the lowlevel Server enters `app_lifespan` once PER
# SESSION. Wrapping the shared tool manager on every entry stacks gates (B's
# widening is nullified by A's closure) and never unwraps (a dead session
# gates the process forever). The wrappers must install once and resolve the
# CURRENT request's hand from the lowlevel request context, falling back to
# the install-time hand when no request is active (stdio, direct calls).


@contextlib.contextmanager
def _request_carrying(hand):
    from mcp.server.lowlevel.server import request_ctx

    token = request_ctx.set(
        RequestContext(
            request_id=1, meta=None, session=AsyncMock(), lifespan_context=SimpleNamespace(hand=hand)
        )
    )
    try:
        yield
    finally:
        request_ctx.reset(token)


async def test_install_hand_installs_its_wrappers_at_most_once_per_manager():
    from valaris_mcp.allowlist import install_hand

    original = AsyncMock(return_value="ok")
    server = _FakeServer(REGISTRY, original)
    install_hand(server, _default_state())
    call_after_first = server._tool_manager.call_tool
    list_after_first = server._tool_manager.list_tools
    assert call_after_first is not original

    install_hand(server, _default_state())
    assert server._tool_manager.call_tool is call_after_first
    assert server._tool_manager.list_tools is list_after_first


async def test_install_hand_gate_depth_stays_one_across_sessions():
    from valaris_mcp.allowlist import install_hand

    hand_a, hand_b = _default_state(), _default_state()
    original = AsyncMock(return_value="ok")
    server = _FakeServer(REGISTRY, original)
    install_hand(server, hand_a)
    install_hand(server, hand_b)

    hand_b.widen([AUTONOMOUS])
    with _request_carrying(hand_b):
        # A stacked gate from session A would deny this before B's ever ran.
        assert await server._tool_manager.call_tool("list_agents", {}) == "ok"
    original.assert_awaited_once_with("list_agents", {})


async def test_install_hand_resolves_the_current_requests_hand():
    from valaris_mcp.allowlist import install_hand

    hand_a, hand_b = _default_state(), _default_state()
    original = AsyncMock(return_value="ok")
    server = _FakeServer(REGISTRY, original)
    install_hand(server, hand_a)

    hand_b.widen([AUTONOMOUS])
    with _request_carrying(hand_b):
        assert "list_agents" in _listed(server)
        assert await server._tool_manager.call_tool("list_agents", {}) == "ok"
    with _request_carrying(hand_a):
        assert "list_agents" not in _listed(server)
        denial = await _denial(server, "list_agents")
        assert denial["toolsets"] == [DEFAULT]
    assert hand_a.toolset_ids == [DEFAULT]  # A was never touched by B's widening


async def test_install_hand_falls_back_to_the_install_time_hand_without_a_request():
    from valaris_mcp.allowlist import install_hand

    hand_a = _default_state()
    original = AsyncMock(return_value="ok")
    server = _FakeServer(REGISTRY, original)
    install_hand(server, hand_a)
    assert "list_agents" not in _listed(server)
    await _denial(server, "list_agents")
    hand_a.widen([AUTONOMOUS])
    assert "list_agents" in _listed(server)
    assert await server._tool_manager.call_tool("list_agents", {}) == "ok"


async def test_install_hand_denial_describes_the_requests_hand_not_the_installed_one():
    from valaris_mcp.allowlist import install_hand

    hand_a = _default_state()
    hand_b = _state(["cards"], frozenset({"get_card"}))
    original = AsyncMock(return_value="ok")
    server = _FakeServer(REGISTRY, original)
    install_hand(server, hand_a)
    with _request_carrying(hand_b):
        assert _listed(server) == ["get_card"]
        denial = await _denial(server, "create_note")
        assert denial["allowlist"] == ["get_card"]
        assert denial["toolsets"] == ["cards"]


@pytest.fixture
def restore_singleton_manager():
    # `install_hand`/`install_tracking` patch the shared singleton's manager in
    # place; leave the rest of the suite the unpatched class methods.
    manager = mcp._tool_manager
    patched_before = {name: vars(manager)[name] for name in ("call_tool", "list_tools") if name in vars(manager)}
    yield manager
    for name in ("call_tool", "list_tools"):
        vars(manager).pop(name, None)
    vars(manager).update(patched_before)


async def test_two_sequential_lifespans_on_the_singleton_leave_one_wrapper_layer(
    monkeypatch, restore_singleton_manager
):
    import valaris_mcp.server as server_module

    monkeypatch.delenv(TOOLSETS_ENV, raising=False)
    monkeypatch.delenv(ALLOWLIST_ENV, raising=False)
    monkeypatch.setattr(server_module, "ValarisClient", lambda: AsyncMock())
    monkeypatch.setattr(server_module, "ExecutionTracker", lambda client: AsyncMock())
    manager = restore_singleton_manager

    async with app_lifespan(mcp) as first:
        list_after_first = manager.list_tools
    async with app_lifespan(mcp) as second:
        assert manager.list_tools is list_after_first
        assert second.hand is not first.hand

        second.hand.widen([AUTONOMOUS])
        with _request_carrying(second.hand):
            assert "list_agents" in {tool.name for tool in manager.list_tools()}
            # Not denied: the only thing left to fail is the mocked client.
            try:
                await manager.call_tool("list_agents", {})
            except PermissionError as exc:
                pytest.fail(f"session B denied by a stacked gate: {exc}")
            except Exception:
                pass
        with _request_carrying(first.hand):
            assert "list_agents" not in {tool.name for tool in manager.list_tools()}
            with pytest.raises(PermissionError):
                await manager.call_tool("list_agents", {})


# ---------- ghost allowlist entries never count as growth ----------


def test_widen_all_ignores_allowlist_names_this_server_does_not_register():
    allowlist = frozenset({"get_server_info", TOOL, "whoami", "ghost_tool"})
    state = _hand_state()([DEFAULT], resolve_hand([DEFAULT]), allowlist)
    assert state.composed == allowlist - {"ghost_tool"}  # guard the premise
    assert state.widen([ALL]) == frozenset()
    assert state.toolset_hand is None


async def test_enable_toolsets_ghost_allowlist_entry_adds_nothing_and_stays_silent(mock_client):
    allowlist = frozenset({"get_server_info", TOOL, "whoami", "ghost_tool"})
    state = _hand_state()([DEFAULT], resolve_hand([DEFAULT]), allowlist)
    ctx, session = _tool_ctx(mock_client, state)
    out = await _call(ctx, [ALL])
    assert out["loaded"] == [ALL]
    assert out["added_tools"] == []
    assert out["added_count"] == 0
    assert out["list_changed_sent"] is False
    session.send_tool_list_changed.assert_not_awaited()


# ---------- a failed notification never undoes the widening ----------


async def test_enable_toolsets_reports_the_widening_when_the_notification_fails(mock_client):
    state = _default_state()
    ctx, session = _tool_ctx(mock_client, state)
    session.send_tool_list_changed.side_effect = RuntimeError("transport closed")
    out = await _call(ctx, [AUTONOMOUS])
    assert "error" not in out
    assert out["loaded"] == [DEFAULT, AUTONOMOUS]
    assert out["added_count"] == len(tools_in_toolset(AUTONOMOUS) - default_hand()) > 0
    assert out["list_changed_sent"] is False
    assert "list" in out["_hint"].lower()  # tells the client to re-list by hand
    assert state.toolset_hand == resolve_hand([DEFAULT, AUTONOMOUS])
    session.send_tool_list_changed.assert_awaited_once()


# ---------- whitespace: the tool strips like the env parser ----------


def test_validate_toolset_ids_strips_whitespace_like_the_env_parser():
    from valaris_mcp.toolsets import validate_toolset_ids

    assert validate_toolset_ids([" cards ", "notes"]) == ["cards", "notes"]
    assert validate_toolset_ids([" all "]) is None


def test_widen_strips_whitespace_around_ids():
    state = _default_state()
    state.widen([" boards"])
    assert state.toolset_ids == [DEFAULT, "boards"]


async def test_enable_toolsets_accepts_ids_with_surrounding_whitespace(mock_client):
    state = _default_state()
    ctx, _ = _tool_ctx(mock_client, state)
    out = await _call(ctx, [" cards"])
    assert "error" not in out, out
    assert out["loaded"] == [DEFAULT, "cards"]


@pytest.mark.parametrize("repeat", [False, True])
async def test_enable_toolsets_reports_unverified_client_catalog_and_exact_restart_env(mock_client, repeat):
    ctx, session = _tool_ctx(mock_client, _default_state())
    first = await _call(ctx, [AUTONOMOUS])
    out = await _call(ctx, [AUTONOMOUS]) if repeat else first

    assert out["client_catalog_status"] == "unverified"
    assert out["restart_env"] == {TOOLSETS_ENV: f"{DEFAULT},{AUTONOMOUS}"}
    hint = out["_hint"].lower()
    assert "client" in hint and "refresh" in hint
    assert "restart" in hint and "session" in hint
    assert "allowlist" in hint
    session.send_tool_list_changed.assert_awaited_once()


async def test_enable_toolsets_restart_env_keeps_all_and_never_replaces_allowlist(mock_client):
    allowlist = frozenset({TOOL, "get_card"})
    ctx, _ = _tool_ctx(mock_client, _state(["start-here"], allowlist))
    out = await _call(ctx, [ALL])

    assert out["client_catalog_status"] == "unverified"
    assert out["restart_env"] == {TOOLSETS_ENV: ALL}
    assert ctx.request_context.lifespan_context.hand.allowlist == allowlist
    assert set(out["added_tools"]) <= allowlist


async def test_enable_toolsets_failed_notification_retains_client_recovery_instructions(mock_client):
    ctx, session = _tool_ctx(mock_client, _default_state())
    session.send_tool_list_changed.side_effect = RuntimeError("transport closed")
    out = await _call(ctx, [AUTONOMOUS])

    assert out["list_changed_sent"] is False
    assert out["client_catalog_status"] == "unverified"
    assert out["restart_env"] == {TOOLSETS_ENV: f"{DEFAULT},{AUTONOMOUS}"}
    assert "restart" in out["_hint"].lower()
