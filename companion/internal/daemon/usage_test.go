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

	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

func claudeRequest(t *testing.T, at time.Time, messageID, requestID string, output int, text string) string {
	t.Helper()
	line, err := json.Marshal(map[string]any{
		"type": "assistant", "sessionId": "sess-1", "timestamp": at.UTC().Format(time.RFC3339Nano), "requestId": requestID,
		"cwd": "/SECRET/cwd",
		"message": map[string]any{
			"id": messageID, "role": "assistant", "model": "claude-sonnet-4-5-20250929",
			"content": []any{map[string]any{"type": "text", "text": text}},
			"usage": map[string]any{
				"input_tokens": 3, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 300,
				"cache_creation": map[string]any{"ephemeral_5m_input_tokens": 100, "ephemeral_1h_input_tokens": 200},
				"output_tokens":  output, "service_tier": "standard",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	return string(line) + "\n"
}

// stamp is a moment just after the fixture's clock, inside whatever capture
// window the last tick left open.
func (f *fixture) stamp() time.Time { return f.clock.Add(time.Second) }

func (f *fixture) setPaused(t *testing.T, paused bool) {
	t.Helper()
	f.setPreferences(t, state.Preferences{Paused: paused})
}

func (f *fixture) setPreferences(t *testing.T, preferences state.Preferences) {
	t.Helper()
	if err := store.WriteJSON(f.layout.Preferences(), preferences); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) at(t *testing.T, offset time.Duration) time.Time {
	t.Helper()
	*f.clock = now.Add(offset)
	return *f.clock
}

func outputsOf(records []map[string]any) []float64 {
	var outputs []float64
	for _, record := range usageRecords(records) {
		for _, event := range record["events"].([]any) {
			outputs = append(outputs, event.(map[string]any)["gen_ai"].(map[string]any)["usage"].(map[string]any)["output_tokens"].(float64))
		}
	}
	return outputs
}

// Turns taken while capture was paused are never uploaded, even when the
// boundary that reads them comes after the resume.
func TestClaudeUsageDuringAPauseIsNeverUploaded(t *testing.T) {
	f := newFixture(t)
	transcript := f.transcript(t, claudeRequest(t, f.at(t, 30*time.Second), "msg_before", "req_before", 1, "x"))
	f.at(t, time.Minute)
	f.tick(t)
	f.setPaused(t, true)
	f.at(t, 2*time.Minute)
	f.tick(t)
	f.transcript(t, claudeRequest(t, f.at(t, 3*time.Minute), "msg_paused", "req_paused", 2, "x"))
	f.boundary(t, "Stop", transcript)
	f.setPaused(t, false)
	f.at(t, 5*time.Minute)
	f.tick(t)
	f.transcript(t, claudeRequest(t, f.at(t, 6*time.Minute), "msg_after", "req_after", 3, "x"))
	f.at(t, 7*time.Minute)
	f.boundary(t, "Stop", transcript)
	f.tick(t)
	if outputs := outputsOf(f.server.Records()); fmt.Sprint(outputs) != "[1 3]" {
		t.Fatalf("want the requests from before the pause and after the resume, got %v", outputs)
	}
}

// While the session's directory is excluded (an ignored path or an exclude
// glob) its mapping stays allowed elsewhere, but its own usage never uploads.
func (f *fixture) setMappings(t *testing.T, mappings ...policy.Mapping) {
	t.Helper()
	f.server.Lock()
	f.server.Policy.Mappings = mappings
	f.server.Unlock()
	f.forcePolicyRefresh(t)
}

// While the session's directory resolved to another mapping (a nested,
// disabled one) or to none (a mapping edited away from it), its usage
// never uploads, even once it resolves to an allowed mapping again.
func TestClaudeUsageWhileTheDirectoryResolvedElsewhereIsNeverUploaded(t *testing.T) {
	variants := map[string]struct {
		before, during func(f *fixture) []policy.Mapping
	}{
		"nested disabled mapping": {
			before: func(f *fixture) []policy.Mapping {
				return []policy.Mapping{{ID: "parent", WorkspaceID: "w", RootPath: filepath.Dir(f.repo), Enabled: true, ContentLevel: "standard"}}
			},
			during: func(f *fixture) []policy.Mapping {
				return []policy.Mapping{
					{ID: "parent", WorkspaceID: "w", RootPath: filepath.Dir(f.repo), Enabled: true, ContentLevel: "standard"},
					{ID: "child", WorkspaceID: "w", RootPath: f.repo, Enabled: false, ContentLevel: "standard"},
				}
			},
		},
		"root edited away": {
			before: func(f *fixture) []policy.Mapping {
				return []policy.Mapping{{ID: "m1", WorkspaceID: "w", RootPath: f.repo, Enabled: true, ContentLevel: "standard"}}
			},
			during: func(f *fixture) []policy.Mapping {
				return []policy.Mapping{{ID: "m1", WorkspaceID: "w", RootPath: filepath.Join(filepath.Dir(f.repo), "other"), Enabled: true, ContentLevel: "standard"}}
			},
		},
		"repository edited away": {
			before: func(f *fixture) []policy.Mapping {
				return []policy.Mapping{{ID: "m1", WorkspaceID: "w", RepoURLNormalized: "github.com/acme/app", Enabled: true, ContentLevel: "standard"}}
			},
			during: func(f *fixture) []policy.Mapping {
				return []policy.Mapping{{ID: "m1", WorkspaceID: "w", RepoURLNormalized: "github.com/acme/other", Enabled: true, ContentLevel: "standard"}}
			},
		},
	}
	for name, variant := range variants {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			os.MkdirAll(filepath.Join(filepath.Dir(f.repo), "other"), 0o700)
			f.setMappings(t, variant.before(f)...)
			transcript := f.transcript(t, claudeRequest(t, f.stamp(), "msg_before", "req_before", 1, "x"))
			*f.clock = f.clock.Add(time.Minute)
			f.tick(t)
			f.setMappings(t, variant.during(f)...)
			f.transcript(t, claudeRequest(t, f.stamp(), "msg_elsewhere", "req_elsewhere", 2, "x"))
			f.boundary(t, "Stop", transcript)
			*f.clock = f.clock.Add(time.Minute)
			f.tick(t)
			f.setMappings(t, variant.before(f)...)
			f.hook(t, f.repo, "UserPromptSubmit", `,"prompt":"again"`)
			f.transcript(t, claudeRequest(t, f.stamp(), "msg_after", "req_after", 3, "x"))
			f.boundary(t, "Stop", transcript)
			f.tick(t)
			if outputs := outputsOf(f.server.Records()); fmt.Sprint(outputs) != "[1 3]" {
				t.Fatalf("want the requests while the directory resolved to the allowed mapping, got %v", outputs)
			}
		})
	}
}

func TestClaudeUsageWhileTheDirectoryWasExcludedIsNeverUploaded(t *testing.T) {
	exclusions := map[string]struct{ exclude, include func(*fixture, *testing.T) }{
		"ignored path": {
			exclude: func(f *fixture, t *testing.T) { f.setPreferences(t, state.Preferences{IgnoredPaths: []string{f.repo}}) },
			include: func(f *fixture, t *testing.T) { f.setPreferences(t, state.Preferences{}) },
		},
		"exclude glob": {
			exclude: func(f *fixture, t *testing.T) { f.setExcludeGlobs(t, []string{"code/app"}) },
			include: func(f *fixture, t *testing.T) { f.setExcludeGlobs(t, nil) },
		},
	}
	for name, exclusion := range exclusions {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			transcript := f.transcript(t, claudeRequest(t, f.at(t, 30*time.Second), "msg_before", "req_before", 1, "x"))
			f.at(t, time.Minute)
			f.tick(t)
			exclusion.exclude(f, t)
			f.at(t, 6*time.Minute)
			f.tick(t)
			f.transcript(t, claudeRequest(t, f.at(t, 7*time.Minute), "msg_excluded", "req_excluded", 2, "x"))
			f.boundary(t, "Stop", transcript)
			// The daemon keeps ticking through the exclusion.
			f.at(t, 9*time.Minute)
			f.tick(t)
			exclusion.include(f, t)
			f.at(t, 12*time.Minute)
			f.tick(t)
			f.transcript(t, claudeRequest(t, f.at(t, 13*time.Minute), "msg_after", "req_after", 3, "x"))
			f.at(t, 14*time.Minute)
			f.boundary(t, "Stop", transcript)
			f.tick(t)
			if outputs := outputsOf(f.server.Records()); fmt.Sprint(outputs) != "[1 3]" {
				t.Fatalf("want the requests outside the exclusion, got %v", outputs)
			}
		})
	}
}

func (f *fixture) setExcludeGlobs(t *testing.T, globs []string) {
	t.Helper()
	f.server.Lock()
	f.server.Policy.Installation.ExcludeGlobs = globs
	f.server.Unlock()
	// The next tick is past the policy interval, so it refreshes.
	*f.clock = f.clock.Add(PolicyInterval)
}

// A forked or resumed session's transcript opens with the history it was
// forked from, rewritten under the new session id; that history was counted
// by its own session.
func TestClaudeUsageCopiedIntoAForkedSessionIsNotCountedAgain(t *testing.T) {
	f := newFixture(t)
	path := filepath.Join(f.home, ".claude", "projects", "-home-code-app", "sess-1.jsonl")
	os.MkdirAll(filepath.Dir(path), 0o700)
	os.WriteFile(path, []byte(claudeRequest(t, f.at(t, 10*time.Second), "msg_copied", "req_copied", 1, "x")), 0o600)
	f.at(t, time.Minute)
	f.hook(t, f.repo, "SessionStart", `,"source":"resume"`)
	f.tick(t)
	f.transcript(t, claudeRequest(t, f.at(t, 70*time.Second), "msg_new", "req_new", 2, "x"))
	f.boundary(t, "Stop", path)
	f.tick(t)
	if outputs := outputsOf(f.server.Records()); fmt.Sprint(outputs) != "[2]" {
		t.Fatalf("want only the forked session's own request, got %v", outputs)
	}
}

// A session that began before its repository was mapped uploads only the
// usage from after the mapping reached the device.
func TestClaudeUsageFromBeforeTheMappingIsNeverUploaded(t *testing.T) {
	f := newFixture(t)
	f.server.Lock()
	mapping := f.server.Policy.Mappings[0]
	f.server.Policy.Mappings = nil
	f.server.Unlock()
	f.forcePolicyRefresh(t)
	transcript := f.transcript(t, claudeRequest(t, f.stamp(), "msg_unmapped", "req_unmapped", 1, "x"))
	f.boundary(t, "Stop", transcript)
	mapping.ID = "m2"
	f.server.Lock()
	f.server.Policy.Mappings = []policy.Mapping{mapping}
	f.server.Unlock()
	f.forcePolicyRefresh(t)
	f.hook(t, f.repo, "UserPromptSubmit", `,"prompt":"go on"`)
	f.transcript(t, claudeRequest(t, f.stamp(), "msg_mapped", "req_mapped", 2, "x"))
	*f.clock = f.clock.Add(time.Minute)
	f.boundary(t, "Stop", transcript)
	f.tick(t)
	if outputs := outputsOf(f.server.Records()); fmt.Sprint(outputs) != "[2]" {
		t.Fatalf("want only the mapped request, got %v", outputs)
	}
}

// While the daemon is down nothing observes the pause state, so usage from
// that gap is never uploaded; usage from before the gap still is.
func TestClaudeUsageFromDaemonDowntimeIsNeverUploaded(t *testing.T) {
	f := newFixture(t)
	transcript := f.transcript(t, claudeRequest(t, f.at(t, 30*time.Second), "msg_before", "req_before", 1, "x"))
	f.at(t, 2*time.Minute)
	f.tick(t)
	f.transcript(t, claudeRequest(t, f.at(t, 10*time.Minute), "msg_gap", "req_gap", 2, "x"))
	f.at(t, 20*time.Minute)
	f.daemon = New(f.daemon.config)
	f.tick(t)
	f.transcript(t, claudeRequest(t, f.at(t, 21*time.Minute), "msg_after", "req_after", 3, "x"))
	f.at(t, 22*time.Minute)
	f.boundary(t, "Stop", transcript)
	f.tick(t)
	if outputs := outputsOf(f.server.Records()); fmt.Sprint(outputs) != "[1 3]" {
		t.Fatalf("want the requests on either side of the downtime, got %v", outputs)
	}
}

// transcript appends to the session's transcript; the first call opens the
// session with its SessionStart hook, as Claude Code does.
func (f *fixture) transcript(t *testing.T, content string) string {
	t.Helper()
	path := filepath.Join(f.home, ".claude", "projects", "-home-code-app", "sess-1.jsonl")
	if _, err := os.Stat(path); err != nil {
		f.hook(t, f.repo, "SessionStart", `,"source":"startup"`)
	}
	os.MkdirAll(filepath.Dir(path), 0o700)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	file.WriteString(content)
	return path
}

// boundary fires a hook a moment later, after the requests it closes.
func (f *fixture) boundary(t *testing.T, event, transcript string) {
	t.Helper()
	*f.clock = f.clock.Add(2 * time.Second)
	path, err := json.Marshal(transcript)
	if err != nil {
		t.Fatal(err)
	}
	f.hook(t, f.repo, event, `,"transcript_path":`+string(path))
}

// usageRecords returns the uploaded records carrying token.usage events.
func usageRecords(records []map[string]any) []map[string]any {
	var found []map[string]any
	for _, record := range records {
		events, _ := record["events"].([]any)
		if len(events) > 0 && events[0].(map[string]any)["event"].(map[string]any)["action"] == "token.usage" {
			found = append(found, record)
		}
	}
	return found
}

func TestClaudeTranscriptUsageIsUploadedOncePerRequest(t *testing.T) {
	f := newFixture(t)
	transcript := f.transcript(t, claudeRequest(t, f.stamp(), "msg_1", "req_1", 1, "SECRET_BLOCK_ONE")+claudeRequest(t, f.stamp(), "msg_1", "req_1", 250, "SECRET_BLOCK_TWO")+claudeRequest(t, f.stamp(), "msg_2", "req_2", 40, "SECRET_ANSWER"))
	f.boundary(t, "Stop", transcript)
	f.tick(t)
	usage := usageRecords(f.server.Records())
	if len(usage) != 1 {
		t.Fatalf("want one usage record, got %d of %v", len(usage), f.server.Records())
	}
	record := usage[0]
	for key, want := range map[string]any{"mapping_id": "m1", "harness": "claude_code", "native_session_id": "sess-1", "collection_method": "poll"} {
		if record[key] != want {
			t.Errorf("%s = %v, want %v", key, record[key], want)
		}
	}
	events := record["events"].([]any)
	if len(events) != 2 {
		t.Fatalf("want one event per request, got %d", len(events))
	}
	first := events[0].(map[string]any)
	usageFields := first["gen_ai"].(map[string]any)["usage"].(map[string]any)
	if usageFields["output_tokens"] != float64(250) || usageFields["cache_creation"].(map[string]any)["ephemeral_1h_input_tokens"] != float64(200) {
		t.Fatalf("usage %v", usageFields)
	}
	encoded, _ := json.Marshal(f.server.Records())
	for _, forbidden := range []string{"SECRET", transcript, f.home} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("%q was uploaded: %s", forbidden, encoded)
		}
	}

	f.boundary(t, "Stop", transcript)
	f.tick(t)
	if again := usageRecords(f.server.Records()); len(again) != 1 {
		t.Fatalf("a boundary with no new requests uploaded usage again: %d records", len(again))
	}
	f.transcript(t, claudeRequest(t, f.stamp(), "msg_3", "req_3", 9, "SECRET_LATER"))
	f.boundary(t, "SessionEnd", transcript)
	f.tick(t)
	later := usageRecords(f.server.Records())
	if len(later) != 2 || len(later[1]["events"].([]any)) != 1 {
		t.Fatalf("the session end uploads only the new request: %v", later)
	}
}

func TestClaudeUsageReplayedAfterALostCursorIsRecognized(t *testing.T) {
	f := newFixture(t)
	transcript := f.transcript(t, claudeRequest(t, f.stamp(), "msg_1", "req_1", 5, "x"))
	f.boundary(t, "Stop", transcript)
	f.tick(t)
	entries, _ := os.ReadDir(f.layout.UsageDir())
	for _, entry := range entries {
		os.Remove(filepath.Join(f.layout.UsageDir(), entry.Name()))
	}
	f.boundary(t, "Stop", transcript)
	f.tick(t)
	if usage := usageRecords(f.server.Records()); len(usage) != 1 {
		t.Fatalf("a re-read of the same requests was queued again: %d records", len(usage))
	}
}

func TestClaudeUsageKeepsTokensAndTierAtTheMetadataLevel(t *testing.T) {
	f := newFixture(t)
	f.server.Lock()
	f.server.Policy.Mappings[0].ContentLevel = "metadata"
	f.server.Unlock()
	f.forcePolicyRefresh(t)
	transcript := f.transcript(t, claudeRequest(t, f.stamp(), "msg_1", "req_1", 5, "SECRET_TEXT"))
	f.boundary(t, "Stop", transcript)
	f.tick(t)
	usage := usageRecords(f.server.Records())
	if len(usage) != 1 {
		t.Fatalf("got %d usage records", len(usage))
	}
	event := usage[0]["events"].([]any)[0].(map[string]any)
	if event["model"] != "claude-sonnet-4-5-20250929" || event["gen_ai"].(map[string]any)["usage"].(map[string]any)["service_tier"] != "standard" {
		t.Fatalf("pricing metadata lost at the metadata level: %v", event)
	}
	if event["gen_ai"].(map[string]any)["usage"].(map[string]any)["input_tokens"] != float64(3) {
		t.Fatalf("token counts lost: %v", event)
	}
}

// Usage recorded while a session was out of scope is passed over, not
// uploaded once it is back in scope.
func TestClaudeUsageOutOfScopeAtDrainIsNeverUploaded(t *testing.T) {
	f := newFixture(t)
	transcript := f.transcript(t, claudeRequest(t, f.stamp(), "msg_1", "req_1", 5, "x"))
	f.boundary(t, "Stop", transcript)
	f.server.Lock()
	mappings := f.server.Policy.Mappings
	f.server.Policy.Mappings = nil
	f.server.Unlock()
	f.forcePolicyRefresh(t)
	if usage := usageRecords(f.server.Records()); len(usage) != 0 {
		t.Fatalf("out-of-scope usage uploaded: %v", usage)
	}
	f.server.Lock()
	f.server.Policy.Mappings = mappings
	f.server.Unlock()
	f.forcePolicyRefresh(t)
	f.transcript(t, claudeRequest(t, f.stamp(), "msg_2", "req_2", 7, "y"))
	f.boundary(t, "Stop", transcript)
	f.tick(t)
	usage := usageRecords(f.server.Records())
	if len(usage) != 1 || len(usage[0]["events"].([]any)) != 1 {
		t.Fatalf("want only the in-scope request, got %v", usage)
	}
}

func TestClaudeBoundaryWithoutTranscriptStillUploadsTheHook(t *testing.T) {
	f := newFixture(t)
	f.boundary(t, "Stop", filepath.Join(f.home, "missing.jsonl"))
	f.tick(t)
	if records := f.server.Records(); len(records) != 1 || len(usageRecords(records)) != 0 {
		t.Fatalf("want the Stop record alone, got %v", records)
	}
	if f.inboxCount(t) != 0 {
		t.Fatal("inbox not drained")
	}
}

func (f *fixture) forcePolicyRefresh(t *testing.T) {
	t.Helper()
	*f.clock = f.clock.Add(PolicyInterval + time.Second)
	f.tick(t)
	cached, err := policy.Load(f.layout.Policy())
	if err != nil {
		t.Fatal(err)
	}
	f.server.Lock()
	defer f.server.Unlock()
	if len(cached.Policy.Mappings) != len(f.server.Policy.Mappings) {
		t.Fatalf("policy not refreshed: %v", cached.Policy.Mappings)
	}
}
