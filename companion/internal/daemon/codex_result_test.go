// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
)

func TestCodexToolResultCompletionSurvivesEveryContentLevel(t *testing.T) {
	for _, level := range []privacy.ContentLevel{privacy.Metadata, privacy.Standard, privacy.Full} {
		for success, action := range map[string]string{"true": "tool.completed", "false": "tool.failed"} {
			t.Run(string(level)+success, func(t *testing.T) {
				raw := json.RawMessage(`{"event":{"action":"tool.invoked","id":"native-event"},"harness":{"name":"codex_desktop"},"gen_ai":{"tool":{"call":{"id":"exec-native-id"}}},"raw":{"attributes":{"event.name":"codex.tool_result","success":"` + success + `","mcp_server":"valaris","tool_name":"get_note","duration_ms":"478","output":"PRIVATE_BODY"}}}`)
				encoded, err := applyEventLevel(raw, level)
				if err != nil {
					t.Fatal(err)
				}
				var event map[string]any
				if err := json.Unmarshal(encoded, &event); err != nil {
					t.Fatal(err)
				}
				if event["event"].(map[string]any)["action"] != action {
					t.Fatalf("result not completed: %s", encoded)
				}
				mcp, ok := event["mcp"].(map[string]any)
				if !ok || mcp["server"] != "valaris" || mcp["tool"] != "get_note" {
					t.Fatalf("MCP identity missing: %s", encoded)
				}
				if event["command"].(map[string]any)["duration_ms"] != float64(478) {
					t.Fatalf("duration missing: %s", encoded)
				}
				if level == privacy.Metadata && strings.Contains(string(encoded), "PRIVATE_BODY") {
					t.Fatal("normalization leaked output")
				}
				again, _ := applyEventLevel(encoded, level)
				if string(again) != string(encoded) {
					t.Fatal("normalization is not idempotent")
				}
			})
		}
	}
}
