// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package lifecycle

import (
	"context"
	"errors"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// TestDefaultPipelineLifecycle_OrchestratorWalks mirrors the orchestrator
// lifecycle in backend/app/services/workspace_config.py:DEFAULT_PIPELINE_CONFIG
// after the LIFECYCLE-1 A.3 migration. The walker must traverse the whole
// chain — discover → claim → git_setup → llm → move_card — and stop cleanly
// at the terminal move_card. Handler bodies are stubs so this test exercises
// the routing, not the real side-effects (which live in workloop and are
// covered by back_compat_lifecycle_test.go).
//
// If the Python migration drifts from this Go fixture, the parity check in
// backend tests/services/test_default_pipeline_config_lifecycle.py + the
// step-name asserts here keep both sides honest.
func TestDefaultPipelineLifecycle_OrchestratorWalks(t *testing.T) {
	var calls []string
	withHandlers(t, map[string]Handler{
		"discover":          recordCalls(&calls, "discover", ""),
		"claim":             recordCalls(&calls, "claim", ""),
		"git_setup":         recordCalls(&calls, "git_setup", ""),
		"llm":               recordCalls(&calls, "llm", ""),
		"create_pr":         recordCalls(&calls, "create_pr", ""),
		"enable_auto_merge": recordCalls(&calls, "enable_auto_merge", ""),
		"ship":              recordCalls(&calls, "ship", ""),
	})

	steps := orchestratorDefaultLifecycle()

	ws := &WalkState{}
	if err := (Walker{}).Walk(context.Background(), ws, steps); err != nil {
		t.Fatalf("Walk: %v", err)
	}
	want := []string{
		"discover:discover_unassigned",
		"claim:claim_card",
		"git_setup:git_setup_branch",
		"llm:implement",
		"create_pr:create_pr_for_card",
		"enable_auto_merge:arm_auto_merge",
		"ship:ship_to_review",
	}
	if !equalSlice(calls, want) {
		t.Errorf("orchestrator lifecycle = %v, want %v", calls, want)
	}
}

// TestDefaultPipelineLifecycle_ReviewerBothBranches verifies the reviewer's
// produces_decision branching: approve routes to move_card(done),
// request_changes routes to create_note. The migration's correctness rests on
// this branching, so we exercise both paths.
func TestDefaultPipelineLifecycle_ReviewerBothBranches(t *testing.T) {
	for _, tc := range []struct {
		decision string
		want     []string
	}{
		{
			decision: "approve",
			want: []string{
				"discover:discover_review_column",
				"claim:claim_for_review",
				"git_setup:checkout_pr_branch",
				"llm:review_diff",
				"post_pr_review:post_pr_review_approve",
				"merge_pr:merge_the_pr",
				"wake_role:wake_documentator",
				"move_card:approve_move_done",
			},
		},
		{
			decision: "request_changes",
			want: []string{
				"discover:discover_review_column",
				"claim:claim_for_review",
				"git_setup:checkout_pr_branch",
				"llm:review_diff",
				"post_pr_review:post_pr_review_request_changes",
				"mcp_call:request_changes_unassign_self",
				"create_note:request_changes_create_note",
			},
		},
	} {
		t.Run(tc.decision, func(t *testing.T) {
			var calls []string
			withHandlers(t, map[string]Handler{
				"discover":       recordCalls(&calls, "discover", ""),
				"claim":          recordCalls(&calls, "claim", ""),
				"git_setup":      recordCalls(&calls, "git_setup", ""),
				"llm":            recordCalls(&calls, "llm", tc.decision),
				"move_card":      recordCalls(&calls, "move_card", ""),
				"create_note":    recordCalls(&calls, "create_note", ""),
				"wake_role":      recordCalls(&calls, "wake_role", ""),
				"mcp_call":       recordCalls(&calls, "mcp_call", ""),
				"post_pr_review": recordCalls(&calls, "post_pr_review", ""),
				"merge_pr":       recordCalls(&calls, "merge_pr", ""),
			})

			steps := reviewerDefaultLifecycle()
			ws := &WalkState{}
			if err := (Walker{}).Walk(context.Background(), ws, steps); err != nil {
				t.Fatalf("Walk: %v", err)
			}
			if !equalSlice(calls, tc.want) {
				t.Errorf("decision=%s walk = %v, want %v", tc.decision, calls, tc.want)
			}
		})
	}
}

// TestDefaultPipelineLifecycle_ReviewerMergeConflictSelfHeals verifies that an
// approving review whose MERGE FAILS (conflicting PR) routes into the rework
// self-heal edge instead of returning an error (which would orphan the open PR
// and board-wide-block every implementer via repo_has_no_open_pr). The walk
// must: drop self, write a merge-conflict verdict, wake the mediator, and end at
// move_card(active) — NOT bubble the merge error up to failWithConfig.
func TestDefaultPipelineLifecycle_ReviewerMergeConflictSelfHeals(t *testing.T) {
	var calls []string
	withHandlers(t, map[string]Handler{
		"discover":       recordCalls(&calls, "discover", ""),
		"claim":          recordCalls(&calls, "claim", ""),
		"git_setup":      recordCalls(&calls, "git_setup", ""),
		"llm":            recordCalls(&calls, "llm", "approve"),
		"post_pr_review": recordCalls(&calls, "post_pr_review", ""),
		"merge_pr": func(_ context.Context, _ *WalkState, step *valaris.LifecycleStep) (string, string, error) {
			calls = append(calls, "merge_pr:"+step.Name)
			return "", "", errors.New("merge failed: CONFLICTING")
		},
		"wake_role": recordCalls(&calls, "wake_role", ""),
		"mcp_call":  recordCalls(&calls, "mcp_call", ""),
		"move_card": recordCalls(&calls, "move_card", ""),
	})

	steps := reviewerDefaultLifecycle()
	ws := &WalkState{}
	if err := (Walker{}).Walk(context.Background(), ws, steps); err != nil {
		t.Fatalf("Walk should self-heal a merge conflict, not error: %v", err)
	}
	want := []string{
		"discover:discover_review_column",
		"claim:claim_for_review",
		"git_setup:checkout_pr_branch",
		"llm:review_diff",
		"post_pr_review:post_pr_review_approve",
		"merge_pr:merge_the_pr",
		"mcp_call:merge_conflict_unassign_self",
		"mcp_call:merge_conflict_write_verdict",
		"wake_role:merge_conflict_wake_mediator",
		"move_card:merge_conflict_move_back",
	}
	if !equalSlice(calls, want) {
		t.Errorf("merge-conflict walk = %v, want %v", calls, want)
	}
	// The walker records the merge error so the verdict note can surface it.
	if le, ok := ws.Get("last_error"); !ok || le == "" {
		t.Errorf("walker must set last_error on the failing merge step; got %v (ok=%v)", le, ok)
	}
}

// TestDefaultPipelineLifecycle_DocumentatorWalks: linear chain ending at
// apply_label (terminal).
func TestDefaultPipelineLifecycle_DocumentatorWalks(t *testing.T) {
	var calls []string
	withHandlers(t, map[string]Handler{
		"discover":    recordCalls(&calls, "discover", ""),
		"claim":       recordCalls(&calls, "claim", ""),
		"git_setup":   recordCalls(&calls, "git_setup", ""),
		"llm":         recordCalls(&calls, "llm", ""),
		"apply_label": recordCalls(&calls, "apply_label", ""),
		"end": func(_ context.Context, _ *WalkState, _ *valaris.LifecycleStep) (string, string, error) {
			return "", "", nil
		},
	})

	steps := documentatorDefaultLifecycle()
	ws := &WalkState{}
	if err := (Walker{}).Walk(context.Background(), ws, steps); err != nil {
		t.Fatalf("Walk: %v", err)
	}
	want := []string{
		"discover:discover_done_column",
		"claim:claim_for_docs",
		"git_setup:setup_docs_branch",
		"llm:generate_docs",
		"apply_label:label_documented",
	}
	if !equalSlice(calls, want) {
		t.Errorf("documentator lifecycle = %v, want %v", calls, want)
	}
}

// TestDefaultPipelineLifecycle_DocumentatorFailureRoutes: when generate_docs
// fails, the walker routes through fail_unassign_self → fail_mark_failed,
// mirroring legacy on_failure {stay_in_column, unassign} behavior.
func TestDefaultPipelineLifecycle_DocumentatorFailureRoutes(t *testing.T) {
	var calls []string
	withHandlers(t, map[string]Handler{
		"discover":  recordCalls(&calls, "discover", ""),
		"claim":     recordCalls(&calls, "claim", ""),
		"git_setup": recordCalls(&calls, "git_setup", ""),
		"llm": func(_ context.Context, _ *WalkState, step *valaris.LifecycleStep) (string, string, error) {
			calls = append(calls, "llm:"+step.Name)
			return "", "", errors.New("doc gen blew up")
		},
		"mcp_call":    recordCalls(&calls, "mcp_call", ""),
		"apply_label": recordCalls(&calls, "apply_label", ""),
		"end": func(_ context.Context, _ *WalkState, _ *valaris.LifecycleStep) (string, string, error) {
			return "", "", nil
		},
	})

	steps := documentatorDefaultLifecycle()
	ws := &WalkState{}
	if err := (Walker{}).Walk(context.Background(), ws, steps); err != nil {
		t.Fatalf("Walk: %v", err)
	}
	want := []string{
		"discover:discover_done_column",
		"claim:claim_for_docs",
		"git_setup:setup_docs_branch",
		"llm:generate_docs",
		"mcp_call:fail_unassign_self",
		"apply_label:fail_mark_failed",
	}
	if !equalSlice(calls, want) {
		t.Errorf("documentator failure walk = %v, want %v", calls, want)
	}
	if ws.GetString("last_error") != "doc gen blew up" {
		t.Errorf("last_error = %q, want %q", ws.GetString("last_error"), "doc gen blew up")
	}
}

// --- Lifecycle fixtures (Go mirror of DEFAULT_PIPELINE_CONFIG.lifecycle) ---
//
// Kept terse — these are intentionally close-as-possible to the Python literal
// so a diff against workspace_config.py is mechanical. If the migration grows
// fields, update both sides + the kind tests in workloop.

func orchestratorDefaultLifecycle() []valaris.LifecycleStep {
	return []valaris.LifecycleStep{
		{Name: "discover_unassigned", Kind: "discover", Next: "claim_card",
			Params: map[string]any{
				"strategy":            "unassigned_or_rework",
				"column_type":         "",
				"column_type_exclude": "done",
				"filters":             map[string]any{"require_git_repo": true},
				"preconditions":       []any{"repo_has_no_open_pr"},
			}},
		{Name: "claim_card", Kind: "claim", Next: "git_setup_branch",
			Params: map[string]any{
				"participant_role": "hero",
				"execution_action": "implement_card",
			}},
		{Name: "git_setup_branch", Kind: "git_setup", Next: "implement",
			Params: map[string]any{
				"action":               "create_branch",
				"branch_prefix":        "",
				"create_pr":            true,
				"force_push_on_rework": true,
				"base_ref":             "integration_branch",
			}},
		{Name: "implement", Kind: "llm", Next: "create_pr_for_card",
			Params: map[string]any{
				"stage":             "implement",
				"provider":          "claude-cli",
				"model":             "sonnet",
				"post_process_kind": "writes_code",
				"inject_directives": true,
				"approval_enabled":  true,
				"tools": []any{
					"mcp__valaris__get_card",
					"mcp__valaris__get_project_context",
					"mcp__valaris__log_execution_update",
					"mcp__valaris__request_approval",
				},
			}},
		{Name: "create_pr_for_card", Kind: "create_pr", Next: "arm_auto_merge",
			Params: map[string]any{}},
		{Name: "arm_auto_merge", Kind: "enable_auto_merge", Next: "ship_to_review",
			Params: map[string]any{}},
		{Name: "ship_to_review", Kind: "ship",
			Params: map[string]any{"to_column_type": "review"}},
	}
}

func reviewerDefaultLifecycle() []valaris.LifecycleStep {
	return []valaris.LifecycleStep{
		{Name: "discover_review_column", Kind: "discover", Next: "claim_for_review",
			Params: map[string]any{
				"strategy":            "column_scan",
				"column_type":         "review",
				"column_type_exclude": "",
				"filters": map[string]any{
					"require_pr_url":           true,
					"skip_if_participant_role": "reviewer",
					"require_git_repo":         true,
				},
			}},
		{Name: "claim_for_review", Kind: "claim", Next: "checkout_pr_branch",
			Params: map[string]any{
				"participant_role": "helper",
				"execution_action": "review_card",
			}},
		{Name: "checkout_pr_branch", Kind: "git_setup", Next: "review_diff",
			Params: map[string]any{
				"action":               "checkout_pr_branch",
				"branch_prefix":        "",
				"create_pr":            false,
				"force_push_on_rework": false,
			}},
		{Name: "review_diff", Kind: "llm",
			Branches: map[string]string{
				"approve":         "post_pr_review_approve",
				"request_changes": "post_pr_review_request_changes",
			},
			Params: map[string]any{
				"stage":             "review",
				"provider":          "claude-cli",
				"model":             "sonnet",
				"post_process_kind": "produces_decision",
				"inject_directives": true,
				"approval_enabled":  false,
				"tools": []any{
					"mcp__valaris__get_card",
					"mcp__valaris__get_project_context",
				},
			}},
		{Name: "post_pr_review_approve", Kind: "post_pr_review", Next: "merge_the_pr",
			Params: map[string]any{"decision": "approve"}},
		{Name: "merge_the_pr", Kind: "merge_pr", Next: "wake_documentator",
			OnFailure: "merge_conflict_unassign_self",
			Params:    map[string]any{}},
		{Name: "wake_documentator", Kind: "wake_role", Next: "approve_move_done",
			Params: map[string]any{"roles": []any{"documentator"}}},
		{Name: "approve_move_done", Kind: "move_card",
			Params: map[string]any{"to_column_type": "done"}},
		{Name: "post_pr_review_request_changes", Kind: "post_pr_review", Next: "request_changes_unassign_self",
			Params: map[string]any{"decision": "request_changes"}},
		{Name: "request_changes_unassign_self", Kind: "mcp_call", Next: "request_changes_create_note",
			Params: map[string]any{
				"tool": "remove_card_participant",
				"args": map[string]any{"user_id": "$self"},
			}},
		{Name: "request_changes_create_note", Kind: "create_note",
			Params: map[string]any{"from_llm_output": true}},
		// merge_the_pr on_failure subtree (mirrors the request_changes chain):
		// a failed/conflicting merge routes here so the PR is never orphaned.
		{Name: "merge_conflict_unassign_self", Kind: "mcp_call", Next: "merge_conflict_write_verdict",
			Params: map[string]any{
				"tool": "remove_card_participant",
				"args": map[string]any{"user_id": "$self"},
			}},
		{Name: "merge_conflict_write_verdict", Kind: "mcp_call", Next: "merge_conflict_wake_mediator",
			Params: map[string]any{
				"tool": "create_note",
				"args": map[string]any{
					"kind": "review_verdict",
				},
			}},
		{Name: "merge_conflict_wake_mediator", Kind: "wake_role", Next: "merge_conflict_move_back",
			Params: map[string]any{"roles": []any{"rework_mediator"}}},
		{Name: "merge_conflict_move_back", Kind: "move_card",
			Params: map[string]any{"to_column_type": "active"}},
	}
}

func documentatorDefaultLifecycle() []valaris.LifecycleStep {
	return []valaris.LifecycleStep{
		{Name: "discover_done_column", Kind: "discover", Next: "claim_for_docs",
			Params: map[string]any{
				"strategy":            "column_scan",
				"column_type":         "done",
				"column_type_exclude": "",
				"filters": map[string]any{
					"exclude_label":    "documented",
					"require_git_repo": true,
				},
			}},
		{Name: "claim_for_docs", Kind: "claim", Next: "setup_docs_branch",
			Params: map[string]any{
				"participant_role": "helper",
				"execution_action": "document_card",
			}},
		{Name: "setup_docs_branch", Kind: "git_setup", Next: "generate_docs",
			Params: map[string]any{
				"action":               "create_branch",
				"branch_prefix":        "docs-",
				"create_pr":            false,
				"force_push_on_rework": false,
				"base_ref":             "integration_branch",
			}},
		{Name: "generate_docs", Kind: "llm", Next: "label_documented",
			OnFailure: "fail_unassign_self",
			Params: map[string]any{
				"stage":             "document",
				"provider":          "claude-cli",
				"model":             "sonnet",
				"post_process_kind": "writes_code",
				"inject_directives": false,
				"approval_enabled":  false,
				"tools": []any{
					"mcp__valaris__create_note",
					"mcp__valaris__get_card",
					"mcp__valaris__get_project_context",
					"mcp__valaris__list_notes",
					"mcp__valaris__log_execution_update",
				},
			}},
		{Name: "label_documented", Kind: "apply_label", Next: "ok_end",
			Params: map[string]any{"label": "documented"}},
		{Name: "ok_end", Kind: "end"},
		{Name: "fail_unassign_self", Kind: "mcp_call", Next: "fail_mark_failed",
			Params: map[string]any{
				"tool": "remove_card_participant",
				"args": map[string]any{"user_id": "$self"},
			}},
		{Name: "fail_mark_failed", Kind: "apply_label", Next: "fail_end",
			Params: map[string]any{"label": "documentation-failed"}},
		{Name: "fail_end", Kind: "end"},
	}
}
