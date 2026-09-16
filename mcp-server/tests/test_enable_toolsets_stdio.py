# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""What the wire says about `enable_toolsets` (MCP #6), over real stdio.

Spawns the installed `backplane-mcp` entry point against a closed backend
port and drives it with the MCP client: the handshake advertises
`tools.listChanged`, the initial listing is the default hand, widening emits
one `notifications/tools/list_changed` and the re-listed set is the widened
hand, a denied tool becomes callable, and a runner allowlist stays the
ceiling of everything listed.

Spawn the entry point, never `python -m valaris_mcp.server`: that double-
imports the package and trips the catalog coverage check.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

import anyio
import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.types import ServerNotification, ToolListChangedNotification

from valaris_mcp.toolsets import DEFAULT, default_hand, resolve_hand, tools_in_toolset

pytestmark = pytest.mark.anyio

MCP_SERVER_DIR = Path(__file__).resolve().parents[1]
# The console script installs next to the interpreter running the tests: the
# repo .venv locally, /usr/local/bin in the Cloud Build image (plain pip, no
# .venv).
ENTRY_POINT = Path(sys.executable).with_name("backplane-mcp")
if not ENTRY_POINT.exists():
    ENTRY_POINT = Path(shutil.which("backplane-mcp") or ENTRY_POINT)
TOOL = "enable_toolsets"
AUTONOMOUS = "autonomous-operations"
DENIAL = "tool_not_allowed"
# No pytest-timeout in this venv: every probe is bounded by hand.
PROBE_TIMEOUT_S = 30
NOTIFICATION_TIMEOUT_S = 5


def _params(env: dict[str, str]) -> StdioServerParameters:
    base = {
        "PATH": os.environ["PATH"],
        "VALARIS_API_URL": "http://127.0.0.1:9",  # closed port: backend unreachable on purpose
        "VALARIS_API_KEY": "vlr_probe",
    }
    base.update(env)
    return StdioServerParameters(
        command=str(ENTRY_POINT), args=[], env=base, cwd=str(MCP_SERVER_DIR)
    )


class _ListChangedCollector:
    """message_handler capturing every tools/list_changed the server sends."""

    def __init__(self) -> None:
        self.count = 0
        self.arrived = anyio.Event()

    async def __call__(self, message) -> None:
        if isinstance(message, ServerNotification) and isinstance(
            message.root, ToolListChangedNotification
        ):
            self.count += 1
            self.arrived.set()


async def _names(session: ClientSession) -> set[str]:
    return {tool.name for tool in (await session.list_tools()).tools}


async def _call_text(session: ClientSession, name: str, arguments: dict) -> str:
    result = await session.call_tool(name, arguments)
    return "".join(content.text for content in result.content if getattr(content, "text", None))


async def test_handshake_advertises_tool_list_changed_over_stdio():
    with anyio.fail_after(PROBE_TIMEOUT_S):
        async with stdio_client(_params({})) as (read, write):
            async with ClientSession(read, write) as session:
                init = await session.initialize()
                assert init.capabilities.tools is not None
                assert init.capabilities.tools.listChanged is True


async def test_default_session_widens_notifies_once_and_relists_the_wider_hand():
    collector = _ListChangedCollector()
    with anyio.fail_after(PROBE_TIMEOUT_S):
        async with stdio_client(_params({})) as (read, write):
            async with ClientSession(read, write, message_handler=collector) as session:
                await session.initialize()

                initial = await _names(session)
                assert initial == default_hand()
                assert TOOL in initial

                denied = await _call_text(session, "list_agents", {"workspace_slug": "ws"})
                assert DENIAL in denied

                out = json.loads(await _call_text(session, TOOL, {"toolset_ids": [AUTONOMOUS]}))
                assert "error" not in out, out
                assert out["loaded"] == [DEFAULT, AUTONOMOUS]
                assert out["added_tools"] == sorted(tools_in_toolset(AUTONOMOUS) - default_hand())
                assert out["list_changed_sent"] is True

                with anyio.fail_after(NOTIFICATION_TIMEOUT_S):
                    await collector.arrived.wait()
                assert collector.count == 1

                widened = await _names(session)
                assert widened == resolve_hand([DEFAULT, AUTONOMOUS])
                assert len(widened) == out["enabled_tool_count"]

                # Past the gate now; the closed backend port is the only thing left to fail.
                allowed = await _call_text(session, "list_agents", {"workspace_slug": "ws"})
                assert DENIAL not in allowed

                # Widen-only: the same request again grows nothing and stays silent.
                again = json.loads(await _call_text(session, TOOL, {"toolset_ids": [AUTONOMOUS]}))
                assert again["added_count"] == 0
                assert again["list_changed_sent"] is False
                await anyio.sleep(0.2)
                assert collector.count == 1


async def test_unknown_toolset_over_stdio_is_the_house_error_and_widens_nothing():
    collector = _ListChangedCollector()
    with anyio.fail_after(PROBE_TIMEOUT_S):
        async with stdio_client(_params({})) as (read, write):
            async with ClientSession(read, write, message_handler=collector) as session:
                await session.initialize()
                out = json.loads(await _call_text(session, TOOL, {"toolset_ids": ["bogus"]}))
                assert out["error"] is True
                assert "bogus" in out["message"]
                assert await _names(session) == default_hand()
                await anyio.sleep(0.2)
                assert collector.count == 0


async def test_runner_allowlist_stays_the_ceiling_after_widening():
    allowlist = {"get_card", TOOL}
    env = {
        "VALARIS_MCP_ALLOWLIST": ",".join(sorted(allowlist)),
        "VALARIS_MCP_TOOLSETS": "start-here",
    }
    collector = _ListChangedCollector()
    with anyio.fail_after(PROBE_TIMEOUT_S):
        async with stdio_client(_params(env)) as (read, write):
            async with ClientSession(read, write, message_handler=collector) as session:
                await session.initialize()
                # get_card is outside start-here: only the widener itself is listed.
                assert await _names(session) == {TOOL}

                out = json.loads(await _call_text(session, TOOL, {"toolset_ids": ["cards"]}))
                assert "error" not in out, out
                assert out["added_tools"] == ["get_card"]
                assert out["allowlist_clipped"] == sorted(tools_in_toolset("cards") - allowlist)
                assert out["enabled_tool_count"] == len(allowlist)
                assert out["list_changed_sent"] is True

                with anyio.fail_after(NOTIFICATION_TIMEOUT_S):
                    await collector.arrived.wait()
                assert await _names(session) == allowlist

                # Even `all` cannot lift the allowlist.
                out = json.loads(await _call_text(session, TOOL, {"toolset_ids": ["all"]}))
                assert out["loaded"] == ["all"]
                assert out["added_count"] == 0
                assert await _names(session) <= allowlist
                denied = await _call_text(session, "move_card", {"workspace_slug": "ws"})
                assert DENIAL in denied


async def test_static_client_recovers_added_tools_on_initial_listing_after_restart():
    # A static client keeps its original catalog even after the server notifies.
    # Its recovery must retain the widened selection across a new MCP process.
    with anyio.fail_after(PROBE_TIMEOUT_S):
        async with stdio_client(_params({})) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                cached_catalog = await _names(session)
                assert "list_agents" not in cached_catalog
                first = json.loads(await _call_text(session, TOOL, {"toolset_ids": [AUTONOMOUS]}))
                repeated = json.loads(await _call_text(session, TOOL, {"toolset_ids": [AUTONOMOUS]}))
                assert first["list_changed_sent"] is True
                assert repeated["list_changed_sent"] is False
                assert repeated["client_catalog_status"] == "unverified"
                assert repeated["restart_env"] == {
                    "VALARIS_MCP_TOOLSETS": f"{DEFAULT},{AUTONOMOUS}"
                }
                assert "list_agents" not in cached_catalog

        async with stdio_client(_params(repeated["restart_env"])) as (read, write):
            async with ClientSession(read, write) as session:
                await session.initialize()
                initial = await _names(session)
                assert initial == resolve_hand([DEFAULT, AUTONOMOUS])
                assert "list_agents" in initial
                allowed = await _call_text(session, "list_agents", {"workspace_slug": "ws"})
                assert DENIAL not in allowed
