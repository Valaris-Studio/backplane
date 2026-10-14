# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""What a stored event says about its content, without adding any.

Stored events were already reduced to their mapping's content level at ingest
(app/schemas/beacon.py for_content_level), so everything read here is what
the level sent. Content that stayed behind leaves three kinds of traces: the
server's `backplane_redactions`, the companion's `{bytes, sha256}` output
descriptors, and the companion's `[omitted N bytes sha256:…]` digests.
"""

import re
from collections.abc import Iterable
from typing import Any

from app.core.codex_tool_result import MAX_DURATION_MS, codex_tool_result
from app.schemas.beacon import REDACTIONS_KEY, canonical_json

ARGS_PREVIEW_CHARS = 300
PROMPT_PREVIEW_CHARS = 1000
_ELLIPSIS = "…"

PROMPT_PATHS = ("prompt.text",)
# In the order a preview prefers them: the command line, then the arguments.
ARGUMENT_PATHS = (
    "tool.command",
    "command.command",
    "gen_ai.tool.call.arguments",
    "tool.input",
    "tool.arguments",
    "mcp.arguments",
)
OUTPUT_PATHS = (
    "output",
    "gen_ai.output",
    "gen_ai.tool.call.result",
    "command.output",
    "command.stdout",
    "command.stderr",
    "tool.output",
    "tool.result",
    "tool.response",
    "tool.stdout",
    "tool.stderr",
    "mcp.result",
    "mcp.response",
)

# Redaction paths per user-facing field. Metadata redacts whole members
# (`prompt`, `error`), standard the exact output paths.
_FIELD_OF_REDACTED_PATH = {
    "prompt": "prompt",
    "prompt.text": "prompt",
    "gen_ai.input": "prompt",
    **{path: "arguments" for path in ARGUMENT_PATHS},
    "file.path": "arguments",
    **{path: "output" for path in OUTPUT_PATHS},
    "error": "error",
    "error.message": "error",
    "file.diff": "diff",
}

_COMPANION_DIGEST = re.compile(r"^\[omitted (\d+) bytes sha256:[0-9a-f]+\]$")


def _at(data: dict, path: str) -> Any:
    node: Any = data
    for key in path.split("."):
        if not isinstance(node, dict) or key not in node:
            return None
        node = node[key]
    return node


def _is_output_descriptor(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and set(value) == {"bytes", "sha256"}
        and isinstance(value["bytes"], int)
    )


def _withheld_bytes(value: Any) -> int | None:
    """The original size when `value` is a companion placeholder, else None."""
    if _is_output_descriptor(value):
        return value["bytes"]
    if isinstance(value, str) and (match := _COMPANION_DIGEST.match(value)):
        return int(match.group(1))
    return None


def _capped(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + _ELLIPSIS


def _preview(data: dict, paths: tuple[str, ...], limit: int) -> str | None:
    for path in paths:
        value = _at(data, path)
        if value is None or value == "" or _withheld_bytes(value) is not None:
            continue
        text = value if isinstance(value, str) else canonical_json(value)
        return _capped(text, limit)
    return None


def argument_preview(data: dict) -> str | None:
    return _preview(data, ARGUMENT_PATHS, ARGS_PREVIEW_CHARS)


def prompt_preview(data: dict) -> str | None:
    return _preview(data, PROMPT_PATHS, PROMPT_PREVIEW_CHARS)


def withheld_content(events: Iterable[dict]) -> dict[str, int | None]:
    """Field → largest original size in bytes (None when unknown) of what
    these events did not send. A redacted path that still holds a value was
    only cut short (an apply_patch envelope, a long error message), not
    withheld."""
    withheld: dict[str, int | None] = {}

    def note(field: str, size: int | None) -> None:
        known = withheld.get(field)
        withheld[field] = max(known or 0, size) if size is not None else known

    for data in events:
        redactions = data.get(REDACTIONS_KEY)
        if isinstance(redactions, dict):
            for path, fingerprint in redactions.items():
                field = _FIELD_OF_REDACTED_PATH.get(path)
                if field is None or _at(data, path) is not None:
                    continue
                # `bytes` is what Backplane received, which may be a companion
                # placeholder; entries from before `original_bytes` know no size.
                size = (
                    fingerprint.get("original_bytes")
                    if isinstance(fingerprint, dict)
                    else None
                )
                note(
                    field,
                    size
                    if isinstance(size, int) and not isinstance(size, bool)
                    else None,
                )
        for field, paths in (
            ("prompt", PROMPT_PATHS),
            ("arguments", ARGUMENT_PATHS),
            ("output", OUTPUT_PATHS),
        ):
            for path in paths:
                size = _withheld_bytes(_at(data, path))
                if size is not None:
                    note(field, size)
    return withheld


def sends_output(data: dict) -> bool:
    return any(
        (value := _at(data, path)) is not None and _withheld_bytes(value) is None
        for path in OUTPUT_PATHS
    )


def exit_code(data: dict) -> int | None:
    code = _at(data, "command.exit_code")
    return code if isinstance(code, int) and not isinstance(code, bool) else None


def reported_duration_ms(data: dict) -> int | None:
    duration = _at(data, "command.duration_ms")
    if isinstance(duration, (int, float)) and not isinstance(duration, bool):
        return int(duration) if 0 <= duration <= MAX_DURATION_MS else None
    native = codex_tool_result(data)
    return native.duration_ms if native else None
