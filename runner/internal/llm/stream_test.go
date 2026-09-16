// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import "testing"

func TestParseStreamJSON_ResultEvent(t *testing.T) {
	raw := `{"type":"system","subtype":"init","session_id":"abc-123","tools":["Bash"]}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello world"}]},"session_id":"abc-123"}
{"type":"result","subtype":"success","is_error":false,"duration_ms":5432,"num_turns":3,"result":"Hello world","session_id":"abc-123","total_cost_usd":0.042,"usage":{"input_tokens":1500,"output_tokens":200,"cache_creation_input_tokens":100,"cache_read_input_tokens":50}}`

	text, meta := parseStreamJSON(raw)

	if text != "Hello world" {
		t.Errorf("text: got %q, want %q", text, "Hello world")
	}
	if meta.SessionID != "abc-123" {
		t.Errorf("session_id: got %q, want %q", meta.SessionID, "abc-123")
	}
	if meta.CostUSD != 0.042 {
		t.Errorf("cost: got %f, want %f", meta.CostUSD, 0.042)
	}
	if meta.InputTokens != 1500 {
		t.Errorf("input_tokens: got %d, want %d", meta.InputTokens, 1500)
	}
	if meta.OutputTokens != 200 {
		t.Errorf("output_tokens: got %d, want %d", meta.OutputTokens, 200)
	}
	if meta.CacheCreationTokens != 100 {
		t.Errorf("cache_creation: got %d, want %d", meta.CacheCreationTokens, 100)
	}
	if meta.CacheReadTokens != 50 {
		t.Errorf("cache_read: got %d, want %d", meta.CacheReadTokens, 50)
	}
	if meta.NumTurns != 3 {
		t.Errorf("num_turns: got %d, want %d", meta.NumTurns, 3)
	}
	if meta.DurationMS != 5432 {
		t.Errorf("duration_ms: got %d, want %d", meta.DurationMS, 5432)
	}
	if meta.IsError {
		t.Error("is_error should be false")
	}
}

func TestParseStreamJSON_ErrorResult(t *testing.T) {
	raw := `{"type":"system","subtype":"init","session_id":"err-1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Credit balance is too low"}]},"session_id":"err-1","error":"billing_error"}
{"type":"result","subtype":"success","is_error":true,"duration_ms":144,"num_turns":1,"result":"Credit balance is too low","session_id":"err-1","total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}`

	text, meta := parseStreamJSON(raw)

	if text != "Credit balance is too low" {
		t.Errorf("text: got %q", text)
	}
	if !meta.IsError {
		t.Error("is_error should be true for billing errors")
	}
	if meta.SessionID != "err-1" {
		t.Errorf("session_id: got %q", meta.SessionID)
	}
}

func TestParseStreamJSON_EmptyOutput(t *testing.T) {
	text, meta := parseStreamJSON("")
	if text != "" {
		t.Errorf("empty input should return empty text: got %q", text)
	}
	if meta.SessionID != "" {
		t.Errorf("empty input should have empty session_id: got %q", meta.SessionID)
	}
}

func TestParseStreamJSON_PlainText(t *testing.T) {
	// Non-JSON output (e.g., from text format) should pass through.
	raw := "Just some plain text output"
	text, meta := parseStreamJSON(raw)
	if text != raw {
		t.Errorf("plain text should pass through: got %q", text)
	}
	if meta.SessionID != "" {
		t.Error("plain text should have no session_id")
	}
}

func TestParseStreamJSON_SessionIDFromInit(t *testing.T) {
	raw := `{"type":"system","subtype":"init","session_id":"init-sess-1","tools":["Read","Write"]}
{"type":"result","subtype":"success","result":"done","session_id":"init-sess-1","total_cost_usd":0.01,"usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}`

	_, meta := parseStreamJSON(raw)
	if meta.SessionID != "init-sess-1" {
		t.Errorf("session_id should come from init event: got %q", meta.SessionID)
	}
}

func TestParseStreamJSON_HookEventsIgnored(t *testing.T) {
	raw := `{"type":"system","subtype":"hook_started","hook_id":"h1","session_id":"s1"}
{"type":"system","subtype":"hook_response","hook_id":"h1","output":"hook output","session_id":"s1"}
{"type":"system","subtype":"init","session_id":"s1"}
{"type":"result","subtype":"success","result":"actual output","session_id":"s1","total_cost_usd":0.05,"usage":{"input_tokens":500,"output_tokens":100,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}`

	text, meta := parseStreamJSON(raw)
	if text != "actual output" {
		t.Errorf("hook events should not affect text: got %q", text)
	}
	if meta.CostUSD != 0.05 {
		t.Errorf("cost: got %f, want %f", meta.CostUSD, 0.05)
	}
}

func TestParseStreamJSON_NoUsage(t *testing.T) {
	raw := `{"type":"result","subtype":"success","result":"output","session_id":"s1","total_cost_usd":0}`

	_, meta := parseStreamJSON(raw)
	if meta.InputTokens != 0 {
		t.Errorf("no usage block should leave tokens at 0: got %d", meta.InputTokens)
	}
}

func TestExtractText_ContentArray(t *testing.T) {
	content := []byte(`[{"type":"text","text":"hello"},{"type":"tool_use","id":"t1"},{"type":"text","text":" world"}]`)
	got := extractText(content)
	if got != "hello world" {
		t.Errorf("got %q, want %q", got, "hello world")
	}
}

func TestExtractText_Nil(t *testing.T) {
	got := extractText(nil)
	if got != "" {
		t.Errorf("nil content should return empty: got %q", got)
	}
}

func TestParseStreamJSON_StructuredOutput(t *testing.T) {
	// When --json-schema is used, the model emits a StructuredOutput tool_use
	// and the terminal result event carries the parsed object as a top-level
	// `structured_output` field. Stream parser must surface it.
	raw := `{"type":"system","subtype":"init","session_id":"s1"}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"StructuredOutput","input":{"decision":"approve","summary":"LGTM","findings":"All tests pass."}}]},"session_id":"s1"}
{"type":"result","subtype":"success","is_error":false,"result":"","session_id":"s1","total_cost_usd":0.05,"usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0},"structured_output":{"decision":"approve","summary":"LGTM","findings":"All tests pass."}}`

	_, meta := parseStreamJSON(raw)
	if len(meta.StructuredOutput) == 0 {
		t.Fatal("structured_output should be captured")
	}
	want := `{"decision":"approve","summary":"LGTM","findings":"All tests pass."}`
	if string(meta.StructuredOutput) != want {
		t.Errorf("structured_output: got %s, want %s", string(meta.StructuredOutput), want)
	}
}

func TestParseStreamJSON_StructuredOutput_Absent(t *testing.T) {
	// Without --json-schema, no structured_output key. Field stays nil.
	raw := `{"type":"result","subtype":"success","result":"plain text","session_id":"s1","total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}`

	_, meta := parseStreamJSON(raw)
	if len(meta.StructuredOutput) != 0 {
		t.Errorf("structured_output should be empty when absent: got %s", string(meta.StructuredOutput))
	}
}
