// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/claudecode"
	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
	"github.com/Valaris-Studio/backplane/companion/internal/contracttest"
	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/shim"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

var now = time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)

type fakeNormalizer struct {
	calls    atomic.Int32
	fail     bool
	err      error
	payloads []map[string]any
	// carryPayload copies the payload into the event's raw member, as the
	// pinned Beacon does for Pi events.
	carryPayload bool
	// normalized, when set, is what Beacon makes of every request.
	normalized []map[string]any
}

func (f *fakeNormalizer) Normalize(_ context.Context, request beacon.Request) (beacon.Result, error) {
	f.calls.Add(1)
	f.payloads = append(f.payloads, request.Payload)
	if f.fail {
		return beacon.Result{}, beacon.ErrNormalize
	}
	if f.err != nil {
		return beacon.Result{}, f.err
	}
	// Like Beacon, the event carries the local working directory.
	if f.normalized != nil {
		var events []json.RawMessage
		for _, event := range f.normalized {
			encoded, _ := json.Marshal(event)
			events = append(events, encoded)
		}
		return beacon.Result{Events: events, SchemaVersion: "1.0"}, nil
	}
	normalized := map[string]any{"schema_version": "1.0", "event": map[string]string{"action": "observed." + request.Event}, "session": map[string]string{"id": request.SessionID, "working_directory": request.Cwd}, "repository": request.Cwd}
	if f.carryPayload {
		normalized["raw"] = request.Payload
	}
	event, _ := json.Marshal(normalized)
	return beacon.Result{Events: []json.RawMessage{event}, SchemaVersion: "1.0"}, nil
}

type fixture struct {
	daemon     *Daemon
	shim       shim.Shim
	server     *uplinktest.Server
	normalizer *fakeNormalizer
	layout     store.Layout
	home, repo string
	clock      *time.Time
	// setupDone is the clock once a fixture's setup finished ticking.
	setupDone time.Time
	// parsed counts the session-file lines the rich fixture's agent parsed.
	parsed *atomic.Int64
}

const fixtureInstallation = "fixture-installation"

func newFixture(t *testing.T, extraAgents ...agent.Agent) *fixture {
	t.Helper()
	root, _ := filepath.EvalSymlinks(t.TempDir())
	home := filepath.Join(root, "home")
	repo := filepath.Join(home, "code", "app")
	os.MkdirAll(filepath.Join(repo, ".git"), 0o700)
	os.WriteFile(filepath.Join(repo, ".git", "config"), []byte("[remote \"origin\"]\n\turl = git@github.com:acme/app.git\n"), 0o600)
	os.MkdirAll(filepath.Join(root, "tmp"), 0o700)
	layout, err := store.Open(filepath.Join(root, "data"))
	if err != nil {
		t.Fatal(err)
	}
	store.WriteJSON(layout.Installation(), state.Installation{ID: fixtureInstallation})
	server := uplinktest.New(t)
	server.Policy.Mappings = []policy.Mapping{{ID: "m1", WorkspaceID: "w", RootPath: repo, Enabled: true, ContentLevel: "standard"}}
	client, _ := uplink.New(uplink.Options{Endpoint: server.URL, AllowLoopbackHTTP: true})
	device, _ := client.WithDeviceToken(uplinktest.DeviceToken)
	for index, extra := range extraAgents {
		if reader, ok := extra.(contracttest.Agent); ok && reader.Root == "" {
			reader.Root = sessionsDir(home)
			extraAgents[index] = reader
		}
	}
	registry := agent.NewRegistry(append([]agent.Agent{claudecode.New()}, extraAgents...)...)
	current := now
	clock := func() time.Time { return current }
	temp := []string{filepath.Join(root, "tmp")}
	normalizer := &fakeNormalizer{}
	f := &fixture{
		daemon:     New(Config{InstallationID: fixtureInstallation, Layout: layout, Client: device, Normalizer: normalizer, Registry: registry, Home: home, TempDirs: temp, Now: clock}),
		shim:       shim.Shim{Layout: layout, Registry: registry, Home: home, TempDirs: temp, Now: clock},
		server:     server,
		normalizer: normalizer,
		layout:     layout,
		home:       home,
		repo:       repo,
		clock:      &current,
	}
	// The shim only captures once the daemon has cached a policy.
	f.tick(t)
	return f
}

func (f *fixture) tick(t *testing.T) {
	t.Helper()
	if err := f.daemon.Tick(context.Background()); err != nil {
		t.Fatal(err)
	}
}

// tickRevoked runs a pass that must end the run because the server refused
// the device credential.
func (f *fixture) tickRevoked(t *testing.T) {
	t.Helper()
	if err := f.daemon.Tick(context.Background()); !errors.Is(err, ErrRevoked) {
		t.Fatalf("a refused credential must end the run with ErrRevoked, got %v", err)
	}
}

func (f *fixture) hook(t *testing.T, cwd, event, extra string) {
	t.Helper()
	base, err := json.Marshal(map[string]string{"cwd": cwd, "session_id": "sess-1", "hook_event_name": event})
	if err != nil {
		t.Fatal(err)
	}
	input := strings.TrimSuffix(string(base), "}") + extra + "}"
	if err := f.shim.Handle("claude_code", strings.NewReader(input)); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) inboxCount(t *testing.T) int {
	names, err := inbox.List(f.layout.InboxDir())
	if err != nil {
		t.Fatal(err)
	}
	return len(names)
}

func (f *fixture) queueCount(t *testing.T) int {
	stats, err := queue.Open(f.layout).Stats()
	if err != nil {
		t.Fatal(err)
	}
	return stats.Records
}

func TestInboxIsNormalizedUploadedAndReclaimed(t *testing.T) {
	f := newFixture(t)
	f.hook(t, f.repo, "SessionStart", "")
	f.hook(t, f.repo, "UserPromptSubmit", `,"prompt":"hello"`)
	f.tick(t)
	records := f.server.Records()
	if len(records) != 2 {
		t.Fatalf("uploaded %d records", len(records))
	}
	first := records[0]
	for key, want := range map[string]any{"mapping_id": "m1", "harness": "claude_code", "collection_method": "hook", "native_session_id": "sess-1", "harness_version": nil} {
		if first[key] != want {
			t.Errorf("%s = %v, want %v", key, first[key], want)
		}
	}
	if id, _ := first["capture_id"].(string); len(id) != 32 {
		t.Errorf("capture id %q", id)
	}
	provenance, _ := first["beacon"].(map[string]any)
	if provenance["commit"] != beacon.Commit || provenance["schema_version"] != "1.0" {
		t.Errorf("beacon provenance %v", provenance)
	}
	if f.inboxCount(t) != 0 || f.queueCount(t) != 0 {
		t.Fatal("local state not empty after ack")
	}
}

func TestUploadedEventsCarryTheRepositoryAndNoLocalPath(t *testing.T) {
	f := newFixture(t)
	os.WriteFile(filepath.Join(f.repo, ".git", "HEAD"), []byte("ref: refs/heads/main\n"), 0o600)
	sub := filepath.Join(f.repo, "cmd")
	os.MkdirAll(sub, 0o700)
	f.hook(t, sub, "UserPromptSubmit", `,"prompt":"open `+f.repo+`/main.go and `+f.home+`/notes.txt"`)
	f.tick(t)
	records := f.server.Records()
	if len(records) != 1 {
		t.Fatalf("uploaded %d records", len(records))
	}
	event := records[0]["events"].([]any)[0].(map[string]any)
	if event["repository"] != "github.com/acme/app" || event["branch"] != "main" {
		t.Errorf("repository %v, branch %v", event["repository"], event["branch"])
	}
	if directory := event["session"].(map[string]any)["working_directory"]; directory != "cmd" {
		t.Errorf("working directory %v", directory)
	}
	encoded, _ := json.Marshal(records)
	if strings.Contains(string(encoded), f.home) {
		t.Fatalf("a local path was uploaded: %s", encoded)
	}
}

func TestPendingAutoMatchResolvesOncePerRoot(t *testing.T) {
	f := newFixture(t)
	f.server.Lock()
	f.server.Policy.Mappings = nil
	f.server.Policy.RepoCatalog = []policy.CatalogRepo{{WorkspaceID: "w", BoardID: "b", RepoURLNormalized: "github.com/acme/app"}}
	f.server.Resolvable["github.com/acme/app"] = policy.Mapping{ID: "auto-1", WorkspaceID: "w", Enabled: true, ContentLevel: "metadata"}
	f.server.Unlock()
	f.daemon.refreshPolicy(context.Background())
	f.hook(t, f.repo, "UserPromptSubmit", `,"prompt":"private words"`)
	f.hook(t, f.repo, "Stop", "")
	f.tick(t)
	f.server.Lock()
	resolutions := f.server.Resolutions
	f.server.Unlock()
	if len(resolutions) != 1 || len(resolutions[0]) != 1 || resolutions[0]["repo_url"] != "github.com/acme/app" {
		t.Fatalf("resolutions: %+v", resolutions)
	}
	records := f.server.Records()
	if len(records) != 2 || records[0]["mapping_id"] != "auto-1" {
		t.Fatalf("records not bound to the resolved mapping: %+v", records)
	}
	encoded, _ := json.Marshal(f.normalizer.payloads[0])
	if strings.Contains(string(encoded), "private words") {
		t.Fatal("resolved metadata level not applied before normalization")
	}
	cached, _ := policy.Load(f.layout.Policy())
	if len(cached.Policy.Mappings) != 1 {
		t.Fatal("resolved mapping not cached")
	}
}

func TestUnmatchedAutoMatchDropsItemsAndMarksProject(t *testing.T) {
	f := newFixture(t)
	f.server.Lock()
	f.server.Policy.Mappings = nil
	f.server.Policy.RepoCatalog = []policy.CatalogRepo{{WorkspaceID: "w", RepoURLNormalized: "github.com/acme/app"}}
	f.server.Unlock()
	f.daemon.refreshPolicy(context.Background())
	f.hook(t, f.repo, "SessionStart", "")
	f.tick(t)
	if f.inboxCount(t) != 0 || len(f.server.Records()) != 0 || f.normalizer.calls.Load() != 0 {
		t.Fatal("unmatched item retained, normalized or uploaded")
	}
	discovered, _ := state.Load[state.Discovered](f.layout.Discovered())
	if len(discovered.UnmatchedRoots()) != 1 {
		t.Fatalf("project not marked unmatched: %+v", discovered)
	}
	f.hook(t, f.repo, "SessionStart", "")
	if f.inboxCount(t) != 0 {
		t.Fatal("shim retried a repo the server refused")
	}
}

func TestInboxIsRescopedAgainstFreshPolicy(t *testing.T) {
	f := newFixture(t)
	f.hook(t, f.repo, "SessionStart", "")
	f.server.Lock()
	f.server.Policy.Installation.Paused = true
	f.server.Unlock()
	f.daemon.refreshPolicy(context.Background())
	f.tick(t)
	if f.inboxCount(t) != 0 || len(f.server.Records()) != 0 {
		t.Fatal("item captured before a server pause was uploaded")
	}
}

func TestUnauthorizedStopsAdmissionAndKeepsQueue(t *testing.T) {
	f := newFixture(t)
	f.tick(t)
	f.hook(t, f.repo, "SessionStart", "")
	f.server.RevokeAll()
	f.tickRevoked(t)
	admission, _ := state.Load[state.Admission](f.layout.Admission())
	if !admission.Unauthorized || f.queueCount(t) != 1 {
		t.Fatalf("401 did not stop admission or lost data: %+v queue=%d", admission, f.queueCount(t))
	}
	f.hook(t, f.repo, "Stop", "")
	if f.inboxCount(t) != 0 {
		t.Fatal("shim admitted while unauthorized")
	}
	// Reconnecting (same installation, rotated token) starts a new run.
	f.server.Lock()
	f.server.TokenRevoked = false
	f.server.Unlock()
	f.daemon = New(f.daemon.config)
	f.tick(t)
	if admission, _ := state.Load[state.Admission](f.layout.Admission()); admission.Unauthorized || f.queueCount(t) != 0 {
		t.Fatal("successful policy refresh did not restore admission and drain")
	}
}

func TestABare401BacksOffWithoutRevokingTheDevice(t *testing.T) {
	f := newFixture(t)
	f.hook(t, f.repo, "SessionStart", "")
	f.server.Lock()
	f.server.Status["/api/companion/ingest"] = 401
	f.server.Status["/api/companion/status"] = 401
	f.server.Unlock()
	f.tick(t)
	admission, _ := state.Load[state.Admission](f.layout.Admission())
	stats, _ := queue.Open(f.layout).Stats()
	if admission.Unauthorized || stats.Records != 1 || stats.LastError != "unauthorized" || !f.clock.Before(stats.NextAttempt) {
		t.Fatalf("a proxy's 401 must back off, not revoke: %+v %+v", admission, stats)
	}
	f.server.Lock()
	f.server.Status = map[string]int{"/api/companion/policy": 401}
	f.server.Unlock()
	*f.clock = f.clock.Add(PolicyInterval)
	f.tick(t)
	if admission, _ := state.Load[state.Admission](f.layout.Admission()); admission.Unauthorized {
		t.Fatal("a bare 401 on the policy revoked the device")
	}
}

func TestRejectedRecordsAreDeletedAndCounted(t *testing.T) {
	f := newFixture(t)
	f.server.Lock()
	f.server.Respond = func(ids []string) (int, any) {
		return 200, map[string]any{"acknowledged": []string{}, "rejected": []map[string]string{{"capture_id": ids[0], "reason": "mapping_revoked"}}}
	}
	f.server.Unlock()
	f.hook(t, f.repo, "SessionStart", "")
	f.tick(t)
	stats, _ := queue.Open(f.layout).Stats()
	if stats.Records != 0 || stats.RejectReasons["mapping_revoked"] != 1 {
		t.Fatalf("rejected record lingered or went uncounted: %+v", stats)
	}
}

func TestMalformedAckDeletesNothingAndBacksOff(t *testing.T) {
	f := newFixture(t)
	f.server.Lock()
	f.server.Respond = func([]string) (int, any) { return 200, map[string]any{"records": []any{}} }
	f.server.Unlock()
	f.hook(t, f.repo, "SessionStart", "")
	f.tick(t)
	stats, _ := queue.Open(f.layout).Stats()
	if stats.Records != 1 || stats.Failures == 0 || stats.LastError != uplink.ErrInvalidResponse.Error() {
		t.Fatalf("malformed ack handling: %+v", stats)
	}
}

func TestNormalizationFailureDropsItemAndCounts(t *testing.T) {
	f := newFixture(t)
	f.normalizer.fail = true
	f.hook(t, f.repo, "SessionStart", "")
	f.tick(t)
	health, _ := state.Load[state.Health](f.layout.Health())
	if f.inboxCount(t) != 0 || health.NormalizeFailures != 1 || len(f.server.Records()) != 0 {
		t.Fatalf("poison item not dropped: %+v", health)
	}
}

func TestSingleInstanceAndPromptCancellation(t *testing.T) {
	f := newFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- f.daemon.Run(ctx) }()
	time.Sleep(100 * time.Millisecond)
	second := New(f.daemon.config)
	if err := second.Run(context.Background()); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("second daemon started: %v", err)
	}
	started := time.Now()
	cancel()
	select {
	case err := <-done:
		if err != nil || time.Since(started) > 2*time.Second {
			t.Fatalf("cancel: %v after %v", err, time.Since(started))
		}
	case <-time.After(5 * time.Second):
		t.Fatal("daemon ignored cancellation")
	}
}

func (f *fixture) inboxFiles(t *testing.T) map[string][]byte {
	t.Helper()
	names, _ := inbox.List(f.layout.InboxDir())
	files := map[string][]byte{}
	for _, name := range names {
		data, err := os.ReadFile(filepath.Join(f.layout.InboxDir(), name))
		if err != nil {
			t.Fatal(err)
		}
		files[name] = data
	}
	return files
}

func (f *fixture) restoreInbox(t *testing.T, files map[string][]byte) {
	t.Helper()
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(f.layout.InboxDir(), name), data, 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCrashReplayOfInboxItemIsNotRenormalizedOrDuplicated(t *testing.T) {
	f := newFixture(t)
	f.hook(t, f.repo, "UserPromptSubmit", `,"prompt":"hello"`)
	saved := f.inboxFiles(t)
	f.server.Lock()
	f.server.Status["/api/companion/ingest"] = 503
	f.server.Unlock()
	f.tick(t)
	if f.queueCount(t) != 1 || f.normalizer.calls.Load() != 1 {
		t.Fatal("setup: record not queued")
	}
	// A crash between enqueue and inbox removal leaves both copies.
	f.restoreInbox(t, saved)
	f.tick(t)
	if f.normalizer.calls.Load() != 1 || f.queueCount(t) != 1 || f.inboxCount(t) != 0 {
		t.Fatalf("replayed item re-normalized or duplicated: calls=%d queue=%d", f.normalizer.calls.Load(), f.queueCount(t))
	}
	f.server.Lock()
	delete(f.server.Status, "/api/companion/ingest")
	f.server.Unlock()
	*f.clock = f.clock.Add(time.Hour)
	f.tick(t)
	f.restoreInbox(t, saved)
	f.tick(t)
	records := f.server.Records()
	if len(records) != 1 || f.normalizer.calls.Load() != 1 {
		t.Fatalf("replay after ack uploaded again: records=%d calls=%d", len(records), f.normalizer.calls.Load())
	}
	for name := range saved {
		if records[0]["capture_id"] != captureID("claude_code", name) {
			t.Fatalf("capture id not derived from the inbox item: %v", records[0]["capture_id"])
		}
	}
}

func TestTransientAdmissionStatesKeepAdmittedItems(t *testing.T) {
	t.Run("policy stale", func(t *testing.T) {
		f := newFixture(t)
		f.hook(t, f.repo, "SessionStart", "")
		f.server.Lock()
		f.server.Status["/api/companion/policy"] = 503
		f.server.Unlock()
		*f.clock = f.clock.Add(policy.TrustWindow + time.Hour)
		f.tick(t)
		if f.inboxCount(t) != 1 || f.normalizer.calls.Load() != 0 {
			t.Fatal("stale policy dropped or processed an admitted item")
		}
		f.server.Lock()
		delete(f.server.Status, "/api/companion/policy")
		f.server.Unlock()
		*f.clock = f.clock.Add(time.Hour)
		f.tick(t)
		if f.inboxCount(t) != 0 || len(f.server.Records()) != 1 {
			t.Fatal("item not processed after the policy recovered")
		}
	})
	t.Run("unauthorized", func(t *testing.T) {
		f := newFixture(t)
		f.hook(t, f.repo, "SessionStart", "")
		f.server.Lock()
		f.server.TokenRevoked = true
		f.server.Unlock()
		*f.clock = f.clock.Add(time.Hour)
		f.tickRevoked(t)
		if f.inboxCount(t) != 1 {
			t.Fatal("unauthorized device dropped an admitted item")
		}
	})
	t.Run("privacy exclusion drops", func(t *testing.T) {
		f := newFixture(t)
		f.hook(t, f.repo, "SessionStart", "")
		store.WriteJSON(f.layout.Preferences(), state.Preferences{IgnoredPaths: []string{f.repo}})
		f.tick(t)
		if f.inboxCount(t) != 0 || f.normalizer.calls.Load() != 0 {
			t.Fatal("ignored project's item was kept or processed")
		}
	})
}

func TestZeroProgressAckBacksOffInsteadOfHotLooping(t *testing.T) {
	f := newFixture(t)
	f.server.Lock()
	f.server.Respond = func([]string) (int, any) { return 200, map[string]any{"acknowledged": []string{}, "rejected": []any{}} }
	f.server.Unlock()
	f.hook(t, f.repo, "SessionStart", "")
	f.tick(t)
	stats, _ := queue.Open(f.layout).Stats()
	f.server.Lock()
	batches := len(f.server.Batches)
	f.server.Unlock()
	if stats.Records != 1 || stats.Failures != 1 || batches != 1 {
		t.Fatalf("empty ack did not back off: %+v batches=%d", stats, batches)
	}
}

func TestNormalizeInterruptionKeepsItem(t *testing.T) {
	f := newFixture(t)
	f.normalizer.err = fmt.Errorf("%w: canceled", beacon.ErrInterrupted)
	f.hook(t, f.repo, "SessionStart", "")
	f.tick(t)
	health, _ := state.Load[state.Health](f.layout.Health())
	if f.inboxCount(t) != 1 || health.NormalizeFailures != 0 {
		t.Fatalf("interrupted normalization dropped the item: %+v", health)
	}
}

func withAgentEnv(t *testing.T, f *fixture) agent.Env {
	t.Helper()
	executable := filepath.Join(f.home, "bin", "backplane-companion")
	os.MkdirAll(filepath.Dir(executable), 0o700)
	os.WriteFile(executable, []byte("#!/bin/sh\n"), 0o700)
	env := agent.Env{Home: f.home, Getenv: func(string) string { return "" }, Executable: executable}
	f.daemon.config.AgentEnv = env
	return env
}

func TestReconcileRepairsStaleOwnedEntriesOnly(t *testing.T) {
	f := newFixture(t)
	env := withAgentEnv(t, f)
	claude := claudecode.New()
	settings := filepath.Join(f.home, ".claude", "settings.json")
	f.tick(t)
	if _, err := os.Stat(settings); !os.IsNotExist(err) {
		t.Fatal("reconcile installed an agent the user never installed")
	}
	oldEnv := env
	oldEnv.Executable = filepath.Join(f.home, "old", "backplane-companion")
	if err := claude.Install(oldEnv); err != nil {
		t.Fatal(err)
	}
	var parsed map[string]any
	data, _ := os.ReadFile(settings)
	json.Unmarshal(data, &parsed)
	hooks := parsed["hooks"].(map[string]any)
	delete(hooks, "PreToolUse")
	hooks["Notification"] = []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": "foreign notifier"}}}}
	edited, _ := json.Marshal(parsed)
	os.WriteFile(settings, edited, 0o600)
	*f.clock = f.clock.Add(ReconcileInterval - time.Minute)
	f.tick(t)
	if data, _ := os.ReadFile(settings); string(data) != string(edited) {
		t.Fatal("reconciled before the interval elapsed")
	}
	*f.clock = f.clock.Add(2 * time.Minute)
	f.tick(t)
	data, _ = os.ReadFile(settings)
	if strings.Contains(string(data), oldEnv.Executable) || !strings.Contains(string(data), env.Executable) {
		t.Fatalf("stale owned entries not repointed: %s", data)
	}
	if strings.Contains(string(data), "PreToolUse") {
		t.Fatal("reconcile re-added an event hook the user removed")
	}
	if !strings.Contains(string(data), "foreign notifier") {
		t.Fatal("repair touched a foreign entry")
	}
	for cycle := 0; cycle < 3; cycle++ {
		*f.clock = f.clock.Add(ReconcileInterval)
		f.tick(t)
	}
	health, _ := state.Load[state.Health](f.layout.Health())
	if len(health.AgentRepairs) != 2 || health.AgentRepairs[0].Result != "repaired" || health.AgentRepairs[1].Result != "unrepaired" || !contains(health.AgentRepairs[1].Problems, "PreToolUse:missing") {
		t.Fatalf("expected one repair and one note for the remaining opt-out: %+v", health.AgentRepairs)
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func TestReconcileNotesFailedRepairAndLeavesCorruptSettings(t *testing.T) {
	f := newFixture(t)
	env := withAgentEnv(t, f)
	settings := filepath.Join(f.home, ".claude", "settings.json")
	claudecode.New().Install(env)
	os.WriteFile(settings, []byte(`{"hooks":`), 0o600)
	for cycle := 0; cycle < 3; cycle++ {
		*f.clock = f.clock.Add(ReconcileInterval)
		f.tick(t)
	}
	if data, _ := os.ReadFile(settings); string(data) != `{"hooks":` {
		t.Fatal("corrupt settings rewritten")
	}
	health, _ := state.Load[state.Health](f.layout.Health())
	if len(health.AgentRepairs) != 1 || !strings.HasPrefix(health.AgentRepairs[0].Result, "failed:") {
		t.Fatalf("failed repair not noted: %+v", health.AgentRepairs)
	}
}

func TestAgentActivityIsRecordedForStatus(t *testing.T) {
	f := newFixture(t)
	f.hook(t, f.repo, "SessionStart", "")
	f.tick(t)
	health, _ := state.Load[state.Health](f.layout.Health())
	activity := health.Agents["claude_code"]
	if !activity.LastObservationAt.Equal(now) || !activity.LastUploadAt.Equal(now) {
		t.Fatalf("agent activity not recorded: %+v", health.Agents)
	}
}

func TestEventsBeaconDoesNotMapAreDroppedQuietly(t *testing.T) {
	f := newFixture(t)
	f.normalizer.err = beacon.ErrNoEvents
	f.hook(t, f.repo, "SessionStart", "")
	f.tick(t)
	health, _ := state.Load[state.Health](f.layout.Health())
	if f.inboxCount(t) != 0 || f.queueCount(t) != 0 || health.NormalizeFailures != 0 || health.DroppedItems != 0 || health.BeaconEmpty != 1 {
		t.Fatalf("unmapped event kept, counted as a failure or not counted as empty: inbox=%d %+v", f.inboxCount(t), health)
	}
}

func registryWith(extra ...agent.Agent) *agent.Registry {
	return agent.NewRegistry(append([]agent.Agent{claudecode.New()}, extra...)...)
}

func TestMappingRefusalsLeaveTheRepoUnmappedWithoutAnAuthFailure(t *testing.T) {
	for _, status := range []int{409, 403, 422} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			f := newFixture(t)
			f.server.Lock()
			f.server.Policy.Mappings = nil
			f.server.Policy.RepoCatalog = []policy.CatalogRepo{{WorkspaceID: "w", RepoURLNormalized: "github.com/acme/app"}}
			f.server.MappingRefusals["github.com/acme/app"] = status
			f.server.Unlock()
			f.daemon.refreshPolicy(context.Background())
			f.hook(t, f.repo, "SessionStart", "")
			f.tick(t)
			admission, _ := state.Load[state.Admission](f.layout.Admission())
			discovered, _ := state.Load[state.Discovered](f.layout.Discovered())
			if f.inboxCount(t) != 0 || admission.Unauthorized || len(discovered.UnmatchedRoots()) != 1 {
				t.Fatalf("status %d: inbox=%d unauthorized=%v discovered=%+v", status, f.inboxCount(t), admission.Unauthorized, discovered)
			}
		})
	}
}

// Capture records which folder it attributed to which mapping, so agent
// access can find a repo-bound mapping's clones.
func TestCaptureRecordsTheRootItAttributedToAMapping(t *testing.T) {
	f := newFixture(t)
	sub := filepath.Join(f.repo, "pkg")
	os.MkdirAll(sub, 0o700)
	f.hook(t, sub, "SessionStart", "")
	other := filepath.Join(f.home, "code", "unbound")
	os.MkdirAll(filepath.Join(other, ".git"), 0o700)
	f.hook(t, other, "SessionStart", "")
	f.tick(t)
	roots, err := state.Load[state.MappedRoots](f.layout.MappedRoots())
	if err != nil || roots.Roots[f.repo].MappingID != "m1" {
		t.Fatalf("mapped roots %+v %v", roots, err)
	}
	if _, recorded := roots.Roots[other]; recorded || len(roots.Roots) != 1 {
		t.Fatalf("an unmapped folder was recorded: %+v", roots.Roots)
	}
}
