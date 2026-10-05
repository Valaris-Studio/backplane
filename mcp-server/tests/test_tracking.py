# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Canonical invocation outcomes, recorded off the tool call's hot path."""

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import anyio
import httpx
import pytest
from mcp.server.fastmcp import FastMCP
from mcp.types import CallToolResult, ImageContent, TextContent

from valaris_mcp.results import normalize_tool_result
from valaris_mcp.server import install_tracking
from valaris_mcp.tracking import InvocationRecorder

pytestmark = pytest.mark.anyio


def client():
    async def acknowledge(path, body):
        return {"id": body["id"]}

    return AsyncMock(post=AsyncMock(side_effect=acknowledge))


def bodies(api):
    for call in api.post.call_args_list:
        assert call.args[0] == "/me/mcp-invocations"
    api.get.assert_not_called()
    api.patch.assert_not_called()
    return [call.args[1] for call in api.post.call_args_list]


def invocation(api):
    rows = {body["id"]: body for body in bodies(api)}
    assert len(rows) == 1
    return next(iter(rows.values()))


@asynccontextmanager
async def started(api, **options):
    recorder = InvocationRecorder(api, server_instance_id="server-under-test", **options)
    async with recorder.running():
        yield recorder


async def record(recorder, name, arguments, result, error=None):
    call = recorder.begin(name, arguments)
    recorder.finish(call, result, error=error)
    await recorder.flush()
    return call


def wrapped(recorder, call_tool):
    server = SimpleNamespace(_tool_manager=SimpleNamespace(call_tool=call_tool))
    install_tracking(server, recorder)
    return server._tool_manager.call_tool


def http_error(status):
    request = httpx.Request("POST", "http://test/api/me/mcp-invocations")
    return httpx.HTTPStatusError(
        str(status), request=request, response=httpx.Response(status, request=request)
    )


# --- outcome content ---------------------------------------------------------


@pytest.mark.parametrize("names", [("get_board", "get_board"), ("get_board", "list_cards")])
async def test_interleaved_calls_keep_identity_timing_and_outcome(names):
    api = client()
    async with started(api) as recorder:
        first = recorder.begin(names[0], {"workspace_slug": "one"})
        second = recorder.begin(names[1], {"workspace_slug": "two"})
        assert first.id != second.id
        recorder.finish(first, '{"id":"first"}')
        recorder.finish(second, "boom", error=RuntimeError("boom"))
        await recorder.flush()
    rows = bodies(api)
    assert [body["id"] for body in rows] == [first.id, second.id]
    assert [body["tool_name"] for body in rows] == list(names)
    assert [body["workspace_slug"] for body in rows] == ["one", "two"]
    assert [body["status"] for body in rows] == ["completed", "failed"]
    assert rows[0]["started_at"] <= rows[1]["started_at"]
    assert all(body["duration_seconds"] >= 0 for body in rows)
    assert rows[1]["error_message"] == "boom"
    assert {body["server_instance_id"] for body in rows} == {"server-under-test"}


async def test_native_context_is_captured_at_call_start_and_posted_flat():
    api = client()
    contexts = iter(
        [
            {
                "harness": "claude_code",
                "native_call_id": "toolu_1",
                "client_name": "claude-code",
                "client_version": "2.1.0",
            },
            {},
        ]
    )
    async with started(api, native_context=lambda _arguments: next(contexts)) as recorder:
        await record(recorder, "get_card", {}, "{}")
        await record(recorder, "get_card", {}, "{}")
    native, plain = bodies(api)
    assert native["harness"] == "claude_code"
    assert native["native_call_id"] == "toolu_1"
    assert native["client_name"] == "claude-code"
    assert native["client_version"] == "2.1.0"
    assert "native_context" not in native
    assert "harness" not in plain and "native_call_id" not in plain


async def test_native_context_sees_the_call_arguments():
    api = client()
    seen = []

    def context(arguments):
        seen.append(arguments)
        return {"arguments_fingerprint": "f" * 64}

    async with started(api, native_context=context) as recorder:
        await record(recorder, "get_card", {"card_id": "c1"}, "{}")
    assert seen == [{"card_id": "c1"}]
    assert invocation(api)["arguments_fingerprint"] == "f" * 64


@pytest.mark.parametrize("name", ["list_workspaces", "get_server_info", "log_execution_start"])
async def test_calls_without_workspace_are_recorded(name):
    api = client()
    async with started(api) as recorder:
        await record(recorder, name, {}, "[]")
    body = invocation(api)
    assert body["workspace_slug"] is None
    assert body["tool_name"] == name
    assert body["status"] == "completed"
    assert api.post.await_count == 1


ERROR = '{"error":true,"status":422,"message":"missing PR","error_code":"pr_url_missing"}'
TEXT = TextContent(type="text", text=ERROR)
IMAGE = ImageContent(type="image", data="aGk=", mimeType="image/png")


@pytest.mark.parametrize(
    "result,summary,status",
    [
        (ERROR, ERROR, "failed"),
        ([TEXT], ERROR, "failed"),
        (([TEXT], {"result": ERROR}), ERROR, "failed"),
        (CallToolResult(content=[TEXT]), ERROR, "failed"),
        (CallToolResult(content=[], isError=True), None, "failed"),
        (
            [TextContent(type="text", text="one"), IMAGE, TextContent(type="text", text="two")],
            "one\ntwo",
            "completed",
        ),
        ([IMAGE], None, "completed"),
        ([], None, "completed"),
        ((), None, "completed"),
        (42, None, "completed"),
        ("not json", "not json", "completed"),
        (
            '{"error":"already exists","existing":{}}',
            '{"error":"already exists","existing":{}}',
            "completed",
        ),
        ('{"error":false}', '{"error":false}', "completed"),
        ("[]", "[]", "completed"),
        ("{}", "{}", "completed"),
    ],
)
async def test_result_shapes_preserve_normalization_and_classification(result, summary, status):
    api = client()
    async with started(api) as recorder:
        await record(recorder, "tool", {}, result)
    body = invocation(api)
    assert body["result_summary"] == summary
    assert body["status"] == status
    if status == "failed" and summary:
        assert "422" in body["error_message"]
        assert "pr_url_missing" in body["error_message"]
    normalized = normalize_tool_result(result)
    if status == "failed" and isinstance(result, (list, tuple, CallToolResult)):
        assert normalized.isError
    else:
        assert normalized is result


async def test_summaries_and_exception_reason_are_bounded():
    api = client()
    async with started(api) as recorder:
        await record(
            recorder, "tool", {"data": "a" * 1000}, "b" * 1000, error=RuntimeError("c" * 1000)
        )
    body = invocation(api)
    assert len(body["arguments_summary"]) == 200
    assert body["result_summary"] == "b" * 500
    assert body["error_message"] == "c" * 500


@pytest.mark.parametrize("unsafe,encoded", [("\x00", "\\u0000"), ("\ud800", "\\ud800")])
async def test_unsupported_summary_text_is_escaped_without_changing_tool_result(unsafe, encoded):
    api = client()
    result = CallToolResult(content=[TextContent(type="text", text="prefix" + unsafe + "x" * 700)])
    async with started(api) as recorder:
        call_tool = wrapped(recorder, AsyncMock(return_value=result))
        returned = await call_tool("tool", {"value": unsafe})
        await recorder.flush()
    assert returned is result and returned.content[0].text == "prefix" + unsafe + "x" * 700
    body = invocation(api)
    assert body["result_summary"] == ("prefix" + encoded + "x" * 700)[:500]
    assert unsafe not in body["arguments_summary"]
    body["result_summary"].encode("utf-8")
    assert api.post.await_count == recorder.health()["recorded"] == 1


@pytest.mark.parametrize("unsafe,encoded", [("\x00", "\\u0000"), ("\ud800", "\\ud800")])
async def test_unsupported_exception_summary_is_escaped_without_changing_exception(
    unsafe, encoded
):
    api = client()
    error = RuntimeError("prefix" + unsafe)
    async with started(api) as recorder:
        call_tool = wrapped(recorder, AsyncMock(side_effect=error))
        with pytest.raises(RuntimeError) as raised:
            await call_tool("tool", {})
        await recorder.flush()
    assert raised.value is error
    body = invocation(api)
    assert body["error_message"] == body["result_summary"] == "prefix" + encoded
    assert body["status"] == "failed"


# --- delivery ----------------------------------------------------------------


async def test_recording_retry_uses_exact_same_outcome_and_identity():
    api = client()
    acknowledge = api.post.side_effect

    async def lost_ack(path, body):
        if api.post.await_count == 1:
            raise httpx.ReadError("response lost")
        return await acknowledge(path, body)

    api.post.side_effect = lost_ack
    async with started(api) as recorder:
        await record(recorder, "get_board", {}, "{}")
    assert api.post.await_count == 2
    assert api.post.call_args_list[0] == api.post.call_args_list[1]
    assert recorder.health()["recorded"] == 1
    assert recorder.health()["unconfirmed"] == 0


async def test_success_survives_recording_failure_with_content_free_health(caplog):
    api = client()
    api.post.side_effect = httpx.ConnectError("private token and content")
    result = [TextContent(type="text", text='{"id":"saved"}')]
    async with started(api) as recorder:
        call_tool = wrapped(recorder, AsyncMock(return_value=result))
        assert await call_tool("save", {}) is result
        await recorder.flush()
    assert api.post.await_count == 2
    assert recorder.health()["unconfirmed"] == 1
    assert recorder.health()["last_error"] == "transport_error"
    assert "private token" not in caplog.text
    assert "unconfirmed" in caplog.text


async def test_recording_deadline_is_bounded():
    api = client()

    async def hang(*args):
        await anyio.sleep_forever()

    api.post.side_effect = hang
    async with started(api, record_timeout=0.02) as recorder:
        with anyio.fail_after(0.5):
            await record(recorder, "tool", {}, "{}")
    assert recorder.health()["unconfirmed"] == 1
    assert recorder.health()["last_error"] == "timeout"


async def test_acknowledgement_must_match_and_diagnostics_do_not_grow_per_call(caplog):
    api = client()
    api.post.side_effect = None
    api.post.return_value = {"id": "wrong"}
    async with started(api) as recorder:
        for _ in range(5):
            await record(recorder, "tool", {}, "success")
    assert api.post.await_count == 10
    assert recorder.health()["recorded"] == 0
    assert recorder.health()["unconfirmed"] == 5
    assert recorder.health()["last_error"] == "invalid_acknowledgement"
    assert len(caplog.records) == 3  # first, second, fourth gap


async def test_tool_response_never_waits_on_a_slow_backend():
    api = client()
    acknowledge = api.post.side_effect

    async def slow(path, body):
        await anyio.sleep(0.2)
        return await acknowledge(path, body)

    api.post.side_effect = slow
    async with started(api) as recorder:
        call_tool = wrapped(recorder, AsyncMock(return_value="done"))
        began = time.monotonic()
        results = await asyncio.gather(*(call_tool("tool", {"n": n}) for n in range(5)))
        elapsed = time.monotonic() - began
        assert results == ["done"] * 5
        assert elapsed < 0.2, elapsed
        assert recorder.health()["queued"] >= 4
    # Leaving `running` flushed the queue before returning.
    assert recorder.health()["recorded"] == 5


async def test_full_queue_drops_outcomes_without_blocking_the_call():
    api = client()
    gate = anyio.Event()
    acknowledge = api.post.side_effect

    async def blocked(path, body):
        await gate.wait()
        return await acknowledge(path, body)

    api.post.side_effect = blocked
    async with started(api, max_queued=2) as recorder:
        call_tool = wrapped(recorder, AsyncMock(return_value="done"))
        with anyio.fail_after(0.5):
            for _ in range(6):
                await call_tool("tool", {})
        assert recorder.health()["last_error"] == "queue_full"
        gate.set()
    health = recorder.health()
    assert health["recorded"] + health["unconfirmed"] == 6
    assert health["unconfirmed"] >= 3


@pytest.mark.parametrize("status", [404, 405, 401, 403])
async def test_breaker_stops_posting_after_an_endpoint_or_credential_rejection(caplog, status):
    api = client()
    api.post.side_effect = http_error(status)
    with caplog.at_level(logging.WARNING, logger="valaris_mcp.tracking"):
        async with started(api, breaker_cooldown=60) as recorder:
            for _ in range(4):
                await record(recorder, "tool", {}, "{}")
            health = recorder.health()
    assert api.post.await_count == 1
    assert health["circuit_open"] is True
    assert health["unconfirmed"] == 4
    assert health["last_error"] == "circuit_open"
    paused = [record for record in caplog.records if "paused" in record.getMessage()]
    assert len(paused) == 1


async def test_breaker_closes_after_its_cooldown():
    api = client()
    acknowledge = api.post.side_effect
    api.post.side_effect = http_error(404)
    async with started(api, breaker_cooldown=0.05) as recorder:
        await record(recorder, "tool", {}, "{}")
        await record(recorder, "tool", {}, "{}")
        assert api.post.await_count == 1
        await anyio.sleep(0.08)
        api.post.side_effect = acknowledge
        await record(recorder, "tool", {}, "{}")
    assert api.post.await_count == 2
    assert recorder.health()["recorded"] == 1
    assert recorder.health()["circuit_open"] is False


@pytest.mark.parametrize("status", [422, 409])
async def test_other_client_errors_neither_retry_nor_open_the_breaker(status):
    api = client()
    api.post.side_effect = http_error(status)
    async with started(api) as recorder:
        await record(recorder, "tool", {}, "{}")
        await record(recorder, "tool", {}, "{}")
    assert api.post.await_count == 2
    assert recorder.health()["circuit_open"] is False


async def test_shutdown_flushes_queued_outcomes():
    api = client()
    recorder = InvocationRecorder(api, server_instance_id="s")
    async with recorder.running():
        for _ in range(3):
            recorder.finish(recorder.begin("tool", {}), "{}")
    assert api.post.await_count == 3
    assert recorder.health()["recorded"] == 3


async def test_shutdown_flush_is_bounded_and_counts_what_it_abandons():
    api = client()

    async def hang(*args):
        await anyio.sleep_forever()

    api.post.side_effect = hang
    recorder = InvocationRecorder(api, server_instance_id="s", record_timeout=30)
    with anyio.fail_after(1):
        async with recorder.running(flush_deadline=0.05):
            for _ in range(3):
                recorder.finish(recorder.begin("tool", {}), "{}")
    assert recorder.health()["unconfirmed"] == 3
    assert recorder.health()["last_error"] == "shutdown"
    recorder.finish(recorder.begin("late", {}), "{}")
    assert recorder.health()["last_error"] == "recorder_closed"


# --- the wrapper ---------------------------------------------------------------


async def test_cancellation_records_aborted_and_clears_request_correlation():
    from valaris_mcp.client import current_invocation_id

    api = client()
    entered = asyncio.Event()

    async def running(name, arguments):
        assert current_invocation_id.get() is not None
        entered.set()
        await asyncio.Future()

    async with started(api) as recorder:
        call_tool = wrapped(recorder, running)
        task = asyncio.create_task(call_tool("tool", {}))
        await entered.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await recorder.flush()
    assert invocation(api)["status"] == "aborted"
    assert current_invocation_id.get() is None
    assert recorder.health()["recorded"] == 1


async def test_anyio_cancellation_is_recorded_then_propagates():
    api = client()

    async def running(name, arguments):
        await anyio.sleep_forever()

    async with started(api) as recorder:
        call_tool = wrapped(recorder, running)
        with anyio.move_on_after(0.01) as cancelled:
            await call_tool("tool", {})
        await recorder.flush()
    assert cancelled.cancel_called
    assert invocation(api)["status"] == "aborted"


@pytest.mark.parametrize("same_name", [False, True])
async def test_concurrent_wrapped_calls_keep_correlation_and_results(same_name):
    from valaris_mcp.client import current_invocation_id

    api = client()
    arrived = asyncio.Event()
    contexts = {}

    async def running(name, arguments):
        contexts[arguments["which"]] = current_invocation_id.get()
        if len(contexts) == 2:
            arrived.set()
        await arrived.wait()
        if arguments["which"] == "failure":
            raise RuntimeError("own error")
        return "own success"

    async with started(api) as recorder:
        call_tool = wrapped(recorder, running)
        with anyio.fail_after(2):
            results = await asyncio.gather(
                call_tool("first", {"which": "success"}),
                call_tool("first" if same_name else "second", {"which": "failure"}),
                return_exceptions=True,
            )
        await recorder.flush()
    assert results[0] == "own success" and isinstance(results[1], RuntimeError)
    rows = {body["id"]: body for body in bodies(api)}
    assert len(rows) == 2
    assert rows[contexts["success"]]["result_summary"] == "own success"
    assert rows[contexts["failure"]]["error_message"] == "own error"
    assert current_invocation_id.get() is None


async def test_backend_requests_during_the_tool_carry_the_invocation_header():
    from valaris_mcp.client import ValarisClient

    seen = []

    def handler(request):
        seen.append((request.url.path, request.headers.get("X-Backplane-Invocation-ID")))
        body = json.loads(request.content) if request.content else {}
        return httpx.Response(200, json={"id": body.get("id")})

    backend = ValarisClient()
    backend._http = httpx.AsyncClient(
        base_url="http://test", transport=httpx.MockTransport(handler)
    )
    recorder = InvocationRecorder(backend, server_instance_id="s")

    async def tool(name, arguments):
        await backend.get("/workspaces/x/boards")
        return "ok"

    async with recorder.running():
        call_tool = wrapped(recorder, tool)
        await call_tool("list_boards", {})
    await backend.close()
    tool_request, receipt = seen
    assert tool_request[0] == "/api/workspaces/x/boards"
    assert tool_request[1] is not None
    # The receipt is posted from the background task, outside the call.
    assert receipt == ("/api/me/mcp-invocations", None)


async def test_fastmcp_converted_result_keeps_error_receipt():
    api = client()
    server = FastMCP("tracking-test")

    @server.tool()
    async def update_card() -> str:
        return ERROR

    async with started(api) as recorder:
        install_tracking(server, recorder)
        result = await server.call_tool("update_card", {})
        await recorder.flush()
    assert isinstance(result, CallToolResult) and result.isError
    assert result.content[0].text == ERROR
    assert invocation(api)["status"] == "failed"


# --- secrets never reach an outcome -----------------------------------------------

SECRET = "SENTINEL-WEBHOOK-SECRET"


@pytest.mark.parametrize(
    "arguments",
    [
        {"workspace_slug": "w", "url": "https://x", "events": ["card.moved"], "secret": SECRET},
        {"workspace_slug": "w", "webhook_id": "h1", "secret": SECRET, "is_active": True},
        {"nested": {"Authorization": SECRET, "items": [{"api_key": SECRET}]}},
        {"PASSWORD": SECRET, "private_key": SECRET, "apiKey": SECRET, "db_passwd": SECRET},
        {"access_token": SECRET, "credentials": {"user": "u"}},
    ],
)
async def test_secret_arguments_are_redacted_by_key_name(arguments):
    api = client()
    async with started(api) as recorder:
        await record(recorder, "create_webhook", arguments, "{}")
    body = invocation(api)
    assert SECRET not in body["arguments_summary"]
    assert "[redacted]" in body["arguments_summary"]


async def test_webhook_tools_never_record_their_secret_end_to_end():
    from valaris_mcp.tools.webhooks import create_webhook, update_webhook

    api = client()
    server = FastMCP("webhook-secret-test")
    server.add_tool(create_webhook)
    server.add_tool(update_webhook)
    backend = AsyncMock()
    backend.ws = lambda slug: f"/workspaces/{slug}"
    backend.post.return_value = {"id": "h1", "secret": SECRET}
    backend.patch.return_value = {"id": "h1", "secret": SECRET}
    lifespan = SimpleNamespace(client=backend)
    from mcp.server.lowlevel.server import request_ctx
    from mcp.shared.context import RequestContext

    token = request_ctx.set(
        RequestContext(request_id=1, meta=None, session=AsyncMock(), lifespan_context=lifespan)
    )
    try:
        async with started(api) as recorder:
            install_tracking(server, recorder)
            await server.call_tool(
                "create_webhook",
                {"workspace_slug": "w", "url": "https://x", "events": ["a"], "secret": SECRET},
            )
            await server.call_tool(
                "update_webhook", {"workspace_slug": "w", "webhook_id": "h1", "secret": SECRET}
            )
            await recorder.flush()
    finally:
        request_ctx.reset(token)
    rows = bodies(api)
    assert [row["tool_name"] for row in rows] == ["create_webhook", "update_webhook"]
    assert SECRET not in json.dumps(rows)


async def test_validation_error_input_values_are_redacted():
    from valaris_mcp.tools.webhooks import create_webhook

    api = client()
    server = FastMCP("validation-secret-test")
    server.add_tool(create_webhook)
    async with started(api) as recorder:
        install_tracking(server, recorder)
        with pytest.raises(Exception) as raised:
            await server.call_tool(
                "create_webhook",
                {"workspace_slug": "w", "url": "https://x", "events": ["a"], "secret": [SECRET]},
            )
        await recorder.flush()
    assert SECRET in str(raised.value)  # the caller still sees its own error
    body = invocation(api)
    assert body["status"] == "failed"
    assert SECRET not in json.dumps(body)
    assert "input_value=[redacted]" in body["error_message"]


# --- lifecycle edges ---------------------------------------------------------------


async def test_running_reraises_the_lifespan_error_itself():
    recorder = InvocationRecorder(client(), server_instance_id="s")
    with pytest.raises(RuntimeError, match="lifespan failed"):
        async with recorder.running():
            raise RuntimeError("lifespan failed")


async def test_abandoned_outcomes_are_not_also_reported_as_queued():
    api = client()

    async def hang(*args):
        await anyio.sleep_forever()

    api.post.side_effect = hang
    recorder = InvocationRecorder(api, server_instance_id="s", record_timeout=30)
    async with recorder.running(flush_deadline=0.05):
        for _ in range(3):
            recorder.finish(recorder.begin("tool", {}), "{}")
    assert recorder.health()["unconfirmed"] == 3
    assert recorder.health()["queued"] == 0


# --- signed URLs (bearer credentials) ------------------------------------------------

SIGNED_GCS = (
    "https://storage.googleapis.com/b/o.txt?X-Goog-Algorithm=GOOG4-RSA-SHA256"
    "&X-Goog-Credential=sa%40p.iam%2F20261003%2Fauto%2Fstorage%2Fgoog4_request"
    "&X-Goog-Expires=900&X-Goog-Signature=0123abcdSIGNATURE"
)
SIGNED_SECRETS = ("0123abcdSIGNATURE", "sa%40p.iam")


@pytest.mark.parametrize("tool", ["get_download_url", "get_upload_url"])
async def test_signed_url_tools_keep_their_status_but_never_a_result_summary(tool):
    api = client()
    async with started(api) as recorder:
        await record(recorder, tool, {"workspace_slug": "w"}, json.dumps({"url": SIGNED_GCS}))
    body = invocation(api)
    assert body["status"] == "completed"
    assert body["result_summary"] is None


@pytest.mark.parametrize(
    "signed",
    [
        SIGNED_GCS,
        "https://acct.blob.core.windows.net/c/f?sv=2024-01-01&sig=AZURESECRET%3D",
        "https://cdn.example/f?Expires=1&Signature=CLOUDFRONTSECRET&Key-Pair-Id=K",
    ],
)
async def test_signed_url_query_values_are_redacted_from_any_summary(signed):
    api = client()
    async with started(api) as recorder:
        await record(recorder, "get_resource", {"link": signed}, json.dumps({"link": signed}))
        await record(recorder, "get_resource", {}, "failed", error=RuntimeError(f"GET {signed} 500"))
    rows = bodies(api)
    text = json.dumps(rows)
    for secret in (*SIGNED_SECRETS, "AZURESECRET", "CLOUDFRONTSECRET"):
        assert secret not in text
    assert "[redacted]" in rows[0]["arguments_summary"]
    assert "[redacted]" in rows[0]["result_summary"]
    assert "[redacted]" in rows[1]["error_message"]


async def test_ordinary_query_strings_are_recorded_unchanged():
    result = json.dumps({"link": "https://example.test/search?q=sig&page=2&design=Signature"})
    api = client()
    async with started(api) as recorder:
        await record(recorder, "get_resource", {}, result)
    assert invocation(api)["result_summary"] == result
