// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

type envTarget struct {
	Status  string `json:"status"`
	Summary string `json:"summary"`
}

// The shared envelope decoder is the single parse seam for every stage. It
// prefers the schema-enforced StructuredOutput channel, falls back to JSON
// embedded in prose, and reports ok=false (without mutating target) when the
// output carries no valid JSON — so each caller applies its own stage-specific
// fallback (implement→done, review→request_changes, …).
func TestDecodeLLMEnvelope_PrefersStructuredOutput(t *testing.T) {
	var tgt envTarget
	res := &llm.Result{
		Output:           "prose with no json",
		StructuredOutput: []byte(`{"status":"done","summary":"from structured"}`),
	}
	if ok := decodeLLMEnvelope(res, &tgt); !ok {
		t.Fatal("expected ok=true from structured output")
	}
	if tgt.Status != "done" || tgt.Summary != "from structured" {
		t.Fatalf("got %+v", tgt)
	}
}

func TestDecodeLLMEnvelope_FallsBackToProseJSON(t *testing.T) {
	var tgt envTarget
	res := &llm.Result{Output: "Did it.\n```json\n{\"status\":\"done\"}\n```"}
	if ok := decodeLLMEnvelope(res, &tgt); !ok {
		t.Fatal("expected ok=true from embedded JSON")
	}
	if tgt.Status != "done" {
		t.Fatalf("got %+v", tgt)
	}
}

func TestDecodeLLMEnvelope_PureProseReturnsFalse(t *testing.T) {
	var tgt envTarget
	// Real implement output: prose summary with brace fragments, no JSON.
	res := &llm.Result{Output: "M1-03 is done. Shipped auth.py with verify({raw_key})."}
	if ok := decodeLLMEnvelope(res, &tgt); ok {
		t.Fatal("pure prose must return ok=false so the caller applies its own fallback")
	}
	if tgt.Status != "" || tgt.Summary != "" {
		t.Fatalf("target must be untouched when no JSON found, got %+v", tgt)
	}
}

func TestDecodeLLMEnvelope_BadStructuredFallsBackToProse(t *testing.T) {
	var tgt envTarget
	res := &llm.Result{
		Output:           `{"status":"done","summary":"prose json"}`,
		StructuredOutput: []byte(`{broken`),
	}
	if ok := decodeLLMEnvelope(res, &tgt); !ok {
		t.Fatal("expected fallback to prose JSON when structured is malformed")
	}
	if tgt.Summary != "prose json" {
		t.Fatalf("got %+v", tgt)
	}
}

func TestDecodeLLMEnvelope_NilResult(t *testing.T) {
	var tgt envTarget
	if ok := decodeLLMEnvelope(nil, &tgt); ok {
		t.Fatal("nil result must return ok=false")
	}
}
