// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/collector"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// beyondFloat64 is 2^53+1: decoding it through float64 yields ...992.
const beyondFloat64 = "9007199254740993"

// codexResultLogs are codex.tool_result log records as Codex exports them:
// every attribute a string except the integer ones.
func codexResultLogs() string {
	text := func(key, value string) string {
		return `{"key":` + quoted(key) + `,"value":{"stringValue":` + quoted(value) + `}}`
	}
	integer := func(key, value string) string {
		return `{"key":` + quoted(key) + `,"value":{"intValue":` + quoted(value) + `}}`
	}
	var records []string
	for _, attributes := range [][]string{
		{text("call_id", "call_ok"), text("tool_name", "get_note"), text("mcp_server", "valaris"), text("success", "true"), text("duration_ms", "478"),
			text("arguments", `{"note_id":"RESULT_ARGUMENT_MARK"}`), text("output", "RESULT_OUTPUT_MARK"), integer("output_bytes", beyondFloat64)},
		{text("call_id", "call_fail"), text("tool_name", "update_card"), text("mcp_server", "valaris"), text("success", "false"), integer("duration_ms", "12"),
			text("output", "FAILED_OUTPUT_MARK")},
		{text("call_id", "call_unknown"), text("tool_name", "get_card"), text("mcp_server", "valaris"), text("success", "True"), text("duration_ms", "5")},
		{text("call_id", "call_missing"), text("tool_name", "exec_command"), text("duration_ms", "7")},
	} {
		records = append(records, `{"timeUnixNano":"1790000000000000000","body":{"stringValue":"codex.tool_result"},"attributes":[`+
			text("event.name", "codex.tool_result")+","+text("conversation.id", "thread-root")+","+text("app.version", "0.144.1")+","+
			text("model", "gpt-5")+","+strings.Join(attributes, ",")+`]}`)
	}
	return `{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"codex_exec"}}]},"scopeLogs":[{"scope":{"name":"codex_otel.log_only"},"logRecords":[` + strings.Join(records, ",") + `]}]}]}`
}

type codexResultRun struct {
	// uploaded are the tool events the fake server received, by native call id.
	uploaded map[string]map[string]any
	// collected are the same events as the pinned collector wrote them, before
	// the daemon's normalization and content level.
	collected map[string]map[string]any
	rawUpload []byte
}

// runCodexResultsThroughCollector sends codex.tool_result records through the
// actual gate, pinned collector, daemon normalization and level, and uplink.
func runCodexResultsThroughCollector(t *testing.T, contentLevel string) codexResultRun {
	t.Helper()
	hooksManifest, collectorManifest := os.Getenv(envBeaconArtifact), os.Getenv(envOtelcolArtifact)
	if hooksManifest == "" || collectorManifest == "" || runtime.GOOS == "windows" {
		t.Skip("set BACKPLANE_BEACON_ARTIFACT and BACKPLANE_OTELCOL_ARTIFACT to run through the pinned collector")
	}
	h := newHarness(t)
	h.env[envBeaconArtifact] = hooksManifest
	h.env[envOtelcolArtifact] = collectorManifest
	h.server.Policy.Installation.EnabledAgents = []string{"claude_code", "codex_cli"}
	h.server.Policy.Mappings[0].ContentLevel = contentLevel
	if contentLevel == "rich" {
		h.server.Policy.RichCapture = policy.RichCapture{Present: true, Offer: &policy.RichCaptureOffer{
			Version: 1, Limits: policy.DeviceRichLimits,
			RichMappings: []policy.RichMappingGrant{{MappingID: "m1", RichSince: time.Now().Add(-time.Hour)}},
		}}
	}
	h.connect(t)
	h.codexHome(t)
	if err := h.run(t, "agents", "install", "codex"); err != nil {
		t.Fatal(err)
	}
	settings, _ := state.Load[state.OTelSettings](store.Layout{Root: h.data}.OTelSettings())
	h.app.stdin = strings.NewReader(`{"session_id":"thread-root","transcript_path":null,"cwd":` + quoted(h.repo) + `,"hook_event_name":"SessionStart","model":"gpt-5","permission_mode":"default","source":"startup"}`)
	h.app.runHook([]string{"codex"})

	logPath := filepath.Join(h.data, "logs", "companion.log")
	cancel, done := h.runDaemonAsync(t, "--log", logPath)
	defer func() {
		cancel()
		<-done
	}()
	waitForLog(t, logPath, "started")
	postUntilAccepted(t, fmt.Sprintf("http://127.0.0.1:%d/v1/logs", settings.GatePort), codexResultLogs())

	calls := []string{"call_ok", "call_fail", "call_unknown", "call_missing"}
	run := codexResultRun{}
	deadline := time.Now().Add(45 * time.Second)
	for {
		run.uploaded = toolEventsByCall(t, h.server.Records())
		if len(run.uploaded) == len(calls) || time.Now().After(deadline) {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	h.server.Lock()
	for _, batch := range h.server.Batches {
		for _, record := range batch {
			run.rawUpload = append(append(run.rawUpload, record...), '\n')
		}
	}
	h.server.Unlock()
	run.collected = collectedToolEvents(t, collector.RuntimePath(filepath.Join(h.data, "otel")))
	if contentLevel == "rich" && connectionOffer(t, h) == nil {
		t.Fatal("the rich offer was not cached; this run is not rich")
	}
	if len(run.uploaded) != len(calls) || len(run.collected) != len(calls) {
		collectorLog, _ := os.ReadFile(filepath.Join(h.data, "otel", "collector.log"))
		t.Fatalf("tool events uploaded %d, collected %d of %d\nuploaded: %s\ncollector: %s", len(run.uploaded), len(run.collected), len(calls), run.rawUpload, collectorLog)
	}
	return run
}

func toolEventsByCall(t *testing.T, records []map[string]any) map[string]map[string]any {
	t.Helper()
	found := map[string]map[string]any{}
	for _, record := range records {
		for _, raw := range record["events"].([]any) {
			event := raw.(map[string]any)
			if call := nativeCallID(event); call != "" {
				found[call] = event
			}
		}
	}
	return found
}

func collectedToolEvents(t *testing.T, path string) map[string]map[string]any {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatalf("collector output: %v", err)
	}
	defer file.Close()
	found := map[string]map[string]any{}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 1<<20), 1<<24)
	for scanner.Scan() {
		var event map[string]any
		decoder := json.NewDecoder(bytes.NewReader(scanner.Bytes()))
		decoder.UseNumber()
		if decoder.Decode(&event) == nil {
			if call := nativeCallID(event); call != "" {
				found[call] = event
			}
		}
	}
	return found
}

func nativeCallID(event map[string]any) string {
	genAI, _ := event["gen_ai"].(map[string]any)
	tool, _ := genAI["tool"].(map[string]any)
	call, _ := tool["call"].(map[string]any)
	id, _ := call["id"].(string)
	return id
}

func member(event map[string]any, path ...string) any {
	var value any = event
	for _, key := range path {
		object, _ := value.(map[string]any)
		value = object[key]
	}
	return value
}

// A Codex tool result keeps its native event and call ids through the actual
// gate, collector, normalization and content level; only an exact native
// success settles a call; MCP identity and duration survive even metadata,
// whose text stays on the device; and Full no longer rounds large integers.
func TestCodexToolResultsThroughGateCollectorAndEveryLevel(t *testing.T) {
	for _, level := range []string{"metadata", "standard", "full", "rich"} {
		t.Run(level, func(t *testing.T) {
			run := runCodexResultsThroughCollector(t, level)
			for call, uploaded := range run.uploaded {
				collected := run.collected[call]
				if id := member(uploaded, "event", "id"); id == nil || id != member(collected, "event", "id") {
					t.Errorf("%s: event id %v, collector wrote %v", call, id, member(collected, "event", "id"))
				}
			}
			for call, want := range map[string]string{"call_ok": "tool.completed", "call_fail": "tool.failed"} {
				event := run.uploaded[call]
				if got := member(event, "event", "action"); got != want {
					t.Errorf("%s: action %v, want %s", call, got, want)
				}
				if member(event, "mcp", "server") != "valaris" || member(event, "mcp", "tool") == nil {
					t.Errorf("%s: MCP identity missing: %v", call, event["mcp"])
				}
			}
			for _, call := range []string{"call_unknown", "call_missing"} {
				if got := member(run.uploaded[call], "event", "action"); got != member(run.collected[call], "event", "action") || got == "tool.completed" || got == "tool.failed" {
					t.Errorf("%s: an unknown success settled the call: %v (collector %v)", call, got, member(run.collected[call], "event", "action"))
				}
			}
			for call, want := range map[string]float64{"call_ok": 478, "call_fail": 12, "call_unknown": 5, "call_missing": 7} {
				if got := member(run.uploaded[call], "command", "duration_ms"); got != want {
					t.Errorf("%s: duration %v, want %v", call, got, want)
				}
			}
			if bytes.Contains(run.rawUpload, []byte("9007199254740992")) {
				t.Error("a large integer was rounded through float64")
			}
			if level == "full" || level == "rich" {
				if !bytes.Contains(run.rawUpload, []byte(beyondFloat64)) {
					t.Errorf("%s dropped a large integer the collector kept: %s", level, run.rawUpload)
				}
				if !bytes.Contains(run.rawUpload, []byte("RESULT_OUTPUT_MARK")) {
					t.Errorf("%s did not keep tool output; the run fell below full", level)
				}
			} else {
				for _, text := range []string{"RESULT_OUTPUT_MARK", "FAILED_OUTPUT_MARK"} {
					if bytes.Contains(run.rawUpload, []byte(text)) {
						t.Errorf("%s uploaded tool output %s", level, text)
					}
				}
				if level == "metadata" && bytes.Contains(run.rawUpload, []byte("RESULT_ARGUMENT_MARK")) {
					t.Error("metadata uploaded tool arguments")
				}
			}
		})
	}
}
