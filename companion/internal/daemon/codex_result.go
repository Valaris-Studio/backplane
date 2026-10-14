// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"encoding/json"
	"strconv"
)

// Older Beacon builds retain Codex's completion facts only as OTLP raw
// attributes. Lift structural facts before metadata privacy digests strings.
// The original event/call ids remain unchanged; no work links are inferred.
func normalizeCodexResult(event map[string]any) {
	harness, _ := event["harness"].(map[string]any)
	if harness["name"] != "codex_cli" && harness["name"] != "codex_desktop" {
		return
	}
	raw, _ := event["raw"].(map[string]any)
	attrs, _ := raw["attributes"].(map[string]any)
	if attrs["event.name"] != "codex.tool_result" {
		return
	}
	info, _ := event["event"].(map[string]any)
	if info["action"] == "tool.invoked" {
		switch attrs["success"] {
		case true, "true":
			info["action"] = "tool.completed"
		case false, "false":
			info["action"] = "tool.failed"
		}
	}
	server, _ := attrs["mcp_server"].(string)
	tool, _ := attrs["tool_name"].(string)
	if server != "" {
		mcp, _ := event["mcp"].(map[string]any)
		if mcp == nil {
			mcp = map[string]any{}
			event["mcp"] = mcp
		}
		if mcp["server"] == nil {
			mcp["server"] = server
		}
		if mcp["tool"] == nil && tool != "" {
			mcp["tool"] = tool
		}
	}
	var text string
	switch value := attrs["duration_ms"].(type) {
	case string:
		text = value
	case json.Number:
		text = value.String()
	}
	if len(text) == 0 || len(text) > 15 {
		return
	}
	for _, digit := range text {
		if digit < '0' || digit > '9' {
			return
		}
	}
	duration, err := strconv.ParseInt(text, 10, 64)
	if err != nil {
		return
	}
	command, _ := event["command"].(map[string]any)
	if command == nil {
		command = map[string]any{}
		event["command"] = command
	}
	if command["duration_ms"] == nil {
		command["duration_ms"] = duration
	}
}
