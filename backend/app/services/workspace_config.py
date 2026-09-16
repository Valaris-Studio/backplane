# Copyright (c) 2026 Valaris Studio
# SPDX-License-Identifier: AGPL-3.0-or-later

import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.event_bus import event_bus
from app.core.events import CONFIG_CHANGED
from app.exceptions import (
    ConflictError,
    ForbiddenError,
    ResourceNotFoundError,
    ValidationError,
)
from app.models.workspace import Workspace
from app.models.workspace_config import WorkspaceConfig
from app.repositories.agents.agent import AgentRepository
from app.repositories.agents.sensor import SensorCatalogRepository
from app.repositories.agents.team import TeamRepository
from app.repositories.workspace_config import WorkspaceConfigRepository
from app.schemas.workspace_config import WorkspaceConfigUpdate
from app.services.agents.context_source_lint import lint_context_source_wiring
from app.services.pipeline_config_validation import (
    canonicalize_pipeline_config,
    validate_pipeline_config,
)


@dataclass(frozen=True)
class RunnerAgentContext:
    name: str
    has_workspace_binding: bool


# 7-role DEFAULT_PIPELINE_CONFIG (promoted from a battle-tested production run,
# 2026-06-08 — adds ui_validator, the rework freshness gate, and server-rendered
# handoff context; board_reconciler added 2026-06-26 as the A1b no-op-loop cure).
# Supersedes the 2026-05-16 5-role redesign.
#
# Source: the production-hardened pipeline. Every new workspace seeds
# this; existing customized configs are left untouched by backfill.
#
# Roles: planner -> implementer -> reviewer -> {rework_mediator | documentator}
#        -> ui_validator (post-merge, on `needs-ui-validation` cards)
#        -> board_reconciler (lowest priority, on `needs-reconcile` cards).
# documentator ships DISABLED (llm.enabled=false, end-only lifecycle) — an
# operator opts in by enabling it. ui_validator checks out integration HEAD
# (checkout_integration_head) so it validates what SHIPS, not the frozen PR.
#
# Handoff context (the 2026-06-08 fix for the "role can't read its input" class):
# inter-role artifacts are pre-rendered server-side via `llm.context_sources`
# rather than fetched by the agent (whose tool allowlist excludes list_notes and
# whose get_project_context returns content-less note summaries). planner
# receives every note linked to the card (card_notes, no kind filter, alias
# CardNotes: research findings + prior plans); implementer + reviewer receive
# the planner's plan note (card_notes/kind=plan, alias PlanNote, referenced as
# `{{ index .ContextSources "PlanNote" }}`); rework_mediator receives the
# reviewer's verdict via `review_history` -> `{{.ReviewHistory}}`.
# Sources are declared on BOTH the stage `llm` block and the lifecycle llm step
# (the load-bearing copy the runner launches with).
# The lifecycle DSL is the single source of truth for every transition. The
# legacy stage-level `on_success` / `on_failure` blocks are NOT emitted here
# (the walker ignores them and the validator's lifecycle_decision_branch
# guards now own the correctness contract).
#
# Model selection uses abstract tier identifiers (`premium`/`mid`/`low`)
# resolved to a concrete (provider, model) tuple by app.services.llm_tiers
# right before /next-assignment is built. Forward-looking constraint:
# DEFAULT must not couple to a specific provider's model names.
#
# Each `claim` step populates `pipeline_role` = the stage's role string.
# The discover filters `skip_if_pipeline_role` / `require_pipeline_role`
# key on this column (F-14 fix). The legacy `participant_role` (hero/helper)
# is demoted to a display-only hint.
#
# Each reviewer decision branch terminates with a card-moving terminal kind
# (move_card) — the FOLLOWUP-13 wedge (card stuck in `review` with no
# participant) is no longer expressible from this default.
#
# Tool deny-list security floor: the dangerous git/PR shell patterns a
# git-capable autonomous agent must NEVER run. Carried opaquely into the
# /next-assignment payload (llm.tool_policy.deny) and applied runner-side per
# provider (Claude `--disallowedTools`, Codex execpolicy rules). This protects
# the review gate — an LLM must not
# self-merge, force-push, or push to main/master. Code-writing / git-capable
# stages (implementer, reviewer, rework_mediator, documentator) carry it.
# Deny-only — there is no allow-list (full access minus deny).
_TOOL_DENY_FLOOR = [
    "Bash(gh pr merge:*)",
    "Bash(gh pr review:*)",
    "Bash(gh pr close:*)",
    "Bash(git push --force:*)",
    "Bash(git push --force-with-lease:*)",
    "Bash(git push origin main:*)",
    "Bash(git push origin master:*)",
    "Bash(git reset --hard:*)",
]


def _tool_policy_floor() -> dict:
    """Fresh deny-floor tool_policy object. Returns a new list each call so the
    8 embed sites in DEFAULT_PIPELINE_CONFIG never share a mutable list."""
    return {"deny": list(_TOOL_DENY_FLOOR)}


# board_reconciler's produces_decision schema. The runner's built-in
# decisionOutputSchema enums `decision` to approve/request_changes — wrong for
# this role, and a HARD FAILURE under Codex's strict --output-schema. This
# overrides it via the stage's llm.output_schema (carried verbatim through
# /next-assignment → llm.Options.OutputSchema). OpenAI-compat (learned from the
# field run 2026-07-25): additionalProperties:false REQUIRES every property in
# `required`, so all four keys are listed and the optional ones are nullable.
# The shape decodes into the runner's genericLLMOutput/reviewResult (same
# decision/summary/findings field names) — only the enum differs.
_RECONCILE_OUTPUT_SCHEMA = (
    '{"type":"object","properties":{'
    '"decision":{"type":"string","enum":["supersede","no_action","repair","park"],'
    '"description":"supersede=scope verifiably already delivered by a cited '
    'sibling card/PR (→Done); no_action=the duplicate suspicion was wrong, unique '
    'undelivered scope remains (→back to implementer); repair=broken/cyclic deps '
    'fixed via MCP tools (→resume); park=unknown repo or needs a human (→blocked)."},'
    '"summary":{"type":"string","description":"One-line disposition rationale."},'
    '"findings":{"type":"string","description":"Evidence. For supersede you MUST '
    'cite the delivering card ID and concrete proof (file/symbol/grep). When in '
    'doubt, choose no_action — never supersede a card that may have unique scope."},'
    '"superseded_by_card_id":{"type":["string","null"],'
    '"description":"For supersede: the card ID whose delivery makes this a '
    'duplicate. null otherwise."}'
    '},"required":["decision","summary","findings","superseded_by_card_id"],'
    '"additionalProperties":false}'
)


DEFAULT_PIPELINE_CONFIG = {
    "version": 1,
    "stages": [
        {
            "role": "planner",
            "unique": True,
            "discover": {
                "strategy": "column_scan",
                "column_type": "backlog",
                "column_type_exclude": "",
                "filters": {
                    "require_git_repo": True,
                    "skip_if_pipeline_role": "planner",
                    "exclude_label": [
                        "planned",
                        "needs-ui-validation",
                        "direct-implement",
                        "blocked",
                        "awaiting-approval",
                        # Parked for board_reconciler — don't re-plan a card
                        # we've already flagged as duplicate / unknown-repo.
                        "needs-reconcile",
                        # Cell #5 loop-breaker: a card the planner already failed
                        # to plan is parked, not re-handed every poll.
                        "planning-failed",
                    ],
                    "no_other_card_in_flight": True,
                    "all_dependencies_done": True,
                },
            },
            "claim": {"participant_role": "helper", "execution_action": "plan_card"},
            "git": {
                "action": "none",
                "branch_prefix": "",
                "create_pr": False,
                "force_push_on_rework": False,
            },
            "llm": {
                "enabled": True,
                "stage": "plan",
                "provider": "claude-cli",
                "model": "premium",
                "post_process_kind": "produces_note",
                "tools": [
                    "mcp__valaris__get_card",
                    "mcp__valaris__get_project_context",
                    "mcp__valaris__log_execution_update",
                ],
                "inject_directives": True,
                "approval_enabled": False,
                "context_sources": [{"kind": "card_notes", "as": "CardNotes", "filter": {"limit": 12}}],
            },
            "sensors": [],
            "lifecycle": [
                {
                    "name": "discover_backlog",
                    "kind": "discover",
                    "params": {
                        "strategy": "column_scan",
                        "column_type": "backlog",
                        "filters": {
                            "require_git_repo": True,
                            "skip_if_pipeline_role": "planner",
                            "exclude_label": [
                                "planned",
                                "needs-ui-validation",
                                "direct-implement",
                                "blocked",
                                "awaiting-approval",
                                "needs-reconcile",
                                # Cell #5 loop-breaker (see role-level filter).
                                "planning-failed",
                            ],
                            "no_other_card_in_flight": True,
                            "all_dependencies_done": True,
                        },
                    },
                    "next": "claim_for_planning",
                },
                {
                    "name": "claim_for_planning",
                    "kind": "claim",
                    "params": {
                        "pipeline_role": "planner",
                        "participant_role": "helper",
                        "execution_action": "plan_card",
                    },
                    "next": "produce_plan",
                },
                {
                    "name": "produce_plan",
                    "kind": "llm",
                    "params": {
                        "stage": "plan",
                        "provider": "claude-cli",
                        "model": "premium",
                        "post_process_kind": "produces_note",
                        "tools": [
                            "mcp__valaris__get_card",
                            "mcp__valaris__get_project_context",
                            "mcp__valaris__log_execution_update",
                        ],
                        "inject_directives": True,
                        "approval_enabled": False,
                        "context_sources": [{"kind": "card_notes", "as": "CardNotes", "filter": {"limit": 12}}],
                    },
                    "next": "write_plan_note",
                    "on_failure": "planner_fail_unassign",
                },
                {
                    "name": "write_plan_note",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "create_note",
                        "args": {
                            "kind": "plan",
                            "body": "$llm_output",
                            "title": "Plan",
                        },
                    },
                    "next": "planner_unassign_self",
                },
                {
                    "name": "planner_unassign_self",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "remove_card_participant",
                        "args": {"user_id": "$self"},
                    },
                    "next": "planner_apply_planned_label",
                },
                {
                    "name": "planner_apply_planned_label",
                    "kind": "apply_label",
                    "params": {"label": "planned"},
                    "next": "planner_ship_to_active",
                },
                {
                    "name": "planner_ship_to_active",
                    "kind": "move_card",
                    "params": {"to_column_type": "active"},
                },
                {
                    "name": "planner_fail_unassign",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "remove_card_participant",
                        "args": {"user_id": "$self"},
                    },
                    "next": "planner_fail_label",
                },
                {
                    "name": "planner_fail_label",
                    "kind": "apply_label",
                    "params": {"label": "planning-failed"},
                    "next": "planner_fail_end",
                },
                {"name": "planner_fail_end", "kind": "end", "params": {}},
            ],
        },
        {
            "role": "implementer",
            "unique": True,
            "discover": {
                "strategy": "unassigned_or_rework",
                "column_type": "active",
                "column_type_exclude": "",
                "filters": {
                    "require_git_repo": True,
                    "skip_if_pipeline_role": "implementer",
                    "all_dependencies_done": True,
                    "exclude_label": [
                        "needs-ui-validation",
                        "blocked",
                        "awaiting-approval",
                        # A1b loop-breaker: a card the implementer parked as
                        # already-delivered / duplicate (cero-dead-code refusal)
                        # is owned by board_reconciler now — never re-discover
                        # it, or it re-hands every poll forever.
                        "needs-reconcile",
                    ],
                },
                "preconditions": ["repo_has_no_open_pr"],
            },
            "claim": {"participant_role": "hero", "execution_action": "implement_card"},
            "git": {
                "action": "create_branch",
                "branch_prefix": "",
                "base_ref": "integration_branch",
                "create_pr": True,
                "force_push_on_rework": True,
            },
            "llm": {
                "enabled": True,
                "stage": "implement",
                "provider": "claude-cli",
                # Mirrors lifecycle[implement_code].params.model — the lifecycle
                # step is authoritative; this flat block is the legacy fallback
                # and must agree (card b8024b15 split-brain guard).
                "model": "premium",
                "tools": [
                    "mcp__valaris__get_card",
                    "mcp__valaris__get_project_context",
                    "mcp__valaris__log_execution_update",
                    "mcp__valaris__request_approval",
                    "mcp__valaris__create_card",
                    "mcp__valaris__create_note",
                    "mcp__valaris__get_approval_status",
                    # P3/P4 (post-run-B): an interim-seam follow-up card is
                    # chained under the board's acceptance card so unfinished
                    # wiring blocks final acceptance.
                    "mcp__valaris__add_card_dependency",
                    # Skills self-improvement: read the catalog, then propose a
                    # distilled methodology — a human decides via the risk-60
                    # approval. NOTE: the skills_proposal_enabled strip applies
                    # only to the LOOP serve path (BoardService.get_loop_config)
                    # — pipeline configs are served unstripped, so this grant is
                    # unconditional here; the approval gate is the backstop.
                    "mcp__valaris__list_skills",
                    "mcp__valaris__get_skill",
                    "mcp__valaris__propose_skill",
                ],
                "inject_directives": True,
                "approval_enabled": True,
                "tool_policy": _tool_policy_floor(),
                "context_sources": [
                    {"kind": "card_notes", "as": "PlanNote", "filter": {"kind": "plan"}}
                ],
            },
            "sensors": [],
            "lifecycle": [
                {
                    "name": "discover_active",
                    "kind": "discover",
                    "params": {
                        "strategy": "unassigned_or_rework",
                        "column_type": "active",
                        "filters": {
                            "require_git_repo": True,
                            "skip_if_pipeline_role": "implementer",
                            "all_dependencies_done": True,
                            "exclude_label": [
                                "needs-ui-validation",
                                "blocked",
                                "awaiting-approval",
                                "needs-reconcile",
                            ],
                        },
                        "preconditions": ["repo_has_no_open_pr"],
                    },
                    "next": "claim_for_implementation",
                },
                {
                    "name": "claim_for_implementation",
                    "kind": "claim",
                    "params": {
                        "pipeline_role": "implementer",
                        "participant_role": "hero",
                        "execution_action": "implement_card",
                    },
                    "next": "setup_feature_branch",
                },
                {
                    "name": "setup_feature_branch",
                    "kind": "git_setup",
                    "params": {
                        "action": "create_branch",
                        "branch_prefix": "",
                        "create_pr": True,
                        "force_push_on_rework": True,
                        "base_ref": "integration_branch",
                    },
                    "next": "materialize_skills",
                },
                {
                    "name": "materialize_skills",
                    "kind": "skills_setup",
                    "params": {},
                    "next": "implement_code",
                },
                {
                    "name": "implement_code",
                    "kind": "llm",
                    "params": {
                        "stage": "implement",
                        "provider": "claude-cli",
                        "model": "premium",
                        "post_process_kind": "writes_code",
                        "tools": [
                            "mcp__valaris__get_card",
                            "mcp__valaris__get_project_context",
                            "mcp__valaris__log_execution_update",
                            "mcp__valaris__request_approval",
                            "mcp__valaris__create_card",
                            "mcp__valaris__create_note",
                            "mcp__valaris__get_approval_status",
                            "mcp__valaris__add_card_dependency",
                            # Mirrors llm.tools above (split-brain guard).
                            "mcp__valaris__list_skills",
                            "mcp__valaris__get_skill",
                            "mcp__valaris__propose_skill",
                        ],
                        "inject_directives": True,
                        "approval_enabled": True,
                        "tool_policy": _tool_policy_floor(),
                        "context_sources": [
                            {
                                "kind": "card_notes",
                                "as": "PlanNote",
                                "filter": {"kind": "plan"},
                            }
                        ],
                    },
                    "next": "open_pr",
                    "on_failure": "implementer_fail_unassign",
                },
                {
                    "name": "open_pr",
                    "kind": "create_pr",
                    "params": {},
                    "next": "wake_reviewer",
                    "on_failure": "implementer_fail_unassign",
                },
                {
                    "name": "wake_reviewer",
                    "kind": "wake_role",
                    "params": {"roles": ["reviewer"]},
                    "next": "ship_to_review",
                },
                {
                    "name": "ship_to_review",
                    "kind": "ship",
                    "params": {"to_column_type": "review"},
                },
                {
                    "name": "implementer_fail_unassign",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "remove_card_participant",
                        "args": {"user_id": "$self"},
                    },
                    "next": "implementer_fail_move_back",
                },
                {
                    "name": "implementer_fail_move_back",
                    "kind": "move_card",
                    "params": {"to_column_type": "active"},
                },
            ],
        },
        {
            "role": "reviewer",
            "unique": True,
            "discover": {
                "strategy": "column_scan",
                "column_type": "review",
                "column_type_exclude": "",
                "filters": {
                    "require_pr_url": True,
                    "skip_if_pipeline_role": "reviewer",
                    "require_git_repo": True,
                    "exclude_label": [
                        "needs-ui-validation",
                        "blocked",
                        "awaiting-approval",
                        # Cell #3 loop-breaker: a card whose review_diff LLM step
                        # failed is parked (review_fail_label), not re-reviewed
                        # every poll.
                        "review-failed",
                    ],
                },
                "preconditions": ["pr_is_open"],
            },
            "claim": {"participant_role": "helper", "execution_action": "review_card"},
            "git": {
                "action": "checkout_pr_branch",
                "branch_prefix": "",
                "create_pr": False,
                "force_push_on_rework": False,
            },
            "llm": {
                "enabled": True,
                "stage": "review",
                "provider": "claude-cli",
                "model": "premium",
                "tools": [
                    "mcp__valaris__get_card",
                    "mcp__valaris__get_project_context",
                    "mcp__valaris__update_card",
                    # P1 (post-run-B): the integration-honesty check verifies a
                    # deferred fake/stub has an EXISTING board card owning its
                    # replacement — that lookup needs search_cards.
                    "mcp__valaris__search_cards",
                ],
                "inject_directives": True,
                "approval_enabled": False,
                "tool_policy": _tool_policy_floor(),
                "context_sources": [
                    {"kind": "card_notes", "as": "PlanNote", "filter": {"kind": "plan"}}
                ],
            },
            "sensors": [],
            "lifecycle": [
                {
                    "name": "discover_review_column",
                    "kind": "discover",
                    "params": {
                        "strategy": "column_scan",
                        "column_type": "review",
                        "filters": {
                            "require_pr_url": True,
                            "skip_if_pipeline_role": "reviewer",
                            "require_git_repo": True,
                            "exclude_label": [
                                "needs-ui-validation",
                                "blocked",
                                "awaiting-approval",
                                # Cell #3 loop-breaker (see role-level filter).
                                "review-failed",
                            ],
                        },
                        "preconditions": ["pr_is_open"],
                    },
                    "next": "claim_for_review",
                },
                {
                    "name": "claim_for_review",
                    "kind": "claim",
                    "params": {
                        "pipeline_role": "reviewer",
                        "participant_role": "helper",
                        "execution_action": "review_card",
                    },
                    "next": "checkout_pr_branch",
                },
                {
                    "name": "checkout_pr_branch",
                    "kind": "git_setup",
                    "params": {
                        "action": "checkout_pr_branch",
                        "create_pr": False,
                        "force_push_on_rework": False,
                    },
                    "next": "materialize_skills",
                },
                {
                    "name": "materialize_skills",
                    "kind": "skills_setup",
                    "params": {},
                    "next": "review_diff",
                },
                {
                    "name": "review_diff",
                    "kind": "llm",
                    "params": {
                        "stage": "review",
                        "provider": "claude-cli",
                        "model": "premium",
                        "post_process_kind": "produces_decision",
                        "tools": [
                            "mcp__valaris__get_card",
                            "mcp__valaris__get_project_context",
                            "mcp__valaris__update_card",
                            "mcp__valaris__search_cards",
                        ],
                        "inject_directives": True,
                        "approval_enabled": False,
                        "tool_policy": _tool_policy_floor(),
                        "context_sources": [
                            {
                                "kind": "card_notes",
                                "as": "PlanNote",
                                "filter": {"kind": "plan"},
                            }
                        ],
                    },
                    "branches": {
                        "approve": "post_pr_review_approve",
                        "request_changes": "post_pr_review_request_changes",
                    },
                    "on_failure": "review_fail_unassign",
                },
                {
                    "name": "post_pr_review_approve",
                    "kind": "post_pr_review",
                    "params": {"decision": "approve"},
                    "next": "merge_the_pr",
                },
                {
                    "name": "merge_the_pr",
                    "kind": "merge_pr",
                    "params": {},
                    "next": "write_approve_verdict",
                    "on_failure": "merge_conflict_unassign_self",
                },
                {
                    "name": "write_approve_verdict",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "create_note",
                        "args": {
                            "kind": "review_verdict",
                            "title": "Review: " "card — " "approve",
                            "body": "$llm_output",
                        },
                    },
                    "next": "approve_move_done",
                },
                {
                    "name": "approve_move_done",
                    "kind": "move_card",
                    "params": {"to_column_type": "done"},
                },
                {
                    "name": "post_pr_review_request_changes",
                    "kind": "post_pr_review",
                    "params": {"decision": "request_changes"},
                    "next": "request_changes_unassign_self",
                },
                {
                    "name": "request_changes_unassign_self",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "remove_card_participant",
                        "args": {"user_id": "$self"},
                    },
                    "next": "request_changes_write_verdict",
                },
                {
                    "name": "request_changes_write_verdict",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "create_note",
                        "args": {
                            "kind": "review_verdict",
                            "body": "$llm_output",
                            "title": "Review: " "card — " "request_changes",
                        },
                    },
                    "next": "wake_rework_mediator",
                },
                {
                    "name": "wake_rework_mediator",
                    "kind": "wake_role",
                    "params": {"roles": ["rework_mediator"]},
                    "next": "request_changes_move_back",
                },
                {
                    "name": "request_changes_move_back",
                    "kind": "move_card",
                    "params": {"to_column_type": "active"},
                },
                {
                    "name": "review_fail_unassign",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "remove_card_participant",
                        "args": {"user_id": "$self"},
                    },
                    "next": "review_fail_label",
                },
                # Cell #3 loop-breaker: park the card with a durable failure
                # label the reviewer discover excludes, so a persistently failing
                # review_diff stops re-looping (mirrors planner_fail_label /
                # rework_fail_label). Unassign-first strips skip_if_pipeline_role,
                # so without this gate the card would be re-handed every poll.
                {
                    "name": "review_fail_label",
                    "kind": "apply_label",
                    "params": {"label": "review-failed"},
                    "next": "review_fail_end",
                },
                {"name": "review_fail_end", "kind": "end", "params": {}},
                {
                    "name": "merge_conflict_unassign_self",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "remove_card_participant",
                        "args": {"user_id": "$self"},
                    },
                    "next": "merge_conflict_write_verdict",
                },
                {
                    "name": "merge_conflict_write_verdict",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "create_note",
                        "args": {
                            "kind": "review_verdict",
                            "title": "Review: "
                            "card — "
                            "request_changes "
                            "(merge "
                            "conflict)",
                            "body": "The "
                            "approving "
                            "review "
                            "passed "
                            "but the "
                            "PR could "
                            "not be "
                            "merged — "
                            "it "
                            "conflicts "
                            "with the "
                            "base "
                            "branch. "
                            "Re-checkout "
                            "the PR "
                            "branch, "
                            "rebase "
                            "or merge "
                            "the base "
                            "branch, "
                            "resolve "
                            "the "
                            "conflicts, "
                            "keep the "
                            "suite "
                            "green, "
                            "and "
                            "re-push "
                            "to the "
                            "SAME "
                            "branch "
                            "so the "
                            "existing "
                            "PR "
                            "becomes "
                            "mergeable.",
                        },
                    },
                    "next": "merge_conflict_wake_mediator",
                },
                {
                    "name": "merge_conflict_wake_mediator",
                    "kind": "wake_role",
                    "params": {"roles": ["rework_mediator"]},
                    "next": "merge_conflict_move_back",
                },
                {
                    "name": "merge_conflict_move_back",
                    "kind": "move_card",
                    "params": {"to_column_type": "active"},
                },
            ],
        },
        {
            "role": "rework_mediator",
            "unique": True,
            "discover": {
                "strategy": "column_scan",
                "column_type": "active",
                "column_type_exclude": "",
                "filters": {
                    "require_git_repo": True,
                    "require_pr_url": True,
                    "require_note_kind": "review_verdict",
                    "skip_if_pipeline_role": "rework_mediator",
                    "require_note_kind_newer_than": {
                        "kind": "review_verdict",
                        "than_kind": "rework_brief",
                    },
                    "exclude_label": [
                        "needs-ui-validation",
                        "blocked",
                        "awaiting-approval",
                        # Cell #4 loop-breaker: a card whose produce_rework_brief
                        # LLM step failed is parked (rework_fail_label already
                        # applies this), not re-mediated every poll.
                        "rework-mediation-failed",
                    ],
                },
                "preconditions": ["pr_is_open"],
            },
            "claim": {
                "participant_role": "helper",
                "execution_action": "mediate_rework",
            },
            "git": {
                "action": "checkout_pr_branch",
                "branch_prefix": "",
                "create_pr": False,
                "force_push_on_rework": False,
            },
            "llm": {
                "enabled": True,
                "stage": "mediate_rework",
                "provider": "claude-cli",
                "model": "premium",
                "post_process_kind": "produces_note",
                "tools": [
                    "mcp__valaris__get_card",
                    "mcp__valaris__get_project_context",
                    "mcp__valaris__log_execution_update",
                ],
                "inject_directives": True,
                "approval_enabled": False,
                "tool_policy": _tool_policy_floor(),
                "context_sources": [{"kind": "review_history"}],
            },
            "sensors": [],
            "lifecycle": [
                {
                    "name": "discover_rework_candidates",
                    "kind": "discover",
                    "params": {
                        "strategy": "column_scan",
                        "column_type": "active",
                        "filters": {
                            "require_git_repo": True,
                            "require_pr_url": True,
                            "require_note_kind": "review_verdict",
                            "skip_if_pipeline_role": "rework_mediator",
                            "require_note_kind_newer_than": {
                                "kind": "review_verdict",
                                "than_kind": "rework_brief",
                            },
                            "exclude_label": [
                                "needs-ui-validation",
                                "blocked",
                                "awaiting-approval",
                                # Cell #4 loop-breaker (see role-level filter).
                                "rework-mediation-failed",
                            ],
                        },
                        "preconditions": ["pr_is_open"],
                    },
                    "next": "claim_for_mediation",
                },
                {
                    "name": "claim_for_mediation",
                    "kind": "claim",
                    "params": {
                        "pipeline_role": "rework_mediator",
                        "participant_role": "helper",
                        "execution_action": "mediate_rework",
                    },
                    "next": "checkout_existing_branch",
                },
                {
                    "name": "checkout_existing_branch",
                    "kind": "git_setup",
                    "params": {
                        "action": "checkout_pr_branch",
                        "create_pr": False,
                        "force_push_on_rework": False,
                    },
                    "next": "materialize_skills",
                },
                {
                    "name": "materialize_skills",
                    "kind": "skills_setup",
                    "params": {},
                    "next": "produce_rework_brief",
                },
                {
                    "name": "produce_rework_brief",
                    "kind": "llm",
                    "params": {
                        "stage": "mediate_rework",
                        "provider": "claude-cli",
                        "model": "premium",
                        "post_process_kind": "produces_note",
                        "tools": [
                            "mcp__valaris__get_card",
                            "mcp__valaris__get_project_context",
                            "mcp__valaris__log_execution_update",
                        ],
                        "inject_directives": True,
                        "approval_enabled": False,
                        "tool_policy": _tool_policy_floor(),
                        "context_sources": [{"kind": "review_history"}],
                    },
                    "next": "write_rework_brief",
                    "on_failure": "rework_fail_unassign",
                },
                {
                    "name": "write_rework_brief",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "create_note",
                        "args": {
                            "kind": "rework_brief",
                            "body": "$llm_output",
                            "title": "Rework " "brief",
                        },
                    },
                    "next": "clear_implementer_hero",
                },
                {
                    "name": "clear_implementer_hero",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "remove_card_participant",
                        "args": {"pipeline_role": "implementer"},
                    },
                    "next": "wake_implementer",
                },
                {
                    "name": "wake_implementer",
                    "kind": "wake_role",
                    "params": {"roles": ["implementer"]},
                    "next": "mediator_unassign_self",
                },
                {
                    "name": "mediator_unassign_self",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "remove_card_participant",
                        "args": {"user_id": "$self"},
                    },
                    "next": "mediator_end",
                },
                {"name": "mediator_end", "kind": "end", "params": {}},
                {
                    "name": "rework_fail_unassign",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "remove_card_participant",
                        "args": {"user_id": "$self"},
                    },
                    "next": "rework_fail_label",
                },
                {
                    "name": "rework_fail_label",
                    "kind": "apply_label",
                    "params": {"label": "rework-mediation-failed"},
                    "next": "rework_fail_end",
                },
                {"name": "rework_fail_end", "kind": "end", "params": {}},
            ],
        },
        {
            "role": "documentator",
            "unique": True,
            "discover": {
                "strategy": "column_scan",
                "column_type": "done",
                "column_type_exclude": "",
                "filters": {
                    "exclude_label": [
                        "documented",
                        "needs-ui-validation",
                        "blocked",
                        "awaiting-approval",
                    ],
                    "require_git_repo": True,
                    "skip_if_pipeline_role": "documentator",
                },
            },
            "claim": {
                "participant_role": "helper",
                "execution_action": "document_card",
            },
            "git": {
                "action": "create_branch",
                "branch_prefix": "docs-",
                "base_ref": "integration_branch",
                "create_pr": False,
                "force_push_on_rework": False,
            },
            "llm": {
                "enabled": False,
                "stage": "document",
                "provider": "claude-cli",
                "model": "mid",
                "tools": [
                    "mcp__valaris__create_note",
                    "mcp__valaris__get_card",
                    "mcp__valaris__get_project_context",
                    "mcp__valaris__list_notes",
                    "mcp__valaris__log_execution_update",
                ],
                "inject_directives": True,
                "approval_enabled": False,
                "tool_policy": _tool_policy_floor(),
            },
            "sensors": [],
            "lifecycle": [
                {"name": "documentator_disabled_end", "kind": "end", "params": {}}
            ],
        },
        {
            "role": "ui_validator",
            "unique": True,
            "discover": {
                "strategy": "column_scan",
                "column_type": "done",
                "column_type_exclude": "",
                "filters": {
                    "include_label": "needs-ui-validation",
                    "require_git_repo": True,
                    "require_pr_url": True,
                    "skip_if_pipeline_role": "ui_validator",
                    "all_dependencies_done": True,
                },
            },
            "claim": {"participant_role": "helper", "execution_action": "validate_ui"},
            "git": {
                "action": "checkout_pr_branch",
                "branch_prefix": "",
                "create_pr": False,
                "force_push_on_rework": False,
            },
            "llm": {
                "enabled": True,
                "stage": "validate_ui",
                "provider": "claude-cli",
                "model": "premium",
                "post_process_kind": "produces_decision",
                "tools": [
                    "mcp__valaris__get_card",
                    "mcp__valaris__get_project_context",
                    "mcp__valaris__create_note",
                    "mcp__valaris__update_card",
                    "mcp__valaris__log_execution_update",
                    "Bash",
                    "Read",
                    "Write",
                    "Edit",
                    "Grep",
                    "Glob",
                    "Skill",
                ],
                "inject_directives": True,
                "approval_enabled": False,
                "tool_policy": _tool_policy_floor(),
            },
            "sensors": [],
            "lifecycle": [
                {
                    "name": "discover_ui_cards",
                    "kind": "discover",
                    "params": {
                        "strategy": "column_scan",
                        "column_type": "done",
                        "filters": {
                            "include_label": "needs-ui-validation",
                            "require_git_repo": True,
                            "require_pr_url": True,
                            "skip_if_pipeline_role": "ui_validator",
                            "all_dependencies_done": True,
                        },
                    },
                    "next": "claim_for_ui_validation",
                },
                {
                    "name": "claim_for_ui_validation",
                    "kind": "claim",
                    "params": {
                        "pipeline_role": "ui_validator",
                        "participant_role": "helper",
                        "execution_action": "validate_ui",
                    },
                    "next": "checkout_ui_branch",
                },
                {
                    "name": "checkout_ui_branch",
                    "kind": "git_setup",
                    "params": {
                        "action": "checkout_pr_branch",
                        "create_pr": False,
                        "force_push_on_rework": False,
                    },
                    "next": "materialize_skills",
                },
                {
                    "name": "materialize_skills",
                    "kind": "skills_setup",
                    "params": {},
                    "next": "drive_ui",
                },
                {
                    "name": "drive_ui",
                    "kind": "llm",
                    "params": {
                        "stage": "validate_ui",
                        "provider": "claude-cli",
                        "model": "premium",
                        "post_process_kind": "produces_decision",
                        "tools": [
                            "mcp__valaris__get_card",
                            "mcp__valaris__get_project_context",
                            "mcp__valaris__create_note",
                            "mcp__valaris__update_card",
                            "mcp__valaris__log_execution_update",
                            "Bash",
                            "Read",
                            "Write",
                            "Edit",
                            "Grep",
                            "Glob",
                            "Skill",
                        ],
                        "inject_directives": True,
                        "approval_enabled": False,
                        "tool_policy": _tool_policy_floor(),
                    },
                    "branches": {
                        "approve": "ui_pass_write_note",
                        "request_changes": "ui_fail_write_note",
                    },
                    "on_failure": "ui_fail_write_note",
                },
                {
                    "name": "ui_pass_write_note",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "create_note",
                        "args": {
                            "kind": "ui_validation",
                            "title": "UI " "validation " "— pass",
                            "body": "$llm_output",
                        },
                    },
                    "next": "ui_pass_create_fix_cards",
                },
                {
                    # Approve-path minor follow-ups are engine-owned too (same
                    # stamp as the fail path) so they land in active/urgent and
                    # get picked next — NOT scattered into backlog by an LLM
                    # create_card call. link_to_source:False skips the
                    # dependency edge: the source is Done, so an edge would
                    # dangle. No-op when the verdict carries no fix_cards.
                    "name": "ui_pass_create_fix_cards",
                    "kind": "create_fix_cards",
                    "params": {
                        "to_column_type": "active",
                        "priority": "urgent",
                        "card_type": "bug",
                        "labels": ["frontend", "ui-fix", "direct-implement", "planned"],
                        "link_to_source": False,
                    },
                    "next": "ui_pass_unassign",
                },
                {
                    "name": "ui_pass_unassign",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "remove_card_participant",
                        "args": {"user_id": "$self"},
                    },
                    "next": "ui_pass_mark_validated",
                },
                {
                    "name": "ui_pass_mark_validated",
                    "kind": "apply_label",
                    "params": {"label": "ui-validated"},
                    "next": "ui_pass_clear_pending",
                },
                {
                    "name": "ui_pass_clear_pending",
                    "kind": "remove_label",
                    "params": {"label": "needs-ui-validation"},
                },
                {
                    "name": "ui_fail_write_note",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "create_note",
                        "args": {
                            "kind": "review_verdict",
                            "title": "UI " "validation " "— fail",
                            "body": "$llm_output",
                        },
                    },
                    "next": "ui_fail_create_fix_cards",
                },
                {
                    "name": "ui_fail_create_fix_cards",
                    "kind": "create_fix_cards",
                    "params": {
                        "to_column_type": "active",
                        "priority": "urgent",
                        "card_type": "bug",
                        "labels": ["frontend", "ui-fix", "direct-implement", "planned"],
                    },
                    "next": "ui_fail_unassign",
                },
                {
                    "name": "ui_fail_unassign",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "remove_card_participant",
                        "args": {"user_id": "$self"},
                    },
                    "next": "ui_fail_end",
                },
                {"name": "ui_fail_end", "kind": "end", "params": {}},
            ],
        },
        {
            # A1b no-op-loop cure. The implementer/planner park a card they
            # cannot close cleanly (scope already delivered by a sibling PR,
            # exact duplicate, unknown repo) with `needs-reconcile` instead of
            # re-looping. This role is the ONLY one that discovers that label
            # and DISPOSES of the card so the scheduler stops re-offering it —
            # mirrors how ui_validator's `needs-ui-validation` arms a lane.
            # White-label MCP-only; reversible dispositions run autonomously,
            # the one irreversible action (delete_card) is reachable solely via
            # the LLM calling request_approval (STOP-before-irreversible).
            "role": "board_reconciler",
            "unique": True,
            "discover": {
                # column_scan with NO column_type → board-wide; the signal is
                # the `include_label`, not the column. A parked card sits in
                # `active` (where the implementer shed it) but the label is what
                # scopes the lane. column_scan (not unassigned_or_rework) so the
                # role can claim a card that still carries a stale hero.
                "strategy": "column_scan",
                "column_type": "",
                "column_type_exclude": "",
                "filters": {
                    "include_label": "needs-reconcile",
                    # skip_if_pipeline_role only guards a card WHILE it carries a
                    # board_reconciler participant — it does NOT survive the
                    # failure path's unassign. `reconciliation-failed` is the
                    # durable loop-breaker for a deterministic LLM-step failure
                    # (FCH-1); it must mirror the lifecycle discover step's
                    # exclude_label byte-for-byte.
                    "skip_if_pipeline_role": "board_reconciler",
                    "exclude_label": [
                        "blocked",
                        "awaiting-approval",
                        "reconciliation-failed",
                    ],
                },
            },
            "claim": {
                "participant_role": "helper",
                "execution_action": "reconcile_card",
            },
            # No branch, no PR: this role never touches working code.
            "git": {
                "action": "none",
                "branch_prefix": "",
                "create_pr": False,
                "force_push_on_rework": False,
            },
            "llm": {
                "enabled": True,
                "stage": "reconcile",
                "provider": "claude-cli",
                # Disposition is judgement but not heavy code work — mid tier.
                "model": "mid",
                # produces_decision (NOT mutates_backlog): the role emits ONE
                # routing decision (supersede/no_action/park/repair) that the
                # lifecycle `branches` route on. The Go walker hard-errors if a
                # non-produces_decision step returns a decision (walker.go), so
                # branches REQUIRE this kind. The board mutations happen in the
                # lifecycle mcp_call steps, not LLM-side persistence.
                "post_process_kind": "produces_decision",
                # The runner's built-in decisionOutputSchema enums decision to
                # approve/request_changes — which would make this role's four
                # dispositions impossible to emit (and HARD-FAIL under Codex's
                # strict --output-schema). Override with the reconcile envelope.
                "output_schema": _RECONCILE_OUTPUT_SCHEMA,
                "tools": [
                    "mcp__valaris__get_card",
                    "mcp__valaris__get_project_context",
                    "mcp__valaris__search_cards",
                    "mcp__valaris__list_card_dependencies",
                    "mcp__valaris__add_card_dependency",
                    "mcp__valaris__remove_card_dependency",
                    "mcp__valaris__validate_board_dependencies",
                    "mcp__valaris__create_note",
                    "mcp__valaris__log_execution_update",
                ],
                "inject_directives": True,
                # The approval flow is only plumbed for stage 'implement'. This
                # role therefore has NO irreversible action in its toolset
                # (delete_card is excluded entirely) — every disposition it can
                # take is reversible board state, so STOP-before-irreversible is
                # satisfied by construction (like dependency_warden). A card that
                # genuinely warrants deletion routes to `park` (→ blocked) for a
                # human, never an autonomous delete.
                "approval_enabled": False,
                "tool_policy": _tool_policy_floor(),
                # No pre-rendered context source: unlike the implementer (handed
                # one authoritative plan note), board_reconciler gathers what it
                # needs itself — get_card, get_project_context, search_cards (to
                # find the delivering sibling), list_card_dependencies.
            },
            "sensors": [],
            "lifecycle": [
                {
                    "name": "discover_reconcile",
                    "kind": "discover",
                    "params": {
                        "strategy": "column_scan",
                        "filters": {
                            "include_label": "needs-reconcile",
                            "skip_if_pipeline_role": "board_reconciler",
                            # Mirrors the role-level exclude_label byte-for-byte —
                            # `reconciliation-failed` is the FCH-1 loop-breaker.
                            "exclude_label": [
                                "blocked",
                                "awaiting-approval",
                                "reconciliation-failed",
                            ],
                        },
                    },
                    "next": "claim_for_reconcile",
                },
                {
                    "name": "claim_for_reconcile",
                    "kind": "claim",
                    "params": {
                        "pipeline_role": "board_reconciler",
                        "participant_role": "helper",
                        "execution_action": "reconcile_card",
                    },
                    "next": "decide_disposition",
                },
                {
                    "name": "decide_disposition",
                    "kind": "llm",
                    "params": {
                        "stage": "reconcile",
                        "provider": "claude-cli",
                        "model": "mid",
                        "post_process_kind": "produces_decision",
                        "output_schema": _RECONCILE_OUTPUT_SCHEMA,
                        "tools": [
                            "mcp__valaris__get_card",
                            "mcp__valaris__get_project_context",
                            "mcp__valaris__search_cards",
                            "mcp__valaris__list_card_dependencies",
                            "mcp__valaris__add_card_dependency",
                            "mcp__valaris__remove_card_dependency",
                            "mcp__valaris__validate_board_dependencies",
                            "mcp__valaris__create_note",
                            "mcp__valaris__log_execution_update",
                        ],
                        "inject_directives": True,
                        "approval_enabled": False,
                        "tool_policy": _tool_policy_floor(),
                    },
                    "branches": {
                        # Verifiably already shipped by a sibling card/PR → Done.
                        "supersede": "supersede_write_verdict",
                        # The refusal was wrong: unique undelivered scope remains
                        # → hand back to the implementer (false-A1b loop-breaker).
                        "no_action": "no_action_write_note",
                        # Unknown repo / needs a human decision → park as blocked.
                        "park": "park_write_note",
                        # Dependencies repaired in-step via MCP tools → resume.
                        "repair": "repair_write_note",
                    },
                    "on_failure": "reconcile_fail_unassign",
                },
                # --- supersede: card is already delivered → Done -------------
                # Ends on move_card (card-moving terminal): the card leaves the
                # active lane, and skip_if_pipeline_role stops re-discovery (the
                # needs-reconcile label is left as an audit breadcrumb — harmless
                # because the card is now in Done and self-skipped).
                {
                    "name": "supersede_write_verdict",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "create_note",
                        "args": {
                            "kind": "review_verdict",
                            "title": "Reconcile — superseded as already delivered",
                            "body": "$llm_output",
                        },
                    },
                    "next": "supersede_apply_label",
                },
                {
                    "name": "supersede_apply_label",
                    "kind": "apply_label",
                    "params": {"label": "superseded"},
                    "next": "supersede_unassign",
                },
                {
                    "name": "supersede_unassign",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "remove_card_participant",
                        "args": {"user_id": "$self"},
                    },
                    "next": "supersede_move_done",
                },
                {
                    "name": "supersede_move_done",
                    "kind": "move_card",
                    "params": {"to_column_type": "done"},
                },
                # --- no_action: false positive → return to the implementer ---
                # The card is already in `active`; we only clear the signal so
                # the implementer's exclude_label stops skipping it. wake_role
                # nudges the implementer; the terminal remove_label drops the
                # signal (and is a card-non-moving terminal, which is correct —
                # the card stays put, it just becomes implementer-eligible).
                {
                    "name": "no_action_write_note",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "create_note",
                        "args": {
                            "kind": "review_verdict",
                            "title": "Reconcile — not a duplicate, returned to active",
                            "body": "$llm_output",
                        },
                    },
                    "next": "no_action_unassign",
                },
                {
                    "name": "no_action_unassign",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "remove_card_participant",
                        "args": {"user_id": "$self"},
                    },
                    "next": "no_action_wake_implementer",
                },
                {
                    "name": "no_action_wake_implementer",
                    "kind": "wake_role",
                    "params": {"roles": ["implementer"]},
                    "next": "no_action_clear_signal",
                },
                {
                    "name": "no_action_clear_signal",
                    "kind": "remove_label",
                    "params": {"label": "needs-reconcile"},
                },
                # --- repair: deps fixed in-step → resume normal pipeline -----
                {
                    "name": "repair_write_note",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "create_note",
                        "args": {
                            "kind": "review_verdict",
                            "title": "Reconcile — dependencies repaired",
                            "body": "$llm_output",
                        },
                    },
                    "next": "repair_unassign",
                },
                {
                    "name": "repair_unassign",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "remove_card_participant",
                        "args": {"user_id": "$self"},
                    },
                    "next": "repair_wake_implementer",
                },
                {
                    "name": "repair_wake_implementer",
                    "kind": "wake_role",
                    "params": {"roles": ["implementer"]},
                    "next": "repair_clear_signal",
                },
                {
                    "name": "repair_clear_signal",
                    "kind": "remove_label",
                    "params": {"label": "needs-reconcile"},
                },
                # --- park: unknown repo / human decision → blocked ----------
                {
                    "name": "park_write_note",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "create_note",
                        "args": {
                            "kind": "review_verdict",
                            "title": "Reconcile — parked for human (blocked)",
                            "body": "$llm_output",
                        },
                    },
                    "next": "park_apply_blocked",
                },
                {
                    "name": "park_apply_blocked",
                    "kind": "apply_label",
                    "params": {"label": "blocked"},
                    "next": "park_unassign",
                },
                {
                    "name": "park_unassign",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "remove_card_participant",
                        "args": {"user_id": "$self"},
                    },
                    "next": "park_clear_signal",
                },
                # The `blocked` label now scopes the card out of this lane
                # (exclude_label) and out of build (a human park), so dropping
                # needs-reconcile is the clean terminal.
                {
                    "name": "park_clear_signal",
                    "kind": "remove_label",
                    "params": {"label": "needs-reconcile"},
                },
                # --- failure: unassign, then PARK with a durable label --------
                # A3b loop-breaker (mirrors reviewer/planner/rework #3/#4/#5):
                # on a deterministic LLM-step failure we must NOT just unassign +
                # leave `needs-reconcile`. `skip_if_pipeline_role` only excludes a
                # card WHILE it carries a board_reconciler participant
                # (assignment_service.py:_skip_if_pipeline_role) — and
                # reconcile_fail_unassign removes exactly that participant. So
                # without a durable label the card is re-discovered, re-claimed,
                # and fails identically every poll: a cost-monotonic re-loop
                # (FCH-1). `reconciliation-failed` is in the discover exclude_label
                # (both the role-level filter and this lifecycle discover step), so
                # the card drops out of discovery until a human / a future
                # recovery lane removes the label (reversible park).
                {
                    "name": "reconcile_fail_unassign",
                    "kind": "mcp_call",
                    "params": {
                        "tool": "remove_card_participant",
                        "args": {"user_id": "$self"},
                    },
                    "next": "reconcile_fail_label",
                },
                {
                    "name": "reconcile_fail_label",
                    "kind": "apply_label",
                    "params": {"label": "reconciliation-failed"},
                    "next": "reconcile_fail_terminal",
                },
                {"name": "reconcile_fail_terminal", "kind": "end", "params": {}},
            ],
        },
    ],
    "scheduling": {
        "mode": "priority",
        "priority_order": [
            "reviewer",
            "rework_mediator",
            "implementer",
            "planner",
            "documentator",
            "ui_validator",
            # Lowest priority: only dispose of parked/duplicate cards when no
            # real build work is pending, so it never starves the pipeline.
            "board_reconciler",
        ],
    },
}

PLATFORM_DEFAULTS = {
    "max_rework_attempts": 3,
    "card_cooldown_hours": 1.0,
    "commit_message_template": "feat({{.CardID}}): {{.Title}}",
    "pr_description_template": "",
    "model_pricing": None,
    "pipeline_config": DEFAULT_PIPELINE_CONFIG,
    "cost_circuit_breaker": None,
    "role_labels": None,
    "conflict_consolidator": None,
    "enforce_done_merge_gate": True,
    # Bumped 0->1 when the default went 5-role -> 6-role (2026-06-08). Lets an
    # operator tell which cohort a workspace was seeded from.
    "version": 1,
}


# Default roles that are SAFE to backfill into an existing stored pipeline_config
# that predates them. A role qualifies only if it is purely ADDITIVE — idle until
# a signal nothing else produces wakes it — so adding it to a board that lacks it
# is inert-until-needed, never disruptive. `board_reconciler` (the A1b/FCH-1 cure)
# fits: lowest priority, fires only on `needs-reconcile`/`reconciliation-failed`
# labels its own producers stamp. Grows only as a role is proven inert-until-
# signaled. (A role keyed on a label that OTHER roles also touch would NOT be safe
# to auto-add.) See runner/docs/config-backfill-design.md.
BACKFILLABLE_DEFAULT_ROLES = ("board_reconciler",)


# A stored config is treated as "default-derived" (and thus eligible for the role
# backfill) only if it carries this core trio — present in every default-seeded
# pipeline since the 5-role era, absent from a bespoke custom pipeline. A stricter
# marker than `implementer` alone (adversarial review #4) so a custom pipeline that
# merely reuses the role name `implementer` is not backfilled.
_DEFAULT_DERIVED_MARKER_ROLES = frozenset({"planner", "implementer", "reviewer"})


def _backfill_default_roles(pipeline_config: dict | None) -> dict | None:
    """Read-time additive role-merge: append any BACKFILLABLE_DEFAULT_ROLES absent
    from a DEFAULT-DERIVED stored config (+ its priority_order entry), so a board
    frozen before a role existed still inherits a purely-additive loop-breaker.

    Conservative by construction — it never mutates an existing stage and only
    touches a config that is recognizably default-derived (carries `implementer`),
    so a hand-rolled custom pipeline is untouched. A config may freeze its role set
    entirely with `lock_roles: true`. Computed on a deepcopy; the stored row is
    never written back (the merge re-applies every read, tracking the default).
    """
    if not pipeline_config:
        return pipeline_config
    if pipeline_config.get("lock_roles"):
        return pipeline_config
    stages = pipeline_config.get("stages") or []
    present_roles = {s.get("role") for s in stages}
    # Marker of a real default-derived pipeline (vs a bespoke custom one): it
    # carries the core default roles. Requiring the trio (not just `implementer`)
    # tightens the discriminator so a custom pipeline that merely happens to name a
    # role `implementer` is NOT backfilled (adversarial review #4). A default-
    # derived board — even a frozen pre-board_reconciler one — has all three.
    if not _DEFAULT_DERIVED_MARKER_ROLES.issubset(present_roles):
        return pipeline_config

    missing = [
        r
        for r in BACKFILLABLE_DEFAULT_ROLES
        if r not in present_roles
    ]
    if not missing:
        return pipeline_config

    import copy

    merged = copy.deepcopy(pipeline_config)
    default_stages = {s["role"]: s for s in DEFAULT_PIPELINE_CONFIG["stages"]}
    sched = merged.setdefault("scheduling", {})
    order = sched.setdefault("priority_order", [])
    for role in missing:
        default_stage = default_stages.get(role)
        if default_stage is None:  # role no longer in the default — nothing to add
            continue
        merged["stages"].append(copy.deepcopy(default_stage))
        if role not in order:
            order.append(role)
    return merged


class WorkspaceConfigService:
    def __init__(self, db: AsyncSession):
        self.db = db
        self.repo = WorkspaceConfigRepository(db)
        self.agent_repo = AgentRepository(db)
        self.team_repo = TeamRepository(db)

    async def resolve_runner_agent_context(
        self,
        *,
        agent_id: uuid.UUID,
        user_id: uuid.UUID,
        workspace_id: uuid.UUID,
        workspace_slug: str,
    ) -> RunnerAgentContext:
        """Resolve a runner without exposing agents outside the caller's scope.

        A complete binding mirrors the runner's effective access: its workspace
        allowlist admits the slug (with the existing null/empty legacy escape)
        and exactly one active team membership selects this workspace. Multiple
        active memberships remain unresolved because agent config currently
        selects the first row without a workspace discriminator.
        """
        agent = await self.agent_repo.get_by_owner_and_id(user_id, agent_id)
        if agent is None:
            raise ResourceNotFoundError("Agent not found")

        active_team_workspace_ids = (
            await self.team_repo.list_active_workspace_ids_for_agent(agent.id)
        )
        scope_allows_workspace = (
            not agent.allowed_workspaces
            or workspace_slug in agent.allowed_workspaces
        )
        has_unambiguous_team = (
            len(active_team_workspace_ids) == 1
            and active_team_workspace_ids[0] == workspace_id
        )
        return RunnerAgentContext(
            name=agent.name,
            has_workspace_binding=(
                scope_allows_workspace and has_unambiguous_team
            ),
        )

    async def _context_source_warnings(
        self, workspace_id: uuid.UUID, pipeline_config: dict | None
    ) -> list[dict]:
        """Run the context-source ↔ prompt wiring lint for the workspace.

        Loads authored prompt contents and cross-checks declared context
        sources against their consuming prompts. Returns serializable
        warning findings (never blocks).
        """
        if not pipeline_config:
            return []
        from app.services.agents.prompt_config import PromptConfigService

        prompt_contents = await PromptConfigService(self.db).load_prompt_contents(
            workspace_id
        )
        return [
            dict(f)
            for f in lint_context_source_wiring(pipeline_config, prompt_contents)
        ]

    async def get_config(
        self, workspace_id: uuid.UUID, include_warnings: bool = True
    ) -> dict:
        """Return the effective workspace config.

        `include_warnings=False` skips the context-source lint — which loads and
        parses ALL authored prompt contents on every call — for the runner's
        next_assignment hot path, which polls this per cycle and never reads the
        warnings. The config-backfill levers (null-pipeline seed + additive
        default-role merge) still run in BOTH modes: they mutate/compute config,
        not lint output. Default True keeps the API/UI response byte-identical.
        """
        config = await self.repo.get_by_workspace(workspace_id)
        if config:
            if config.pipeline_config is None:
                await self.update_config(
                    workspace_id,
                    WorkspaceConfigUpdate(pipeline_config=DEFAULT_PIPELINE_CONFIG),
                    _seed_defaults=True,
                )
                config = await self.repo.get_by_workspace(workspace_id)
            # Read-time additive role-merge: a board frozen before a purely-
            # additive default role (e.g. board_reconciler, the A1b/FCH-1 cure)
            # existed inherits it without a migration or a re-push. Computed on a
            # copy; the stored row is untouched. Run BEFORE the context-source
            # lint so warnings reflect the effective config.
            effective_pipeline = _backfill_default_roles(config.pipeline_config)
            warnings = (
                await self._context_source_warnings(workspace_id, effective_pipeline)
                if include_warnings
                else []
            )
            return {
                "max_rework_attempts": config.max_rework_attempts,
                "card_cooldown_hours": config.card_cooldown_hours,
                "commit_message_template": config.commit_message_template,
                "pr_description_template": config.pr_description_template,
                "model_pricing": config.model_pricing,
                "pipeline_config": effective_pipeline,
                "cost_circuit_breaker": config.cost_circuit_breaker,
                "role_labels": config.role_labels,
                "conflict_consolidator": config.conflict_consolidator,
                "enforce_done_merge_gate": config.enforce_done_merge_gate,
                "completion_policy": config.completion_policy,
                "version": config.version,
                "context_source_warnings": warnings,
            }
        return PLATFORM_DEFAULTS.copy()

    async def update_config(
        self, workspace_id: uuid.UUID, data: WorkspaceConfigUpdate,
        *, actor_id: uuid.UUID | None = None, _seed_defaults: bool = False,
    ) -> dict:
        """Update or create workspace config. Bumps version on change."""
        update_dict = data.model_dump(exclude_unset=True)
        sensitive_fields = {"completion_policy", "pipeline_config"}
        policy_service = None
        completion_boards = []
        if sensitive_fields.intersection(update_dict):
            from app.services.completion_policy import CompletionPolicyService

            policy_service = CompletionPolicyService(self.db)
            # Serialize before reading the optimistic version or deciding
            # whether a pipeline controls explicit completion work.
            await policy_service.repo.lock_workspace(workspace_id)
            config = await policy_service.repo.workspace_config(workspace_id, lock=True)
            completion_boards = await policy_service.repo.boards(workspace_id, lock=True)
            if _seed_defaults:
                if update_dict != {"pipeline_config": DEFAULT_PIPELINE_CONFIG}:
                    raise ValidationError("Default seeding may only initialize the platform pipeline")
                if config is not None and config.pipeline_config is not None:
                    return await self.get_config(workspace_id)
            elif "pipeline_config" in update_dict and (
                (config is not None and config.completion_policy is not None)
                or any(board.completion_policy is not None for board in completion_boards)
            ):
                await policy_service.authorize(workspace_id, actor_id, operator=True)
        else:
            config = await self.repo.get_by_workspace(workspace_id)
        if "completion_policy" in update_dict:
            from app.services.completion_policy import CompletionPolicyService
            await CompletionPolicyService(self.db).validate_workspace_policy(
                workspace_id, actor_id, data.completion_policy,
            )
        # The workspace-wide done-merge gate is the FIELD an agent must never
        # write (either direction), same as board PATCH — but the route stays
        # open to agent keys because the runner legitimately writes other
        # config fields. Checked before anything is applied so a gate write
        # smuggled in a mixed payload lands nothing. Lazy import as in
        # kanban/board.py: core.auth and the service layer load each other
        # lazily.
        from app.core.auth import current_agent_id

        if (
            "enforce_done_merge_gate" in update_dict
            and current_agent_id.get() is not None
        ):
            raise ForbiddenError(
                "Only a human workspace admin may change the workspace-wide "
                "done-merge gate — not an agent key",
                error_code="admin_required",
            )
        # Optimistic-concurrency guard: if the caller pinned a version, the
        # persisted record must still match. Stale writes get 409 with
        # error_code `stale_version`, which the UI branches on to prompt
        # reload-vs-override.
        expected_version = update_dict.pop("expected_version", None)
        if (
            expected_version is not None
            and config
            and config.version != expected_version
        ):
            raise ConflictError(
                f"Config version mismatch: expected {expected_version}, "
                f"current {config.version}",
                error_code="stale_version",
                context={
                    "current_version": config.version,
                    "expected_version": expected_version,
                },
            )
        if not update_dict:
            return await self.get_config(workspace_id)

        pipeline_config = update_dict.get("pipeline_config")
        if pipeline_config is not None:
            canonicalize_pipeline_config(pipeline_config)
            known_sensors = await self._known_sensor_names(workspace_id)
            findings = validate_pipeline_config(pipeline_config, known_sensors)
            # Only block on errors; warnings are informational (deprecations,
            # decision-branch hints) and the UI surfaces them separately.
            blocking = [e for e in findings if e.get("severity", "error") == "error"]
            if blocking:
                raise ValidationError(detail=[dict(e) for e in blocking])

        if policy_service is not None and not _seed_defaults:
            from app.services.completion import CompletionService
            changed = {field for field in sensitive_fields.intersection(update_dict)
                       if getattr(config, field, None) != update_dict[field]}
            for board in completion_boards:
                if "pipeline_config" in changed or ("completion_policy" in changed and board.completion_policy is None):
                    await CompletionService(self.db).invalidate_board(board, "Workspace completion configuration changed")

        if config:
            update_dict["version"] = config.version + 1
            await self.repo.update(config, **update_dict)
        else:
            if "pipeline_config" not in update_dict:
                update_dict["pipeline_config"] = DEFAULT_PIPELINE_CONFIG
            new_config = WorkspaceConfig(workspace_id=workspace_id, **update_dict)
            self.db.add(new_config)
            await self.db.flush()
            await self.db.refresh(new_config)

        await event_bus.publish(
            CONFIG_CHANGED,
            {
                "entity": "workspace_config",
                "action": "updated",
                "entity_id": str(workspace_id),
            },
            workspace_id=workspace_id,
        )
        return await self.get_config(workspace_id)

    async def export_pipeline(
        self, workspace_id: uuid.UUID, workspace_slug: str
    ) -> dict:
        from app.services.export.envelope import build_envelope

        config = await self.repo.get_by_workspace(workspace_id)
        pipeline_config = config.pipeline_config if config else None
        version = config.version if config else 0
        empty = pipeline_config is None
        return build_envelope(
            entity_type="pipeline",
            source_workspace_slug=workspace_slug,
            data={
                "pipeline_config": pipeline_config or {},
                "version": version,
                "empty": empty,
            },
        )

    async def _known_sensor_names(self, workspace_id: uuid.UUID) -> set[str] | None:
        """Return sensor names reported by agents in the workspace, or None.

        None signals "no catalog available — skip sensor-name validation".
        The platform treats agents as the source of truth for which sensors
        exist; when no agent has reported, we can't reject configs that
        reference custom sensors.
        """
        slug = await self.db.scalar(
            select(Workspace.slug).where(Workspace.id == workspace_id)
        )
        if not slug:
            return None
        catalogs = await SensorCatalogRepository(self.db).list_catalogs_for_workspace(
            slug
        )
        if not catalogs:
            return None
        names: set[str] = set()
        for catalog in catalogs:
            for entry in catalog:
                name = entry.get("name") if isinstance(entry, dict) else None
                if isinstance(name, str) and name:
                    names.add(name)
        return names or None
