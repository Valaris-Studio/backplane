// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import "testing"

// llmStageResult.rawOutput carries the verbatim LLM stdout so downstream
// terminal kinds (create_note body_from="raw", mcp_call resolving $llm_output)
// can read it without re-parsing the structured envelope. The field defaults
// to empty when wrapGenericOutput is called by code paths that have nothing to
// carry forward.
func TestWrapGenericOutput_RawOutputDefaultsEmpty(t *testing.T) {
	res := wrapGenericOutput("writes_code", genericLLMOutput{Status: "done", Summary: "x"})
	if res.rawOutput != "" {
		t.Errorf("rawOutput default = %q, want empty", res.rawOutput)
	}
}

// Sanity / regression guard: future refactors must not break the field's
// round-trip — handlers will literal-init llmStageResult with rawOutput set
// from result.Output, and downstream readers (kind_llm.go) must observe the
// same string.
func TestLLMStageResult_RawOutputRoundTrip(t *testing.T) {
	res := &llmStageResult{rawOutput: "verbatim stdout"}
	if res.rawOutput != "verbatim stdout" {
		t.Errorf("rawOutput = %q, want verbatim stdout", res.rawOutput)
	}
}
