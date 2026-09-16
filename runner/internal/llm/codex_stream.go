// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"encoding/json"
	"strings"
)

// Codex `exec --json` emits newline-delimited JSON, one event per state change.
// Contract (OpenAI Codex docs, 2026): events thread.started / turn.started /
// turn.completed / turn.failed / item.started / item.completed / error. The
// final assistant text is an item.completed whose item.type == "agent_message";
// token usage rides turn.completed.usage; the session id is thread_id on
// thread.started. This shape differs from Claude's stream-json, so it gets its
// own parser rather than overloading parseStreamJSON.
type codexEvent struct {
	Type     string          `json:"type"`
	ThreadID string          `json:"thread_id,omitempty"`
	Item     *codexItem      `json:"item,omitempty"`
	Usage    *codexUsage     `json:"usage,omitempty"`
	Error    json.RawMessage `json:"error,omitempty"`   // present on turn.failed
	Message  string          `json:"message,omitempty"` // present on top-level "error"
}

type codexItem struct {
	ID   string `json:"id,omitempty"`
	Type string `json:"type,omitempty"`
	Text string `json:"text,omitempty"`
}

type codexUsage struct {
	InputTokens           int `json:"input_tokens"`
	CachedInputTokens     int `json:"cached_input_tokens"`
	OutputTokens          int `json:"output_tokens"`
	ReasoningOutputTokens int `json:"reasoning_output_tokens"`
}

// parseCodexJSON parses Codex exec --json NDJSON into the assembled final
// agent_message text and a streamMeta (shared with the Claude parser so the
// provider plumbing is identical). The LAST agent_message wins. Codex reports
// no dollar cost, so meta.CostUSD stays 0 — the loop estimates from tokens.
// cached_input_tokens maps onto CacheReadTokens (Codex has no cache-write
// concept), reasoning tokens fold into the output count for cost purposes.
func parseCodexJSON(raw string) (text string, meta *streamMeta) {
	meta = &streamMeta{}
	var lastAgentMessage string
	sawAgentMessage := false

	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var evt codexEvent
		if err := json.Unmarshal([]byte(line), &evt); err != nil {
			continue
		}

		switch evt.Type {
		case "thread.started":
			if evt.ThreadID != "" {
				meta.SessionID = evt.ThreadID
			}
		case "item.completed":
			if evt.Item != nil && evt.Item.Type == "agent_message" {
				lastAgentMessage = evt.Item.Text
				sawAgentMessage = true
			}
		case "turn.completed":
			if evt.Usage != nil {
				meta.InputTokens = evt.Usage.InputTokens
				meta.CacheReadTokens = evt.Usage.CachedInputTokens
				meta.OutputTokens = evt.Usage.OutputTokens + evt.Usage.ReasoningOutputTokens
			}
		case "turn.failed", "error":
			meta.IsError = true
		}
	}

	if !sawAgentMessage {
		return "", meta
	}
	return lastAgentMessage, meta
}
