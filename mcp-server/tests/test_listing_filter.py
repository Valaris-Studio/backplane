# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The allowlist filters `tools/list`, not just `tools/call`.

A model whose hand is 5 tools should be told about 5 tools: every unlisted
schema is dead context, and a tool it can see but cannot call reads as a
server bug. Built against fresh FastMCP instances because `install_allowlist`
patches the manager in place and the singleton `mcp` is shared across the
suite.
"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from mcp.server.fastmcp import FastMCP

from valaris_mcp.allowlist import install_allowlist, listed_tools, load_allowlist

pytestmark = pytest.mark.anyio


def _three_tool_server() -> FastMCP:
    server = FastMCP("t")

    @server.tool()
    def alpha(value: str) -> str:
        """Alpha."""
        return f"alpha:{value}"

    @server.tool()
    def beta(value: str) -> str:
        """Beta."""
        return f"beta:{value}"

    @server.tool()
    def gamma(value: str) -> str:
        """Gamma."""
        return f"gamma:{value}"

    return server


async def _listed_names(server: FastMCP) -> list[str]:
    return [tool.name for tool in await server.list_tools()]


# ---------- listing ----------


async def test_listing_returns_exactly_the_allowlisted_tools():
    server = _three_tool_server()
    install_allowlist(server, frozenset({"alpha", "gamma"}))
    assert await _listed_names(server) == ["alpha", "gamma"]


async def test_listing_preserves_registration_order():
    server = _three_tool_server()
    install_allowlist(server, frozenset({"gamma", "beta"}))
    assert await _listed_names(server) == ["beta", "gamma"]


async def test_listing_ignores_allowlist_entries_that_are_not_registered():
    server = _three_tool_server()
    install_allowlist(server, frozenset({"alpha", "no_such_tool"}))
    assert await _listed_names(server) == ["alpha"]


async def test_deny_all_sentinel_lists_nothing():
    # The runner's `__none__` sentinel parses as a one-element allowlist that
    # matches no tool: an empty hand, not an unrestricted one.
    server = _three_tool_server()
    install_allowlist(server, frozenset({"__none__"}))
    assert await _listed_names(server) == []


async def test_no_allowlist_lists_everything():
    server = _three_tool_server()
    install_allowlist(server, None)
    assert await _listed_names(server) == ["alpha", "beta", "gamma"]


async def test_listing_filter_does_not_shrink_the_registry():
    # get_server_info reports the full surface from `_tools`; the filter must
    # wrap listing, not delete registrations.
    server = _three_tool_server()
    install_allowlist(server, frozenset({"alpha"}))
    assert sorted(server._tool_manager._tools) == ["alpha", "beta", "gamma"]


# ---------- the call gate is unchanged ----------


async def test_call_gate_still_denies_unlisted_tool():
    server = _three_tool_server()
    install_allowlist(server, frozenset({"alpha"}))
    with pytest.raises(PermissionError):
        await server._tool_manager.call_tool("beta", {"value": "x"})


async def test_call_gate_still_allows_listed_tool():
    server = _three_tool_server()
    install_allowlist(server, frozenset({"alpha"}))
    assert await server._tool_manager.call_tool("alpha", {"value": "x"}) == "alpha:x"


async def test_deny_all_sentinel_denies_every_call():
    server = _three_tool_server()
    install_allowlist(server, frozenset({"__none__"}))
    with pytest.raises(PermissionError):
        await server._tool_manager.call_tool("alpha", {"value": "x"})


# ---------- listed_tools pure helper ----------


def _named(*names: str) -> list[SimpleNamespace]:
    return [SimpleNamespace(name=name) for name in names]


def test_listed_tools_none_returns_all_in_order():
    tools = _named("c", "a", "b")
    assert listed_tools(tools, None) == tools


def test_listed_tools_filters_preserving_order():
    tools = _named("c", "a", "b")
    assert [t.name for t in listed_tools(tools, frozenset({"b", "c"}))] == ["c", "b"]


def test_listed_tools_accepts_any_iterable():
    tools = _named("a", "b")
    assert [t.name for t in listed_tools(iter(tools), frozenset({"b"}))] == ["b"]


def test_listed_tools_deny_all_sentinel_returns_empty_list():
    assert listed_tools(_named("a", "b"), frozenset({"__none__"})) == []


def test_listed_tools_returns_a_list_not_the_input_object():
    tools = tuple(_named("a"))
    assert listed_tools(tools, None) == list(tools)
    assert isinstance(listed_tools(tools, None), list)


# ---------- env → listing, with real tool functions ----------


async def test_env_allowlist_filters_listing_of_real_tools(monkeypatch):
    from valaris_mcp.tools.cards import create_card, get_card, move_card

    monkeypatch.setenv("VALARIS_MCP_ALLOWLIST", "get_card,move_card")
    server = FastMCP("t")
    for fn in (get_card, move_card, create_card):
        server.add_tool(fn)

    install_allowlist(server, load_allowlist())

    assert set(await _listed_names(server)) == {"get_card", "move_card"}
    with pytest.raises(PermissionError):
        await server._tool_manager.call_tool("create_card", {})
