// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package state

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/scope"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

func TestDiscoveredProjectsAreDeduplicatedAndUnmatchedIsClearable(t *testing.T) {
	layout, err := store.Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatal(err)
	}
	ctx, now := context.Background(), time.Now()
	project := scope.Project{Root: "/repo", RepoURL: "github.com/a/b"}
	for i := 0; i < 3; i++ {
		if err := RecordDiscovered(ctx, layout, project, now); err != nil {
			t.Fatal(err)
		}
	}
	if err := MarkUnmatched(ctx, layout, project, now); err != nil {
		t.Fatal(err)
	}
	discovered, _ := Load[Discovered](layout.Discovered())
	if len(discovered.Projects) != 1 || len(discovered.UnmatchedRoots()) != 1 {
		t.Fatalf("not deduplicated: %+v", discovered)
	}
	if err := ClearUnmatched(ctx, layout); err != nil {
		t.Fatal(err)
	}
	if err := ForgetDiscovered(ctx, layout, "/repo"); err != nil {
		t.Fatal(err)
	}
	discovered, _ = Load[Discovered](layout.Discovered())
	if len(discovered.Projects) != 0 {
		t.Fatalf("not forgotten: %+v", discovered)
	}
}

func TestHookErrorCounterIsBoundedAndPersistent(t *testing.T) {
	layout, _ := store.Open(filepath.Join(t.TempDir(), "data"))
	long := make([]byte, 500)
	for i := range long {
		long[i] = 'x'
	}
	if err := RecordHookError(layout, string(long), time.Now()); err != nil {
		t.Fatal(err)
	}
	RecordHookError(layout, "second", time.Now())
	health, err := Load[Health](layout.Health())
	if err != nil || health.HookErrors != 2 || health.HookLastError != "second" {
		t.Fatalf("health: %+v %v", health, err)
	}
}

func TestThreadTableIsBoundedAndSkipsUnchangedWrites(t *testing.T) {
	layout, _ := store.Open(filepath.Join(t.TempDir(), "data"))
	defer func(bound int) { maxThreads = bound }(maxThreads)
	maxThreads = 8
	now := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	for i := 0; i < maxThreads+10; i++ {
		thread := Thread{Agent: "codex_cli", Cwd: "/repo", SessionID: "s"}
		if err := RecordThread(layout, "t"+strconv.Itoa(i), thread, now.Add(time.Duration(i)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	threads, _ := Load[Threads](layout.Threads())
	if len(threads.Threads) != maxThreads {
		t.Fatalf("table not bounded: %d", len(threads.Threads))
	}
	if _, kept := threads.Threads["t0"]; kept {
		t.Fatal("oldest thread not evicted")
	}
	if _, kept := threads.Threads["t"+strconv.Itoa(maxThreads+9)]; !kept {
		t.Fatal("newest thread evicted")
	}
}

func TestThreadKeepsItsTranscriptAndFirstSightingAcrossHooks(t *testing.T) {
	layout, _ := store.Open(filepath.Join(t.TempDir(), "data"))
	now := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	RecordThread(layout, "t1", Thread{Agent: "codex_cli", Cwd: "/repo", SessionID: "t1"}, now)
	RecordThread(layout, "t1", Thread{Agent: "codex_cli", Cwd: "/repo", SessionID: "t1", Transcript: "/h/.codex/sessions/rollout-a.jsonl"}, now.Add(time.Minute))
	threads, _ := Load[Threads](layout.Threads())
	if got := threads.Threads["t1"]; got.Transcript != "/h/.codex/sessions/rollout-a.jsonl" || !got.FirstSeen.Equal(now) {
		t.Fatalf("a hook naming the transcript is written at once, keeping the first sighting: %+v", got)
	}
	// A later hook without a transcript (Codex sends null for an ephemeral
	// thread store) does not forget it.
	RecordThread(layout, "t1", Thread{Agent: "codex_cli", Cwd: "/repo/sub", SessionID: "t1"}, now.Add(2*time.Minute))
	threads, _ = Load[Threads](layout.Threads())
	if got := threads.Threads["t1"]; got.Transcript != "/h/.codex/sessions/rollout-a.jsonl" || got.Cwd != "/repo/sub" || !got.FirstSeen.Equal(now) {
		t.Fatalf("thread after a hook without a transcript: %+v", got)
	}
}

func TestDeletedHistoryReachesThroughItsCutoffOnly(t *testing.T) {
	layout, err := store.Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	through := now.Add(-time.Minute)
	ctx := context.Background()
	if err := RecordDeletedHistory(ctx, layout, []DeletedHistory{{MappingID: "m1", Harness: "claude_code", NativeSessionID: "gone", DeletedThrough: through, Reason: "owner"}}, now); err != nil {
		t.Fatal(err)
	}
	if got, deleted := DeletedThrough(layout, "m1", "claude_code", "gone", now); !deleted || !got.DeletedThrough.Equal(through) || got.Reason != "owner" {
		t.Fatalf("deleted history %+v %v, want through %v by the owner", got, deleted, through)
	}
	// The same native session under another mapping is another session.
	for _, other := range [][3]string{{"m1", "codex_cli", "gone"}, {"m1", "claude_code", "other"}, {"m2", "claude_code", "gone"}} {
		if _, deleted := DeletedThrough(layout, other[0], other[1], other[2], now); deleted {
			t.Fatalf("%v has deleted history", other)
		}
	}

	// A later report never pulls the cutoff back; a later deletion moves it on.
	RecordDeletedHistory(ctx, layout, []DeletedHistory{{MappingID: "m1", Harness: "claude_code", NativeSessionID: "gone", DeletedThrough: through.Add(-time.Hour), Reason: "owner"}}, now)
	if got, _ := DeletedThrough(layout, "m1", "claude_code", "gone", now); !got.DeletedThrough.Equal(through) {
		t.Fatalf("cutoff pulled back to %v", got.DeletedThrough)
	}
	RecordDeletedHistory(ctx, layout, []DeletedHistory{{MappingID: "m1", Harness: "claude_code", NativeSessionID: "gone", DeletedThrough: now, Reason: "retention"}}, now)
	if got, _ := DeletedThrough(layout, "m1", "claude_code", "gone", now); !got.DeletedThrough.Equal(now) || got.Reason != "retention" {
		t.Fatalf("cutoff not moved on with its reason: %+v", got)
	}

	if _, deleted := DeletedThrough(layout, "m1", "claude_code", "gone", now.Add(DeletedHistoryRetention+time.Minute)); deleted {
		t.Fatal("deleted history kept past its retention")
	}
	var many []DeletedHistory
	for index := range maxDeletedHistories + 10 {
		many = append(many, DeletedHistory{MappingID: "m1", Harness: "claude_code", NativeSessionID: fmt.Sprintf("s%d", index), DeletedThrough: now})
	}
	RecordDeletedHistory(ctx, layout, many, now.Add(DeletedHistoryRetention+time.Hour))
	histories, _ := Load[DeletedHistories](layout.Suppressions())
	if len(histories.Sessions) != maxDeletedHistories {
		t.Fatalf("deleted histories not bounded (expired entry pruned): %d", len(histories.Sessions))
	}
}

// The previous release kept only an expiry, 30 days after it learned of the
// deletion. That moment is on the device's clock and after the deletion, so
// it is a safe cutoff, where the old reading blocked the session for a month.
func TestASuppressionFromThePreviousReleaseReadsAsDeletedThroughWhenItWasLearned(t *testing.T) {
	layout, err := store.Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatal(err)
	}
	learned := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	until := learned.Add(30 * 24 * time.Hour).Format(time.RFC3339)
	legacy := `{"sessions":[{"harness":"claude_code","native_session_id":"gone","until":"` + until + `"}]}`
	if err := os.WriteFile(layout.Suppressions(), []byte(legacy), 0o600); err != nil {
		t.Fatal(err)
	}
	// It named no mapping and no reason: it holds for every mapping, and
	// claims no one in particular deleted it.
	got, deleted := DeletedThrough(layout, "any-mapping", "claude_code", "gone", learned.Add(time.Hour))
	if !deleted || !got.DeletedThrough.Equal(learned) || got.Reason != ReasonUnknown {
		t.Fatalf("legacy suppression read as %+v %v, want through %v", got, deleted, learned)
	}
}

func discoveredProject(t *testing.T, layout store.Layout, root string) DiscoveredProject {
	t.Helper()
	discovered, err := Load[Discovered](layout.Discovered())
	if err != nil {
		t.Fatal(err)
	}
	for _, project := range discovered.Projects {
		if project.Root == root {
			return project
		}
	}
	t.Fatalf("%s not discovered: %+v", root, discovered)
	return DiscoveredProject{}
}

func TestRecordDiscovered_AdoptsARemoteAddedAfterFirstSight(t *testing.T) {
	layout, _ := store.Open(filepath.Join(t.TempDir(), "data"))
	ctx, firstSeen := context.Background(), time.Date(2026, 9, 29, 14, 28, 44, 0, time.UTC)
	RecordDiscovered(ctx, layout, scope.Project{Root: "/skate"}, firstSeen)
	if err := RecordDiscovered(ctx, layout, scope.Project{Root: "/skate", RepoURL: "github.com/acme-labs/skate"}, firstSeen.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	project := discoveredProject(t, layout, "/skate")
	if project.RepoURL != "github.com/acme-labs/skate" {
		t.Fatalf("remote added after first sight not adopted: %+v", project)
	}
	if !project.FirstSeen.Equal(firstSeen) {
		t.Fatalf("first_seen moved: %v", project.FirstSeen)
	}
}

func TestRecordDiscovered_AChangedRemoteReplacesTheOldAndReopensAutoMatch(t *testing.T) {
	layout, _ := store.Open(filepath.Join(t.TempDir(), "data"))
	ctx, now := context.Background(), time.Now()
	MarkUnmatched(ctx, layout, scope.Project{Root: "/repo", RepoURL: "github.com/acme/old"}, now)
	if err := RecordDiscovered(ctx, layout, scope.Project{Root: "/repo", RepoURL: "github.com/acme/new"}, now); err != nil {
		t.Fatal(err)
	}
	project := discoveredProject(t, layout, "/repo")
	if project.RepoURL != "github.com/acme/new" || project.Unmatched {
		t.Fatalf("changed remote not adopted or still unmatched: %+v", project)
	}
}

// A removed remote is shown as it is now (no origin), not as it was.
func TestRecordDiscovered_ARemovedRemoteIsForgotten(t *testing.T) {
	layout, _ := store.Open(filepath.Join(t.TempDir(), "data"))
	ctx, now := context.Background(), time.Now()
	MarkUnmatched(ctx, layout, scope.Project{Root: "/repo", RepoURL: "github.com/acme/app"}, now)
	if err := RecordDiscovered(ctx, layout, scope.Project{Root: "/repo"}, now); err != nil {
		t.Fatal(err)
	}
	project := discoveredProject(t, layout, "/repo")
	if project.RepoURL != "" || project.Unmatched {
		t.Fatalf("removed remote still recorded: %+v", project)
	}
}

func TestRecordDiscovered_AnUnchangedRemoteKeepsTheUnmatchedFlagAndDoesNotRewrite(t *testing.T) {
	layout, _ := store.Open(filepath.Join(t.TempDir(), "data"))
	ctx, now := context.Background(), time.Now()
	project := scope.Project{Root: "/repo", RepoURL: "github.com/acme/app"}
	MarkUnmatched(ctx, layout, project, now)
	before, _ := os.Stat(layout.Discovered())
	time.Sleep(10 * time.Millisecond)
	if err := RecordDiscovered(ctx, layout, project, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(layout.Discovered())
	if !after.ModTime().Equal(before.ModTime()) {
		t.Fatal("an unchanged discovery rewrote discovered.json")
	}
	if !discoveredProject(t, layout, "/repo").Unmatched {
		t.Fatal("an unchanged remote cleared the unmatched flag")
	}
}

func TestMarkUnmatched_RecordsTheRemoteItWasRefusedFor(t *testing.T) {
	layout, _ := store.Open(filepath.Join(t.TempDir(), "data"))
	ctx, now := context.Background(), time.Now()
	RecordDiscovered(ctx, layout, scope.Project{Root: "/repo"}, now)
	if err := MarkUnmatched(ctx, layout, scope.Project{Root: "/repo", RepoURL: "github.com/acme/app"}, now); err != nil {
		t.Fatal(err)
	}
	project := discoveredProject(t, layout, "/repo")
	if project.RepoURL != "github.com/acme/app" || !project.Unmatched {
		t.Fatalf("refused remote not recorded: %+v", project)
	}
}

func TestRecordDiscovered_AFullListStillUpdatesKnownRootsButAddsNone(t *testing.T) {
	layout, _ := store.Open(filepath.Join(t.TempDir(), "data"))
	ctx, now := context.Background(), time.Now()
	for index := range maxDiscovered {
		RecordDiscovered(ctx, layout, scope.Project{Root: fmt.Sprintf("/repo%d", index)}, now)
	}
	RecordDiscovered(ctx, layout, scope.Project{Root: "/repo0", RepoURL: "github.com/acme/zero"}, now)
	RecordDiscovered(ctx, layout, scope.Project{Root: "/overflow", RepoURL: "github.com/acme/overflow"}, now)
	discovered, _ := Load[Discovered](layout.Discovered())
	if len(discovered.Projects) != maxDiscovered || discovered.Contains("/overflow") {
		t.Fatalf("list grew past its bound: %d", len(discovered.Projects))
	}
	if discoveredProject(t, layout, "/repo0").RepoURL != "github.com/acme/zero" {
		t.Fatal("a known root was not updated in a full list")
	}
}

func TestRecordDiscovered_RestoringARefusedRemoteKeepsTheRefusal(t *testing.T) {
	layout, _ := store.Open(filepath.Join(t.TempDir(), "data"))
	ctx, now := context.Background(), time.Now()
	refused := scope.Project{Root: "/repo", RepoURL: "github.com/acme/refused"}
	MarkUnmatched(ctx, layout, refused, now)
	RecordDiscovered(ctx, layout, scope.Project{Root: "/repo"}, now)
	if project := discoveredProject(t, layout, "/repo"); project.RepoURL != "" {
		t.Fatalf("a removed remote still shown: %+v", project)
	}
	RecordDiscovered(ctx, layout, refused, now)
	if !discoveredProject(t, layout, "/repo").Unmatched {
		t.Fatal("removing and restoring a refused remote re-armed auto-match")
	}
	RecordDiscovered(ctx, layout, scope.Project{Root: "/repo"}, now)
	RecordDiscovered(ctx, layout, scope.Project{Root: "/repo", RepoURL: "github.com/acme/other"}, now)
	if discoveredProject(t, layout, "/repo").Unmatched {
		t.Fatal("a genuinely different remote was not re-offered for auto-match")
	}
}

func TestRecordDiscovered_ARefusalFromAnOlderFileSurvivesARemoteRoundTrip(t *testing.T) {
	layout, _ := store.Open(filepath.Join(t.TempDir(), "data"))
	ctx, now := context.Background(), time.Now()
	written := `{"projects":[{"root":"/repo","repo_url":"github.com/acme/refused","unmatched":true,"first_seen":"2026-09-01T00:00:00Z"}]}`
	if err := os.WriteFile(layout.Discovered(), []byte(written), 0o600); err != nil {
		t.Fatal(err)
	}
	RecordDiscovered(ctx, layout, scope.Project{Root: "/repo"}, now)
	RecordDiscovered(ctx, layout, scope.Project{Root: "/repo", RepoURL: "github.com/acme/refused"}, now)
	if !discoveredProject(t, layout, "/repo").Unmatched {
		t.Fatal("a refusal recorded before refused_repo_url existed was forgotten")
	}
}

// A policy refresh may bring a catalog that now matches, so it forgets the
// refused remote too, not only the flag.
func TestClearUnmatched_ForgetsWhichRemoteWasRefused(t *testing.T) {
	layout, _ := store.Open(filepath.Join(t.TempDir(), "data"))
	ctx, now := context.Background(), time.Now()
	refused := scope.Project{Root: "/repo", RepoURL: "github.com/acme/refused"}
	MarkUnmatched(ctx, layout, refused, now)
	ClearUnmatched(ctx, layout)
	RecordDiscovered(ctx, layout, scope.Project{Root: "/repo"}, now)
	RecordDiscovered(ctx, layout, refused, now)
	if discoveredProject(t, layout, "/repo").Unmatched {
		t.Fatal("a refusal outlived the policy refresh that cleared it")
	}
	data, _ := os.ReadFile(layout.Discovered())
	if strings.Contains(string(data), "refused_repo_url") {
		t.Fatalf("an unrefused project serialized a refused remote: %s", data)
	}
}
