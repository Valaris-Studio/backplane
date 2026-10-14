// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/contracttest"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

func header(began time.Time, parent string) contracttest.Line {
	return contracttest.Line{Type: "session", Began: &began, Parent: parent}
}

func keyIn(id, nativeRef string) string {
	return agent.ContentKey(richAgent, id, nativeRef, "text:0")
}

// Clear history: a cutoff the server reports settles the spooled bodies it
// reaches without uploading them, keeps the read position, and later
// records are declared; a declaration at or before the cutoff is dropped
// even inside a record captured after it.
func TestAHistoryCutoffSettlesSpooledBodiesAndKeepsTheCursor(t *testing.T) {
	f := newRichFixture(t)
	f.server.Lock()
	f.server.UploadErrors["00000000-0000-4000-8000-000000000001"] = uplinktest.UploadError{Status: 503, Code: "storage_backend_unavailable"}
	f.server.Unlock()
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, replyLine("e1", f.stamp(), strings.Repeat("r", 20<<10)))
	*f.clock = f.clock.Add(time.Second)
	f.tick(t)
	if stats, _ := f.daemon.spool.Stats(); stats.PendingBodies != 1 {
		t.Fatalf("setup: spool %+v", stats)
	}
	late := f.clock.Add(-time.Second)
	cutoff := *f.clock
	f.server.Lock()
	f.server.DeletedThrough[session] = cutoff
	f.server.Unlock()
	*f.clock = f.clock.Add(time.Minute)
	f.appendLines(t, session, textLine("late", late, "occurred before the cutoff"), textLine("e2", f.stamp(), "after the cutoff"))
	readTo := fileSize(t, f.sessionFile(session))
	f.tickUntilSettled(t)
	if stats, _ := f.daemon.spool.Stats(); stats.PendingBodies != 0 || stats.FailedTotal != 0 {
		t.Fatalf("spool after the cutoff %+v", stats)
	}
	if f.server.Body(itemKey("e1")) != nil || f.server.Body(itemKey("late")) != nil {
		t.Fatal("content at or before the cutoff was stored")
	}
	if string(f.server.Body(itemKey("e2"))) != "after the cutoff" {
		t.Fatal("content after the cutoff was not stored")
	}
	if cursor := f.cursorOf(t, session); cursor.Offset != readTo {
		t.Fatalf("cursor at %d, want %d: clear history keeps read positions", cursor.Offset, readTo)
	}
}

// A server from before rich capture never offers it: the device never sends
// it a rich member, in a record or a heartbeat, and spools nothing.
func TestAServerFromBeforeRichCaptureNeverSeesRichMembers(t *testing.T) {
	f := newFixture(t, contracttest.Agent{Name: richAgent})
	f.server.Lock()
	f.server.Policy.Installation.EnabledAgents = nil
	f.server.Policy.Mappings = []policy.Mapping{richMappingOf(f)}
	f.server.RejectRich, f.server.RejectRichStatus = "invalid", true
	f.server.Unlock()
	f.forcePolicyRefresh(t)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, replyLine("e1", f.stamp(), strings.Repeat("r", 20<<10)))
	f.tickUntilSettled(t)
	f.forcePolicyRefresh(t)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, textLine("e2", f.stamp(), "later"))
	f.tickUntilSettled(t)
	for _, record := range f.server.Records() {
		if record["contents"] != nil || record["capture_generation"] != nil {
			t.Fatalf("a rich member reached an old server: %v", record)
		}
	}
	for _, beat := range f.heartbeats() {
		if _, rich := beat["rich_capture"]; rich {
			t.Fatal("a heartbeat carried rich_capture to an old server")
		}
	}
	if bodies, _ := f.daemon.spool.Bodies(); len(bodies) != 0 || len(f.server.Rejections) != 0 {
		t.Fatalf("spooled %d, rejected %v", len(bodies), f.server.Rejections)
	}
}

// After one offer-less response, the first invalid rejection of a rich
// record is evidence enough: the queue is rewritten events-only and the
// spool purged at once, also bodies whose records were acknowledged.
func TestTheFirstInvalidRejectionAfterAnOfferlessPolicyRewritesAndPurges(t *testing.T) {
	f := newRichFixture(t)
	f.server.Lock()
	f.server.UploadErrors["00000000-0000-4000-8000-000000000001"] = uplinktest.UploadError{Status: 503, Code: "storage_backend_unavailable"}
	f.server.Unlock()
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, replyLine("e1", f.stamp(), strings.Repeat("r", 20<<10)))
	*f.clock = f.clock.Add(time.Second)
	f.tick(t)
	f.setOffer(t, policy.RichCapture{})
	f.forcePolicyRefresh(t)
	if stats, _ := f.daemon.spool.Stats(); stats.PendingBodies != 1 {
		t.Fatalf("one offer-less response purged the spool: %+v", stats)
	}
	f.server.Lock()
	f.server.RejectRich = "invalid"
	f.server.Unlock()
	mixed := queueMixedRecord(t, f, strings.Repeat("aa", 16))
	f.tickUntilSettled(t)
	if stats, _ := f.daemon.spool.Stats(); stats.PendingBodies != 0 {
		t.Fatalf("spool not purged by the rejection: %+v", stats)
	}
	eventsOnly, _ := mixed.EventsOnly()
	sent := false
	for _, record := range f.server.Records() {
		sent = sent || record["capture_id"] == eventsOnly.CaptureID
	}
	if !sent {
		t.Fatal("the rejected record's events were not resent")
	}
}

// Two offer-less responses closer together than the policy interval are
// not two pieces of evidence: they change nothing. (Responses from another
// endpoint cannot meet: a switch purges RichDir, where the count lives.)
func TestOfferlessResponsesCloserThanThePolicyIntervalChangeNothing(t *testing.T) {
	f := newRichFixture(t)
	f.holdUploads(t, true)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, replyLine("e1", f.stamp(), strings.Repeat("r", 20<<10)))
	f.tick(t)
	queued := readQueue(t, f)
	before := mustGeneration(t, f, richMapping)
	f.setOffer(t, policy.RichCapture{})
	for range 3 {
		*f.clock = f.clock.Add(time.Minute)
		f.daemon.refreshPolicy(context.Background())
		f.tick(t)
	}
	if again := readQueue(t, f); len(again) != len(queued) {
		t.Fatalf("queue %d → %d", len(queued), len(again))
	}
	if stats, _ := f.daemon.spool.Stats(); stats.PendingBodies != 1 {
		t.Fatalf("spool purged: %+v", stats)
	}
	if after := generation(t, f, richMapping); after == nil || after.ID != before.ID {
		t.Fatalf("generation ended: %+v", after)
	}
}

// Fork rule: an item its parent session already declared is a copy in the
// child, whatever its timestamp; the child's own items are declared.
func TestAForkedSessionNeverDeclaresItsParentsItems(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, "p1", f.repo)
	f.appendLines(t, "p1", textLine("shared", f.stamp(), "said in the parent"))
	f.tickUntilSettled(t)
	f.richHook(t, "c1", f.repo)
	f.appendLines(t, "c1", header(f.stamp(), "p1"), textLine("shared", f.stamp(), "said in the parent"), textLine("own", f.stamp(), "said in the fork"))
	f.tickUntilSettled(t)
	declared := map[string]bool{}
	for _, key := range declaredKeys(f) {
		declared[key] = true
	}
	if !declared[keyIn("p1", "shared")] || !declared[keyIn("c1", "own")] || declared[keyIn("c1", "shared")] {
		t.Fatalf("declared %v", declaredKeys(f))
	}
	if richHealth(t, f).Copied != 1 {
		t.Fatalf("health %+v", richHealth(t, f))
	}
}

// A hookless session (Codex Desktop) is found by its agent's discovery and
// read like any other, its header deciding where reading starts.
func TestAHooklessSessionIsFoundByDiscovery(t *testing.T) {
	var found []agent.ContentFileRef
	f := newRichFixture(t, func() []agent.ContentFileRef { return found })
	found = []agent.ContentFileRef{{Path: f.sessionFile("d1"), NativeSessionID: "d1", Cwd: f.repo}}
	f.appendLines(t, "d1", header(f.stamp(), ""), textLine("x", f.stamp(), "no hook ever ran"))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{keyIn("d1", "x")}) {
		t.Fatalf("declared %v", keys)
	}
}

// Scope is per turn where the source records the turn's directory: a turn
// outside the mapping, or under an ignored path, is not staged.
func TestATurnOutsideTheMappingOrIgnoredIsNotStaged(t *testing.T) {
	f := newRichFixture(t)
	ignored := filepath.Join(f.repo, "vendor")
	mustMkdirAll(t, ignored)
	mustMkdirAll(t, filepath.Join(f.home, "elsewhere"))
	mustMkdirAll(t, filepath.Join(f.repo, "cmd"))
	f.setPreferences(t, state.Preferences{IgnoredPaths: []string{ignored}})
	f.tick(t)
	f.richHook(t, session, f.repo)
	outside := textLine("outside", f.stamp(), "in another folder")
	outside.Cwd = filepath.Join(f.home, "elsewhere")
	vendored := textLine("ignored", f.stamp(), "under an ignored path")
	vendored.Cwd = ignored
	inside := textLine("inside", f.stamp(), "in the project")
	inside.Cwd = filepath.Join(f.repo, "cmd")
	f.appendLines(t, session, outside, vendored, inside)
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("inside")}) {
		t.Fatalf("declared %v", keys)
	}
}

// A resumed session that began before admission starts at its file's size:
// what it held before, older than the sighting less its skew, is never read.
func TestAResumedSessionThatBeganBeforeAdmissionStartsAtItsSize(t *testing.T) {
	f := newRichFixture(t)
	f.appendLines(t, session, header(richGrantedAt.Add(-time.Hour), ""), textLine("old", f.clock.Add(-time.Minute), "held before the resume"))
	f.richHook(t, session, f.repo)
	f.tick(t)
	f.appendLines(t, session, textLine("new", f.stamp(), "after the resume"))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("new")}) {
		t.Fatalf("declared %v", keys)
	}
}

func mustMkdirAll(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
}

// A killed daemon runs no deferred save: a session file is known on disk
// before anything of it is staged, or a crash forgets the session and its
// next sighting would read past what it said meanwhile.
func TestASessionFileIsKnownOnDiskBeforeItsContentIsStaged(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, replyLine("e1", f.stamp(), strings.Repeat("r", 20<<10)))
	durable := false
	commitFault = func(point string) error {
		if point == "staged" {
			sources, _ := state.Load[contentSources](f.daemon.contentSourcesPath())
			_, durable = sources.Sources[f.sessionFile(session)]
			return errors.New("killed")
		}
		return nil
	}
	defer clearFault()
	*f.clock = f.clock.Add(time.Second)
	f.daemon.Tick(context.Background())
	if !durable {
		t.Fatal("the session file was staged from before it was known on disk")
	}
}

// A kill while bodies are being staged must not forget the window that
// admits them: the windows are durable before a file is read.
func TestTheWindowAdmittingAReadIsDurableBeforeItsBodiesAreStaged(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	*f.clock = f.clock.Add(30 * time.Second)
	at := f.stamp()
	f.appendLines(t, session, replyLine("e1", at, strings.Repeat("r", 20<<10)))
	covered := false
	commitFault = func(point string) error {
		if point == "staging" {
			windows, _ := state.Load[captureWindows](f.layout.CaptureWindows())
			for _, window := range windows.Windows[windowKey(richAgent, richMapping)] {
				covered = covered || !at.Before(window.From) && !at.After(window.LastSeen) && window.Generation != nil
			}
			return errors.New("killed")
		}
		return nil
	}
	defer clearFault()
	*f.clock = f.clock.Add(time.Second)
	f.daemon.Tick(context.Background())
	if !covered {
		t.Fatal("bodies were staged under a window not yet durable")
	}
}

// Amendment 19: a header proving the session began within the generation
// admits its records from that start, whenever the daemon first noticed the
// file. A poll that finds a hookless session after its first turn reads that
// turn.
func TestAPolledSessionKeepsTheTurnBeforeItsDiscovery(t *testing.T) {
	var found []agent.ContentFileRef
	f := newRichFixture(t, func() []agent.ContentFileRef { return found })
	*f.clock = f.clock.Add(time.Minute)
	f.tick(t)
	began := f.clock.Add(-4 * time.Second)
	f.appendLines(t, "d1", header(began, ""), textLine("first", began, "the first turn"))
	found = []agent.ContentFileRef{{Path: f.sessionFile("d1"), NativeSessionID: "d1", Cwd: f.repo}}
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{keyIn("d1", "first")}) {
		t.Fatalf("declared %v", keys)
	}
}

// A file named by a hook after its first prompt keeps that prompt.
func TestAHookNamingTheFileAfterItsFirstPromptKeepsThePrompt(t *testing.T) {
	f := newRichFixture(t)
	*f.clock = f.clock.Add(time.Minute)
	f.tick(t)
	began := f.clock.Add(-4 * time.Second)
	f.appendLines(t, session, header(began, ""), textLine("prompt", began.Add(time.Second), "said before the hook"))
	f.richHook(t, session, f.repo)
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("prompt")}) {
		t.Fatalf("declared %v", keys)
	}
}

// A line the agent's parser cannot read is passed over, and counted.
func TestALineTheParserCannotReadIsCounted(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	appendSession(t, f.sessionFile(session), "{not json\n")
	f.appendLines(t, session, textLine("e1", f.stamp(), "after it"))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e1")}) {
		t.Fatalf("declared %v", keys)
	}
	if richHealth(t, f).ParseErrors != 1 {
		t.Fatalf("health %+v", richHealth(t, f))
	}
}
