// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build integration

package workloop

import (
	"context"
	"encoding/json"
	"os/exec"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// TestDecisionSchema_LiveCodexAccepts feeds the REAL production
// decisionOutputSchema to the REAL codex binary via --output-schema and asserts
// it runs (exit 0) and returns a verdict decoding cleanly through the SAME seam
// production uses (decodeDecisionEnvelope). This is the ground-truth guard for
// the review-stage crash: a prior unit-only live test used a toy schema whose
// `required` happened to cover every key, so it never exercised the optional-
// field rule that OpenAI/Codex enforces (and that crashed review with 400
// invalid_json_schema / exit 1 / 0 tokens on the real fix_cards-optional schema).
//
// Skipped by default (build tag `integration`). Run with:
//
//	go test -tags integration -run TestDecisionSchema_LiveCodex ./internal/workloop/
func TestDecisionSchema_LiveCodexAccepts(t *testing.T) {
	if _, err := exec.LookPath("codex"); err != nil {
		t.Skip("no codex binary on PATH")
	}

	cli := llm.NewCodexCLI()
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	res, err := cli.Execute(ctx,
		"You are a code reviewer. The change is trivial and correct; no fix cards are needed. Respond with your verdict.",
		llm.Options{
			WorkingDir:                 t.TempDir(),
			DangerouslySkipPermissions: true,
			OutputSchema:               decisionOutputSchema, // the EXACT production schema
		})
	if err != nil {
		t.Fatalf("codex rejected the production decision schema: %v", err)
	}

	// Decode through the production seam — proves an approve records as approve,
	// not the never-silently-approve coercion.
	review := decodeDecisionEnvelope(res)
	if review.Decision != "approve" && review.Decision != "request_changes" {
		t.Fatalf("decision = %q, want a real verdict from the structured channel (Output=%q)", review.Decision, res.Output)
	}
	// A normal verdict carries no fix cards (the schema sends fix_cards:null).
	if len(review.FixCards) != 0 {
		t.Errorf("a normal reviewer verdict should carry no fix cards, got %d", len(review.FixCards))
	}
	// Sanity: the conforming JSON should have reached the StructuredOutput channel.
	if len(res.StructuredOutput) == 0 || !json.Valid(res.StructuredOutput) {
		t.Errorf("expected schema-conforming JSON on StructuredOutput, got %q", res.StructuredOutput)
	}
	t.Logf("LIVE codex decision schema: decision=%q summary=%q", review.Decision, review.Summary)
}
