# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Cluster I — canonical card-outcome taxonomy.

The pipeline historically knew only success vs failure. Distinct real-world
events (budget exhaustion, planner needs-research, an undecided approval) were
coerced into the failure path → destructive recovery. The taxonomy names them
so each can route to its own non-destructive handling.

This slice is the *backend reference* for the taxonomy (the Go runner emits
the outcomes in a later session). It is a thin, closed value-set — the formal
enum + emit path land with the runner work.
"""

from __future__ import annotations

from app.services.scheduling import outcomes


def test_card_outcomes_is_the_closed_taxonomy():
    assert outcomes.CARD_OUTCOMES == frozenset(
        {
            "success",
            "suspend_budget",
            "needs_research",
            "approval_pending",
            "failed",
        }
    )


def test_success_and_failed_are_terminal_the_rest_are_parked():
    # Terminal outcomes end the card's pipeline pass; parked outcomes hold the
    # card for a later wake (resume / research lands / approval decided).
    assert outcomes.is_terminal("success")
    assert outcomes.is_terminal("failed")
    assert not outcomes.is_terminal("suspend_budget")
    assert not outcomes.is_terminal("needs_research")
    assert not outcomes.is_terminal("approval_pending")


def test_is_terminal_rejects_unknown_outcome():
    import pytest

    with pytest.raises(ValueError):
        outcomes.is_terminal("not_an_outcome")
