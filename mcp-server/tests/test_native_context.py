# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The harness and its tool-call id reach the invocation outcome, end to end."""

import hashlib
import uuid
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from mcp.server.fastmcp import FastMCP
from mcp.shared.memory import create_connected_server_and_client_session
from mcp.types import Implementation, RequestParams

from valaris_mcp import server as server_module
from valaris_mcp.native_context import arguments_fingerprint, native_context

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend():
    return "asyncio"


def meta(**values):
    return RequestParams.Meta(**values)


def client_info(name, version="1.0.0"):
    return SimpleNamespace(name=name, version=version)


@pytest.mark.parametrize(
    "name,harness",
    [
        ("claude-code", "claude_code"),
        ("codex-mcp-client", "codex_cli"),
        # pi-mcp-adapter names its client after the configured server.
        ("pi-mcp-valaris", "pi_cli"),
        ("pi-mcp-backplane-prod", "pi_cli"),
        # The other Pi MCP extensions.
        ("pi-mcp", "pi_cli"),
        ("pi", "pi_cli"),
        ("pi-mcpx", None),
        ("some-new-agent", None),
    ],
)
def test_harness_comes_from_client_info(name, harness):
    context = native_context(client_info(name, "9.9.9"), None)
    context.pop("arguments_fingerprint", None)
    assert context == {
        "harness": harness,
        "native_call_id": None,
        "client_name": name,
        "client_version": "9.9.9",
    }


def test_claude_tool_use_id_is_the_native_call_id():
    context = native_context(
        client_info("claude-code"), meta(**{"claudecode/toolUseId": "toolu_01ABCdef"})
    )
    assert context["native_call_id"] == "toolu_01ABCdef"


def test_codex_call_id_is_the_native_call_id():
    context = native_context(
        client_info("codex-mcp-client"),
        meta(callId="call_7Hq2xYz", threadId="019a-thread", **{"x-codex-turn-metadata": {}}),
    )
    assert context["native_call_id"] == "call_7Hq2xYz"


def test_pi_tool_call_id_is_the_native_call_id():
    context = native_context(
        client_info("pi-mcp-valaris"),
        meta(**{"pi-mcp-adapter/toolCallId": "toolu_01Pi", "pi-mcp-adapter/stream-token": "s"}),
        {"card_id": "c1"},
    )
    assert context["harness"] == "pi_cli"
    assert context["native_call_id"] == "toolu_01Pi"
    # An exact id needs no fuzzy fallback.
    assert "arguments_fingerprint" not in context


# Pi on OpenAI's Responses API joins the call id and the item id with `|`,
# and the item id alone can run to hundreds of characters.
OPENAI_PI_CALL_ID = "call_" + "A1b2" * 6 + "|fc_" + "0123456789abcdef" * 26


# github-copilot, openai-codex and opencode item ids carry base64 (+, /, =).
BASE64_PI_CALL_ID = "call_" + "A1b2" * 6 + "|fc_" + "ab+/cd==" * 55


@pytest.mark.parametrize("short", ["call_abc123|fc_def456", "call_x|fc_ab+/cd=="])
def test_pi_openai_call_ids_with_a_pipe_are_kept(short):
    context = native_context(
        client_info("pi-mcp-valaris"), meta(**{"pi-mcp-adapter/toolCallId": short})
    )
    assert context["native_call_id"] == short


@pytest.mark.parametrize("long_id", [OPENAI_PI_CALL_ID, BASE64_PI_CALL_ID])
def test_call_ids_over_the_backend_limit_become_a_stable_hash(long_id):
    assert len(long_id) > 400
    context = native_context(
        client_info("pi-mcp-valaris"),
        meta(**{"pi-mcp-adapter/toolCallId": long_id}),
    )
    # Must equal the backend's app/core/harness.py native_call_key.
    assert context["native_call_id"] == ("sha256:" + hashlib.sha256(long_id.encode()).hexdigest())


def test_pi_without_a_call_id_carries_an_arguments_fingerprint():
    arguments = {"workspace_slug": "default", "card_id": "c1"}
    context = native_context(client_info("pi-mcp-valaris"), None, arguments)
    assert context["native_call_id"] is None
    assert context["arguments_fingerprint"] == arguments_fingerprint(arguments)


@pytest.mark.parametrize("name", ["claude-code", "codex-mcp-client", "some-new-agent"])
def test_only_harnesses_without_call_ids_carry_a_fingerprint(name):
    assert "arguments_fingerprint" not in native_context(client_info(name), None, {"a": "b"})


# Metadata-level records replace each string with this digest, so both
# sides fingerprint digests.
GO_DIGEST_DEFAULT = "[omitted 7 bytes sha256:37a8eec1ce19687d]"
GO_DIGEST_MULTIBYTE = "[omitted 9 bytes sha256:a7e46d54289812af]"
# A pinned vector: every consumer must compute the same fingerprint.
FINGERPRINT_VECTOR = {"workspace_slug": "default", "limit": 3.0, "tags": ["café ☕"], "on": True}
FINGERPRINT_VECTOR_HEX = "d43be8d9f336a5426084a52327e8ff033765899ca98f2007d59f6f0d4217a079"


def test_fingerprint_matches_the_metadata_digest():
    digested = {
        "workspace_slug": GO_DIGEST_DEFAULT,
        "limit": 3,
        "tags": [GO_DIGEST_MULTIBYTE],
        "on": True,
    }
    # Plain and metadata-level arguments are the same call.
    assert arguments_fingerprint(FINGERPRINT_VECTOR) == arguments_fingerprint(digested)
    assert arguments_fingerprint(FINGERPRINT_VECTOR) == FINGERPRINT_VECTOR_HEX


@pytest.mark.parametrize(
    "other",
    [
        {"workspace_slug": "other", "limit": 3, "tags": ["café ☕"], "on": True},
        {"workspace_slug": "default", "limit": 4, "tags": ["café ☕"], "on": True},
        {"workspace_slug": "default", "limit": 3, "tags": ["café ☕"]},
    ],
)
def test_fingerprint_tells_different_arguments_apart(other):
    assert arguments_fingerprint(other) != arguments_fingerprint(FINGERPRINT_VECTOR)


def test_fingerprint_ignores_key_order_and_integral_floats():
    assert arguments_fingerprint({"a": 1, "b": "x"}) == arguments_fingerprint({"b": "x", "a": 1.0})
    assert arguments_fingerprint(None) == arguments_fingerprint({})


@pytest.mark.parametrize(
    "name,values",
    [
        # Another harness's key is never trusted.
        ("claude-code", {"callId": "call_1"}),
        ("codex-mcp-client", {"claudecode/toolUseId": "toolu_1"}),
        ("pi-mcp-valaris", {"callId": "call_1"}),
        ("claude-code", {"pi-mcp-adapter/toolCallId": "toolu_1"}),
        # Unknown clients never contribute a call id.
        ("some-new-agent", {"callId": "call_1"}),
        # Values the backend would reject are dropped, not sent.
        ("claude-code", {"claudecode/toolUseId": "has space"}),
        ("claude-code", {"claudecode/toolUseId": "x" * 4097}),
        ("claude-code", {"claudecode/toolUseId": 42}),
    ],
)
def test_only_the_harness_key_with_a_valid_id_counts(name, values):
    assert native_context(client_info(name), meta(**values))["native_call_id"] is None


def test_client_text_is_bounded_and_storable():
    context = native_context(client_info("x" * 300 + "\x00", "v\ud800" + "1" * 100), None)
    assert context["client_name"] == "x" * 200
    assert context["client_version"] == "v" + "1" * 63
    assert native_context(None, None) == {
        "harness": None,
        "native_call_id": None,
        "client_name": None,
        "client_version": None,
    }


# --- over the MCP protocol, through the production lifespan and wrapper --------


@pytest.fixture
def recorded(monkeypatch):
    """A real FastMCP server with the production lifespan; returns the posted outcomes."""
    posted = []

    async def acknowledge(path, body):
        posted.append(body)
        return {"id": body["id"]}

    backend = AsyncMock()
    backend.post.side_effect = acknowledge
    monkeypatch.setattr(server_module, "ValarisClient", lambda: backend)
    monkeypatch.delenv("VALARIS_MCP_ALLOWLIST", raising=False)
    monkeypatch.setenv("VALARIS_MCP_TOOLSETS", "all")
    instance = FastMCP("native-context-test", lifespan=server_module.app_lifespan)

    async def echo(text: str) -> str:
        return text

    instance.add_tool(echo)
    return instance, posted


@pytest.mark.parametrize(
    "name,request_meta,harness,call_id",
    [
        ("claude-code", {"claudecode/toolUseId": "toolu_01Proto"}, "claude_code", "toolu_01Proto"),
        (
            "codex-mcp-client",
            {"callId": "call_proto", "threadId": "t1"},
            "codex_cli",
            "call_proto",
        ),
        (
            "pi-mcp-valaris",
            {"pi-mcp-adapter/toolCallId": "toolu_pi", "pi-mcp-adapter/stream-token": "t"},
            "pi_cli",
            "toolu_pi",
        ),
        ("inspector", None, None, None),
    ],
)
async def test_protocol_call_records_native_context(
    recorded, name, request_meta, harness, call_id
):
    instance, posted = recorded
    async with create_connected_server_and_client_session(
        instance, client_info=Implementation(name=name, version="2.1.0")
    ) as session:
        result = await session.call_tool("echo", {"text": "hi"}, meta=request_meta)
    assert result.content[0].text == "hi"
    [outcome] = posted
    assert outcome["tool_name"] == "echo"
    assert outcome["harness"] == harness
    assert outcome["native_call_id"] == call_id
    assert outcome["client_name"] == name
    assert outcome["client_version"] == "2.1.0"
    assert outcome["server_instance_id"] == server_module.SERVER_INSTANCE_ID
    uuid.UUID(outcome["server_instance_id"])
    assert "arguments_fingerprint" not in outcome


async def test_protocol_call_from_pi_without_call_id_records_a_fingerprint(recorded):
    instance, posted = recorded
    async with create_connected_server_and_client_session(
        instance, client_info=Implementation(name="pi-mcp-valaris", version="1.0.0")
    ) as session:
        await session.call_tool("echo", {"text": "hi"})
    [outcome] = posted
    assert outcome["harness"] == "pi_cli"
    assert outcome["native_call_id"] is None
    assert outcome["arguments_fingerprint"] == arguments_fingerprint({"text": "hi"})


async def test_protocol_calls_share_one_server_instance_id(recorded):
    instance, posted = recorded
    async with create_connected_server_and_client_session(instance) as session:
        await session.call_tool("echo", {"text": "a"})
        await session.call_tool("echo", {"text": "b"})
    assert len({outcome["id"] for outcome in posted}) == 2
    assert len({outcome["server_instance_id"] for outcome in posted}) == 1


def test_only_reachable_harnesses_have_call_id_keys():
    from valaris_mcp.native_context import (
        CALL_ID_META_KEYS,
        CLIENT_HARNESS_PREFIXES,
        CLIENT_HARNESSES,
    )

    reachable = set(CLIENT_HARNESSES.values()) | set(CLIENT_HARNESS_PREFIXES.values())
    assert set(CALL_ID_META_KEYS) == reachable
