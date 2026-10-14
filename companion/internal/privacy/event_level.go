// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package privacy

import "strings"

// structuralEventPaths are the Beacon event members that describe an
// activity (identity, timing, action, tool and token counts) rather than its
// content. A path ending in "." keeps its whole subtree.
var structuralEventPaths = []string{
	"schema_version", "timestamp", "severity", "sequence", "vendor", "product", "model",
	"repository", "event.", "harness.", "session.", "trace.", "endpoint.",
	"gen_ai.usage.", "gen_ai.tool.call.id", "gen_ai.operation.", "gen_ai.system",
	"tool.name", "mcp.server", "mcp.tool", "error.type", "file.operation", "file.language",
	"approval.decision", "approval.required", "raw.otel_signal", "raw.span_name",
	"raw.span_kind", "raw.status", "raw.source", "raw.turn_id",
	// What prices a usage event: the model and provider it ran on, the
	// service tier, and whether a plan or an API key paid. None of it is
	// what anyone said.
	"gen_ai.provider.name", "gen_ai.request.model", "gen_ai.response.model",
	"raw.attributes.auth_mode", "raw.attributes.service_tier", "raw.attributes.provider_name",
}

// ApplyEventContentLevel reduces a normalized Beacon event to level. At the
// metadata level every string outside the structural paths is replaced by a
// size and short hash, so unknown members are never retained verbatim. The
// standard level describes tool output and digests the agent's replies, file
// diffs and the content of edits.
func ApplyEventContentLevel(event map[string]any, level ContentLevel) map[string]any {
	switch level {
	case Metadata:
		return digestOutside(event, "").(map[string]any)
	case Standard:
		withheld := withholdEventEditContent(withholdReplies(event).(map[string]any))
		return describeOutput(digestPaths(withheld, "", standardWithheldEventPaths), "").(map[string]any)
	}
	return event
}

// standardWithheldEventPaths stay on the device at the standard level besides
// tool output: the model's output, and the diff Beacon derives from an edit's
// arguments (the arguments themselves are sent).
var standardWithheldEventPaths = map[string]bool{"gen_ai.output": true, "file.diff": true}

func digestPaths(value any, path string, paths map[string]bool) any {
	return transformPaths(value, path, paths, digestStrings)
}

func transformPaths(value any, path string, paths map[string]bool, transform func(any) any) any {
	object, ok := value.(map[string]any)
	if !ok {
		return value
	}
	out := make(map[string]any, len(object))
	for key, child := range object {
		childPath := joinPath(path, key)
		if paths[childPath] {
			out[key] = transform(child)
		} else {
			out[key] = transformPaths(child, childPath, paths, transform)
		}
	}
	return out
}

// eventOutputPaths carry tool output in a normalized Beacon event; the
// standard level keeps only their size and hash.
var eventOutputPaths = map[string]bool{
	"command.output": true, "command.stdout": true, "command.stderr": true,
	"tool.output": true, "tool.result": true, "tool.stdout": true, "tool.stderr": true,
}

func describeOutput(value any, path string) any {
	object, ok := value.(map[string]any)
	if !ok {
		return value
	}
	out := make(map[string]any, len(object))
	for key, child := range object {
		childPath := joinPath(path, key)
		switch {
		case eventOutputPaths[childPath] && !isOutputDescriptor(child):
			out[key] = OutputDescriptor(child)
		default:
			out[key] = describeOutput(child, childPath)
		}
	}
	return out
}

func digestOutside(value any, path string) any {
	switch typed := value.(type) {
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, child := range typed {
			out[key] = digestOutside(child, joinPath(path, key))
		}
		return out
	case []any:
		out := make([]any, len(typed))
		for index, child := range typed {
			out[index] = digestOutside(child, path)
		}
		return out
	case string:
		if isStructuralPath(path) {
			return typed
		}
		return digestStrings(typed)
	default:
		return typed
	}
}

func joinPath(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

func isStructuralPath(path string) bool {
	for _, allowed := range structuralEventPaths {
		if path == allowed || strings.HasSuffix(allowed, ".") && strings.HasPrefix(path, allowed) {
			return true
		}
	}
	return false
}
