// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/valaris/backplane/companion/internal/inbox"
	"github.com/valaris/backplane/companion/internal/policy"
	"github.com/valaris/backplane/companion/internal/privacy"
)

func TestPiStructuredContentThroughPinnedBeacon(t *testing.T) {
	manifest := os.Getenv(envBeaconArtifact)
	if manifest == "" || runtime.GOOS == "windows" {
		t.Skip("set BACKPLANE_BEACON_ARTIFACT to replay through the pinned beacon-hooks executable")
	}
	const marker = "PRIVATE_STRUCTURED_OUTPUT"
	derivedByLevel := map[string][]map[string]any{}
	for _, level := range []string{"full", "rich", "standard", "metadata"} {
		t.Run(level, func(t *testing.T) {
			h := newHarness(t)
			h.env[envBeaconArtifact] = manifest
			h.server.Policy.Installation.EnabledAgents = []string{"pi_cli"}
			h.server.Policy.Mappings[0].ContentLevel = level
			if level == "rich" {
				h.server.Policy.RichCapture = policy.RichCapture{Present: true, Offer: &policy.RichCaptureOffer{Version: 1, Limits: policy.DeviceRichLimits,
					RichMappings: []policy.RichMappingGrant{{MappingID: "m1", RichSince: time.Now().Add(-time.Hour)}},
				}}
			}
			h.connect(t)
			structured := map[string]any{"text": marker + strings.Repeat("x", 8192), "token": "PRIVATE_STRUCTURED_SECRET", "exitCode": 17}
			fixtures := []struct {
				call, tool string
				input      map[string]any
				failed     bool
				action     string
			}{
				{"call_shell", "bash", map[string]any{"command": "make check"}, false, "command.executed"},
				{"call_failed", "bash", map[string]any{"command": "make fail"}, true, "tool.failed"},
				{"call_edit", "edit", map[string]any{"path": "main.go"}, false, "file.modified"},
			}
			for _, fixture := range fixtures {
				payload, err := json.Marshal(map[string]any{"type": "tool_result", "sessionId": "pi-structured-session", "cwd": h.repo,
					"toolName": fixture.tool, "toolCallId": fixture.call, "input": fixture.input, "isError": fixture.failed,
					"content": []any{map[string]any{"type": "text", "text": "existing tool output"}}, "structuredContent": structured})
				if err != nil {
					t.Fatal(err)
				}
				h.app.stdin = strings.NewReader(string(payload))
				h.app.runHook([]string{"pi"})
			}
			names, err := inbox.List(filepath.Join(h.data, "inbox"))
			if err != nil || len(names) != len(fixtures) {
				t.Fatalf("inbox contains %d items: %v", len(names), err)
			}
			for _, name := range names {
				item, err := inbox.Read(filepath.Join(h.data, "inbox"), name)
				if err != nil {
					t.Fatal(err)
				}
				encoded, _ := json.Marshal(item.Payload)
				if (level == "metadata" || level == "standard") && strings.Contains(string(encoded), marker) {
					t.Errorf("%s retained private structured output in the actual inbox", level)
				}
				if strings.Contains(string(encoded), "PRIVATE_STRUCTURED_SECRET") {
					t.Errorf("%s inbox retained a structured secret", level)
				}
				if level == "standard" {
					actual, _ := json.Marshal(item.Payload["structuredContent"])
					want, _ := json.Marshal(privacy.OutputDescriptor(structured))
					if string(actual) != string(want) {
						t.Errorf("standard inbox descriptor changed: got %s, want %s", actual, want)
					}
				}
				if level == "full" || level == "rich" {
					value, ok := item.Payload["structuredContent"].(map[string]any)
					if !ok {
						t.Fatalf("%s lost full structured content", level)
					}
					text, _ := value["text"].(string)
					if len(text) != 4096 || !strings.HasPrefix(text, marker) {
						t.Errorf("%s inbox changed the existing 4KiB bound: %d", level, len(text))
					}
				}
			}
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			go func() { done <- h.app.run(ctx, []string{"run"}) }()
			for deadline := time.Now().Add(30 * time.Second); len(h.server.Records()) < len(fixtures) && time.Now().Before(deadline); {
				time.Sleep(50 * time.Millisecond)
			}
			cancel()
			if err := <-done; err != nil {
				t.Fatal(err)
			}
			records := h.server.Records()
			if len(records) != len(fixtures) {
				t.Fatalf("uploaded %d of %d records", len(records), len(fixtures))
			}
			assertEventContract(t, records)
			uploaded, _ := json.Marshal(records)
			if (level == "metadata" || level == "standard") && strings.Contains(string(uploaded), marker) {
				t.Errorf("%s uploaded private structured output after pinned normalization", level)
			}
			if strings.Contains(string(uploaded), "PRIVATE_STRUCTURED_SECRET") {
				t.Errorf("%s uploaded a structured secret", level)
			}
			for index, record := range records {
				fixture := fixtures[index]
				if record["native_session_id"] != "pi-structured-session" || record["harness"] != "pi_cli" || record["collection_method"] != "plugin" {
					t.Errorf("native envelope identity changed: %v", record)
				}
				events, _ := record["events"].([]any)
				if len(events) != 1 {
					t.Fatalf("%s produced %d normalized events", fixture.call, len(events))
				}
				encoded, _ := json.Marshal(events[0])
				var event map[string]any
				if err := json.Unmarshal(encoded, &event); err != nil {
					t.Fatal(err)
				}
				valueAt := func(parts ...string) any {
					var value any = event
					for _, part := range parts {
						object, ok := value.(map[string]any)
						if !ok {
							return nil
						}
						value = object[part]
					}
					return value
				}
				if valueAt("event", "action") != fixture.action || valueAt("tool", "name") != fixture.tool || valueAt("gen_ai", "tool", "call", "id") != fixture.call {
					t.Errorf("derived action/tool/call identity changed: %s", encoded)
				}
				if level != "metadata" && fixture.tool == "edit" && valueAt("file", "path") != "main.go" {
					t.Errorf("derived file path lost: %s", encoded)
				}
				derivedByLevel[level] = append(derivedByLevel[level], map[string]any{
					"action": valueAt("event", "action"), "tool": valueAt("tool", "name"), "call": valueAt("gen_ai", "tool", "call", "id"),
					"outcome": valueAt("event", "outcome"), "exit_code": valueAt("command", "exit_code"), "command": valueAt("command", "command"),
					"path": valueAt("file", "path"), "operation": valueAt("file", "operation"), "error_type": valueAt("error", "type"),
				})
			}
		})
	}
	for _, level := range []string{"standard", "rich"} {
		if !reflect.DeepEqual(derivedByLevel[level], derivedByLevel["full"]) {
			t.Errorf("%s changed pinned-normalizer action/tool/exit/outcome/path metadata: %v; full: %v", level, derivedByLevel[level], derivedByLevel["full"])
		}
	}
}
