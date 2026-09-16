// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package lifecycle

import "testing"

// WalkState.LLMRawOutput threads the verbatim LLM stdout from the producing
// `llm` step to downstream consumers (terminal create_note, mcp_call(create_note)
// resolving $llm_output). Zero-value safety is load-bearing: handlers that
// never ran an LLM step (planner-before-LLM, discover-only branches) must see
// "" rather than crash.

func TestWalkState_LLMRawOutput_DefaultEmpty(t *testing.T) {
	ws := &WalkState{}
	if ws.LLMRawOutput != "" {
		t.Errorf("zero-value WalkState.LLMRawOutput = %q, want empty", ws.LLMRawOutput)
	}
}

func TestWalkState_LLMRawOutput_AssignReadable(t *testing.T) {
	ws := &WalkState{}
	ws.LLMRawOutput = "raw LLM stdout payload"
	if ws.LLMRawOutput != "raw LLM stdout payload" {
		t.Errorf("WalkState.LLMRawOutput = %q, want %q", ws.LLMRawOutput, "raw LLM stdout payload")
	}
}
