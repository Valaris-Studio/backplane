// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type sessionRecorder struct {
	mu     sync.Mutex
	events []SessionEvent
}

func (r *sessionRecorder) record(event SessionEvent) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, event)
}

func (r *sessionRecorder) kinds() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	kinds := []string{}
	for _, event := range r.events {
		kinds = append(kinds, event.Kind)
	}
	return kinds
}

func (r *sessionRecorder) last() SessionEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.events[len(r.events)-1]
}

func recordSessions(f *fixture) *sessionRecorder {
	recorder := &sessionRecorder{}
	f.daemon.config.Sessions = recorder.record
	return recorder
}

func TestSessionEvents_StartedUpdatedAndEnded(t *testing.T) {
	f := newFixture(t)
	recorder := recordSessions(f)
	started := *f.clock
	f.hook(t, f.repo, "SessionStart", `,"source":"startup"`)
	f.tick(t)
	f.at(t, time.Minute)
	f.hook(t, f.repo, "UserPromptSubmit", `,"prompt":"hello"`)
	f.tick(t)
	f.at(t, 2*time.Minute)
	f.hook(t, f.repo, "SessionEnd", `,"reason":"exit"`)
	f.tick(t)
	if kinds := strings.Join(recorder.kinds(), ","); kinds != "started,updated,ended" {
		t.Fatalf("kinds %s", kinds)
	}
	summary := recorder.last().Session
	if summary.NativeSessionID != "sess-1" || summary.Harness != "claude_code" || summary.Repo != "github.com/acme/app" {
		t.Fatalf("summary %+v", summary)
	}
	if !summary.StartedAt.Equal(started) || !summary.LastEventAt.Equal(now.Add(2*time.Minute)) {
		t.Fatalf("times %v %v", summary.StartedAt, summary.LastEventAt)
	}
}

func TestSessionEvents_UpdatesWithinTheThrottleAreCoalesced(t *testing.T) {
	f := newFixture(t)
	recorder := recordSessions(f)
	f.hook(t, f.repo, "SessionStart", `,"source":"startup"`)
	for range 5 {
		f.hook(t, f.repo, "UserPromptSubmit", `,"prompt":"hello"`)
	}
	f.tick(t)
	if kinds := strings.Join(recorder.kinds(), ","); kinds != "started" {
		t.Fatalf("a burst within the throttle must not flood subscribers: %s", kinds)
	}
}

func TestSessionEvents_CarryTokenTotalsFromUsage(t *testing.T) {
	f := newFixture(t)
	recorder := recordSessions(f)
	transcript := f.transcript(t, claudeRequest(t, f.stamp(), "msg_1", "req_1", 1, "SECRET_ONE")+claudeRequest(t, f.stamp(), "msg_1", "req_1", 250, "SECRET_TWO")+claudeRequest(t, f.stamp(), "msg_2", "req_2", 40, "SECRET_THREE"))
	f.tick(t)
	f.at(t, time.Minute)
	f.boundary(t, "Stop", transcript)
	f.tick(t)
	tokens := recorder.last().Session.Tokens
	if tokens == nil || tokens.Input != 6 || tokens.Output != 290 || tokens.CacheRead != 2000 || tokens.CacheWrite != 600 {
		t.Fatalf("tokens %+v", tokens)
	}
	// A re-read of the same requests is not counted twice.
	f.at(t, 2*time.Minute)
	f.boundary(t, "Stop", transcript)
	f.tick(t)
	if again := recorder.last().Session.Tokens; again.Output != 290 {
		t.Fatalf("tokens after a re-read %+v", again)
	}
}

func TestSessionEvents_CarryNoPromptOrLocalPath(t *testing.T) {
	f := newFixture(t)
	recorder := recordSessions(f)
	f.hook(t, f.repo, "UserPromptSubmit", `,"prompt":"SECRET_PROMPT_TEXT"`)
	f.tick(t)
	encoded, _ := json.Marshal(recorder.events)
	if len(recorder.events) == 0 {
		t.Fatal("no session event")
	}
	for _, forbidden := range []string{"SECRET", f.home, f.repo, "cwd", "prompt"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("session event carries %q: %s", forbidden, encoded)
		}
	}
}

func TestSessionEvents_OutOfScopeEmitsNothing(t *testing.T) {
	f := newFixture(t)
	recorder := recordSessions(f)
	other := filepath.Join(f.home, "code", "other")
	os.MkdirAll(filepath.Join(other, ".git"), 0o700)
	os.WriteFile(filepath.Join(other, ".git", "config"), []byte("[remote \"origin\"]\n\turl = git@github.com:acme/other.git\n"), 0o600)
	f.hook(t, other, "SessionStart", `,"source":"startup"`)
	f.tick(t)
	f.setPaused(t, true)
	f.hook(t, f.repo, "SessionStart", `,"source":"startup"`)
	f.tick(t)
	if len(recorder.kinds()) != 0 {
		t.Fatalf("out-of-scope sessions emitted %v", recorder.kinds())
	}
}

func TestSessionEvents_CostBasisFollowsTheRecordedAuthMode(t *testing.T) {
	codexEvent := func(mode string) json.RawMessage {
		return json.RawMessage(`{"event":{"id":"e-` + mode + `","action":"api.request"},"raw":{"attributes":{"auth_mode":"` + mode + `"}}}`)
	}
	for mode, want := range map[string][2]string{"ChatGPT": {"subscription", "api_equivalent"}, "chatgptAuthTokens": {"subscription", "api_equivalent"}, "ApiKey": {"api", "spend"}, "api_key": {"api", "spend"}} {
		var tracker sessionTracker
		tracker.noteQueued("codex_cli", "s", "", "", now, "", []json.RawMessage{codexEvent(mode)})
		summary := tracker.flush(now)[0].Session
		if summary.AuthKind == nil || *summary.AuthKind != want[0] || summary.CostBasis == nil || *summary.CostBasis != want[1] {
			t.Fatalf("%s: auth %v basis %v", mode, summary.AuthKind, summary.CostBasis)
		}
	}
}

func TestSessionEvents_UnknownAuthLeavesCostBasisNull(t *testing.T) {
	var tracker sessionTracker
	tracker.noteQueued("claude_code", "s", "", "", now, "", []json.RawMessage{json.RawMessage(`{"event":{"id":"e1"},"raw":{"attributes":{"auth_mode":"mystery"}}}`)})
	event := tracker.flush(now)[0]
	encoded, _ := json.Marshal(event)
	if !strings.Contains(string(encoded), `"cost_basis":null`) || !strings.Contains(string(encoded), `"auth_kind":null`) {
		t.Fatalf("unknown auth must be explicit nulls: %s", encoded)
	}
}

func TestSessionEvents_CarryTheMappingThatCapturedThem(t *testing.T) {
	f := newFixture(t)
	recorder := recordSessions(f)
	f.hook(t, f.repo, "SessionStart", `,"source":"startup"`)
	f.tick(t)
	if len(recorder.events) == 0 {
		t.Fatal("no session event")
	}
	// The fixture binds the folder by path only, so the repo alone can't name its board.
	if mappingID := recorder.last().Session.MappingID; mappingID == nil || *mappingID != "m1" {
		t.Fatalf("mapping id %v", mappingID)
	}
}

func TestSessionEvents_UnknownMappingIsAnExplicitNull(t *testing.T) {
	var tracker sessionTracker
	tracker.noteQueued("claude_code", "s", "", "", now, "", nil)
	encoded, _ := json.Marshal(tracker.flush(now)[0])
	if !strings.Contains(string(encoded), `"mapping_id":null`) {
		t.Fatalf("an unknown mapping must be an explicit null: %s", encoded)
	}
	if !strings.Contains(string(encoded), `"history_deleted":null`) {
		t.Fatalf("a session with its history intact must say so with an explicit null: %s", encoded)
	}
}

func TestSessionEvents_KeepTheLastKnownMapping(t *testing.T) {
	var tracker sessionTracker
	tracker.noteQueued("claude_code", "s", "", "m1", now, "", nil)
	tracker.noteQueued("claude_code", "s", "", "", now.Add(time.Second), "", nil)
	if mappingID := tracker.flush(now)[0].Session.MappingID; mappingID == nil || *mappingID != "m1" {
		t.Fatalf("mapping id %v", mappingID)
	}
	tracker.noteQueued("claude_code", "s", "", "m2", now.Add(3*time.Second), "", nil)
	if mappingID := tracker.flush(now.Add(3 * time.Second))[0].Session.MappingID; mappingID == nil || *mappingID != "m2" {
		t.Fatalf("mapping id after a rebind %v", mappingID)
	}
}

func TestSessionEvents_DeletedHistoryForgetsEarlierUsageAndSaysSo(t *testing.T) {
	usage := func(id string, at time.Time, input int) json.RawMessage {
		encoded, _ := json.Marshal(map[string]any{"event": map[string]string{"id": id}, "timestamp": at.UTC().Format(time.RFC3339Nano), "gen_ai": map[string]any{"usage": map[string]int{"input_tokens": input}}})
		return encoded
	}
	var tracker sessionTracker
	tracker.noteQueued("claude_code", "s", "", "", now, "", []json.RawMessage{usage("before", now.Add(-time.Minute), 100), usage("after", now.Add(time.Minute), 7)})
	tracker.flush(now)
	tracker.noteHistoryDeleted("claude_code", "s", now, "retention")
	tracker.noteHistoryDeleted("claude_code", "never-tracked", now, "owner")
	events := tracker.flush(now.Add(time.Hour))
	if len(events) != 1 {
		t.Fatalf("events %+v, want one update of the tracked session only", events)
	}
	summary := events[0].Session
	if summary.HistoryDeleted == nil || *summary.HistoryDeleted != "retention" || summary.Tokens == nil || summary.Tokens.Input != 7 {
		t.Fatalf("summary %+v tokens %+v", summary, summary.Tokens)
	}
	encoded, _ := json.Marshal(events[0])
	if !strings.Contains(string(encoded), `"history_deleted":"retention"`) {
		t.Fatalf("history_deleted missing from %s", encoded)
	}
}
