# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""The `loop-template:` stamp — how an execution says which template ran it.

A loop template's track record (spec §2.3) is DERIVED from executions, never
hand-written, so it must survive detach, rebind and version upgrades. That
means the attribution has to live on the durable row, not on the binding: a
binding that is later detached would take the history with it.

`agent_executions` has no generic metadata column, so the stamp reuses
`prompt_slug` (operator Direction 2026-08-16: no migration — the column's
meaning is already "the prompt the runner rendered", and the activity feed
already displays it). The `loop-template:` prefix keeps the namespace clear of
the pipeline prompt slugs that share the column.

Both halves of the feature go through this module so the writer (stamping at
`start_execution`) and the reader (aggregating the track record) can never
drift onto different key formats.
"""

import re

STAMP_PREFIX = "loop-template:"

# The four outcomes a loop iteration can report, plus the bucket for rows
# written before the convention existed. Order is the reporting order.
LOOP_OUTCOMES = (
    "worked",
    "nothing_ready",
    "blocked_on_human",
    "objective_complete",
)
UNKNOWN_OUTCOME = "unknown"

# The runner writes the outcome as a token at the HEAD of output_summary
# (`fmt.Sprintf("outcome=%s %s — %s", ...)` in workloop/loopmode.go), so this
# is anchored: a bare `%outcome=worked%` search would also match an iteration
# whose PROSE quotes another run's outcome.
_OUTCOME_HEAD = re.compile(
    rf"^outcome=({'|'.join(LOOP_OUTCOMES)})\b",
    re.IGNORECASE,
)


def parse_outcome(output_summary: str | None) -> str:
    """The outcome a loop iteration reported, or `unknown`."""
    if not output_summary:
        return UNKNOWN_OUTCOME
    match = _OUTCOME_HEAD.match(output_summary.strip())
    return match.group(1).lower() if match else UNKNOWN_OUTCOME


def count_outcomes(output_summaries) -> dict[str, int]:
    """Tally outcomes with every bucket present, so a zero reads as a zero
    rather than as a missing key the caller has to guess about."""
    counts = {outcome: 0 for outcome in (*LOOP_OUTCOMES, UNKNOWN_OUTCOME)}
    for summary in output_summaries:
        counts[parse_outcome(summary)] += 1
    return counts


def template_key(source: str, slug: str, version: int) -> str:
    """The stamp written to `AgentExecution.prompt_slug` for a bound loop.

    Version is part of the key so a template's track record can be read either
    per-version or across versions (prefix match) — an upgrade must not look
    like a different template, and a v1 run must not be credited to v3.
    """
    return f"{STAMP_PREFIX}{source}/{slug}@{version}"


def binding_template_key(binding) -> str | None:
    """The stamp for a board's loop-template binding, or None if unbindable.

    `template_ref` is free-form JSON on the binding row, so a malformed or
    partial ref yields no stamp rather than a key with an empty segment that
    would silently split one template's history in two.
    """
    if binding is None:
        return None
    ref = binding.template_ref or {}
    source = ref.get("source")
    slug = ref.get("slug")
    if not source or not slug or binding.version is None:
        return None
    return template_key(str(source), str(slug), int(binding.version))
