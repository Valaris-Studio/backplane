// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"encoding/json"
	"strings"
)

// streamEvent represents a single line of NDJSON from claude --output-format stream-json.
type streamEvent struct {
	Type      string         `json:"type"`
	SubType   string         `json:"subtype,omitempty"`
	SessionID string         `json:"session_id,omitempty"`
	Message   *streamMessage `json:"message,omitempty"`

	// Fields on type:"result" events.
	Result           string          `json:"result,omitempty"`
	IsError          bool            `json:"is_error,omitempty"`
	DurationMS       int             `json:"duration_ms,omitempty"`
	NumTurns         int             `json:"num_turns,omitempty"`
	TotalCostUSD     float64         `json:"total_cost_usd,omitempty"`
	Usage            *streamUsage    `json:"usage,omitempty"`
	StructuredOutput json.RawMessage `json:"structured_output,omitempty"`
}

type streamMessage struct {
	Role    string          `json:"role,omitempty"`
	Content json.RawMessage `json:"content,omitempty"`
}

type streamUsage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
}

type streamContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

// parseStreamJSON parses NDJSON output from claude --output-format stream-json.
// Returns the assembled assistant text output and a streamResult with metadata.
// If parsing fails or no result event is found, returns the raw output as-is.
func parseStreamJSON(raw string) (text string, meta *streamMeta) {
	meta = &streamMeta{}
	var textParts []string

	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		var evt streamEvent
		if err := json.Unmarshal([]byte(line), &evt); err != nil {
			continue
		}

		switch evt.Type {
		case "assistant":
			if evt.Message != nil && evt.Message.Role == "assistant" {
				textParts = append(textParts, extractText(evt.Message.Content))
			}
			if evt.SessionID != "" {
				meta.SessionID = evt.SessionID
			}

		case "result":
			meta.SessionID = evt.SessionID
			meta.CostUSD = evt.TotalCostUSD
			meta.NumTurns = evt.NumTurns
			meta.DurationMS = evt.DurationMS
			meta.IsError = evt.IsError
			if evt.Usage != nil {
				meta.InputTokens = evt.Usage.InputTokens
				meta.OutputTokens = evt.Usage.OutputTokens
				meta.CacheCreationTokens = evt.Usage.CacheCreationInputTokens
				meta.CacheReadTokens = evt.Usage.CacheReadInputTokens
			}
			if len(evt.StructuredOutput) > 0 {
				meta.StructuredOutput = evt.StructuredOutput
			}
			// The result field contains the final text output.
			if evt.Result != "" {
				textParts = append(textParts, evt.Result)
			}

		case "system":
			if evt.SessionID != "" {
				meta.SessionID = evt.SessionID
			}
		}
	}

	if len(textParts) == 0 {
		return raw, meta
	}

	// Prefer the result field (final assembled output) over individual assistant messages.
	// The last text part from a "result" event is the complete output.
	return textParts[len(textParts)-1], meta
}

// streamMeta holds extracted metadata from a stream-json session.
type streamMeta struct {
	SessionID           string
	InputTokens         int
	OutputTokens        int
	CacheCreationTokens int
	CacheReadTokens     int
	CostUSD             float64
	NumTurns            int
	DurationMS          int
	IsError             bool
	StructuredOutput    json.RawMessage
}

// extractText pulls text from a message content JSON array.
func extractText(content json.RawMessage) string {
	if content == nil {
		return ""
	}

	var blocks []streamContentBlock
	if err := json.Unmarshal(content, &blocks); err != nil {
		// Maybe it's a plain string.
		var s string
		if err := json.Unmarshal(content, &s); err == nil {
			return s
		}
		return ""
	}

	var parts []string
	for _, b := range blocks {
		if b.Type == "text" && b.Text != "" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "")
}
