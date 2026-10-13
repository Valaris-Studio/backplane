# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Tolerant reading of Beacon event schema 1.0 (asymptoteobserve.Event).

Only `event.action` and `timestamp` are required. Known fields are typed so a
malformed value is rejected, and every unknown field is kept: the stored event
is the uploaded JSON, never a re-serialization of this model.
"""

import copy
import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.core.command_content import without_command_content
from app.core.harness import COLLECTION_METHODS, native_call_key

TITLE_MAX_CHARS = 200


class _Tolerant(BaseModel):
    model_config = ConfigDict(extra="allow")


class EventInfo(_Tolerant):
    action: str = Field(min_length=1, max_length=200)
    id: str | None = Field(None, min_length=1, max_length=64)
    kind: str | None = Field(None, max_length=64)
    category: str | None = Field(None, max_length=64)
    fidelity: str | None = Field(None, max_length=16)


class HarnessInfo(_Tolerant):
    name: str | None = None
    version: str | None = None
    collection_method: str | None = None


class SessionInfo(_Tolerant):
    id: str | None = None
    working_directory: str | None = None


class ToolInfo(_Tolerant):
    name: str | None = None


class MCPInfo(_Tolerant):
    server: str | None = None
    tool: str | None = None


class CommandInfo(_Tolerant):
    exit_code: int | None = None


class TraceInfo(_Tolerant):
    span_id: str | None = None


class RunInfo(_Tolerant):
    repository: str | None = None
    branch: str | None = None


class PromptInfo(_Tolerant):
    text: str | None = None


class TokenCount(_Tolerant):
    input_tokens: int | None = Field(None, ge=0)


class UsageInfo(_Tolerant):
    input_tokens: int | None = Field(None, ge=0)
    output_tokens: int | None = Field(None, ge=0)
    cache_read: TokenCount | None = None
    cache_creation: TokenCount | None = None
    cost_usd: float | None = Field(None, ge=0, allow_inf_nan=False)


class ModelNameInfo(_Tolerant):
    model: str | None = None


class ToolCallInfo(_Tolerant):
    id: str | None = None


class GenAIToolInfo(_Tolerant):
    name: str | None = None
    call: ToolCallInfo | None = None


class GenAIInfo(_Tolerant):
    request: ModelNameInfo | None = None
    response: ModelNameInfo | None = None
    tool: GenAIToolInfo | None = None
    usage: UsageInfo | None = None


class BeaconEvent(_Tolerant):
    timestamp: datetime
    event: EventInfo
    schema_version: str | None = None
    harness: HarnessInfo | None = None
    session: SessionInfo | None = None
    tool: ToolInfo | None = None
    mcp: MCPInfo | None = None
    command: CommandInfo | None = None
    run: RunInfo | None = None
    trace: TraceInfo | None = None
    prompt: PromptInfo | None = None
    gen_ai: GenAIInfo | None = None
    error: dict[str, Any] | None = None
    model: str | None = None
    repository: str | None = None
    branch: str | None = None

    @field_validator("timestamp", mode="before")
    @classmethod
    def rfc3339_with_offset(cls, value):
        if not isinstance(value, str):
            raise ValueError("timestamp must be an RFC 3339 string")
        parsed = datetime.fromisoformat(value)
        if parsed.tzinfo is None:
            raise ValueError("timestamp requires a UTC offset")
        return parsed.astimezone(timezone.utc)


def canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _bounded(value: str | None, limit: int) -> str | None:
    return value[:limit] if value else None


def _call_key(value: str | None) -> str | None:
    return native_call_key(value) if value else None


@dataclass(frozen=True)
class PromotedEvent:
    """The indexed columns of one stored event plus its session-summary deltas."""

    event_id: str
    occurred_at: datetime
    action: str
    kind: str | None
    category: str | None
    fidelity: str | None
    collection_method: str
    tool_name: str | None
    native_tool_call_id: str | None
    mcp_server: str | None
    mcp_tool: str | None
    outcome: str | None
    harness_version: str | None
    cwd: str | None
    repository: str | None
    branch: str | None
    model: str | None
    prompt_text: str | None
    input_tokens: int
    output_tokens: int
    cache_read_tokens: int
    cache_creation_tokens: int
    cost_usd: Decimal | None


def _outcome(parsed: BeaconEvent) -> str | None:
    action = parsed.event.action
    exit_code = parsed.command.exit_code if parsed.command else None
    if action.endswith(".failed") or parsed.error or (exit_code or 0) != 0:
        return "failed"
    if action.endswith(".completed") or exit_code == 0:
        return "succeeded"
    return None


def _tool_call_id(parsed: BeaconEvent, gen_ai: GenAIInfo) -> str | None:
    """The harness's id for the tool call: gen_ai.tool.call.id, else the hook
    adapter's trace span, which Beacon sets to the same id on tool events."""
    if gen_ai.tool and gen_ai.tool.call and gen_ai.tool.call.id:
        return gen_ai.tool.call.id
    is_tool_event = parsed.tool is not None or parsed.mcp is not None
    return parsed.trace.span_id if is_tool_event and parsed.trace else None


def promote(raw: dict, parsed: BeaconEvent, record_collection_method: str):
    gen_ai = parsed.gen_ai or GenAIInfo()
    usage = gen_ai.usage or UsageInfo()
    harness = parsed.harness or HarnessInfo()
    run = parsed.run or RunInfo()
    collection_method = (
        harness.collection_method
        if harness.collection_method in COLLECTION_METHODS
        else record_collection_method
    )
    event_id = (
        parsed.event.id or hashlib.sha256(canonical_json(raw).encode()).hexdigest()
    )
    model = (
        parsed.model
        or (gen_ai.response.model if gen_ai.response else None)
        or (gen_ai.request.model if gen_ai.request else None)
    )
    return PromotedEvent(
        event_id=event_id,
        occurred_at=parsed.timestamp,
        action=parsed.event.action,
        kind=parsed.event.kind,
        category=parsed.event.category,
        fidelity=parsed.event.fidelity,
        collection_method=collection_method,
        tool_name=_bounded(
            (parsed.tool.name if parsed.tool else None)
            or (gen_ai.tool.name if gen_ai.tool else None),
            200,
        ),
        native_tool_call_id=_call_key(_tool_call_id(parsed, gen_ai)),
        mcp_server=_bounded(parsed.mcp.server if parsed.mcp else None, 200),
        mcp_tool=_bounded(parsed.mcp.tool if parsed.mcp else None, 200),
        outcome=_outcome(parsed),
        harness_version=_bounded(harness.version, 64),
        cwd=_bounded(
            parsed.session.working_directory if parsed.session else None, 1024
        ),
        repository=_bounded(parsed.repository or run.repository, 1024),
        branch=_bounded(parsed.branch or run.branch, 255),
        model=_bounded(model, 200),
        prompt_text=parsed.prompt.text if parsed.prompt else None,
        input_tokens=usage.input_tokens or 0,
        output_tokens=usage.output_tokens or 0,
        cache_read_tokens=(usage.cache_read.input_tokens if usage.cache_read else 0)
        or 0,
        cache_creation_tokens=(
            usage.cache_creation.input_tokens if usage.cache_creation else 0
        )
        or 0,
        cost_usd=Decimal(str(usage.cost_usd)) if usage.cost_usd is not None else None,
    )


def session_title(prompt_text: str | None) -> str | None:
    if not prompt_text:
        return None
    title = " ".join(prompt_text.split())
    return title[:TITLE_MAX_CHARS] or None


REDACTIONS_KEY = "backplane_redactions"

# The only leaves a metadata-level event keeps: structure, identifiers,
# counts and outcomes. Everything else, including fields Beacon adds later,
# is replaced by its hash and size.
_METADATA_LEAVES = (
    "timestamp",
    "sequence",
    "vendor",
    "product",
    "schema_version",
    "severity",
    "origin",
    "status",
    "outcome",
    "field_truncated",
    "model",
    "repository",
    "branch",
    "event.id",
    "event.kind",
    "event.action",
    "event.category",
    "event.fidelity",
    "endpoint.os",
    "endpoint.agent_version",
    "harness.name",
    "harness.version",
    "harness.collection_method",
    "session.id",
    "session.working_directory",
    "trace.id",
    "trace.span_id",
    "trace.parent_span_id",
    "tool.name",
    "mcp.server",
    "mcp.tool",
    "mcp.method.name",
    "mcp.protocol.version",
    "gen_ai.operation.name",
    "gen_ai.provider.name",
    "gen_ai.request.model",
    "gen_ai.response.model",
    "gen_ai.tool.name",
    "gen_ai.tool.call.id",
    "gen_ai.usage.input_tokens",
    "gen_ai.usage.output_tokens",
    "gen_ai.usage.cost_usd",
    "gen_ai.usage.cache_read.input_tokens",
    "gen_ai.usage.cache_creation.input_tokens",
    "gen_ai.usage.reasoning.output_tokens",
    "gen_ai.usage.cache_creation.ephemeral_1h_input_tokens",
    "gen_ai.usage.service_tier",
    "gen_ai.usage.speed",
    "command.exit_code",
    "command.duration_ms",
    "run.repository",
    "run.branch",
    "run.commit",
    "file.operation",
    "file.language",
    "file.diff_hash",
    "file.diff_bytes",
    "content.hash",
    "content.bytes",
    "content.included",
    "content.retention",
    "rpc.response.status_code",
    "approval.decision",
    "policy.decision",
    "health.status",
)

# Removed at the standard level: tool and model output, raw native payloads
# and file diffs. Prompts, commands and tool arguments stay.
_STANDARD_STRIPPED_PATHS = (
    ("raw",),
    ("file", "diff"),
    ("output",),
    ("gen_ai", "output"),
    ("gen_ai", "tool", "call", "result"),
    ("command", "output"),
    ("command", "stdout"),
    ("command", "stderr"),
    ("tool", "output"),
    ("tool", "result"),
    ("tool", "response"),
    ("mcp", "result"),
    ("mcp", "response"),
)


# Command and tool-argument fields kept at the standard level that can still
# carry file content: a heredoc or echo that writes a file, a unified diff or
# an apply_patch envelope. Standard keeps the command and withholds the file
# content, as the companion does before upload.
_COMMAND_BEARING_PATHS = (
    ("tool", "command"),
    ("tool", "input"),
    ("command", "command"),
    ("gen_ai", "tool", "call", "arguments"),
)


def _leaf_tree(paths) -> dict:
    tree: dict = {}
    for path in paths:
        node = tree
        *parents, leaf = path.split(".")
        for key in parents:
            node = node.setdefault(key, {})
        node[leaf] = True
    return tree


_METADATA_TREE = _leaf_tree(_METADATA_LEAVES)


# Largest text any kept structural leaf (metadata) or error message (standard)
# may carry; longer values are cut and marked, with the original fingerprinted.
MAX_KEPT_TEXT_BYTES = 1024
_TRUNCATION_MARKER = "...[truncated]"


def _capped(value: str) -> str:
    encoded = value.encode()
    if len(encoded) <= MAX_KEPT_TEXT_BYTES:
        return value
    room = MAX_KEPT_TEXT_BYTES - len(_TRUNCATION_MARKER)
    return encoded[:room].decode(errors="ignore") + _TRUNCATION_MARKER


# What the companion leaves where it withheld content before upload: a
# `{bytes, sha256}` descriptor (or its JSON text, in an OTLP attribute) and an
# `[omitted N bytes sha256:…]` digest. Both state the original size.
_COMPANION_DIGEST = re.compile(r"^\[omitted (\d+) bytes sha256:[0-9a-f]+\]$")
_COMPANION_PLACEHOLDER_TEXT = re.compile(r'^\{"bytes":(\d+),"sha256":"[0-9a-f]{64}"\}$')


def companion_declared_bytes(value) -> int | None:
    """The original size a companion placeholder states, else None."""
    if (
        isinstance(value, dict)
        and set(value) == {"bytes", "sha256"}
        and isinstance(value["bytes"], int)
        and not isinstance(value["bytes"], bool)
        and isinstance(value["sha256"], str)
    ):
        return value["bytes"]
    if isinstance(value, str):
        match = _COMPANION_DIGEST.match(value) or _COMPANION_PLACEHOLDER_TEXT.match(
            value
        )
        if match:
            return int(match.group(1))
    return None


def _holds_placeholder(value) -> bool:
    if companion_declared_bytes(value) is not None:
        return True
    if isinstance(value, dict):
        return any(_holds_placeholder(child) for child in value.values())
    if isinstance(value, list):
        return any(_holds_placeholder(child) for child in value)
    return False


def _original_bytes(value, received_bytes: int) -> int | None:
    """Size of the content before anyone withheld it: what Backplane received,
    or what a companion placeholder states (also inside a one-member wrapper
    such as `{"text": …}`). None when placeholders and text are mixed."""
    declared = companion_declared_bytes(value)
    if declared is not None:
        return declared
    if not _holds_placeholder(value):
        return received_bytes
    if isinstance(value, dict) and len(value) == 1:
        return _original_bytes(next(iter(value.values())), received_bytes)
    if isinstance(value, list) and len(value) == 1:
        return _original_bytes(value[0], received_bytes)
    return None


def _fingerprint(value) -> dict:
    """`bytes` and `sha256` describe what Backplane received; `original_bytes`
    the size the person's content had, None when unknown. Entries stored
    before `original_bytes` existed carry no trustworthy original size."""
    encoded = (value if isinstance(value, str) else canonical_json(value)).encode()
    return {
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "bytes": len(encoded),
        "original_bytes": _original_bytes(value, len(encoded)),
    }


def _keep_allowlisted(value: dict, allowed: dict, path: tuple, redactions: dict):
    kept = {}
    for key, child in value.items():
        rule = allowed.get(key)
        if rule is True and not isinstance(child, (dict, list)):
            kept[key] = _capped(child) if isinstance(child, str) else child
            if kept[key] is not child:
                redactions[".".join((*path, key))] = _fingerprint(child)
        elif isinstance(rule, dict) and isinstance(child, dict):
            nested = _keep_allowlisted(child, rule, (*path, key), redactions)
            if nested:
                kept[key] = nested
        else:
            redactions[".".join((*path, key))] = _fingerprint(child)
    return kept


def _metadata_only(event: dict) -> dict:
    redactions: dict = {}
    kept = _keep_allowlisted(event, _METADATA_TREE, (), redactions)
    if isinstance(kept.get("content"), dict):
        kept["content"].update(retention="metadata", included=False)
    if redactions:
        kept[REDACTIONS_KEY] = redactions
    return kept


def _without_tool_output(event: dict) -> dict:
    stripped = copy.deepcopy(event)
    redactions = {}
    for path in _STANDARD_STRIPPED_PATHS:
        parent = stripped
        for key in path[:-1]:
            parent = parent.get(key) if isinstance(parent, dict) else None
        if isinstance(parent, dict) and path[-1] in parent:
            redactions[".".join(path)] = _fingerprint(parent.pop(path[-1]))
    for path in _COMMAND_BEARING_PATHS:
        parent = stripped
        for key in path[:-1]:
            parent = parent.get(key) if isinstance(parent, dict) else None
        if isinstance(parent, dict) and path[-1] in parent:
            withheld = without_command_content(parent[path[-1]])
            if withheld != parent[path[-1]]:
                redactions[".".join(path)] = _fingerprint(parent[path[-1]])
                parent[path[-1]] = withheld
    error = stripped.get("error")
    if isinstance(error, dict) and isinstance(error.get("message"), str):
        capped = _capped(error["message"])
        if capped is not error["message"]:
            redactions["error.message"] = _fingerprint(error["message"])
            error["message"] = capped
    if redactions:
        stripped[REDACTIONS_KEY] = redactions
    return stripped


def for_content_level(event: dict, content_level: str) -> dict:
    """The copy of an uploaded event that a mapping's content level may keep.

    metadata is an allowlist of structural leaves, each capped at 1 KiB, so
    unknown and future fields never leak; the ingest has already cut
    `session.working_directory` to the folder's base name. standard drops tool and model
    output, raw payloads and file diffs, including file content that commands
    and tool arguments carry (heredoc and echo bodies that write a file,
    unified diffs, apply_patch envelopes), and caps error.message at 1 KiB; it
    keeps prompts, commands and tool arguments. full keeps the event within
    the ingest size limits. At every level account and host identity are
    dropped, and `backplane_redactions` is written only by the server. Defense
    in depth: the companion applies the same rules before upload and the
    server never relies on it.
    """
    event = strip_identity(event)
    event.pop(REDACTIONS_KEY, None)
    if content_level == "metadata":
        return _metadata_only(event)
    if content_level == "standard":
        return _without_tool_output(event)
    return event


def strip_identity(event: dict) -> dict:
    """Drop the local account and host identity (`user`, `host`,
    `endpoint.hostname`) at every content level. The companion strips them
    before upload; the server never relies on it."""
    stripped = copy.deepcopy(event)
    stripped.pop("user", None)
    stripped.pop("host", None)
    if isinstance(stripped.get("endpoint"), dict):
        stripped["endpoint"].pop("hostname", None)
    return stripped
