# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Audit T03, end to end: the entry point actually serves streamable-http.

Spawns the installed `backplane-mcp` console script with
MCP_TRANSPORT=streamable-http on a free loopback port, waits for it to
listen, then drives it with the SDK's streamable-http client: initialize,
list tools, call `get_server_info`. That tool is locally computable and only
probes the backend best-effort (an unreachable API is reported under
`backend.reachable=false`, never an error result), so it is safe against the
closed port used here.

Spawn the entry point, never `python -m valaris_mcp.server`: that double-
imports the package and trips the catalog coverage check (see
test_enable_toolsets_stdio.py).

No pytest-timeout in this venv: every wait is bounded by hand.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import anyio
import pytest
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

pytestmark = pytest.mark.anyio

MCP_SERVER_DIR = Path(__file__).resolve().parents[1]
ENTRY_POINT = Path(sys.executable).with_name("backplane-mcp")
if not ENTRY_POINT.exists():
    ENTRY_POINT = Path(shutil.which("backplane-mcp") or ENTRY_POINT)

LISTEN_TIMEOUT_S = 20
PROBE_TIMEOUT_S = 30
SHUTDOWN_GRACE_S = 5
HOST = "127.0.0.1"


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind((HOST, 0))
        return probe.getsockname()[1]


def _port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(0.2)
        return probe.connect_ex((HOST, port)) == 0


def _spawn_http_server(port: int, log_path: Path) -> subprocess.Popen:
    env = {
        "PATH": os.environ["PATH"],
        "MCP_TRANSPORT": "streamable-http",
        "MCP_HOST": HOST,
        "MCP_PORT": str(port),
        "VALARIS_API_URL": "http://127.0.0.1:9",  # closed port: backend unreachable on purpose
        "VALARIS_API_KEY": "vlr_synthetic_not_a_real_key",
    }
    # A file, not a PIPE: uvicorn's access/lifespan logging must never fill a
    # pipe buffer and stall the server mid-test.
    log = log_path.open("wb")
    try:
        return subprocess.Popen(
            [str(ENTRY_POINT)],
            env=env,
            cwd=str(MCP_SERVER_DIR),
            stdout=log,
            stderr=subprocess.STDOUT,
        )
    finally:
        log.close()


def _log_tail(log_path: Path, lines: int = 25) -> str:
    return "\n".join(log_path.read_text(errors="replace").splitlines()[-lines:])


def _wait_until_listening(proc: subprocess.Popen, port: int, log_path: Path) -> None:
    deadline = time.monotonic() + LISTEN_TIMEOUT_S
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            pytest.fail(
                f"backplane-mcp exited with code {proc.returncode} before listening on "
                f"{HOST}:{port}; stderr tail:\n{_log_tail(log_path)}"
            )
        if _port_open(port):
            return
        time.sleep(0.1)
    proc.terminate()
    pytest.fail(
        f"backplane-mcp did not listen on {HOST}:{port} within {LISTEN_TIMEOUT_S}s; "
        f"stderr tail:\n{_log_tail(log_path)}"
    )


def _stop(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=SHUTDOWN_GRACE_S)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


def _text(result) -> str:
    return "".join(content.text for content in result.content if getattr(content, "text", None))


async def test_entry_point_serves_streamable_http_and_answers_get_server_info(tmp_path):
    assert ENTRY_POINT.exists(), f"console script not installed next to {sys.executable}"
    port = _free_port()
    log_path = tmp_path / "backplane-mcp.log"
    proc = _spawn_http_server(port, log_path)
    try:
        _wait_until_listening(proc, port, log_path)

        with anyio.fail_after(PROBE_TIMEOUT_S):
            async with streamablehttp_client(f"http://{HOST}:{port}/mcp") as (read, write, _):
                async with ClientSession(read, write) as session:
                    init = await session.initialize()
                    assert init.serverInfo.name == "Valaris"

                    tools = await session.list_tools()
                    assert len(tools.tools) >= 20
                    assert "get_server_info" in {tool.name for tool in tools.tools}

                    result = await session.call_tool("get_server_info", {})
                    assert result.isError is False, _text(result)
                    info = json.loads(_text(result))
                    assert "error" not in info, info
                    assert info["tool_count"] >= 20
                    # Best-effort backend probe against the closed port: flagged, not raised.
                    assert info["backend"]["reachable"] is False
    finally:
        _stop(proc)
