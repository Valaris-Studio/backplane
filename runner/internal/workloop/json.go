// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"encoding/json"
	"strings"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// flexString decodes a JSON value that SHOULD be a string but may arrive as an
// array, object, number, bool, or null — a coding-agent provider-shape gap.
// The decisionOutputSchema declares `findings` as a string; Claude obeys, but
// Codex/gpt-5.5 emitted `findings:[]` on an approve (and could emit a list of
// strings on request_changes). Unmarshalling that into a plain `string` errors,
// which used to sink a valid verdict into the never-silently-approve coercion
// (field run 2026-07-25). flexString flattens any shape to a string so
// the decode succeeds and the decision field survives; all downstream consumers
// read findings as a plain PR-comment / note body.
//
// - JSON string  → verbatim
// - JSON array   → elements joined by "\n" (string elems verbatim, others re-encoded)
// - null         → ""
// - anything else (object/number/bool) → its compact JSON encoding
type flexString string

func (f *flexString) UnmarshalJSON(b []byte) error {
	b = []byte(strings.TrimSpace(string(b)))
	if len(b) == 0 || string(b) == "null" {
		*f = ""
		return nil
	}
	switch b[0] {
	case '"':
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*f = flexString(s)
	case '[':
		var items []json.RawMessage
		if err := json.Unmarshal(b, &items); err != nil {
			return err
		}
		parts := make([]string, 0, len(items))
		for _, it := range items {
			var s string
			if err := json.Unmarshal(it, &s); err == nil {
				parts = append(parts, s)
			} else {
				parts = append(parts, strings.TrimSpace(string(it)))
			}
		}
		*f = flexString(strings.Join(parts, "\n"))
	default:
		// object / number / bool — keep the compact JSON so nothing is lost.
		*f = flexString(strings.TrimSpace(string(b)))
	}
	return nil
}

func (f flexString) String() string { return string(f) }

// decodeLLMEnvelope is the single parse seam every LLM stage shares. It decodes
// the stage's structured envelope into target, preferring the schema-enforced
// StructuredOutput channel (claude --json-schema) and falling back to JSON
// embedded in the prose Output. It returns ok=false WITHOUT mutating target
// when the result carries no valid JSON, so each caller can apply its own
// stage-specific fallback (implement→done, review→request_changes, planner→
// prose-as-summary). This keeps output parsing generic across all stages —
// present and future — rather than re-implemented per stage.
func decodeLLMEnvelope(res *llm.Result, target any) (ok bool) {
	if res == nil {
		return false
	}
	// Prefer the schema-enforced channel when present.
	if len(res.StructuredOutput) > 0 {
		if err := json.Unmarshal(res.StructuredOutput, target); err == nil {
			return true
		}
		// Malformed structured output — fall through to prose extraction.
	}
	extracted := extractJSON(res.Output)
	if !json.Valid([]byte(extracted)) {
		return false
	}
	if err := json.Unmarshal([]byte(extracted), target); err != nil {
		return false
	}
	return true
}

// extractJSON strips markdown fences and extracts the first *valid* JSON object
// or array embedded in LLM output. LLMs frequently wrap JSON in ```json ... ```
// blocks, or return a prose summary that happens to contain brace-like
// fragments (e.g. `verify({raw_key})`, `{insufficient_scope}`) with no real
// JSON envelope. The earlier "lock onto the first '{'" approach mis-parsed
// those fragments; this version scans every candidate opener and returns the
// first balanced span that actually unmarshals, falling back to the original
// string when none do (so the caller's graceful prose-as-summary path runs and
// json.Unmarshal fails cleanly rather than on a garbage fragment).
func extractJSON(s string) string {
	s = strings.TrimSpace(s)

	// Strip markdown code fences if present.
	if strings.HasPrefix(s, "```") {
		// Remove opening fence (```json, ```, etc.)
		if idx := strings.Index(s, "\n"); idx != -1 {
			s = s[idx+1:]
		}
		// Remove closing fence.
		if idx := strings.LastIndex(s, "```"); idx > 0 {
			s = s[:idx]
		}
		s = strings.TrimSpace(s)
	}

	// Try each candidate opener in order; return the first balanced span that
	// is valid JSON. A fragment like `{raw_key}` balances but fails
	// json.Valid, so we keep scanning to the real envelope.
	for i := 0; i < len(s); i++ {
		if s[i] != '{' && s[i] != '[' {
			continue
		}
		if span := balancedSpan(s, i); span != "" && json.Valid([]byte(span)) {
			return span
		}
	}

	// No valid JSON found — return the original so the caller sees a clean
	// unmarshal error and falls back to treating the prose as a summary.
	return s
}

// balancedSpan returns the substring of s starting at the opener index `start`
// through its matching close brace/bracket, respecting strings and escapes.
// Returns "" when the span is unbalanced (truncated output) so the caller skips
// this candidate.
func balancedSpan(s string, start int) string {
	openChar := s[start]
	var closeChar byte
	if openChar == '{' {
		closeChar = '}'
	} else {
		closeChar = ']'
	}

	depth := 0
	inString := false
	escaped := false
	for i := start; i < len(s); i++ {
		c := s[i]
		if escaped {
			escaped = false
			continue
		}
		if c == '\\' && inString {
			escaped = true
			continue
		}
		if c == '"' {
			inString = !inString
			continue
		}
		if inString {
			continue
		}
		if c == openChar {
			depth++
		} else if c == closeChar {
			depth--
			if depth == 0 {
				return s[start : i+1]
			}
		}
	}
	return ""
}

// truncate returns the first n bytes of s, appending "..." if truncated.
func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
