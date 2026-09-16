# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Canonical card-outcome taxonomy (Cluster I).

The pipeline historically expressed only two outcomes — SUCCESS (commit + PR
+ review) and FAILURE (unassign → reset → retry). Distinct real-world events
were funnelled into the FAILURE path and got the same destructive recovery,
which is wrong for events where the work is recoverable or the card is merely
waiting:

  success           the stage produced its deliverable; advance the card.
  suspend_budget    a per-pass budget/turn cutoff hit mid-work — the work is
                    typically ~80% done. Checkpoint + resume, do NOT wipe.
  needs_research    the planner (or any role) cannot proceed without an answer
                    it does not have. Park the card; resume when answered.
  approval_pending  a human decision is required and not yet made. Park the
                    card structurally so re-pickups don't re-file duplicates.
  failed            an unrecoverable error; the only outcome that keeps the
                    legacy wipe-and-retry semantics.

This module is the BACKEND reference for the taxonomy. The Go runner emits
these outcomes in a later session; the formal cross-language enum + emit path
land with that work. Here we only need the closed value-set plus the
terminal/parked split that the scheduler and lifecycle reason about.
"""

from __future__ import annotations

SUCCESS = "success"
SUSPEND_BUDGET = "suspend_budget"
NEEDS_RESEARCH = "needs_research"
APPROVAL_PENDING = "approval_pending"
FAILED = "failed"

CARD_OUTCOMES = frozenset(
    {SUCCESS, SUSPEND_BUDGET, NEEDS_RESEARCH, APPROVAL_PENDING, FAILED}
)

# Terminal outcomes end the card's pipeline pass. Parked outcomes (the
# complement) hold the card for a later wake — resume from a checkpoint, the
# research landing, or the approval being decided.
_TERMINAL_OUTCOMES = frozenset({SUCCESS, FAILED})


def is_terminal(outcome: str) -> bool:
    """True iff `outcome` ends the card's pipeline pass.

    Raises ValueError for an outcome outside CARD_OUTCOMES — callers route on
    the result, so a typo must surface loudly rather than silently park.
    """
    if outcome not in CARD_OUTCOMES:
        raise ValueError(
            f"unknown card outcome {outcome!r} (expected one of "
            f"{sorted(CARD_OUTCOMES)})"
        )
    return outcome in _TERMINAL_OUTCOMES
