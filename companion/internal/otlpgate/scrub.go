// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package otlpgate

import (
	"strings"

	"go.opentelemetry.io/collector/pdata/pcommon"

	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
)

// outputAttributes carry tool output, which only the full level retains.
var outputAttributes = map[string]bool{
	"output": true, "stdout": true, "stderr": true, "result": true,
	"tool.output": true, "tool_output": true, "command.output": true,
}

// identityAttributes name the account or machine rather than the activity;
// sessions are attributed through the device credential instead.
var identityAttributes = []string{"user.email", "user.account_id", "user.id", "user.name", "host.name", "host.id"}

// structuralAttributes describe the activity (ids, names, outcomes,
// timings, token counts) rather than its content. At the metadata level
// every other string value is replaced by a size and short hash, so an
// attribute this build does not know is never retained verbatim.
var structuralAttributes = map[string]bool{
	"event.name": true, "event.timestamp": true, "event.kind": true,
	"conversation.id": true, "thread.id": true, "thread_id": true, "turn.id": true, "turn_id": true,
	"call_id": true, "tool.call_id": true, "tool_name": true, "tool.name": true,
	"model": true, "slug": true, "originator": true, "terminal.type": true, "auth_mode": true,
	"app.version": true, "decision": true, "source": true, "success": true, "status": true,
	"outcome": true, "kind": true, "provider_name": true, "approval_policy": true,
	"sandbox_policy": true, "reasoning_effort": true, "reasoning_summary": true, "service_tier": true,
	"mcp_server": true, "mcp_server_origin": true, "mcp.server": true, "mcp.tool": true,
	"env": true, "otel.name": true, "http.response.status_code": true,
}

var structuralPrefixes = []string{"service.", "codex.turn.token_usage.", "codex.usage.", "gen_ai.usage.", "telemetry.sdk."}

var structuralSuffixes = []string{"_tokens", "_ms", "_count", "_length", ".id", "_id"}

func isStructural(key string) bool {
	key = strings.ToLower(key)
	if structuralAttributes[key] {
		return true
	}
	for _, prefix := range structuralPrefixes {
		if strings.HasPrefix(key, prefix) {
			return true
		}
	}
	for _, suffix := range structuralSuffixes {
		if strings.HasSuffix(key, suffix) {
			return true
		}
	}
	return false
}

// stampThread writes an inferred thread onto the record: conversation.id is
// what Beacon reads as the session, thread.id what it reads on Codex's turn
// usage span.
func stampThread(item heldItem) {
	if !item.viaTrace {
		return
	}
	for _, attributes := range recordAttributes(item) {
		attributes.PutStr("conversation.id", item.thread)
		if item.signal == Traces {
			attributes.PutStr("thread.id", item.thread)
		}
	}
}

// recordAttributes are the attributes of the item's log records or spans
// (not resources or span events).
func recordAttributes(item heldItem) []pcommon.Map {
	var maps []pcommon.Map
	if item.signal == Logs {
		resources := item.logs.ResourceLogs()
		for r := 0; r < resources.Len(); r++ {
			for s := 0; s < resources.At(r).ScopeLogs().Len(); s++ {
				records := resources.At(r).ScopeLogs().At(s).LogRecords()
				for l := 0; l < records.Len(); l++ {
					maps = append(maps, records.At(l).Attributes())
				}
			}
		}
		return maps
	}
	resources := item.traces.ResourceSpans()
	for r := 0; r < resources.Len(); r++ {
		for s := 0; s < resources.At(r).ScopeSpans().Len(); s++ {
			spans := resources.At(r).ScopeSpans().At(s).Spans()
			for i := 0; i < spans.Len(); i++ {
				maps = append(maps, spans.At(i).Attributes())
			}
		}
	}
	return maps
}

func scrub(item heldItem, level privacy.ContentLevel) {
	level = privacy.EventLevel(level)
	for _, attributes := range itemAttributes(item) {
		for _, key := range identityAttributes {
			attributes.Remove(key)
		}
		tool := stringAttr(attributes, "tool_name")
		attributes.Range(func(key string, value pcommon.Value) bool {
			if value.Type() != pcommon.ValueTypeStr {
				return true
			}
			// Embedded binary (images, attachments) is never retained.
			if replaced := privacy.ReplaceDataURLs(value.Str()); replaced != value.Str() {
				value.SetStr(replaced)
			}
			if level == privacy.Standard {
				value.SetStr(privacy.ReduceEditContentAttribute(item.harness, tool, key, value.Str()))
			}
			switch {
			case privacy.IsBinaryString(key, value.Str()):
				value.SetStr(privacy.BinaryPlaceholder(value.Str()))
			case level == privacy.Standard && outputAttributes[strings.ToLower(key)]:
				value.SetStr(privacy.OutputPlaceholder(value.Str()))
			case level == privacy.Full && outputAttributes[strings.ToLower(key)]:
				bounded, _ := privacy.TruncateToolOutput(value.Str())
				value.SetStr(bounded)
			case level == privacy.Metadata && !isStructural(key):
				value.SetStr(privacy.Digest(value.Str()))
			}
			return true
		})
	}
	if item.signal == Logs {
		scrubLogBodies(item, level)
	}
}

// scrubLogBodies removes binary from log bodies and, at the metadata level,
// digests a body unless it only repeats the event name.
func scrubLogBodies(item heldItem, level privacy.ContentLevel) {
	resources := item.logs.ResourceLogs()
	for r := 0; r < resources.Len(); r++ {
		scopes := resources.At(r).ScopeLogs()
		for s := 0; s < scopes.Len(); s++ {
			records := scopes.At(s).LogRecords()
			for l := 0; l < records.Len(); l++ {
				record := records.At(l)
				body := record.Body()
				if body.Type() == pcommon.ValueTypeStr {
					body.SetStr(privacy.ReplaceDataURLs(body.Str()))
				}
				switch {
				case body.Type() != pcommon.ValueTypeStr:
				case privacy.IsBinaryString("body", body.Str()):
					body.SetStr(privacy.BinaryPlaceholder(body.Str()))
				case level == privacy.Metadata && body.Str() != stringAttr(record.Attributes(), "event.name"):
					body.SetStr(privacy.Digest(body.Str()))
				}
			}
		}
	}
}

func itemAttributes(item heldItem) []pcommon.Map {
	var maps []pcommon.Map
	if item.signal == Logs {
		resources := item.logs.ResourceLogs()
		for r := 0; r < resources.Len(); r++ {
			maps = append(maps, resources.At(r).Resource().Attributes())
			scopes := resources.At(r).ScopeLogs()
			for s := 0; s < scopes.Len(); s++ {
				records := scopes.At(s).LogRecords()
				for l := 0; l < records.Len(); l++ {
					maps = append(maps, records.At(l).Attributes())
				}
			}
		}
		return maps
	}
	resources := item.traces.ResourceSpans()
	for r := 0; r < resources.Len(); r++ {
		maps = append(maps, resources.At(r).Resource().Attributes())
		scopes := resources.At(r).ScopeSpans()
		for s := 0; s < scopes.Len(); s++ {
			spans := scopes.At(s).Spans()
			for i := 0; i < spans.Len(); i++ {
				maps = append(maps, spans.At(i).Attributes())
				for e := 0; e < spans.At(i).Events().Len(); e++ {
					maps = append(maps, spans.At(i).Events().At(e).Attributes())
				}
			}
		}
	}
	return maps
}
