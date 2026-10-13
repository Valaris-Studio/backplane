// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/claudecode"
	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
)

func (f *fixture) hookSession(t *testing.T, session, event string) {
	t.Helper()
	input := `{"cwd":"` + f.repo + `","session_id":"` + session + `","hook_event_name":"` + event + `"}`
	if err := f.shim.Handle("claude_code", strings.NewReader(input)); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) uploadedSessions() []string {
	var sessions []string
	for _, record := range f.server.Records() {
		sessions = append(sessions, record["native_session_id"].(string))
	}
	return sessions
}

func TestADeletedSessionIsCapturedAgainAfterItsCutoff(t *testing.T) {
	f := newFixture(t)
	recorder := recordSessions(f)
	through := *f.clock
	f.server.Lock()
	f.server.DeletedThrough["gone"] = through
	f.server.Unlock()
	f.hookSession(t, "gone", "SessionStart")
	f.tick(t)
	stats, _ := queue.Open(f.layout).Stats()
	if stats.Records != 0 || stats.Dropped != 1 || stats.DropReasons["session_deleted"] != 1 {
		t.Fatalf("dropped record not delivered and counted: %+v", stats)
	}

	// Captured by the cutoff: the device no longer uploads it at all.
	f.hookSession(t, "gone", "UserPromptSubmit")
	f.hookSession(t, "kept", "UserPromptSubmit")
	f.tick(t)
	if got := f.uploadedSessions(); strings.Join(got, ",") != "gone,kept" {
		t.Fatalf("uploaded sessions %v, want nothing of the deleted one by its cutoff", got)
	}
	health, _ := state.Load[state.Health](f.layout.Health())
	if health.SuppressedDeleted != 1 || f.inboxCount(t) != 0 {
		t.Fatalf("suppressed capture not counted or not reclaimed: %+v", health)
	}

	// Resumed after the cutoff: captured again, and its row says why the
	// earlier history is gone instead of waiting for token counts.
	*f.clock = through.Add(time.Minute)
	f.hookSession(t, "gone", "UserPromptSubmit")
	f.tick(t)
	if got := f.uploadedSessions(); strings.Join(got, ",") != "gone,kept,gone" {
		t.Fatalf("uploaded sessions %v, want the resumed session captured", got)
	}
	if stats, _ := queue.Open(f.layout).Stats(); stats.Dropped != 1 {
		t.Fatalf("activity after the cutoff dropped: %+v", stats)
	}
	var gone *SessionSummary
	for _, event := range recorder.events {
		if event.Session.NativeSessionID == "gone" {
			gone = &event.Session
		}
	}
	if gone == nil || gone.HistoryDeleted == nil || *gone.HistoryDeleted != "owner" {
		t.Fatalf("resumed session not marked as having deleted history: %+v", gone)
	}
}

// A server from before history cutoffs drops without naming one: the moment
// the device learns of the deletion stands in for it.
func TestADropWithoutACutoffStopsUploadsOnlyUntilTheDeviceLearnedOfIt(t *testing.T) {
	f := newFixture(t)
	f.server.Lock()
	f.server.DeletedSessions["gone"] = true
	f.server.Unlock()
	f.hookSession(t, "gone", "SessionStart")
	f.tick(t)
	learned := *f.clock

	f.server.Lock()
	delete(f.server.DeletedSessions, "gone")
	f.server.Unlock()
	f.hookSession(t, "gone", "UserPromptSubmit")
	f.tick(t)
	*f.clock = learned.Add(time.Minute)
	f.hookSession(t, "gone", "UserPromptSubmit")
	f.tick(t)
	if got := f.uploadedSessions(); strings.Join(got, ",") != "gone,gone" {
		t.Fatalf("uploaded sessions %v, want the drop, then only what came after it", got)
	}
}

func TestEventsObservedAfterTheCutoffAreAllThatIsKept(t *testing.T) {
	through := now
	line := func(id string, at time.Time) json.RawMessage {
		encoded, _ := json.Marshal(map[string]any{"event": map[string]string{"id": id}, "timestamp": at.UTC().Format(time.RFC3339Nano)})
		return encoded
	}
	untimed := json.RawMessage(`{"event":{"id":"untimed"}}`)
	lines := []json.RawMessage{
		line("before", through.Add(-time.Second)),
		line("at", through),
		line("after", through.Add(time.Millisecond)),
		untimed,
	}
	// An event without a timestamp is as old as the capture that carries it.
	kept := eventsObservedAfter(lines, through, through.Add(time.Minute))
	if len(kept) != 2 || !strings.Contains(string(kept[0]), `"after"`) || string(kept[1]) != string(untimed) {
		t.Fatalf("kept %s", kept)
	}
	if kept := eventsObservedAfter([]json.RawMessage{untimed}, through, through); len(kept) != 0 {
		t.Fatalf("an untimed event captured by the cutoff was kept: %s", kept)
	}
}

func (f *fixture) heartbeats() []map[string]any {
	f.server.Lock()
	defer f.server.Unlock()
	return append([]map[string]any(nil), f.server.Heartbeats...)
}

func (f *fixture) withClaudeInstalled(t *testing.T) {
	t.Helper()
	executable := filepath.Join(f.home, "bin", "backplane-companion")
	os.MkdirAll(filepath.Dir(executable), 0o700)
	os.WriteFile(executable, []byte("#!/bin/sh\n"), 0o700)
	env := agent.Env{Home: f.home, Getenv: func(string) string { return "" }, Executable: executable}
	if err := claudecode.New().Install(env); err != nil {
		t.Fatal(err)
	}
	f.daemon.config.AgentEnv = env
}

func TestHeartbeatIsSentAtStartOnChangeAndEveryFiveMinutes(t *testing.T) {
	f := newFixture(t)
	f.withClaudeInstalled(t)
	f.daemon.heartbeat = heartbeatState{} // as a daemon starting with Claude installed
	f.tick(t)
	sent := f.heartbeats()
	if len(sent) == 0 {
		t.Fatal("no heartbeat at start")
	}
	first := sent[len(sent)-1]
	encoded, _ := json.Marshal(first)
	if first["companion_version"] != "dev" || first["beacon_commit"] != beacon.Commit || strings.Contains(string(encoded), f.home) {
		t.Fatalf("heartbeat: %s", encoded)
	}
	agents := first["agents"].([]any)
	if claude := agents[0].(map[string]any); claude["harness"] != "claude_code" || claude["state"] != "capturing" {
		t.Fatalf("agent states: %v", agents)
	}
	queued := first["queue"].(map[string]any)
	if queued["pending"] != float64(0) || queued["dropped_total"] != float64(0) {
		t.Fatalf("queue health: %v", queued)
	}
	count := len(sent)

	f.tick(t)
	if len(f.heartbeats()) != count {
		t.Fatal("heartbeat repeated without a change")
	}
	*f.clock = f.clock.Add(2 * time.Minute)
	state.Update(context.Background(), f.layout, f.layout.Preferences(), func(preferences *state.Preferences) bool {
		preferences.Paused = true
		return true
	})
	f.tick(t)
	sent = f.heartbeats()
	if len(sent) != count+1 || sent[count]["agents"].([]any)[0].(map[string]any)["state"] != "disabled" {
		t.Fatalf("a paused agent was not reported: %v", sent)
	}
	*f.clock = f.clock.Add(30 * time.Second)
	state.Update(context.Background(), f.layout, f.layout.Preferences(), func(preferences *state.Preferences) bool {
		preferences.Paused = false
		return true
	})
	f.tick(t)
	if len(f.heartbeats()) != count+1 {
		t.Fatal("heartbeat sent within a minute of the last one")
	}
	*f.clock = f.clock.Add(5 * time.Minute)
	f.tick(t)
	if len(f.heartbeats()) != count+2 {
		t.Fatal("no periodic heartbeat")
	}
}

func TestRevokedDeviceHeartbeatMarksItUnauthorized(t *testing.T) {
	f := newFixture(t)
	f.tick(t)
	f.server.Lock()
	f.server.TokenRevoked = true
	f.server.Status["/api/companion/policy"] = 503
	f.server.Unlock()
	*f.clock = f.clock.Add(6 * time.Minute)
	f.tickRevoked(t)
	admission, _ := state.Load[state.Admission](f.layout.Admission())
	if !admission.Unauthorized {
		t.Fatal("401 on the heartbeat did not mark the device unauthorized")
	}
}

func TestRevokedCredentialEndsTheRunButKeepsTheQueue(t *testing.T) {
	f := newFixture(t)
	f.tick(t)
	f.hook(t, f.repo, "SessionStart", "")
	f.server.RevokeAll()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := f.daemon.RunLocked(ctx); !errors.Is(err, ErrRevoked) {
		t.Fatalf("run must end on a revoked credential: %v", err)
	}
	if f.queueCount(t) != 1 {
		t.Fatalf("revocation must keep queued records: %d", f.queueCount(t))
	}
}

func TestARevocationRecordsWhichInstallationItApplied(t *testing.T) {
	f := newFixture(t)
	f.daemon.config.InstallationID = "this-installation"
	f.server.RevokeAll()
	*f.clock = f.clock.Add(PolicyInterval)
	f.tickRevoked(t)
	admission, _ := state.Load[state.Admission](f.layout.Admission())
	if !admission.Unauthorized || admission.InstallationID != "this-installation" {
		t.Fatalf("revocation not attributed: %+v", admission)
	}
}
