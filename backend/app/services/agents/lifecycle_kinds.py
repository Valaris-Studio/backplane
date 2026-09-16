# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

"""Closed registry of lifecycle step kinds for the generic role-lifecycle walker.

This module is the **source of truth** for what step kinds the runner can
execute. Roles, prompts, stage names, models, and step composition are open;
the kind set is closed — new kinds require a runner deploy because each kind
maps to a server-side or runner-side handler.

Mirror: ``runner/internal/lifecycle/kinds.go``. The parity test at
``tests/services/agents/test_lifecycle_kinds_parity.py`` keeps both sides in
sync. Update both files together.
"""

from __future__ import annotations

from typing import TypedDict


class KindSchema(TypedDict):
    name: str
    params_schema: dict
    produces_decision: bool
    terminal: bool


# Param schemas use a deliberately loose JSON-schema-ish shape — enough for a
# UI editor to render input controls and for the validator to typecheck known
# keys. Unknown keys are tolerated for forward compatibility.
_PARAM_TYPE_STRING = {"type": "string"}
_PARAM_TYPE_BOOL = {"type": "boolean"}
_PARAM_TYPE_LIST_STRING = {"type": "array", "items": {"type": "string"}}
_PARAM_TYPE_OBJECT = {"type": "object"}


LIFECYCLE_KINDS: dict[str, KindSchema] = {
    "discover": {
        "name": "discover",
        "params_schema": {
            "strategy": {
                "type": "string",
                "enum": ["unassigned_or_rework", "column_scan", "label_scan"],
            },
            "column_type": _PARAM_TYPE_STRING,
            "column_type_exclude": _PARAM_TYPE_STRING,
            "filters": _PARAM_TYPE_OBJECT,
            "preconditions": _PARAM_TYPE_LIST_STRING,
        },
        "produces_decision": False,
        "terminal": False,
    },
    "claim": {
        "name": "claim",
        "params_schema": {
            # `pipeline_role` is the F-14 canonical: the discover filters
            # `skip_if_pipeline_role` / `require_pipeline_role` key on this.
            # Required in new configs (validator emits a warning when omitted —
            # see pipeline_config_validation.py). The legacy `participant_role`
            # (hero/helper) is demoted to a display-only hint.
            "pipeline_role": _PARAM_TYPE_STRING,
            "participant_role": {"type": "string", "enum": ["hero", "helper"]},
            "execution_action": _PARAM_TYPE_STRING,
        },
        "produces_decision": False,
        "terminal": False,
    },
    "git_setup": {
        "name": "git_setup",
        "params_schema": {
            "action": {
                "type": "string",
                "enum": [
                    "create_branch",
                    "checkout_pr_branch",
                    "checkout_integration_head",
                    "none",
                ],
            },
            "branch_prefix": _PARAM_TYPE_STRING,
            "create_pr": _PARAM_TYPE_BOOL,
            "force_push_on_rework": _PARAM_TYPE_BOOL,
            "base_ref": {
                "type": "string",
                "enum": ["default_branch", "integration_branch"],
            },
        },
        "produces_decision": False,
        "terminal": False,
    },
    # skills_setup materializes the board's effective skills (the manifest
    # bundled on NextAssignmentResponse.skills) into the working tree before
    # the LLM runs. Sync contract: mirrored in
    # runner/internal/lifecycle/kinds.go — update both files together.
    "skills_setup": {
        "name": "skills_setup",
        "params_schema": {},
        "produces_decision": False,
        "terminal": False,
    },
    "llm": {
        "name": "llm",
        "params_schema": {
            "stage": _PARAM_TYPE_STRING,
            "provider": _PARAM_TYPE_STRING,
            "model": _PARAM_TYPE_STRING,
            "tools": _PARAM_TYPE_LIST_STRING,
            "post_process_kind": {
                "type": "string",
                "enum": [
                    "writes_code",
                    "produces_decision",
                    "produces_note",
                    "mutates_backlog",
                ],
            },
            "inject_directives": _PARAM_TYPE_BOOL,
            "approval_enabled": _PARAM_TYPE_BOOL,
            "use_minimal_prompt_when_unauthored": _PARAM_TYPE_BOOL,
        },
        # produces_decision is configuration-dependent for `llm` (only when
        # post_process_kind == "produces_decision"). The kind-level flag here
        # reflects the *maximum* surface — branches are accepted by the
        # validator. The runtime walker re-checks the post_process_kind.
        "produces_decision": True,
        "terminal": False,
    },
    "sensor": {
        "name": "sensor",
        "params_schema": {
            "name": _PARAM_TYPE_STRING,
            "config": _PARAM_TYPE_OBJECT,
            "on_pass": _PARAM_TYPE_STRING,
            "on_fail": _PARAM_TYPE_STRING,
        },
        "produces_decision": True,
        "terminal": False,
    },
    "move_card": {
        "name": "move_card",
        "params_schema": {
            "to_column_type": {
                "type": "string",
                "enum": ["backlog", "active", "review", "done", "blocked"],
            },
        },
        "produces_decision": False,
        "terminal": True,
    },
    "apply_label": {
        "name": "apply_label",
        "params_schema": {"label": _PARAM_TYPE_STRING},
        "produces_decision": False,
        # Non-terminal so labels can chain into a real terminal (e.g.
        # apply_label("planned") -> move_card("active") closes the planner
        # handoff without an operator promoting the card by hand). Sites
        # that genuinely want to stop after labeling chain to the `end`
        # no-op terminal below.
        "terminal": False,
    },
    "remove_label": {
        "name": "remove_label",
        "params_schema": {"label": _PARAM_TYPE_STRING},
        "produces_decision": False,
        "terminal": True,
    },
    "create_note": {
        "name": "create_note",
        # Phase 4 of the LLM-lifecycle contract: the runner owns note-writing.
        # `kind` is the note registry key (review_verdict / plan / rework_brief /
        # …); `body_from` selects which LLM-output channel the runner copies
        # into the note body. `from_llm_output` (the legacy bool flag) is
        # removed — pipeline configs carrying it are hard-rejected by the
        # validator with a migration hint.
        "params_schema": {
            "kind": {"type": "string", "required": True},
            "title": _PARAM_TYPE_STRING,
            "body_from": {
                "type": "string",
                "enum": ["findings", "raw", "summary", "decision"],
            },
            "failure_class": _PARAM_TYPE_STRING,
        },
        "produces_decision": False,
        "terminal": True,
    },
    "enqueue_for_merge": {
        "name": "enqueue_for_merge",
        "params_schema": {"strategy": _PARAM_TYPE_STRING},
        "produces_decision": False,
        "terminal": True,
    },
    "mcp_call": {
        "name": "mcp_call",
        "params_schema": {
            "tool": _PARAM_TYPE_STRING,
            "args": _PARAM_TYPE_OBJECT,
        },
        "produces_decision": False,
        "terminal": False,
    },
    # create_fix_cards reads the prior produces_decision step's structured
    # `fix_cards[]` and creates one board card per entry — an auditor role
    # (e.g. ui_validator) filing follow-up work when it fails a done card.
    # `to_column_type` selects where new cards land (default "active" so the
    # implementer grabs them directly); `labels` + `priority` are the fixed
    # stamp applied to every card (routing via `direct-implement` keeps the
    # planner off small fixes). Non-terminal: it chains into the label swap
    # that records the audit verdict on the validated card.
    "create_fix_cards": {
        "name": "create_fix_cards",
        "params_schema": {
            "to_column_type": {
                "type": "string",
                "enum": ["backlog", "active", "review", "done", "blocked"],
            },
            "labels": _PARAM_TYPE_LIST_STRING,
            "priority": {
                "type": "string",
                "enum": ["none", "low", "medium", "high", "urgent"],
            },
            "card_type": _PARAM_TYPE_STRING,
        },
        "produces_decision": False,
        "terminal": False,
    },
    "branch": {
        "name": "branch",
        "params_schema": {
            "expression": _PARAM_TYPE_STRING,
            "cases": _PARAM_TYPE_OBJECT,
        },
        "produces_decision": True,
        "terminal": False,
    },
    "wake_role": {
        "name": "wake_role",
        "params_schema": {
            "roles": _PARAM_TYPE_LIST_STRING,
        },
        "produces_decision": False,
        "terminal": False,
    },
    # PR-lifecycle kinds (LIFECYCLE-FOLLOWUP-4). Each handler is a thin shim
    # over an existing Loop / git.Manager helper. title_from / body_from on
    # create_pr and post_pr_review are reserved for future template support;
    # the runner ignores them today and pulls fixed defaults (card.Title,
    # llmResult summary/findings).
    "create_pr": {
        "name": "create_pr",
        "params_schema": {
            "title_from": _PARAM_TYPE_STRING,
            "body_from": _PARAM_TYPE_STRING,
        },
        "produces_decision": False,
        "terminal": False,
    },
    "enable_auto_merge": {
        "name": "enable_auto_merge",
        "params_schema": {
            "strategy": {"type": "string", "enum": ["merge", "squash", "rebase"]},
        },
        "produces_decision": False,
        "terminal": False,
    },
    "merge_pr": {
        "name": "merge_pr",
        "params_schema": {
            "strategy": {"type": "string", "enum": ["merge", "squash", "rebase"]},
        },
        "produces_decision": False,
        "terminal": False,
    },
    "post_pr_review": {
        "name": "post_pr_review",
        "params_schema": {
            "decision": {
                "type": "string",
                "enum": ["approve", "request_changes", "comment"],
            },
            "body_from": _PARAM_TYPE_STRING,
            "mode": {"type": "string", "enum": ["github", "comment"]},
        },
        "produces_decision": False,
        "terminal": False,
    },
    "ship": {
        "name": "ship",
        "params_schema": {
            "to_column_type": {
                "type": "string",
                "enum": ["backlog", "active", "review", "done", "blocked"],
            },
        },
        "produces_decision": False,
        "terminal": True,
    },
    # No-op terminal. Lets a non-terminal kind that should stop the walk
    # (e.g. apply_label as the last meaningful step in a failure subtree)
    # point at an explicit terminator instead of being terminal-by-default.
    "end": {
        "name": "end",
        "params_schema": {},
        "produces_decision": False,
        "terminal": True,
    },
}


# ── Operator-facing knowledge ────────────────────────────────────────────────
# Distilled from the runner's real handlers (runner/internal/workloop/kind_*.go)
# so the frontend can explain WHAT each step does and WHEN to use it — the
# pipeline is only configurable "with knowledge" if the editor teaches the kinds.
# These are DATA (English, like the kind names themselves), shipped through
# GET /api/config/lifecycle-kinds alongside the schema. Kept SEPARATE from
# LIFECYCLE_KINDS so the Go parity test (names + flags only) is untouched.
#
# Contract: every kind in LIFECYCLE_KINDS MUST have an entry here (completeness
# gated by test_config_lifecycle_kinds.py). `gotcha` is optional — present only
# where there's a real, non-obvious trap.


class KindDoc(TypedDict, total=False):
    summary: str
    when_to_use: str
    gotcha: str


KIND_DOCS: dict[str, KindDoc] = {
    "discover": {
        "summary": "Finds the next eligible card for this role and reserves it — "
        "the entry point of every role's run.",
        "when_to_use": "As the first step of a role, to pull work using the "
        "stage's discover strategy (unassigned/rework, column scan, or label scan).",
        "gotcha": "Params are ignored at runtime — discovery uses the stage's "
        "discover/filters/preconditions config, not the step's params. When no "
        "card matches, the role's run ends cleanly (idle), it does not error.",
    },
    "claim": {
        "summary": "Takes ownership of the discovered card, opening an execution "
        "record the rest of the run logs against.",
        "when_to_use": "Right after discover, before any step that does real work "
        "(LLM, git, notes) — nothing downstream can run without a claim.",
        "gotcha": "`pipeline_role` is the canonical role key that discover's "
        "require_pipeline_role / skip_if_pipeline_role filters match on; set it or "
        "sibling roles can't coordinate. `participant_role` (hero/helper) is only a "
        "display hint now.",
    },
    "git_setup": {
        "summary": "Prepares the working tree — clones the repo and creates or "
        "checks out the branch the LLM will edit.",
        "when_to_use": "Before an LLM step that writes code, or before opening a "
        "PR; skip it for read-only roles (a reviewer that only comments).",
        "gotcha": "`base_ref` must match what create_pr targets (integration_branch "
        "vs default_branch) or the PR silently retargets main and bypasses "
        "integration.",
    },
    "skills_setup": {
        "summary": "Copies the board's bound workspace skills into the working "
        "tree so the coding agent can load them during the LLM step.",
        "when_to_use": "Between git_setup and an LLM step, so the materialized "
        "skills land inside the freshly prepared working tree.",
        "gotcha": "A board with no bound skills is a clean no-op — the "
        "assignment bundle carries no manifest and the step just passes "
        "through; it never fails the run over an empty set.",
    },
    "llm": {
        "summary": "Runs the coding agent for a named stage with its authored "
        "prompt — the step that actually thinks, writes code, or judges.",
        "when_to_use": "The core of most roles: implement, review, plan, reconcile. "
        "The `stage` names which prompt to load and which model tier applies.",
        "gotcha": "It only branches the pipeline when post_process_kind is "
        "`produces_decision` (e.g. a reviewer's approve/request_changes); "
        "writes_code stages return no decision. With no authored prompt the stage "
        "soft-skips via the `no_prompt` branch — wire it for a graceful path.",
    },
    "sensor": {
        "summary": "Runs a single programmatic check and branches on its pass/fail "
        "result — a deterministic gate, no LLM.",
        "when_to_use": "To guard a stage on an objective condition (tests green, "
        "a file exists, a threshold met) before proceeding.",
        "gotcha": "Returns the on_pass / on_fail string as the decision — wire both "
        "to real next steps or a fail silently dead-ends.",
    },
    "move_card": {
        "summary": "Moves the card to a column by type (backlog/active/review/"
        "done/blocked) and ends the role's run for this card.",
        "when_to_use": "As a terminal step to hand the card to the next stage of "
        "the board (e.g. a planner moving a card to active).",
        "gotcha": "A force-blocked card is only allowed to move to `blocked` — any "
        "other target is skipped so a fail-move can't undo the cost-breaker park.",
    },
    "apply_label": {
        "summary": "Adds a label to the card (idempotent — a no-op if already "
        "present).",
        "when_to_use": "To stamp routing/audit signals other roles key on "
        "(e.g. `planned`, `needs-ui-validation`), usually chained before a move.",
        "gotcha": "Deliberately NON-terminal so it can chain into a real terminal "
        "(apply_label → move_card). A label-add backend error is logged, not "
        "fatal — labels are bookkeeping.",
    },
    "remove_label": {
        "summary": "Removes a label from the card and ends the run "
        "(no-op if absent).",
        "when_to_use": "To clear a routing/state label once a stage is done with "
        "it (e.g. dropping a `rework` flag after a successful re-run).",
    },
    "create_note": {
        "summary": "Writes a typed note onto the card (a review verdict, plan, or "
        "rework brief) and ends the run.",
        "when_to_use": "To persist an LLM step's structured output as durable "
        "board context the next role reads.",
        "gotcha": "`kind` is required (a closed-set note type) and `body_from` "
        "selects which LLM channel fills the body; an empty resolved body is a "
        "hard error, not a silent skip.",
    },
    "enqueue_for_merge": {
        "summary": "Submits the card's PR to the backend merge queue and ends "
        "the run.",
        "when_to_use": "When merges are serialized through the platform queue "
        "rather than merged directly by the runner.",
        "gotcha": "On enqueue failure it errors to the walker — wire an on_failure "
        "or branch if you want fail-soft; the legacy swallow behavior is gone.",
    },
    "mcp_call": {
        "summary": "Invokes a generic backend tool that has no dedicated kind of "
        "its own.",
        "when_to_use": "Only as an escape hatch — reach for a specialized kind "
        "(move_card, apply_label, create_note) first; they're better-typed and "
        "survive validation.",
        "gotcha": "The runner supports a closed set of tools; an unknown tool "
        "errors the run rather than no-op'ing.",
    },
    "create_fix_cards": {
        "summary": "Reads the prior decision step's fix list and files one blocker "
        "card per finding against the source card.",
        "when_to_use": "In an auditor role (e.g. ui_validator) to turn a "
        "request_changes verdict into concrete follow-up work.",
        "gotcha": "On a request_changes verdict that filed zero fixes it synthesizes "
        "one umbrella card, so the source→fix dependency always exists — otherwise "
        "the auditor loops on the same unfixed card. Non-terminal: it chains into "
        "the verdict label swap.",
    },
    "branch": {
        "summary": "Routes to a named next step by matching a variable's value "
        "against a case table — an explicit go-to.",
        "when_to_use": "When you need to route on something the closed kinds don't "
        "emit (e.g. a custom mcp_call output).",
        "gotcha": "Minimal expression language (${var}, ${last_decision}, or a "
        "literal); unknown values fall to cases['default'] then step.next. Not a "
        "real expression engine.",
    },
    "wake_role": {
        "summary": "Clears sibling roles' idle cooldown so they pick up downstream "
        "work on the next tick instead of waiting out their backoff.",
        "when_to_use": "After a handoff (e.g. planner → implementer) to make the "
        "next role react immediately rather than after its poll interval.",
        "gotcha": "A silent no-op on a single-role runner and for unknown role "
        "names — it's a latency optimization, not a hard dependency.",
    },
    "create_pr": {
        "summary": "Opens a pull request for the code the prior LLM step pushed.",
        "when_to_use": "After a writes_code LLM step, in a role that ships via PR.",
        "gotcha": "Base branch comes from the same resolver as git_setup — they "
        "must agree or the PR retargets the repo default and bypasses integration. "
        "Stores the PR url for downstream steps.",
    },
    "enable_auto_merge": {
        "summary": "A retired no-op — kept in the registry only so old configs "
        "referencing it don't fail to start.",
        "when_to_use": "Don't add it to new pipelines. Merges happen via the "
        "reviewer's explicit merge_pr after an approve verdict.",
        "gotcha": "Does nothing at runtime: it depended on a GitHub-only feature "
        "and was dropped for the git-provider-agnostic north star.",
    },
    "merge_pr": {
        "summary": "Merges the card's PR directly (or hands it to the merge queue "
        "when the workspace routes merges through the queue).",
        "when_to_use": "In a reviewer role, after an approve verdict, as the real "
        "merge path.",
        "gotcha": "A thin merge — it does NOT retry-on-rebase or route-to-blocked "
        "on failure; compose those via on_failure → create_note + move_card.",
    },
    "post_pr_review": {
        "summary": "Mirrors the reviewer's verdict onto the PR itself via the forge "
        "(a GitHub review or a comment).",
        "when_to_use": "After a review LLM step, to make the verdict visible on the "
        "PR, not just on the card.",
        "gotcha": "Defaults the decision to the last decision step's output; "
        "fail-soft — skipped cleanly when the card has no PR or forge review is off, "
        "and gh errors are logged, not fatal.",
    },
    "ship": {
        "summary": "The canonical end-of-stage step for a hero role — moves the "
        "card to its next column AND stamps PR/branch metadata onto it.",
        "when_to_use": "As the terminal step of an implementer-style role that "
        "produced a PR (defaults the card to the review column).",
        "gotcha": "Prefer ship over a bare move_card for hero roles: move_card only "
        "moves the card, ship also records the PR/branch footer the reviewer needs.",
    },
    "end": {
        "summary": "An explicit no-op terminator that stops the run without any "
        "side effect.",
        "when_to_use": "To end a non-terminal step's branch cleanly (e.g. after an "
        "apply_label at the tail of a failure subtree) instead of relying on "
        "terminal-by-default.",
    },
}


def is_known_kind(kind: str) -> bool:
    return kind in LIFECYCLE_KINDS


def kind_produces_decision(kind: str) -> bool:
    schema = LIFECYCLE_KINDS.get(kind)
    return bool(schema and schema["produces_decision"])


def kind_is_terminal(kind: str) -> bool:
    schema = LIFECYCLE_KINDS.get(kind)
    return bool(schema and schema["terminal"])
