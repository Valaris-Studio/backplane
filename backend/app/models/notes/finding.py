# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Severity-tiered reviewer rubric (SWE-AF #3).

Reviewer verdicts attach a structured `findings` list — each finding carries a
severity tier that the done-gate uses to derive `approved` deterministically:

    approved = tests_pass AND no BLOCKING findings

The three tiers are deliberately closed so the gate stays a simple boolean
predicate. SHOULD_FIX is intentionally non-blocking — it's a strong signal to
the implementer but never holds up a merge by itself; that's what BLOCKING is
for. The advisor / rework planner consumes SHOULD_FIX as "fix-next" signal.
"""

from enum import Enum


class FindingSeverity(str, Enum):
    # Must fix before merge: broken tests, security holes, contract violations,
    # anything that makes the change unsafe to ship.
    BLOCKING = "BLOCKING"

    # Strong suggestion: correctness edge cases, missing tests, code that works
    # but the reviewer thinks should be improved. Does NOT block approval —
    # the implementer and downstream advisor decide whether to address now.
    SHOULD_FIX = "SHOULD_FIX"

    # Nit: style, naming, micro-refactors. Never blocks. Surfaced for
    # information only.
    SUGGESTION = "SUGGESTION"


FINDING_SEVERITY_VALUES: frozenset[str] = frozenset(s.value for s in FindingSeverity)
