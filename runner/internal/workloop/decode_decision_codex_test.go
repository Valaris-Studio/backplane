// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"encoding/json"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// decisionOutputSchema is sent to Codex via --output-schema, which enforces
// OpenAI structured-output rules: when additionalProperties is false, `required`
// MUST list EVERY key in `properties` (optional fields are expressed as nullable,
// not omitted from required). Claude's --json-schema tolerates a partial required
// set; OpenAI rejects it at startup (400 invalid_json_schema, exit 1, 0 tokens —
// the field run 2026-07-25 review-stage crash: "Missing 'fix_cards'"). This test pins
// the schema to the stricter contract so both providers accept it.
func TestDecisionOutputSchema_RequiredCoversAllProperties(t *testing.T) {
	var schema struct {
		Properties           map[string]json.RawMessage `json:"properties"`
		Required             []string                   `json:"required"`
		AdditionalProperties *bool                      `json:"additionalProperties"`
	}
	if err := json.Unmarshal([]byte(decisionOutputSchema), &schema); err != nil {
		t.Fatalf("decisionOutputSchema is not valid JSON: %v", err)
	}
	req := make(map[string]bool, len(schema.Required))
	for _, k := range schema.Required {
		req[k] = true
	}
	for prop := range schema.Properties {
		if !req[prop] {
			t.Errorf("property %q is not in `required` — OpenAI/Codex --output-schema rejects this (express optional as nullable instead)", prop)
		}
	}
	if schema.AdditionalProperties == nil || *schema.AdditionalProperties {
		t.Error("additionalProperties must be false for OpenAI structured output")
	}
}

// Provider-shape gap on the OUTPUT side (field run 2026-07-25 money-loop): the
// decisionOutputSchema declares findings as a string and Claude obeys, but
// Codex/gpt-5.5 emitted a well-formed approve with findings as an EMPTY ARRAY
// ([]). json.Unmarshal of [] into a string field errored, decodeLLMEnvelope
// returned ok=false, and the never-silently-approve guard coerced a genuine
// approval into request_changes → every approval re-looped into rework at
// ~$11-16/lap. The decoder must tolerate findings as string OR array OR object,
// flattening to a string (all downstream consumers read it as a PR/note body).

func TestDecodeDecisionEnvelope_CodexApproveWithArrayFindings(t *testing.T) {
	// The exact live verdict the runner mis-parsed.
	res := &llm.Result{Output: `{"decision":"approve","summary":"Approved: F0 scaffold matches the plan.","findings":[],"failure_class":null}`}

	review := decodeDecisionEnvelope(res)

	if review.Decision != "approve" {
		t.Fatalf("a valid approve with array findings must decode as approve, got %q (Findings=%q) — this is the money-loop", review.Decision, review.Findings)
	}
}

func TestDecodeDecisionEnvelope_CodexRequestChangesWithArrayFindings(t *testing.T) {
	// A non-empty findings array (Codex listing issues) must flatten to a
	// non-empty string so the reviewer's PR comment / rework brief survives.
	res := &llm.Result{Output: `{"decision":"request_changes","summary":"Needs work","findings":["auth.py:12 missing null check","app.tsx:40 unhandled error"]}`}

	review := decodeDecisionEnvelope(res)

	if review.Decision != "request_changes" {
		t.Fatalf("expected request_changes, got %q", review.Decision)
	}
	if review.Findings == "" {
		t.Fatal("non-empty findings array must flatten to a non-empty string, not be dropped")
	}
}

func TestDecodeDecisionEnvelope_ClaudeStringFindingsUnchanged(t *testing.T) {
	// The Claude shape (findings as a string) must keep decoding exactly as
	// before — the fix is additive, not a behavior change for the existing path.
	res := &llm.Result{Output: `{"decision":"request_changes","summary":"x","findings":"auth.py:12 missing null check"}`}

	review := decodeDecisionEnvelope(res)

	if review.Decision != "request_changes" || review.Findings != "auth.py:12 missing null check" {
		t.Fatalf("string findings must pass through verbatim, got decision=%q findings=%q", review.Decision, review.Findings)
	}
}

func TestDecodeDecisionEnvelope_BlankDecisionStillCoerces(t *testing.T) {
	// The load-bearing never-silently-approve guard must still fire when there
	// genuinely is no decision (unparseable / empty), independent of findings.
	res := &llm.Result{Output: "I could not complete the review."}

	review := decodeDecisionEnvelope(res)

	if review.Decision != "request_changes" {
		t.Fatalf("a truly absent decision must coerce to request_changes, got %q", review.Decision)
	}
}
