// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import "testing"

func TestExtractJSON_PlainObject(t *testing.T) {
	input := `{"card_id":"abc","board_id":"123"}`
	got := extractJSON(input)
	if got != input {
		t.Errorf("plain JSON should pass through: got %q", got)
	}
}

func TestExtractJSON_MarkdownFence(t *testing.T) {
	input := "```json\n{\"status\":\"done\"}\n```"
	want := `{"status":"done"}`
	got := extractJSON(input)
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestExtractJSON_MarkdownFenceNoLang(t *testing.T) {
	input := "```\n{\"status\":\"done\"}\n```"
	want := `{"status":"done"}`
	got := extractJSON(input)
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestExtractJSON_SurroundingText(t *testing.T) {
	input := "Here is the result:\n{\"card_id\":\"x\"}\nDone."
	want := `{"card_id":"x"}`
	got := extractJSON(input)
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestExtractJSON_NestedBraces(t *testing.T) {
	input := `{"action_payload":{"details":"create table"},"status":"ok"}`
	got := extractJSON(input)
	if got != input {
		t.Errorf("nested braces should be handled: got %q", got)
	}
}

func TestExtractJSON_StringWithBraces(t *testing.T) {
	input := `{"summary":"fixed {issue} in code"}`
	got := extractJSON(input)
	if got != input {
		t.Errorf("braces in strings should be ignored: got %q", got)
	}
}

func TestExtractJSON_EscapedQuotes(t *testing.T) {
	input := `{"summary":"he said \"hello\""}`
	got := extractJSON(input)
	if got != input {
		t.Errorf("escaped quotes should be handled: got %q", got)
	}
}

func TestExtractJSON_Array(t *testing.T) {
	input := `Some text [{"id":"1"},{"id":"2"}] more text`
	want := `[{"id":"1"},{"id":"2"}]`
	got := extractJSON(input)
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestExtractJSON_EmptyString(t *testing.T) {
	got := extractJSON("")
	if got != "" {
		t.Errorf("empty input should return empty: got %q", got)
	}
}

func TestExtractJSON_NoJSON(t *testing.T) {
	input := "No JSON here at all"
	got := extractJSON(input)
	if got != input {
		t.Errorf("no JSON should return original: got %q", got)
	}
}

// Real-world prose the implement LLM returned on M1-02/03/04: a markdown
// summary with NO JSON envelope, but containing brace-like fragments in code
// references. The old extractJSON locked onto the first '{' (inside the prose)
// and produced invalid JSON, triggering "looking for beginning of object key
// string". A robust extractor must return the original prose (so the caller's
// graceful fallback treats it as a summary) rather than a broken fragment.
func TestExtractJSON_ProseWithBraceFragmentNoJSON(t *testing.T) {
	// No trailing whitespace — extractJSON documents a leading/trailing
	// TrimSpace, so the returned prose is the trimmed original.
	input := "M1-03 is done. Here's the summary:\n\n" +
		"**What shipped:**\n" +
		"- `core/services/auth.py` — verify({raw_key}) round-trips\n" +
		"- scope guard returns {insufficient_scope}"
	got := extractJSON(input)
	// No valid JSON present → return the (trimmed) original so json.Unmarshal
	// fails cleanly and the caller falls back to prose-as-summary.
	if got != input {
		t.Errorf("prose with brace fragments but no real JSON should return original;\n got %q", got)
	}
}

// Prose preceding a genuine JSON object where an earlier '{' fragment appears
// in the prose. The extractor must skip the non-JSON '{' and find the real one.
func TestExtractJSON_ProseWithFragmentThenRealJSON(t *testing.T) {
	input := "Done. Notes: verify({key}) works.\n" +
		`Result: {"status":"done","summary":"shipped"}`
	want := `{"status":"done","summary":"shipped"}`
	got := extractJSON(input)
	if got != want {
		t.Errorf("must skip the prose '{' fragment and find the real JSON;\n got %q\nwant %q", got, want)
	}
}

// A non-JSON brace fragment that itself parses as a partial object must not be
// returned when a later, complete envelope is the real payload.
func TestExtractJSON_FirstBraceIsInvalidSecondIsValid(t *testing.T) {
	input := `prefix {not json: bare words} and then {"ok":true}`
	want := `{"ok":true}`
	got := extractJSON(input)
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestExtractJSON_WhitespaceAroundFences(t *testing.T) {
	input := "  \n```json\n  {\"key\":\"val\"}  \n```\n  "
	want := `{"key":"val"}`
	got := extractJSON(input)
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestExtractJSON_FenceWithExtraText(t *testing.T) {
	input := "I found the card:\n```json\n{\"card_id\":\"abc\"}\n```\nHope that helps!"
	want := `{"card_id":"abc"}`
	got := extractJSON(input)
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}
