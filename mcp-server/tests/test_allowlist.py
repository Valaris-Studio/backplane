# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tests for server-side MCP tool allowlist enforcement.

Design: docs/pipeline-design/05-mcp-allowlist-enforcement.md §3.

Threat model: under `dangerously_skip_permissions: true`, claude-cli ignores
its own `--allowedTools` flag. The runner-side dynamic `--mcp-config`
injects `VALARIS_MCP_ALLOWLIST` into the MCP server process env; the server
turns that into a hard gate on `_tool_manager.call_tool`.

Back-compat: missing env, empty env, or empty parsed list = no restriction
(preserves MCP Inspector / manual claude session behaviour).
"""
from __future__ import annotations

import json
import logging
from unittest.mock import AsyncMock

import pytest

from valaris_mcp.allowlist import install_allowlist, load_allowlist

pytestmark = pytest.mark.anyio


# ---------- load_allowlist (env parsing) ----------


def test_allowlist_load_no_env_returns_none(monkeypatch):
    monkeypatch.delenv("VALARIS_MCP_ALLOWLIST", raising=False)
    assert load_allowlist() is None


def test_allowlist_load_empty_string_returns_none(monkeypatch):
    monkeypatch.setenv("VALARIS_MCP_ALLOWLIST", "")
    assert load_allowlist() is None


def test_allowlist_load_whitespace_only_returns_none(monkeypatch):
    monkeypatch.setenv("VALARIS_MCP_ALLOWLIST", "   ")
    assert load_allowlist() is None


def test_allowlist_load_parses_comma_list(monkeypatch):
    monkeypatch.setenv("VALARIS_MCP_ALLOWLIST", "get_card,create_note")
    assert load_allowlist() == frozenset({"get_card", "create_note"})


def test_allowlist_load_strips_whitespace(monkeypatch):
    monkeypatch.setenv("VALARIS_MCP_ALLOWLIST", " get_card , create_note ")
    assert load_allowlist() == frozenset({"get_card", "create_note"})


def test_allowlist_load_rejects_malformed_token_raises(monkeypatch):
    monkeypatch.setenv("VALARIS_MCP_ALLOWLIST", "get_card,!!bad!!")
    with pytest.raises(RuntimeError, match="invalid tool names"):
        load_allowlist()


def test_allowlist_load_wildcard_returns_none(monkeypatch):
    # `*` is the universal "allow all" token. Operators (and hand-written
    # run.sh / .mcp.json templates) reach for it to mean "no restriction".
    # It must map to None, not crash the server on the tool-name regex.
    monkeypatch.setenv("VALARIS_MCP_ALLOWLIST", "*")
    assert load_allowlist() is None


def test_allowlist_load_wildcard_with_whitespace_returns_none(monkeypatch):
    monkeypatch.setenv("VALARIS_MCP_ALLOWLIST", "  *  ")
    assert load_allowlist() is None


def test_allowlist_load_wildcard_among_tokens_returns_none(monkeypatch):
    # If `*` appears anywhere in the list, the operator intent is "everything";
    # honour the wildcard rather than rejecting it as a malformed tool name.
    monkeypatch.setenv("VALARIS_MCP_ALLOWLIST", "get_card,*,create_note")
    assert load_allowlist() is None


# ---------- install_allowlist (call_tool gating) ----------


class _FakeToolManager:
    def __init__(self, call_tool):
        self.call_tool = call_tool


class _FakeServer:
    def __init__(self, call_tool):
        self._tool_manager = _FakeToolManager(call_tool)


async def test_install_allowlist_none_is_noop():
    original = AsyncMock(return_value="ok")
    server = _FakeServer(original)
    install_allowlist(server, None)
    assert server._tool_manager.call_tool is original


async def test_install_allowlist_permits_listed_tool():
    original = AsyncMock(return_value="ok")
    server = _FakeServer(original)
    install_allowlist(server, frozenset({"get_card"}))

    result = await server._tool_manager.call_tool("get_card", {"workspace_slug": "x"})
    assert result == "ok"
    original.assert_awaited_once_with("get_card", {"workspace_slug": "x"})


async def test_install_allowlist_denies_unlisted_tool_raises_permissionerror():
    original = AsyncMock(return_value="ok")
    server = _FakeServer(original)
    install_allowlist(server, frozenset({"get_card"}))

    with pytest.raises(PermissionError) as excinfo:
        await server._tool_manager.call_tool("create_card", {"workspace_slug": "x"})

    payload = json.loads(str(excinfo.value))
    assert payload == {
        "error": "tool_not_allowed",
        "tool": "create_card",
        "allowlist": ["get_card"],
    }
    original.assert_not_called()


async def test_install_allowlist_denial_payload_sorts_allowlist():
    original = AsyncMock(return_value="ok")
    server = _FakeServer(original)
    install_allowlist(server, frozenset({"get_card", "create_note", "list_cards"}))

    with pytest.raises(PermissionError) as excinfo:
        await server._tool_manager.call_tool("create_card", {})

    payload = json.loads(str(excinfo.value))
    assert payload["allowlist"] == ["create_note", "get_card", "list_cards"]


async def test_install_allowlist_denial_logs_warning(caplog):
    original = AsyncMock(return_value="ok")
    server = _FakeServer(original)
    install_allowlist(server, frozenset({"get_card"}))

    with caplog.at_level(logging.WARNING, logger="valaris_mcp.allowlist"):
        with pytest.raises(PermissionError):
            await server._tool_manager.call_tool("create_card", {})

    denial_records = [
        r for r in caplog.records
        if r.levelno == logging.WARNING and "create_card" in r.getMessage()
    ]
    assert len(denial_records) == 1


# ---------- toolsets composition (MCP #2, card 176b4503) ----------
#
# Shape chosen for the toolset-aware seam: `install_allowlist(server, hand,
# toolsets=ids)` where `ids` is the configured list (e.g. ["cards"]) or None
# when no toolset filter is active. The denial payload gains a "toolsets" key
# only when ids is not None, so a denied model knows to ask for a wider hand.


def test_compose_hand_is_exported_by_the_allowlist_module():
    from valaris_mcp.allowlist import compose_hand

    assert compose_hand(None, None) is None
    assert compose_hand(frozenset({"a", "b"}), frozenset({"b", "c"})) == frozenset({"b"})
    assert compose_hand(frozenset({"a"}), None) == frozenset({"a"})
    assert compose_hand(None, frozenset({"a"})) == frozenset({"a"})


async def test_install_allowlist_denial_payload_names_active_toolsets():
    original = AsyncMock(return_value="ok")
    server = _FakeServer(original)
    install_allowlist(server, frozenset({"get_card"}), toolsets=["cards"])

    with pytest.raises(PermissionError) as excinfo:
        await server._tool_manager.call_tool("create_card", {"workspace_slug": "x"})

    payload = json.loads(str(excinfo.value))
    assert payload == {
        "error": "tool_not_allowed",
        "tool": "create_card",
        "allowlist": ["get_card"],
        "toolsets": ["cards"],
    }
    original.assert_not_called()


async def test_install_allowlist_denial_payload_omits_toolsets_when_none():
    original = AsyncMock(return_value="ok")
    server = _FakeServer(original)
    install_allowlist(server, frozenset({"get_card"}), toolsets=None)

    with pytest.raises(PermissionError) as excinfo:
        await server._tool_manager.call_tool("create_card", {})

    assert "toolsets" not in json.loads(str(excinfo.value))


async def test_install_allowlist_with_toolsets_still_permits_listed_tool():
    original = AsyncMock(return_value="ok")
    server = _FakeServer(original)
    install_allowlist(server, frozenset({"get_card"}), toolsets=["cards"])

    assert await server._tool_manager.call_tool("get_card", {"workspace_slug": "x"}) == "ok"
    original.assert_awaited_once_with("get_card", {"workspace_slug": "x"})
