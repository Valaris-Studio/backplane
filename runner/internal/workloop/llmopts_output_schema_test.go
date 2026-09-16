// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// Per-stage output schema resolution mirrors model + tool-deny dispatch: the
// backend authors a custom decision schema per stage (board_reconciler ships
// supersede/no_action/repair/park) and carries it on AssignmentLLM.OutputSchema.
// llmOpts must flow it into llm.Options so the produces_decision dispatch
// (strategy_generic.go:1388 — `if opts.OutputSchema == "" { opts.OutputSchema =
// decisionOutputSchema }`) PREFERS the backend schema and only falls back to the
// default approve/request_changes schema when the stage declares none.
//
// Uses newModelTestLoop (defined in loop_per_role_model_test.go) so llmOpts has
// a real strategy + cfg, exactly like the model/tool-deny dispatch tests.

const reconcileSchema = `{"type":"object","properties":{"decision":{"type":"string","enum":["supersede","no_action","repair","park"]},"summary":{"type":"string"},"findings":{"type":"string"}},"required":["decision","summary","findings"],"additionalProperties":false}`

func TestOutputSchema_PrefersAssignmentOverDefault(t *testing.T) {
	loop := newModelTestLoop(t, "yaml-default")
	assignment := valaris.AssignmentLLM{Provider: "claude-cli", Model: "mid", PromptSlug: "reconcile"}
	assignment.OutputSchema = reconcileSchema
	loop.SetAssignmentLLM(assignment)

	opts := loop.llmOpts("reconcile")
	if opts.OutputSchema != reconcileSchema {
		t.Fatalf("llmOpts must carry the backend per-stage output schema; got %q want the reconcile schema", opts.OutputSchema)
	}

	// The produces_decision guard (strategy_generic.go:1388) must NOT overwrite a
	// present backend schema with the approve/request_changes default.
	if opts.OutputSchema == "" {
		opts.OutputSchema = decisionOutputSchema
	}
	if opts.OutputSchema != reconcileSchema {
		t.Error("backend reconcile schema must win — the produces_decision guard must not overwrite a non-empty OutputSchema")
	}
	if opts.OutputSchema == decisionOutputSchema {
		t.Error("reconcile stage must not receive the approve/request_changes default schema")
	}
}

func TestOutputSchema_FallsBackToDefaultWhenBackendOmitsIt(t *testing.T) {
	// A reviewer/ui_validator stage declares no schema → OutputSchema empty, so
	// the produces_decision guard falls back to decisionOutputSchema. An old
	// backend omits the field entirely → empty string, identical behavior.
	loop := newModelTestLoop(t, "yaml-default")
	loop.SetAssignmentLLM(valaris.AssignmentLLM{Provider: "claude-cli", Model: "premium", PromptSlug: "review"})

	opts := loop.llmOpts("review")
	if opts.OutputSchema != "" {
		t.Fatalf("llmOpts must leave OutputSchema empty when the backend declares none; got %q", opts.OutputSchema)
	}

	if opts.OutputSchema == "" {
		opts.OutputSchema = decisionOutputSchema
	}
	if opts.OutputSchema != decisionOutputSchema {
		t.Errorf("a schema-less produces_decision stage must fall back to decisionOutputSchema; got %q", opts.OutputSchema)
	}
}

func TestOutputSchema_EmptyWhenNoAssignment(t *testing.T) {
	// No SetAssignmentLLM (pre-rollout backend / non-assignment code path) → the
	// field is the zero value, never garbage.
	loop := newModelTestLoop(t, "yaml-default")
	if opts := loop.llmOpts("implement"); opts.OutputSchema != "" {
		t.Errorf("OutputSchema must be empty with no assignment; got %q", opts.OutputSchema)
	}
}

// decodeDecisionEnvelope must preserve a non-enum reconcile decision verbatim —
// coercion to request_changes fires ONLY on an empty/unparseable decision (the
// loop.go fail-safe). Without this, supersede/no_action/repair/park would be
// silently rewritten to request_changes and never route to their branches.
func TestDecodeDecisionEnvelope_PreservesReconcileDecisions(t *testing.T) {
	for _, decision := range []string{"no_action", "repair", "park"} {
		res := &llm.Result{Output: mustJSON(t, map[string]any{
			"decision": decision,
			"summary":  "disposition chosen",
			"findings": "cited card 89dd9099 + evidence",
		})}
		review := decodeDecisionEnvelope(res)
		if review.Decision != decision {
			t.Errorf("decision %q must decode verbatim; got %q (coercion fired on a valid decision)", decision, review.Decision)
		}
	}
}

// SUPERSEDE GUARD (HIGH, the irreversible-mistake firewall): supersede closes a
// card to Done autonomously. The "you MUST cite a delivering card" rule lives in
// the schema DESCRIPTION prose, which structured-output validators (Codex) do
// NOT enforce — so {"decision":"supersede","superseded_by_card_id":null} passes
// the schema. The runner must enforce the citation: a supersede WITHOUT a
// non-empty superseded_by_card_id coerces to no_action (return the card to the
// implementer), never a silent close. Mirrors the never-silently-approve
// guarantee (blank decision → request_changes).
func TestDecodeDecisionEnvelope_SupersedeWithCitation_DecodesVerbatim(t *testing.T) {
	res := &llm.Result{Output: mustJSON(t, map[string]any{
		"decision":              "supersede",
		"summary":               "already shipped by 89dd9099",
		"findings":              "grep confirms BuildBadge.tsx exists on integration",
		"superseded_by_card_id": "89dd9099-1234-5678-9abc-def012345678",
	})}
	review := decodeDecisionEnvelope(res)
	if review.Decision != "supersede" {
		t.Errorf("supersede WITH a cited delivering card must decode verbatim; got %q", review.Decision)
	}
	if review.SupersededByCardID == "" {
		t.Error("the cited card id must be preserved for the audit trail")
	}
}

func TestDecodeDecisionEnvelope_SupersedeWithoutCitation_CoercesToNoAction(t *testing.T) {
	for _, citation := range []string{"", "   ", "\t\n"} {
		res := &llm.Result{Output: mustJSON(t, map[string]any{
			"decision":              "supersede",
			"summary":               "looks like a dup",
			"findings":              "no card cited",
			"superseded_by_card_id": citation,
		})}
		review := decodeDecisionEnvelope(res)
		if review.Decision != "no_action" {
			t.Errorf("supersede with empty/whitespace citation %q must coerce to no_action (never silently close a card); got %q",
				citation, review.Decision)
		}
	}
}

// The guard must be SCOPED to supersede only — it must never touch the
// reviewer/ui_validator decisions (approve/request_changes), which legitimately
// carry no superseded_by_card_id.
func TestDecodeDecisionEnvelope_GuardDoesNotAffectApproveRequestChanges(t *testing.T) {
	for _, decision := range []string{"approve", "request_changes"} {
		res := &llm.Result{Output: mustJSON(t, map[string]any{
			"decision": decision,
			"summary":  "verdict",
			"findings": "no citation field, as expected for a reviewer",
		})}
		review := decodeDecisionEnvelope(res)
		if review.Decision != decision {
			t.Errorf("reviewer decision %q must be untouched by the supersede guard; got %q", decision, review.Decision)
		}
	}
}
