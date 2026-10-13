// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
)

// Discovery fixtures do not inject hooks, threads or discovery results. The
// real Codex adapter must find the rollout before the daemon can upload it.
func hooklessDesktopRollout(t *testing.T, f *fixture, thread, parent, cwd string, began time.Time) string {
	t.Helper()
	path := f.codexRollout(thread)
	header := rolloutLine(t, began, "session_meta", map[string]any{
		"id": thread, "timestamp": began.Format(time.RFC3339Nano), "cwd": cwd,
		"originator": "Codex Desktop", "cli_version": "0.160.0", "forked_from_id": parent,
		"base_instructions":  map[string]any{"text": "PRIVATE_HARNESS_INSTRUCTIONS"},
		"creator_account_id": "PRIVATE_ACCOUNT_ID",
	})
	writeLines(t, path, []string{header, rolloutLine(t, began, "turn_context", map[string]any{"turn_id": "turn-1", "cwd": cwd, "model": "gpt-5.4"})})
	return path
}

func desktopReply(t *testing.T, at time.Time, thread, id, text string) string {
	t.Helper()
	return rolloutLine(t, at, "event_msg", map[string]any{
		"type": "item_completed", "thread_id": thread, "turn_id": "turn-1",
		"item": map[string]any{"type": "AgentMessage", "id": id, "content": []any{map[string]any{"type": "text", "text": text}}},
	})
}

func discoverDesktop(t *testing.T, f *fixture) {
	t.Helper()
	for range 3 {
		*f.clock = f.clock.Add(time.Second)
		f.tick(t)
	}
	if f.inboxCount(t) != 0 || f.normalizer.calls.Load() != 0 {
		t.Fatal("hookless discovery must not rely on a hook or Beacon normalization")
	}
}

func assertDesktopUsage(t *testing.T, f *fixture, thread string, outputs ...float64) {
	t.Helper()
	var got []float64
	ids := map[string]bool{}
	for _, record := range usageRecords(f.server.Records()) {
		if record["native_session_id"] != thread {
			continue
		}
		if record["harness"] != codex.DesktopID || record["collection_method"] != "poll" || record["mapping_id"] != richMapping {
			t.Fatalf("discovered usage envelope: %v", record)
		}
		for _, raw := range record["events"].([]any) {
			event := raw.(map[string]any)
			id := event["event"].(map[string]any)["id"].(string)
			if ids[id] {
				t.Fatalf("usage event %s uploaded twice", id)
			}
			ids[id] = true
			usage := event["gen_ai"].(map[string]any)["usage"].(map[string]any)
			got = append(got, usage["output_tokens"].(float64))
			if usage["input_tokens"] != float64(3000) || usage["cache_read"].(map[string]any)["input_tokens"] != float64(9000) {
				t.Fatalf("discovered token split: %v", usage)
			}
		}
	}
	if !reflect.DeepEqual(got, outputs) {
		t.Fatalf("hookless Desktop %s output tokens = %v, want %v", thread, got, outputs)
	}
}

func assertUsageHasNoPrivateText(t *testing.T, f *fixture) {
	t.Helper()
	encoded, err := json.Marshal(usageRecords(f.server.Records()))
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"PRIVATE_REPLY", "PRIVATE_HARNESS_INSTRUCTIONS", "PRIVATE_ACCOUNT_ID", f.home, f.repo, ".codex"} {
		quoted, _ := json.Marshal(forbidden)
		if strings.Contains(string(encoded), string(quoted[1:len(quoted)-1])) {
			t.Fatalf("discovered usage leaked %q: %s", forbidden, encoded)
		}
	}
}

func TestHooklessDesktopUsageAtEveryCaptureLevel(t *testing.T) {
	for _, level := range []string{"metadata", "standard", "full", "rich"} {
		t.Run(level, func(t *testing.T) {
			f := codexContentFixture(t, level)
			path := hooklessDesktopRollout(t, f, codexDesktopThread, "", f.repo, f.since(t, 5*time.Second))
			appendTo(t, path, desktopReply(t, f.since(t, 8*time.Second), codexDesktopThread, "reply-1", "PRIVATE_REPLY"))
			appendTo(t, path, rolloutRecord(t, f.since(t, 10*time.Second), codexDesktopThread, "response-1", 800))
			// The completed first turn precedes discovery but is inside an
			// already-open capture window; it must not disappear at first sight.
			f.since(t, 20*time.Second)
			discoverDesktop(t, f)
			assertDesktopUsage(t, f, codexDesktopThread, 800)
			assertUsageHasNoPrivateText(t, f)
			key := agent.ContentKey(codex.DesktopID, codexDesktopThread, "reply-1", "text:0")
			if level == "rich" {
				if len(declarationsByKey(f)[key]) != 1 {
					t.Fatal("rich content must still accompany discovered usage")
				}
			} else if len(f.server.Declarations()) != 0 {
				t.Fatalf("%s discovery emitted rich content", level)
			}
		})
	}
}

func TestHooklessDesktopStandardUsageDoesNotDependOnARichOffer(t *testing.T) {
	f := codexContentFixture(t, "standard")
	f.server.Lock()
	f.server.Policy.RichCapture = policy.RichCapture{}
	f.server.Unlock()
	f.forcePolicyRefresh(t)
	f.setupDone = *f.clock
	path := hooklessDesktopRollout(t, f, codexDesktopThread, "", f.repo, f.since(t, time.Second))
	appendTo(t, path, rolloutRecord(t, f.since(t, 2*time.Second), codexDesktopThread, "response-1", 75))
	discoverDesktop(t, f)
	assertDesktopUsage(t, f, codexDesktopThread, 75)
	if len(f.server.Declarations()) != 0 {
		t.Fatal("a server without a rich offer received contents")
	}
}

func TestHooklessDesktopSubagentRecordsCarryTheirActualParent(t *testing.T) {
	f := codexContentFixture(t, "rich")
	parent := hooklessDesktopRollout(t, f, codexDesktopThread, "", f.repo, f.since(t, time.Second))
	appendTo(t, parent, rolloutRecord(t, f.since(t, 2*time.Second), codexDesktopThread, "parent-response", 800))
	child := hooklessDesktopRollout(t, f, codexDesktopChild, codexDesktopThread, f.repo, f.since(t, 3*time.Second))
	// A copied parent's record remains its parent's usage, even with a new timestamp.
	appendTo(t, child, rolloutRecord(t, f.since(t, 4*time.Second), codexDesktopThread, "parent-response", 800))
	appendTo(t, child, desktopReply(t, f.since(t, 5*time.Second), codexDesktopChild, "child-reply", "Child-owned text"))
	appendTo(t, child, rolloutRecord(t, f.since(t, 6*time.Second), codexDesktopChild, "child-response", 40))
	discoverDesktop(t, f)
	childRecords := 0
	for _, record := range f.server.Records() {
		switch record["native_session_id"] {
		case codexDesktopThread:
			if record["parent_native_session_id"] != nil {
				t.Fatalf("a root session acquired a parent: %v", record)
			}
		case codexDesktopChild:
			childRecords++
			if record["parent_native_session_id"] != codexDesktopThread {
				t.Fatalf("discovered child record has parent %v; want %s", record["parent_native_session_id"], codexDesktopThread)
			}
		}
	}
	if childRecords == 0 {
		t.Fatal("discovered child produced no records")
	}
	assertDesktopUsage(t, f, codexDesktopThread, 800)
	assertDesktopUsage(t, f, codexDesktopChild, 40)
}

func TestHooklessDesktopUsageCursorSurvivesUnchangedPollsPartialLinesAndRestart(t *testing.T) {
	f := codexContentFixture(t, "standard")
	path := hooklessDesktopRollout(t, f, codexDesktopThread, "", f.repo, f.since(t, time.Second))
	appendTo(t, path, rolloutRecord(t, f.since(t, 2*time.Second), codexDesktopThread, "response-1", 80))
	discoverDesktop(t, f)
	assertDesktopUsage(t, f, codexDesktopThread, 80)
	discoverDesktop(t, f)
	f.daemon = New(f.daemon.config)
	discoverDesktop(t, f)
	assertDesktopUsage(t, f, codexDesktopThread, 80)
	f.since(t, 2*time.Minute)
	partial := rolloutRecord(t, f.stamp(), codexDesktopThread, "response-2", 15)
	appendTo(t, path, partial[:len(partial)/2])
	discoverDesktop(t, f)
	assertDesktopUsage(t, f, codexDesktopThread, 80)
	f.daemon = New(f.daemon.config)
	appendTo(t, path, partial[len(partial)/2:])
	discoverDesktop(t, f)
	assertDesktopUsage(t, f, codexDesktopThread, 80, 15)
	appendTo(t, path, rolloutRecord(t, f.stamp(), codexDesktopThread, "response-3", 9))
	discoverDesktop(t, f)
	assertDesktopUsage(t, f, codexDesktopThread, 80, 15, 9)
}

func TestHooklessDesktopNeverImportsUsageFromBeforeAdmission(t *testing.T) {
	f := codexContentFixture(t, "standard")
	path := hooklessDesktopRollout(t, f, codexDesktopThread, "", f.repo, f.setupDone.Add(-time.Hour))
	appendTo(t, path, rolloutRecord(t, f.setupDone.Add(-time.Hour), codexDesktopThread, "old-response", 9999))
	f.since(t, 20*time.Second)
	discoverDesktop(t, f)
	assertDesktopUsage(t, f, codexDesktopThread)
	appendTo(t, path, rolloutRecord(t, f.stamp(), codexDesktopThread, "current-response", 25))
	discoverDesktop(t, f)
	assertDesktopUsage(t, f, codexDesktopThread, 25)
}

func TestHooklessDesktopUsageIsNotDuplicatedWhenAHookLaterNamesTheSameThread(t *testing.T) {
	f := codexContentFixture(t, "standard")
	path := hooklessDesktopRollout(t, f, codexDesktopThread, "", f.repo, f.since(t, time.Second))
	appendTo(t, path, rolloutRecord(t, f.since(t, 2*time.Second), codexDesktopThread, "before-hook", 80))
	discoverDesktop(t, f)
	assertDesktopUsage(t, f, codexDesktopThread, 80)
	// The first sighting was hookless; a newly trusted hook is a second
	// source of the same identity, not a fresh session or usage counter.
	f.codexHook(t, codexDesktopThread, "SessionStart", "resume")
	appendTo(t, path, rolloutRecord(t, f.stamp(), codexDesktopThread, "after-hook", 15))
	for range 3 {
		*f.clock = f.clock.Add(time.Second)
		f.tick(t)
	}
	assertDesktopUsage(t, f, codexDesktopThread, 80, 15)
	for _, record := range usageRecords(f.server.Records()) {
		if record["native_session_id"] != codexDesktopThread || record["harness"] != codex.DesktopID {
			t.Fatalf("hook/discovery overlap forked session identity: %v", record)
		}
	}
}

func TestHooklessDesktopUsageHonorsCaptureGaps(t *testing.T) {
	for _, gap := range []string{"paused", "codex disabled", "ignored path"} {
		t.Run(gap, func(t *testing.T) {
			f := codexContentFixture(t, "standard")
			path := hooklessDesktopRollout(t, f, codexDesktopThread, "", f.repo, f.since(t, time.Second))
			appendTo(t, path, rolloutRecord(t, f.since(t, 2*time.Second), codexDesktopThread, "before-gap", 20))
			discoverDesktop(t, f)
			assertDesktopUsage(t, f, codexDesktopThread, 20)
			switch gap {
			case "paused":
				f.setPaused(t, true)
			case "codex disabled":
				f.server.Lock()
				f.server.Policy.Installation.EnabledAgents = []string{"claude_code"}
				f.server.Unlock()
				f.forcePolicyRefresh(t)
			case "ignored path":
				f.setPreferences(t, state.Preferences{IgnoredPaths: []string{f.repo}})
			}
			discoverDesktop(t, f)
			appendTo(t, path, rolloutRecord(t, f.stamp(), codexDesktopThread, "in-gap", 9999))
			discoverDesktop(t, f)
			assertDesktopUsage(t, f, codexDesktopThread, 20)
			f.setPreferences(t, state.Preferences{})
			if gap == "codex disabled" {
				f.server.Lock()
				f.server.Policy.Installation.EnabledAgents = []string{"codex_cli"}
				f.server.Unlock()
				f.forcePolicyRefresh(t)
			}
			discoverDesktop(t, f)
			appendTo(t, path, rolloutRecord(t, f.stamp(), codexDesktopThread, "after-gap", 30))
			discoverDesktop(t, f)
			assertDesktopUsage(t, f, codexDesktopThread, 20, 30)
		})
	}
}

func TestHooklessDesktopUsageExcludesDaemonDowntime(t *testing.T) {
	f := codexContentFixture(t, "standard")
	path := hooklessDesktopRollout(t, f, codexDesktopThread, "", f.repo, f.since(t, time.Second))
	appendTo(t, path, rolloutRecord(t, f.since(t, 2*time.Second), codexDesktopThread, "before-stop", 20))
	discoverDesktop(t, f)
	assertDesktopUsage(t, f, codexDesktopThread, 20)
	// Persist the observed window, then stop running ticks for ten minutes.
	f.since(t, 2*time.Minute)
	discoverDesktop(t, f)
	appendTo(t, path, rolloutRecord(t, f.since(t, 5*time.Minute), codexDesktopThread, "during-stop", 9999))
	f.since(t, 12*time.Minute)
	f.daemon = New(f.daemon.config)
	discoverDesktop(t, f)
	assertDesktopUsage(t, f, codexDesktopThread, 20)
	appendTo(t, path, rolloutRecord(t, f.stamp(), codexDesktopThread, "after-start", 30))
	discoverDesktop(t, f)
	assertDesktopUsage(t, f, codexDesktopThread, 20, 30)
}

func TestHooklessDesktopDiscoveryDoesNotUploadAnUnmappedSession(t *testing.T) {
	f := codexContentFixture(t, "standard")
	outside := filepath.Join(f.home, "outside")
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	path := hooklessDesktopRollout(t, f, codexDesktopThread, "", outside, f.since(t, time.Second))
	appendTo(t, path, rolloutRecord(t, f.since(t, 2*time.Second), codexDesktopThread, "outside-response", 9999))
	discoverDesktop(t, f)
	if records := f.server.Records(); len(records) != 0 {
		t.Fatalf("out-of-scope discovered session uploaded %s", fmt.Sprint(records))
	}
}
