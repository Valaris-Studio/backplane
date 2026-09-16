# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Audit T03: `main()` under MCP_TRANSPORT=streamable-http.

`FastMCP.run(transport, mount_path)` takes no host/port kwargs on any mcp 1.x
release; the SDK reads them from `mcp.settings` (`run_streamable_http_async`
builds `uvicorn.Config(host=self.settings.host, port=self.settings.port)`).
Passing host/port to `run()` raises TypeError before the server ever listens.

The fake `run` below mirrors the REAL keyword-only signature on purpose: a
`**kwargs` stand-in would swallow the exact kwargs the SDK rejects and hide
the defect.
"""
from __future__ import annotations

import pytest

import valaris_mcp.server as server_module

STREAMABLE_HTTP = "streamable-http"
STDIO = "stdio"


@pytest.fixture
def restore_transport_settings():
    # `mcp.settings` is a process-wide singleton: main() mutating host/port
    # must not leak into the rest of the suite.
    settings = server_module.mcp.settings
    saved_host, saved_port = settings.host, settings.port
    yield settings
    settings.host = saved_host
    settings.port = saved_port


@pytest.fixture
def run_calls(monkeypatch, restore_transport_settings):
    calls: list[dict] = []

    # Same signature as `FastMCP.run(self, transport="stdio", mount_path=None)`
    # minus `self` (patched on the instance): unknown kwargs raise exactly as
    # the SDK does.
    def fake_run(transport=STDIO, mount_path=None):
        calls.append({"transport": transport, "mount_path": mount_path})

    monkeypatch.setattr(server_module.mcp, "run", fake_run)
    return calls


@pytest.fixture
def clean_transport_env(monkeypatch):
    for name in (
        "MCP_TRANSPORT",
        "MCP_HOST",
        "MCP_PORT",
        # main() validates these first; unset so the transport branch is reached.
        "VALARIS_MCP_TOOLSETS",
        "VALARIS_MCP_ALLOWLIST",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("VALARIS_API_URL", "http://127.0.0.1:9")
    monkeypatch.setenv("VALARIS_API_KEY", "vlr_synthetic_not_a_real_key")


def _only_run_call(calls: list[dict]) -> dict:
    assert len(calls) == 1, calls
    call = calls[0]
    # mount_path is not part of the contract either way; only the transport is.
    return {"transport": call["transport"]}


def test_main_streamable_http_configures_settings_then_runs_without_host_port_kwargs(
    monkeypatch, clean_transport_env, run_calls, restore_transport_settings
):
    monkeypatch.setenv("MCP_TRANSPORT", STREAMABLE_HTTP)
    monkeypatch.setenv("MCP_HOST", "127.0.0.1")
    monkeypatch.setenv("MCP_PORT", "23991")

    server_module.main()

    assert _only_run_call(run_calls) == {"transport": STREAMABLE_HTTP}
    assert restore_transport_settings.host == "127.0.0.1"
    assert restore_transport_settings.port == 23991
    assert isinstance(restore_transport_settings.port, int)


def test_main_streamable_http_defaults_host_and_port(
    monkeypatch, clean_transport_env, run_calls, restore_transport_settings
):
    # Documented defaults (README / docs): bind every interface on 8001.
    monkeypatch.setenv("MCP_TRANSPORT", STREAMABLE_HTTP)

    server_module.main()

    assert _only_run_call(run_calls) == {"transport": STREAMABLE_HTTP}
    assert restore_transport_settings.host == "0.0.0.0"
    assert restore_transport_settings.port == 8001


def test_main_stdio_is_default_and_unchanged(
    clean_transport_env, run_calls, restore_transport_settings
):
    saved_host, saved_port = restore_transport_settings.host, restore_transport_settings.port

    server_module.main()

    assert _only_run_call(run_calls) == {"transport": STDIO}
    assert restore_transport_settings.host == saved_host
    assert restore_transport_settings.port == saved_port


def test_main_unknown_transport_falls_back_to_stdio(
    monkeypatch, clean_transport_env, run_calls, restore_transport_settings
):
    # Pins current behaviour: an unrecognised MCP_TRANSPORT silently means
    # stdio. Whether it should error instead is a separate decision.
    monkeypatch.setenv("MCP_TRANSPORT", "carrier-pigeon")
    saved_host, saved_port = restore_transport_settings.host, restore_transport_settings.port

    server_module.main()

    assert _only_run_call(run_calls) == {"transport": STDIO}
    assert restore_transport_settings.host == saved_host
    assert restore_transport_settings.port == saved_port
