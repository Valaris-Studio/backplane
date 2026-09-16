// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// When the claude CLI honors --json-schema it returns the payload on
// result.StructuredOutput. parseLLMResultGeneric must prefer that channel over
// scraping prose from result.Output.
func TestParseLLMResultGeneric_PrefersStructuredOutput(t *testing.T) {
	res := &llm.Result{
		Output:           "Sure! Here's what I did, in prose with no JSON envelope.",
		StructuredOutput: []byte(`{"status":"done","decision":"approve","summary":"shipped it"}`),
	}
	out := parseLLMResultGeneric(res)
	if out.Status != "done" || out.Decision != "approve" || out.Summary != "shipped it" {
		t.Fatalf("must parse from StructuredOutput, got %+v", out)
	}
}

// With no structured output, it falls back to extracting JSON embedded in prose.
func TestParseLLMResultGeneric_FallsBackToProseJSON(t *testing.T) {
	res := &llm.Result{
		Output: "Done.\n```json\n{\"status\":\"done\",\"summary\":\"ok\"}\n```",
	}
	out := parseLLMResultGeneric(res)
	if out.Status != "done" || out.Summary != "ok" {
		t.Fatalf("must extract JSON from prose, got %+v", out)
	}
}

// Pure prose with no JSON at all: degrade gracefully — the prose becomes the
// summary, no fields invented, no panic.
func TestParseLLMResultGeneric_PureProseBecomesSummary(t *testing.T) {
	res := &llm.Result{
		Output: "M1-03 is done. Shipped auth.py with verify({raw_key}).",
	}
	out := parseLLMResultGeneric(res)
	if out.Summary == "" {
		t.Fatalf("pure prose must become the summary, got %+v", out)
	}
	if out.Status != "" || out.Decision != "" {
		t.Fatalf("must not invent status/decision from prose, got %+v", out)
	}
}

// Malformed StructuredOutput must not strand the result — fall back to prose.
func TestParseLLMResultGeneric_BadStructuredFallsBack(t *testing.T) {
	res := &llm.Result{
		Output:           `{"status":"done","summary":"from prose"}`,
		StructuredOutput: []byte(`{not valid json`),
	}
	out := parseLLMResultGeneric(res)
	if out.Status != "done" || out.Summary != "from prose" {
		t.Fatalf("bad structured output must fall back to prose JSON, got %+v", out)
	}
}
