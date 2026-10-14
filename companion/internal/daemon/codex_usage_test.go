// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
	"github.com/Valaris-Studio/backplane/companion/internal/collector"
	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

const desktopThread = "019a8f2e-7c1d-7b3a-9e41-5d2c8a6f0b11"

// desktopFixture is Codex Desktop as the owner ran it: hooks carry the
// rollout path, the telemetry carries no traces, so no usage.
func desktopFixture(t *testing.T) *fixture {
	t.Helper()
	f := codexFixture(t)
	f.server.Lock()
	f.server.Policy.Installation.EnabledAgents = []string{"claude_code", "codex_cli", "codex_desktop"}
	f.server.Unlock()
	f.forcePolicyRefresh(t)
	f.shim.Registry = registryWith(codex.New())
	withAgentEnv(t, f)
	f.setupDone = *f.clock
	return f
}

// since sets the clock to offset after the fixture's setup, whose policy
// refresh opened the Codex capture window.
func (f *fixture) since(t *testing.T, offset time.Duration) time.Time {
	t.Helper()
	*f.clock = f.setupDone.Add(offset)
	return *f.clock
}

func (f *fixture) rolloutPath(thread string) string {
	return filepath.Join(f.home, ".codex", "sessions", "2026", "09", "24", "rollout-2026-09-24T12-00-00-"+thread+".jsonl")
}

func rolloutLine(t *testing.T, at time.Time, kind string, payload map[string]any) string {
	t.Helper()
	line, err := json.Marshal(map[string]any{"timestamp": at.UTC().Format(time.RFC3339Nano), "type": kind, "payload": payload})
	if err != nil {
		t.Fatal(err)
	}
	return string(line) + "\n"
}

func rolloutRecord(t *testing.T, at time.Time, thread, responseID string, output int) string {
	usage := map[string]any{"input_tokens": 12000, "cached_input_tokens": 9000, "cache_write_input_tokens": 0, "output_tokens": output, "reasoning_output_tokens": 0, "total_tokens": 12000 + output}
	return rolloutLine(t, at, "token_usage_record", map[string]any{"thread_id": thread, "turn_id": "turn-1", "session_id": thread, "response_id": responseID, "usage": usage, "turn_token_usage": usage, "thread_token_usage": usage})
}

// startDesktopSession writes the rollout's header and runs the thread's
// SessionStart hook with its transcript_path, as Codex Desktop does.
func (f *fixture) startDesktopSession(t *testing.T, thread, cwd string) string {
	t.Helper()
	return f.startCodexSession(t, thread, cwd, "Codex Desktop")
}

func (f *fixture) startCodexSession(t *testing.T, thread, cwd, originator string) string {
	t.Helper()
	path := f.rolloutPath(thread)
	os.MkdirAll(filepath.Dir(path), 0o700)
	header := rolloutLine(t, f.stamp(), "session_meta", map[string]any{"id": thread, "session_id": thread, "cwd": cwd, "originator": originator, "cli_version": "0.155.0-alpha.16", "model_provider": "openai"}) +
		rolloutLine(t, f.stamp(), "turn_context", map[string]any{"turn_id": "turn-1", "cwd": cwd, "model": "gpt-5.4"}) +
		rolloutLine(t, f.stamp(), "response_item", map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": "SECRET_PROMPT"}}})
	if err := os.WriteFile(path, []byte(header), 0o600); err != nil {
		t.Fatal(err)
	}
	input := `{"session_id":"` + thread + `","transcript_path":"` + path + `","cwd":"` + cwd + `","hook_event_name":"SessionStart","model":"gpt-5.4","permission_mode":"default","source":"startup"}`
	if err := f.shim.Handle("codex", strings.NewReader(input)); err != nil {
		t.Fatal(err)
	}
	return path
}

func appendTo(t *testing.T, path, text string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	file.WriteString(text)
}

// traceUsage is Beacon's normalization of a Codex turn span.
func traceUsage(thread, harness, turn string, output int) string {
	event, _ := json.Marshal(map[string]any{
		"schema_version": "1.0", "timestamp": "2026-09-24T12:00:10Z",
		"event":   map[string]any{"action": "token.usage", "id": "span-" + turn},
		"harness": map[string]any{"name": harness, "collection_method": "otlp"},
		"session": map[string]any{"id": thread},
		"gen_ai":  map[string]any{"usage": map[string]any{"input_tokens": 3000, "cache_read": map[string]any{"input_tokens": 9000}, "output_tokens": output}},
		"raw":     map[string]any{"otel_signal": "traces", "source": "codex_turn_span", "turn_id": turn},
	})
	return string(event) + "\n"
}

func (f *fixture) appendRuntime(t *testing.T, lines string) {
	t.Helper()
	otelDir := store.Layout{Root: f.layout.Root}.OTelDir()
	os.MkdirAll(otelDir, 0o700)
	file, err := os.OpenFile(collector.RuntimePath(otelDir), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	file.WriteString(lines)
}

func usageBy(records []map[string]any) map[string][]float64 {
	found := map[string][]float64{}
	for _, record := range usageRecords(records) {
		key := fmt.Sprint(record["harness"], "/", record["collection_method"])
		for _, event := range record["events"].([]any) {
			found[key] = append(found[key], event.(map[string]any)["gen_ai"].(map[string]any)["usage"].(map[string]any)["output_tokens"].(float64))
		}
	}
	return found
}

func TestCodexDesktopUsageIsReadFromTheRolloutWhenNoTraceCarriesIt(t *testing.T) {
	f := desktopFixture(t)
	recorder := recordSessions(f)
	rollout := f.startDesktopSession(t, desktopThread, f.repo)
	response := f.since(t, 10*time.Second)
	appendTo(t, rollout, rolloutRecord(t, response, desktopThread, "resp_01", 800))
	f.appendRuntime(t, runtimeEvent(desktopThread, "codex_desktop", "session.started")+"\n")
	// Well within the settle: Codex Desktop exports no traces, so nothing
	// is worth waiting for.
	f.since(t, 20*time.Second)
	f.tick(t)
	usage := usageRecords(f.server.Records())
	if len(usage) != 1 {
		t.Fatalf("want one usage record, got %v", usageBy(f.server.Records()))
	}
	record := usage[0]
	if record["harness"] != "codex_desktop" || record["collection_method"] != "poll" || record["native_session_id"] != desktopThread || record["mapping_id"] != "m1" {
		t.Fatalf("record envelope: %v", record)
	}
	encoded, _ := json.Marshal(record)
	for _, forbidden := range []string{"SECRET_PROMPT", f.repo, ".codex"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("%q uploaded: %s", forbidden, encoded)
		}
	}
	event := recorder.last()
	if event.Session.Harness != "codex_desktop" || event.Session.NativeSessionID != desktopThread {
		t.Fatalf("session event: %+v", event.Session)
	}
	if tokens := event.Session.Tokens; tokens == nil || tokens.Output != 800 || tokens.Input != 3000 || tokens.CacheRead != 9000 {
		t.Fatalf("the Home tile's tokens: %+v", tokens)
	}
	f.since(t, 5*time.Minute)
	f.tick(t)
	if found := usageBy(f.server.Records()); fmt.Sprint(found) != "map[codex_desktop/poll:[800]]" {
		t.Fatalf("a later poll re-uploaded: %v", found)
	}
}

func TestCodexTraceUsageWinsOverTheRollout(t *testing.T) {
	f := desktopFixture(t)
	recorder := recordSessions(f)
	rollout := f.startDesktopSession(t, desktopThread, f.repo)
	appendTo(t, rollout, rolloutRecord(t, f.since(t, 10*time.Second), desktopThread, "resp_01", 800))
	f.appendRuntime(t, traceUsage(desktopThread, "codex_cli", "turn-1", 800))
	f.since(t, 15*time.Second)
	f.tick(t)
	f.since(t, 10*time.Second+rolloutSettle+time.Minute)
	appendTo(t, rollout, rolloutRecord(t, f.stamp(), desktopThread, "resp_02", 50))
	f.tick(t)
	f.since(t, 10*time.Minute)
	f.tick(t)
	if found := usageBy(f.server.Records()); fmt.Sprint(found) != "map[codex_cli/otlp:[800]]" {
		t.Fatalf("a session whose traces carry usage is never also read from its rollout: %v", found)
	}
	if tokens := recorder.last().Session.Tokens; tokens == nil || tokens.Output != 800 {
		t.Fatalf("tokens counted once: %+v", tokens)
	}
}

func TestCodexRolloutClaimsTheSessionSoLateTraceUsageIsNotCountedAgain(t *testing.T) {
	f := desktopFixture(t)
	rollout := f.startDesktopSession(t, desktopThread, f.repo)
	appendTo(t, rollout, rolloutRecord(t, f.since(t, 10*time.Second), desktopThread, "resp_01", 800))
	f.since(t, 10*time.Second+rolloutSettle+time.Second)
	f.tick(t)
	// A restarted daemon still knows which source owns the session.
	config := f.daemon.config
	f.daemon = New(config)
	f.appendRuntime(t, traceUsage(desktopThread, "codex_desktop", "turn-1", 800)+runtimeEvent(desktopThread, "codex_desktop", "prompt.submitted")+"\n")
	appendTo(t, rollout, rolloutRecord(t, f.stamp(), desktopThread, "resp_02", 50))
	f.tick(t)
	if found := usageBy(f.server.Records()); fmt.Sprint(found) != "map[codex_desktop/poll:[800 50]]" {
		t.Fatalf("trace usage for a session its rollout already counts must not be added: %v", found)
	}
	if len(f.server.Records()) != 3 {
		t.Fatalf("the thread's other telemetry still uploads: %d records", len(f.server.Records()))
	}
}

func TestCodexRolloutOfAnOutOfScopeThreadIsNeverUploaded(t *testing.T) {
	f := desktopFixture(t)
	outside := filepath.Join(f.home, "elsewhere")
	os.MkdirAll(outside, 0o700)
	rollout := f.startDesktopSession(t, desktopThread, outside)
	appendTo(t, rollout, rolloutRecord(t, f.since(t, 10*time.Second), desktopThread, "resp_01", 800))
	f.since(t, 10*time.Second+rolloutSettle+time.Second)
	f.tick(t)
	if found := usageBy(f.server.Records()); len(found) != 0 {
		t.Fatalf("out-of-scope usage uploaded: %v", found)
	}
}

func TestCodexRolloutOutsideTheSessionsDirectoryIsNeverRead(t *testing.T) {
	f := desktopFixture(t)
	elsewhere := filepath.Join(f.home, "elsewhere", "rollout-2026-09-24T12-00-00-"+desktopThread+".jsonl")
	os.MkdirAll(filepath.Dir(elsewhere), 0o700)
	os.WriteFile(elsewhere, []byte(rolloutRecord(t, f.since(t, 10*time.Second), desktopThread, "resp_01", 800)), 0o600)
	input := `{"session_id":"` + desktopThread + `","transcript_path":"` + elsewhere + `","cwd":"` + f.repo + `","hook_event_name":"SessionStart","model":"gpt-5.4","permission_mode":"default","source":"startup"}`
	if err := f.shim.Handle("codex", strings.NewReader(input)); err != nil {
		t.Fatal(err)
	}
	f.since(t, 10*time.Second+rolloutSettle+time.Second)
	f.tick(t)
	if found := usageBy(f.server.Records()); len(found) != 0 {
		t.Fatalf("a rollout outside ~/.codex/sessions was read: %v", found)
	}
}

// The desktop writes enabled_agents from its integrations (one Codex), so
// Codex Desktop's usage follows the codex_cli switch.
func TestCodexDesktopUsageFollowsTheCodexSwitch(t *testing.T) {
	for name, c := range map[string]struct {
		enabled []string
		want    string
	}{
		"Pi switched off":        {[]string{"claude_code", "codex_cli"}, "map[codex_desktop/poll:[800]]"},
		"Codex switched off":     {[]string{"claude_code", "pi_cli"}, "map[]"},
		"list from an old build": {[]string{"claude_code", "codex_cli", "pi_cli"}, "map[codex_desktop/poll:[800]]"},
	} {
		t.Run(name, func(t *testing.T) {
			f := desktopFixture(t)
			f.server.Lock()
			f.server.Policy.Installation.EnabledAgents = c.enabled
			f.server.Unlock()
			f.forcePolicyRefresh(t)
			f.setupDone = *f.clock
			rollout := f.startDesktopSession(t, desktopThread, f.repo)
			appendTo(t, rollout, rolloutRecord(t, f.since(t, 10*time.Second), desktopThread, "resp_01", 800))
			f.appendRuntime(t, runtimeEvent(desktopThread, "codex_desktop", "prompt.submitted")+"\n")
			f.since(t, 10*time.Second+rolloutSettle+time.Second)
			f.tick(t)
			if found := usageBy(f.server.Records()); fmt.Sprint(found) != c.want {
				t.Fatalf("usage uploaded %v, want %s", found, c.want)
			}
			if telemetry := len(f.server.Records()) - len(usageRecords(f.server.Records())); (telemetry == 1) != (c.want != "map[]") {
				t.Fatalf("Desktop telemetry records: %d", telemetry)
			}
		})
	}
}

func TestTranscriptPollPausesWhileTheQueueIsFull(t *testing.T) {
	f := desktopFixture(t)
	rollout := f.startDesktopSession(t, desktopThread, f.repo)
	appendTo(t, rollout, rolloutRecord(t, f.since(t, 10*time.Second), desktopThread, "resp_01", 800))
	f.since(t, 10*time.Second+rolloutSettle+time.Second)
	f.daemon.queue = queue.Open(f.layout).WithClock(f.daemon.config.Now).WithMaxRecords(0)
	f.tick(t)
	if found := usageBy(f.server.Records()); len(found) != 0 {
		t.Fatalf("uploaded with a full queue: %v", found)
	}
	f.daemon.queue = queue.Open(f.layout).WithClock(f.daemon.config.Now)
	f.since(t, 10*time.Second+rolloutSettle+2*time.Second)
	f.tick(t)
	if found := usageBy(f.server.Records()); fmt.Sprint(found) != "map[codex_desktop/poll:[800]]" {
		t.Fatalf("the usage read while the queue was full waits and is uploaded once: %v", found)
	}
}

// wireCodexTraces points Codex's exporters at the companion's gate, as
// agents install codex does.
func (f *fixture) wireCodexTraces(t *testing.T) {
	t.Helper()
	f.knowGateEndpoint()
	if err := codex.New().Install(f.daemon.config.AgentEnv); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) knowGateEndpoint() {
	f.daemon.config.AgentEnv.Telemetry.Endpoint = "http://127.0.0.1:14327"
}

// A client the rollout does not name as Codex Desktop may export traces.
func TestCodexCLIRollout_WaitsTheSettleWhileItsTracesReachTheGate(t *testing.T) {
	for _, originator := range []string{"codex_cli_rs", "codex_future_client"} {
		t.Run(originator, func(t *testing.T) {
			f := desktopFixture(t)
			f.wireCodexTraces(t)
			rollout := f.startCodexSession(t, desktopThread, f.repo, originator)
			appendTo(t, rollout, rolloutRecord(t, f.since(t, 10*time.Second), desktopThread, "resp_01", 800))
			f.since(t, 20*time.Second)
			f.tick(t)
			if found := usageBy(f.server.Records()); len(found) != 0 {
				t.Fatalf("usage within the settle window may still arrive as a trace; uploaded %v", found)
			}
			f.appendRuntime(t, traceUsage(desktopThread, "codex_cli", "turn-1", 800))
			f.since(t, 40*time.Second)
			f.tick(t)
			f.since(t, 10*time.Second+rolloutSettle+time.Minute)
			f.tick(t)
			if found := usageBy(f.server.Records()); fmt.Sprint(found) != "map[codex_cli/otlp:[800]]" {
				t.Fatalf("the trace that came within the settle counts the session alone: %v", found)
			}
		})
	}
}

func TestCodexCLIRollout_IsCountedAtOnceWhenNoTraceCanReachTheGate(t *testing.T) {
	for name, setup := range map[string]func(*testing.T, *fixture){
		"exporters not wired":    func(_ *testing.T, f *fixture) { f.knowGateEndpoint() },
		"daemon runs no gateway": func(t *testing.T, f *fixture) { f.wireCodexTraces(t); f.daemon.config.OTel = nil },
	} {
		t.Run(name, func(t *testing.T) {
			f := desktopFixture(t)
			setup(t, f)
			rollout := f.startCodexSession(t, desktopThread, f.repo, "codex_cli_rs")
			appendTo(t, rollout, rolloutRecord(t, f.since(t, 10*time.Second), desktopThread, "resp_01", 800))
			f.since(t, 20*time.Second)
			f.tick(t)
			if found := usageBy(f.server.Records()); fmt.Sprint(found) != "map[codex_cli/poll:[800]]" {
				t.Fatalf("usage no trace can carry waited: %v", found)
			}
		})
	}
}

func TestCodexDesktopRollout_ClaimedAtOnceSoALateTraceIsNotCountedAgain(t *testing.T) {
	f := desktopFixture(t)
	f.wireCodexTraces(t)
	rollout := f.startDesktopSession(t, desktopThread, f.repo)
	appendTo(t, rollout, rolloutRecord(t, f.since(t, 10*time.Second), desktopThread, "resp_01", 800))
	f.since(t, 20*time.Second)
	f.tick(t)
	f.appendRuntime(t, traceUsage(desktopThread, "codex_desktop", "turn-1", 800))
	f.since(t, 30*time.Second)
	f.tick(t)
	f.since(t, 10*time.Second+rolloutSettle+time.Minute)
	f.tick(t)
	if found := usageBy(f.server.Records()); fmt.Sprint(found) != "map[codex_desktop/poll:[800]]" {
		t.Fatalf("one source per session: %v", found)
	}
}
