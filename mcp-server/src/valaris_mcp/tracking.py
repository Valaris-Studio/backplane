# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""One immutable MCP outcome per tool call, delivered off the call's hot path."""

from __future__ import annotations

import json
import logging
import re
import time
import uuid
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import anyio
import httpx
from mcp.types import CallToolResult

from valaris_mcp.results import classify_result, normalize_tool_result, result_text

__all__ = ["InvocationCall", "InvocationRecorder", "normalize_tool_result"]

logger = logging.getLogger(__name__)
MAX_ARGS_SUMMARY = 200
MAX_RESULT_SUMMARY = 500
RECORD_TIMEOUT_SECONDS = 2.0
MAX_RECORD_ATTEMPTS = 2
MAX_QUEUED_OUTCOMES = 256
SHUTDOWN_FLUSH_SECONDS = 2.0
# 404/405: the backend predates the endpoint; 401/403: this credential may not
# record. Neither heals per request, so stop posting for a while.
BREAKER_STATUSES = frozenset({401, 403, 404, 405})
BREAKER_COOLDOWN_SECONDS = 300.0
# Keys whose values are never summarized, at any depth, whatever the tool.
_SECRET_KEY = re.compile(
    r"secret|token|passw(or)?d|api_?key|authorization|credential|private_?key", re.IGNORECASE
)
# Pydantic echoes the rejected value (`input_value=...`) in validation errors.
_ECHOED_INPUT = re.compile(r"input_value=.*?(?=, input_type=|\]|$)", re.MULTILINE)
# A signed URL is a bearer credential carried in its query string: GCS v4
# (X-Goog-Signature, X-Goog-Credential), CloudFront (Signature), Azure SAS (sig).
_SIGNED_URL_PARAM = re.compile(
    r"([?&](?:X-Goog-Signature|X-Goog-Credential|Signature|sig)=)[^&#\s\"'\\]*",
    re.IGNORECASE,
)
REDACTED = "[redacted]"
# Tools whose success result carries a credential (a once-only raw_api_key, a
# signed URL): their outcome keeps its status but never a result summary.
CREDENTIAL_RESULT_TOOLS = frozenset(
    {"create_agent", "rotate_agent_key", "get_download_url", "get_upload_url"}
)


def _redacted(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: REDACTED if isinstance(key, str) and _SECRET_KEY.search(key) else _redacted(child)
            for key, child in value.items()
        }
    if isinstance(value, list):
        return [_redacted(child) for child in value]
    if isinstance(value, str):
        return _without_url_signatures(value)
    return value


def _without_url_signatures(text: str) -> str:
    return _SIGNED_URL_PARAM.sub(r"\1" + REDACTED, text)


def _redacted_text(text: str | None) -> str | None:
    """Secret-free text: JSON by key name, anything else by echoed input values."""
    if text is None:
        return None
    try:
        parsed = json.loads(text)
    except (ValueError, RecursionError):
        return _without_url_signatures(_ECHOED_INPUT.sub("input_value=" + REDACTED, text))
    redacted = _redacted(parsed)
    # Untouched JSON keeps its original text, byte for byte.
    return text if redacted == parsed else json.dumps(redacted, default=str)


def _bounded_summary(value: str | None, limit: int) -> str | None:
    if value is None:
        return None
    # PostgreSQL text cannot store NUL or UTF-8 surrogates. Escape only report
    # summaries; the caller's result and immutable invocation identity stay intact.
    return "".join(
        f"\\u{ord(char):04x}" if char == "\x00" or 0xD800 <= ord(char) <= 0xDFFF else char
        for char in value[:limit]
    )[:limit]


@dataclass(frozen=True)
class InvocationCall:
    id: str
    tool_name: str
    workspace_slug: str | None
    arguments_summary: str | None
    started_at: datetime
    start_mono: float
    native_context: dict[str, str | None] = field(default_factory=dict)


class InvocationRecorder:
    """Builds each call's outcome and hands it to a bounded background queue.

    The tool call never waits on the backend: `finish` only enqueues, so it
    cannot block and cannot be interrupted by the call's cancellation. The
    drain task (see `running`) posts each outcome at most twice. A full queue,
    an open breaker or a shutdown past its flush deadline leave outcomes
    unconfirmed; `health` counts them, and nothing is retried durably.

    `native_context` is called with the call's arguments and returns the
    harness fields for the current call; it is injected so this module stays
    agent-neutral.
    """

    def __init__(
        self,
        client: Any,
        *,
        server_instance_id: str,
        native_context: Callable[[dict], dict[str, str | None]] = lambda _arguments: {},
        max_queued: int = MAX_QUEUED_OUTCOMES,
        record_timeout: float = RECORD_TIMEOUT_SECONDS,
        breaker_cooldown: float = BREAKER_COOLDOWN_SECONDS,
    ) -> None:
        self._client = client
        self._server_instance_id = server_instance_id
        self._native_context = native_context
        self._record_timeout = record_timeout
        self._breaker_cooldown = breaker_cooldown
        self._send, self._receive = anyio.create_memory_object_stream[dict](max_queued)
        self._pending = 0
        self._idle = anyio.Event()
        self._idle.set()
        self._breaker_open_until = 0.0
        self._recorded = 0
        self._unconfirmed = 0
        self._last_error: str | None = None

    def health(self) -> dict:
        # Process/session lifetime only. An unconfirmed outcome may have committed
        # before its acknowledgement was lost; never claim that it was absent.
        return {
            "recorded": self._recorded,
            "unconfirmed": self._unconfirmed,
            "queued": self._pending,
            "last_error": self._last_error,
            "circuit_open": time.monotonic() < self._breaker_open_until,
            "durable_retry": False,
        }

    def begin(self, name: str, arguments: dict | None) -> InvocationCall:
        arguments = arguments or {}
        try:
            summary = json.dumps(_redacted(arguments), default=str)[:MAX_ARGS_SUMMARY]
        except (TypeError, ValueError):
            summary = None
        workspace = arguments.get("workspace_slug")
        return InvocationCall(
            id=str(uuid.uuid4()),
            tool_name=name,
            workspace_slug=workspace if isinstance(workspace, str) else None,
            arguments_summary=summary,
            started_at=datetime.now(timezone.utc),
            start_mono=time.monotonic(),
            native_context=self._native_context(arguments),
        )

    def finish(
        self, call: InvocationCall, result: Any, *, error: BaseException | None = None
    ) -> None:
        payload = result_text(result)
        status, reason = classify_result(payload)
        if error is not None:
            status = "aborted" if isinstance(error, anyio.get_cancelled_exc_class()) else "failed"
            reason = str(error) or type(error).__name__
        elif isinstance(result, CallToolResult) and result.isError:
            status, reason = "failed", reason or payload or "Tool call failed"
        outcome = {
            "id": call.id,
            "tool_name": call.tool_name,
            "workspace_slug": call.workspace_slug,
            "arguments_summary": call.arguments_summary,
            "started_at": call.started_at.isoformat(),
            "completed_at": max(call.started_at, datetime.now(timezone.utc)).isoformat(),
            "duration_seconds": round(max(0, time.monotonic() - call.start_mono), 3),
            "status": status,
            "result_summary": None
            if call.tool_name in CREDENTIAL_RESULT_TOOLS
            else _bounded_summary(_redacted_text(payload), MAX_RESULT_SUMMARY),
            "error_message": _bounded_summary(_redacted_text(reason), MAX_RESULT_SUMMARY)
            if reason
            else None,
            "server_instance_id": self._server_instance_id,
            **call.native_context,
        }
        try:
            self._send.send_nowait(outcome)
        except anyio.WouldBlock:
            self._unconfirmed_outcome("queue_full")
            return
        except (anyio.ClosedResourceError, anyio.BrokenResourceError):
            self._unconfirmed_outcome("recorder_closed")
            return
        if self._pending == 0:
            self._idle = anyio.Event()
        self._pending += 1

    async def flush(self) -> None:
        """Wait until every queued outcome has been delivered or given up on."""
        await self._idle.wait()

    @asynccontextmanager
    async def running(self, flush_deadline: float = SHUTDOWN_FLUSH_SECONDS):
        """Run the drain task for the enclosed lifetime, then flush briefly."""
        lifespan_error: Exception | None = None
        async with anyio.create_task_group() as tasks:
            tasks.start_soon(self._drain)
            try:
                yield self
            except Exception as exc:
                # Raised again below, outside the task group, so callers see
                # their own exception rather than an ExceptionGroup.
                lifespan_error = exc
            finally:
                self._send.close()
                with anyio.move_on_after(flush_deadline, shield=True):
                    await self.flush()
                for _ in range(self._pending):
                    self._unconfirmed_outcome("shutdown")
                self._pending = 0
                self._idle.set()
                tasks.cancel_scope.cancel()
        if lifespan_error is not None:
            raise lifespan_error

    async def _drain(self) -> None:
        async with self._receive:
            async for outcome in self._receive:
                try:
                    await self._deliver(outcome)
                finally:
                    # Shutdown may already have written this one off.
                    self._pending = max(0, self._pending - 1)
                    if self._pending == 0:
                        self._idle.set()

    async def _deliver(self, outcome: dict) -> None:
        if time.monotonic() < self._breaker_open_until:
            self._unconfirmed_outcome("circuit_open")
            return
        failure = "timeout"
        with anyio.move_on_after(self._record_timeout) as deadline:
            for _ in range(MAX_RECORD_ATTEMPTS):
                try:
                    receipt = await self._client.post("/me/mcp-invocations", outcome)
                    if not isinstance(receipt, dict) or receipt.get("id") != outcome["id"]:
                        failure = "invalid_acknowledgement"
                        continue
                    self._recorded += 1
                    return
                except httpx.HTTPStatusError as exc:
                    code = exc.response.status_code
                    failure = f"http_{code}"
                    if code in BREAKER_STATUSES:
                        self._open_breaker(code)
                        break
                    if code < 500 and code != 429:
                        break
                except httpx.TransportError:
                    failure = "transport_error"
                except Exception:
                    failure = "recording_error"
        if deadline.cancel_called:
            failure = "timeout"
        self._unconfirmed_outcome(failure)

    def _open_breaker(self, status_code: int) -> None:
        if time.monotonic() >= self._breaker_open_until:
            logger.warning(
                "MCP invocation recording paused for %.0fs: backend answered %d",
                self._breaker_cooldown,
                status_code,
            )
        self._breaker_open_until = time.monotonic() + self._breaker_cooldown

    def _unconfirmed_outcome(self, failure: str) -> None:
        self._unconfirmed += 1
        self._last_error = failure
        if self._unconfirmed & (self._unconfirmed - 1) == 0:
            logger.warning(
                "MCP invocation outcomes unconfirmed: %d (%s)", self._unconfirmed, failure
            )
