# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Exact-block inclusion of server-rendered context in the final prompt bytes.

A source counts as included only where its ENTIRE rendered block occurs
byte-for-byte; escaped, partial or templated forms are not inclusion. This
proves byte presence, not semantic use or which template branch produced it.
Matching is on UTF-8 bytes: a complete UTF-8 needle can only match at
character boundaries, so offsets are always valid UTF-8 positions.
"""

from __future__ import annotations

from dataclasses import dataclass

CHANNELS = ("input", "system")


@dataclass(frozen=True)
class InclusionResult:
    source_inclusions: list[dict]
    injected_bytes: dict[str, int]
    missing_required: list[int]


def _occurrences(haystack: bytes, needle: bytes) -> list[tuple[int, int]]:
    # Step one byte so overlapping self-occurrences are each reported.
    spans, start = [], 0
    while (index := haystack.find(needle, start)) != -1:
        spans.append((index, index + len(needle)))
        start = index + 1
    return spans


def _union_length(intervals: list[tuple[int, int]]) -> int:
    total, covered_to = 0, -1
    for start, end in sorted(intervals):
        if end <= covered_to:
            continue
        total += end - max(start, covered_to)
        covered_to = end
    return total


def verify_inclusion(
    blocks: list[str], required: list[bool], aliases: list[str], *, input_prompt: str, system_prompt: str
) -> InclusionResult:
    channel_bytes = {"input": input_prompt.encode("utf-8"), "system": system_prompt.encode("utf-8")}
    admitted: dict[str, list[tuple[int, int]]] = {channel: [] for channel in CHANNELS}
    inclusions, missing = [], []
    for index, (block, is_required, alias) in enumerate(zip(blocks, required, aliases, strict=True)):
        needle = block.encode("utf-8")
        spans = [
            {"channel": channel, "start": start, "end": end}
            for channel in CHANNELS
            for start, end in (_occurrences(channel_bytes[channel], needle) if needle else [])
        ]
        if spans:
            outcome, contribution = "exact", sum(s["end"] - s["start"] for s in spans)
            for span in spans:
                admitted[span["channel"]].append((span["start"], span["end"]))
        elif is_required:
            missing.append(index)
            outcome, contribution = "exact_block_not_observed", None
        elif not needle:
            outcome, contribution = "empty", 0
        else:
            outcome, contribution = "exact_block_not_observed", None
        inclusions.append({
            "source_index": index, "alias": alias, "required": is_required,
            "outcome": outcome, "spans": spans, "contribution_bytes": contribution,
        })
    injected = {channel: _union_length(admitted[channel]) for channel in CHANNELS}
    injected["total"] = injected["input"] + injected["system"]
    return InclusionResult(source_inclusions=inclusions, injected_bytes=injected, missing_required=missing)
