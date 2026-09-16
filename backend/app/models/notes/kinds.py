# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

USER_NOTE = "user_note"
REVIEW_VERDICT = "review_verdict"
SYSTEM = "system"
# Pipeline-role outputs registered in the role-redesign session (2026-05-16).
# PLAN: planner role emits one plan note per backlog card.
# REWORK_BRIEF: rework_mediator distills a reviewer's request_changes verdict
# into a focused brief consumed by the next implementer pass.
PLAN = "plan"
REWORK_BRIEF = "rework_brief"

# Kinds whose notes are append-only audit records — once written, neither the
# author nor any other workspace member may PATCH or DELETE them. Used by the
# Done-gate: orchestrator queries the latest review_verdict to decide whether
# a merged-PR shortcut is allowed.
IMMUTABLE_KINDS = frozenset({REVIEW_VERDICT})
