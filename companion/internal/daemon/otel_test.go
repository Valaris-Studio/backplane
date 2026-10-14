// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
	"github.com/Valaris-Studio/backplane/companion/internal/collector"
	"github.com/Valaris-Studio/backplane/companion/internal/otlpgate"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

func codexFixture(t *testing.T) *fixture {
	t.Helper()
	f := newFixture(t)
	f.server.Lock()
	f.server.Policy.Installation.EnabledAgents = []string{"claude_code", "codex_cli"}
	f.server.Unlock()
	f.daemon.config.Registry = registryWith(codex.New())
	f.daemon.config.OTel = &OTelConfig{Harness: codex.HarnessForService}
	f.daemon.refreshPolicy(context.Background())
	return f
}

func (f *fixture) thread(t *testing.T, id, cwd string) {
	t.Helper()
	if err := state.RecordThread(f.layout, id, state.Thread{Agent: "codex_cli", Cwd: cwd, SessionID: "thread-root"}, *f.clock); err != nil {
		t.Fatal(err)
	}
}

func TestResolverDecidesThreadsFromHookCwd(t *testing.T) {
	f := codexFixture(t)
	outside := filepath.Join(f.home, "elsewhere")
	os.MkdirAll(outside, 0o700)
	f.thread(t, "thread-root", f.repo)
	f.thread(t, "thread-out", outside)
	ctx := context.Background()
	if decision := f.daemon.Resolve(ctx, "thread-root", "codex_cli"); decision.Verdict != otlpgate.Forward || decision.MappingID != "m1" || decision.ContentLevel != privacy.Standard {
		t.Fatalf("mapped thread: %+v", decision)
	}
	if decision := f.daemon.Resolve(ctx, "thread-out", "codex_cli"); decision.Verdict != otlpgate.Drop {
		t.Fatalf("unmapped thread: %+v", decision)
	}
	if decision := f.daemon.Resolve(ctx, "thread-unknown", "codex_cli"); decision.Verdict != otlpgate.Undecided {
		t.Fatalf("thread without a hook decision: %+v", decision)
	}
	if decision := f.daemon.Resolve(ctx, "thread-root", "codex_desktop"); decision.Verdict != otlpgate.Forward {
		t.Fatalf("Codex Desktop follows the Codex switch, whatever list an older build wrote: %+v", decision)
	}
	if decision := f.daemon.Resolve(ctx, "thread-root", "pi_cli"); decision.Verdict != otlpgate.Drop {
		t.Fatalf("a harness not enabled must drop: %+v", decision)
	}
	*f.clock = f.clock.Add(24*time.Hour + time.Minute)
	f.daemon.resolved = nil
	if decision := f.daemon.Resolve(ctx, "thread-root", "codex_cli"); decision.Verdict != otlpgate.Undecided {
		t.Fatalf("a stale policy must hold, not drop or forward: %+v", decision)
	}
}

func runtimeEvent(session, harness, action string) string {
	event, _ := json.Marshal(map[string]any{
		"schema_version": "1.0", "timestamp": "2026-09-24T12:00:00Z",
		"event":    map[string]any{"action": action, "id": session + action},
		"harness":  map[string]any{"name": harness, "collection_method": "otlp"},
		"session":  map[string]any{"id": session},
		"user":     map[string]any{"name": "person"},
		"endpoint": map[string]any{"hostname": "laptop.local", "os": "darwin"},
	})
	return string(event)
}

func TestNormalizedOTelEventsAreScopedQueuedAndUploadedOnce(t *testing.T) {
	f := codexFixture(t)
	outside := filepath.Join(f.home, "elsewhere")
	os.MkdirAll(outside, 0o700)
	f.thread(t, "thread-root", f.repo)
	f.thread(t, "thread-out", outside)
	otelDir := store.Layout{Root: f.layout.Root}.OTelDir()
	os.MkdirAll(otelDir, 0o700)
	lines := runtimeEvent("thread-root", "codex_cli", "prompt.submitted") + "\n" + runtimeEvent("thread-out", "codex_cli", "prompt.submitted") + "\n" + runtimeEvent("thread-root", "codex_cli", "token.usage") + "\n"
	os.WriteFile(collector.RuntimePath(otelDir), []byte(lines), 0o600)
	f.tick(t)
	records := f.server.Records()
	if len(records) != 2 {
		t.Fatalf("uploaded %d records", len(records))
	}
	for _, record := range records {
		if record["harness"] != "codex_cli" || record["collection_method"] != "otlp" || record["native_session_id"] != "thread-root" || record["mapping_id"] != "m1" {
			t.Fatalf("record envelope: %v", record)
		}
	}
	encoded, _ := json.Marshal(records)
	if strings.Contains(string(encoded), "laptop.local") || strings.Contains(string(encoded), `"user"`) {
		t.Fatalf("device identity uploaded: %s", encoded)
	}
	if event := records[0]["events"].([]any)[0].(map[string]any); event["repository"] != "github.com/acme/app" {
		t.Fatalf("runtime event not placed at its repository: %v", event)
	}
	os.Remove(filepath.Join(otelDir, "tail.json"))
	f.tick(t)
	if len(f.server.Records()) != 2 {
		t.Fatal("replayed runtime lines uploaded twice")
	}
	if stats, _ := queue.Open(f.layout).Stats(); stats.Records != 0 {
		t.Fatalf("queue not drained: %+v", stats)
	}
}

func TestUndecidedRuntimeLinesStayUnreadAndUnknownThreadsAreConsumed(t *testing.T) {
	f := codexFixture(t)
	f.thread(t, "thread-root", f.repo)
	otelDir := f.layout.OTelDir()
	os.MkdirAll(otelDir, 0o700)
	os.WriteFile(collector.RuntimePath(otelDir), []byte(runtimeEvent("thread-evicted", "codex_cli", "prompt.submitted")+"\n"+runtimeEvent("thread-root", "codex_cli", "prompt.submitted")+"\n"), 0o600)
	f.server.Lock()
	f.server.Status["/api/companion/policy"] = 503
	f.server.Unlock()
	*f.clock = f.clock.Add(24*time.Hour + time.Minute)
	f.tick(t)
	if len(f.server.Records()) != 0 {
		t.Fatal("uploaded under a stale policy")
	}
	f.server.Lock()
	delete(f.server.Status, "/api/companion/policy")
	f.server.Unlock()
	*f.clock = f.clock.Add(2 * time.Minute)
	f.daemon.resolved = nil
	f.tick(t)
	records := f.server.Records()
	if len(records) != 1 || records[0]["native_session_id"] != "thread-root" {
		t.Fatalf("a line held during a stale policy was lost or the unknown thread uploaded: %v", records)
	}
}

func TestTailTimeContentLevelFollowsTheCurrentMapping(t *testing.T) {
	f := codexFixture(t)
	f.server.Lock()
	f.server.Policy.Mappings[0].ContentLevel = "metadata"
	f.server.Unlock()
	f.daemon.refreshPolicy(context.Background())
	f.thread(t, "thread-root", f.repo)
	event, _ := json.Marshal(map[string]any{
		"schema_version": "1.0", "event": map[string]any{"action": "prompt.submitted"},
		"harness": map[string]any{"name": "codex_cli"}, "session": map[string]any{"id": "thread-root"},
		"prompt": map[string]any{"text": "FORWARDED_WHILE_STANDARD"},
	})
	os.MkdirAll(f.layout.OTelDir(), 0o700)
	os.WriteFile(collector.RuntimePath(f.layout.OTelDir()), append(event, '\n'), 0o600)
	f.tick(t)
	uploaded, _ := json.Marshal(f.server.Records())
	if len(f.server.Records()) != 1 || strings.Contains(string(uploaded), "FORWARDED_WHILE_STANDARD") || !strings.Contains(string(uploaded), "prompt.submitted") {
		t.Fatalf("metadata level not re-applied at tail time: %s", uploaded)
	}
}

func TestBackpressureIsRecomputedEvenWhenTheInboxDrainFails(t *testing.T) {
	f := codexFixture(t)
	os.MkdirAll(f.layout.OTelDir(), 0o700)
	line := runtimeEvent("thread-unknown", "codex_cli", "prompt.submitted") + "\n"
	backlog := strings.Repeat(line, collector.BacklogLimit/len(line)+1)
	os.WriteFile(collector.RuntimePath(f.layout.OTelDir()), []byte(backlog), 0o600)
	// A hard inbox failure: the inbox directory is replaced by a file.
	os.RemoveAll(f.layout.InboxDir())
	os.WriteFile(f.layout.InboxDir(), []byte("not a directory"), 0o600)
	if err := f.daemon.Tick(context.Background()); err == nil {
		t.Fatal("setup: the inbox drain should fail")
	}
	if !f.daemon.otelBackpressure.Load() {
		t.Fatal("back-pressure not recomputed after an inbox drain failure")
	}
}

// A Codex hook's session_id is the tree's root, not the subagent's
// immediate parent, and the server keeps the first parent it is told: with
// no header of its own to read, the child names no parent.
func TestSubagentRecordsWithoutTheirOwnHeaderNameNoParent(t *testing.T) {
	f := codexFixture(t)
	f.thread(t, "thread-root", f.repo)
	if err := state.RecordThread(f.layout, "thread-child", state.Thread{Agent: "codex_cli", Cwd: f.repo, SessionID: "thread-root"}, *f.clock); err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(f.layout.OTelDir(), 0o700)
	lines := runtimeEvent("thread-root", "codex_cli", "prompt.submitted") + "\n" + runtimeEvent("thread-child", "codex_cli", "prompt.submitted") + "\n"
	os.WriteFile(collector.RuntimePath(f.layout.OTelDir()), []byte(lines), 0o600)
	f.tick(t)
	parents := map[any]any{}
	for _, record := range f.server.Records() {
		parent, present := record["parent_native_session_id"]
		if !present {
			parent = "<absent>"
		}
		parents[record["native_session_id"]] = parent
	}
	if parents["thread-child"] != "<absent>" || parents["thread-root"] != "<absent>" {
		t.Fatalf("parent sessions: %v", parents)
	}
}
