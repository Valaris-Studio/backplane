// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"fmt"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/contracttest"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
)

// Amendment 38: a session begun before the open generation and resumed is
// read from its trailing run of lines no older than its first sighting,
// less the skew of a fire-and-forget sighting, never from before it.

// resumeSession writes a session begun an hour ago with earlier lines
// minutes old, then the resumed run's first prompt, sighted 19 ms after it.
func (f *fixture) resumeSession(t *testing.T, earlier int, prompts ...contracttest.Line) {
	t.Helper()
	*f.clock = f.clock.Add(10 * time.Minute)
	lines := []contracttest.Line{header(f.clock.Add(-time.Hour), "")}
	for index := range earlier {
		lines = append(lines, textLine(fmt.Sprintf("old%d", index), f.clock.Add(-5*time.Minute), "said before the resume"))
	}
	f.appendLines(t, session, append(lines, prompts...)...)
	*f.clock = prompts[0].At.Add(19 * time.Millisecond)
	f.richHook(t, session, f.repo)
	f.tickUntilSettled(t)
}

func TestAResumedRunsFirstPromptWrittenBeforeItsSightingIsCaptured(t *testing.T) {
	f := newRichFixture(t)
	f.resumeSession(t, 1, textLine("p1", f.clock.Add(10*time.Minute), "the resumed run's first prompt"))
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("p1")}) {
		t.Fatalf("declared %v", keys)
	}
}

func TestAResumedSessionsEarlierLinesAreNeverParsed(t *testing.T) {
	f := newRichFixture(t)
	f.resumeSession(t, 30, textLine("p1", f.clock.Add(10*time.Minute), "the resumed run's first prompt"))
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("p1")}) {
		t.Fatalf("declared %v", keys)
	}
	if parsed := f.parsed.Load(); parsed != 1 {
		t.Fatalf("parsed %d lines, want the prompt alone", parsed)
	}
}

// The scan looks back 1 MiB at most: a longer trailing run is read from
// the first whole line within that bound.
func TestTheResumeScanStopsAtItsBound(t *testing.T) {
	f := newRichFixture(t)
	const lineBytes, lines = 4 << 10, 320
	start := f.clock.Add(10 * time.Minute)
	var run []contracttest.Line
	for index := range lines {
		run = append(run, textLine(fmt.Sprintf("p%d", index), start.Add(time.Duration(index)*time.Millisecond), strings.Repeat("x", lineBytes)))
	}
	f.resumeSession(t, 1, run...)
	declared := map[string]bool{}
	for _, key := range declaredKeys(f) {
		declared[key] = true
	}
	if declared[itemKey("p0")] || !declared[itemKey(fmt.Sprintf("p%d", lines-1))] {
		t.Fatalf("declared %d of the run, first %v, last %v", len(declared), declared[itemKey("p0")], declared[itemKey(fmt.Sprintf("p%d", lines-1))])
	}
	if parsed := f.parsed.Load(); parsed > (1<<20)/lineBytes+1 {
		t.Fatalf("parsed %d lines past the 1 MiB bound", parsed)
	}
}

// A file sighted long before its mapping was granted is read from no
// earlier than the grant: what was written in between is never parsed.
func TestAStaleSightingNeverBackfillsWhatPrecededTheGrant(t *testing.T) {
	parsed := &atomic.Int64{}
	f := newFixture(t, contracttest.Agent{Name: richAgent, Parsed: parsed})
	f.server.Lock()
	f.server.Policy.Installation.EnabledAgents = nil
	f.server.Policy.Mappings = []policy.Mapping{richMappingOf(f)}
	f.server.Policy.RichCapture = offerFor(map[string]time.Time{})
	f.server.Unlock()
	f.forcePolicyRefresh(t)
	f.appendLines(t, session, header(f.clock.Add(-time.Hour), ""))
	f.richHook(t, session, f.repo)
	*f.clock = f.clock.Add(time.Minute)
	f.appendLines(t, session, textLine("between", f.stamp(), "before the grant"))
	*f.clock = f.clock.Add(5 * time.Minute)
	f.setOffer(t, offerFor(map[string]time.Time{richMapping: richGrantedAt}))
	f.forcePolicyRefresh(t)
	f.appendLines(t, session, textLine("after", f.stamp(), "after the grant"))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("after")}) {
		t.Fatalf("declared %v", keys)
	}
	if parsed.Load() != 1 {
		t.Fatalf("parsed %d lines, want the line after the grant alone", parsed.Load())
	}
}

// resumedAt starts a session begun before admission, its two entries from
// before admission, and returns when its resume writes: minutes later.
func (f *fixture) resumedAt(t *testing.T) time.Time {
	t.Helper()
	f.appendLines(t, session, header(richGrantedAt.Add(-time.Hour), ""),
		textLine("pre1", richGrantedAt.Add(-50*time.Minute), "before admission"), textLine("pre2", richGrantedAt.Add(-40*time.Minute), "before admission"))
	*f.clock = f.clock.Add(10 * time.Minute)
	return *f.clock
}

// RC-04's Pi shape (native f001): a prompt, its sighting 20 ms later, the
// reply 1.8 s after the prompt; read between them or only after both.
func TestAResumedPromptAndReplyAreDeclaredWhicheverTheFirstReadFollows(t *testing.T) {
	for _, midRun := range []bool{true, false} {
		t.Run(fmt.Sprint("read between: ", midRun), func(t *testing.T) {
			f := newRichFixture(t)
			prompt := f.resumedAt(t)
			f.appendLines(t, session, textLine("p1", prompt, "the resumed prompt"))
			*f.clock = prompt.Add(20 * time.Millisecond)
			f.richHook(t, session, f.repo)
			if midRun {
				f.tick(t)
			}
			*f.clock = prompt.Add(1800 * time.Millisecond)
			f.appendLines(t, session, replyLine("r1", *f.clock, "the reply"))
			f.tickUntilSettled(t)
			if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("p1"), itemKey("r1")}) {
				t.Fatalf("declared %v", keys)
			}
		})
	}
}

// The scan's threshold may reach before the grant; the windows still hold
// what precedes it.
func TestALineScannedInBeforeTheGrantIsNeverDeclared(t *testing.T) {
	parsed := &atomic.Int64{}
	f := newFixture(t, contracttest.Agent{Name: richAgent, Parsed: parsed})
	f.server.Lock()
	f.server.Policy.Installation.EnabledAgents = nil
	f.server.Policy.Mappings = []policy.Mapping{richMappingOf(f)}
	f.server.Policy.RichCapture = offerFor(map[string]time.Time{})
	f.server.Unlock()
	f.forcePolicyRefresh(t)
	f.appendLines(t, session, header(f.clock.Add(-time.Hour), ""))
	f.setOffer(t, offerFor(map[string]time.Time{richMapping: richGrantedAt}))
	f.forcePolicyRefresh(t)
	granted := *f.clock
	f.appendLines(t, session, textLine("edge", granted.Add(-time.Second), "a second before the grant"))
	*f.clock = granted.Add(500 * time.Millisecond)
	f.richHook(t, session, f.repo)
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); len(keys) != 0 {
		t.Fatalf("declared %v", keys)
	}
	if outside := richHealth(t, f).OutsideWindow; outside != 1 || parsed.Load() != 1 {
		t.Fatalf("outside the window %d, parsed %d: the line must be read and held", outside, parsed.Load())
	}
}

// The skew is 2 s and no more: a line 3 s before the sighting stays out.
func TestALineThreeSecondsBeforeTheSightingIsNotDeclared(t *testing.T) {
	f := newRichFixture(t)
	prompt := f.resumedAt(t)
	f.appendLines(t, session, textLine("early", prompt.Add(-3*time.Second), "before the resume"), textLine("p1", prompt, "the resumed prompt"))
	*f.clock = prompt.Add(19 * time.Millisecond)
	f.richHook(t, session, f.repo)
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("p1")}) {
		t.Fatalf("declared %v", keys)
	}
}

// Without LineAt the scan reads times by Parse; with no time to read at
// all, the file is checkpointed at its size, as before amendment 38.
func TestWithoutLineTimesTheScanFallsBackToParseThenToTheSize(t *testing.T) {
	t.Run("parse", func(t *testing.T) {
		f := newRichFixtureOf(t, contracttest.Agent{Name: richAgent, ParseOnly: true})
		prompt := f.resumedAt(t)
		f.appendLines(t, session, textLine("p1", prompt, "the resumed prompt"))
		*f.clock = prompt.Add(19 * time.Millisecond)
		f.richHook(t, session, f.repo)
		f.tickUntilSettled(t)
		if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("p1")}) {
			t.Fatalf("declared %v", keys)
		}
	})
	t.Run("size", func(t *testing.T) {
		f := newRichFixtureOf(t, contracttest.Agent{Name: richAgent, ParseOnly: true})
		f.resumedAt(t)
		f.appendLines(t, session, contracttest.Line{ID: "untimed", Items: []contracttest.Item{contracttest.TextItem("text:0", "user", "prompt", "text/plain", "no time")}})
		f.richHook(t, session, f.repo)
		f.tick(t)
		if cursor := f.cursorOf(t, session); cursor.Offset != fileSize(t, f.sessionFile(session)) {
			t.Fatalf("cursor at %d of %d", cursor.Offset, fileSize(t, f.sessionFile(session)))
		}
	})
}

// A trailing line without a readable time ends the run: only what follows
// it is the resume's.
func TestAnUntimedLineEndsTheResumedRun(t *testing.T) {
	f := newRichFixture(t)
	prompt := f.resumedAt(t)
	untimed := contracttest.Line{ID: "untimed", Items: []contracttest.Item{contracttest.TextItem("text:0", "user", "prompt", "text/plain", "no time")}}
	f.appendLines(t, session, textLine("p1", prompt, "before the untimed line"), untimed, textLine("p2", prompt.Add(time.Millisecond), "after it"))
	*f.clock = prompt.Add(19 * time.Millisecond)
	f.richHook(t, session, f.repo)
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("p2")}) {
		t.Fatalf("declared %v", keys)
	}
}

// The run is trailing, not merely recent: an old-stamped line inside it
// ends it there, and a prompt before that line is lost (conservative).
func TestAnOldStampedLineInTheTailEndsTheResumedRun(t *testing.T) {
	f := newRichFixture(t)
	prompt := f.resumedAt(t)
	f.appendLines(t, session, textLine("p1", prompt, "the resumed prompt"), textLine("stale", prompt.Add(-time.Hour), "an old stamp"), replyLine("r1", prompt.Add(time.Second), "the reply"))
	*f.clock = prompt.Add(19 * time.Millisecond)
	f.richHook(t, session, f.repo)
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("r1")}) {
		t.Fatalf("declared %v", keys)
	}
}

// Without a header the first sighting is the fork-copy fence and takes no
// skew: a copy a second older than it is not the session's own.
func TestAHeaderlessCopyJustBeforeTheSightingIsNotDeclared(t *testing.T) {
	f := newRichFixture(t)
	*f.clock = f.clock.Add(10 * time.Minute)
	f.appendLines(t, session, textLine("copy", f.clock.Add(-time.Second), "copied from the parent"))
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, textLine("own", f.stamp(), "the fork's own"))
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("own")}) {
		t.Fatalf("declared %v", keys)
	}
}

// The scan's bound limits the older content looked at, never the newest
// line: a resumed prompt larger than it (an image) is still found.
func TestAResumedPromptLargerThanTheScanBoundIsCaptured(t *testing.T) {
	f := newRichFixture(t)
	f.server.Lock()
	f.server.ChunkBytes = 1 << 20
	f.server.Unlock()
	prompt := f.resumedAt(t)
	f.appendLines(t, session, textLine("big", prompt, strings.Repeat("x", 3<<19)))
	*f.clock = prompt.Add(20 * time.Millisecond)
	f.richHook(t, session, f.repo)
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("big")}) {
		t.Fatalf("declared %v", keys)
	}
	if truncated := richHealth(t, f).ResumeScanTruncated; truncated != 0 {
		t.Fatalf("a run found whole counted truncated %d times", truncated)
	}
}

// A resumed run longer than the bound is counted where health is read.
func TestAResumedRunCutByTheScanBoundIsCounted(t *testing.T) {
	f := newRichFixture(t)
	start := f.clock.Add(10 * time.Minute)
	var run []contracttest.Line
	for index := range 300 {
		run = append(run, textLine(fmt.Sprintf("p%d", index), start.Add(time.Duration(index)*time.Millisecond), strings.Repeat("x", 4<<10)))
	}
	f.resumeSession(t, 1, run...)
	if truncated := richHealth(t, f).ResumeScanTruncated; truncated != 1 {
		t.Fatalf("resume_scan_truncated %d, want 1", truncated)
	}
}

// RC-05's Codex shape: the sighting comes first, the prompt 26 ms after
// it and the reply 1.5 s after, both written before the first read.
func TestAResumedPromptAfterItsSightingIsDeclaredWithItsReply(t *testing.T) {
	f := newRichFixture(t)
	sighted := f.resumedAt(t)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, textLine("p1", sighted.Add(26*time.Millisecond), "the resumed prompt"), replyLine("r1", sighted.Add(1500*time.Millisecond), "the reply"))
	*f.clock = sighted.Add(1500 * time.Millisecond)
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("p1"), itemKey("r1")}) {
		t.Fatalf("declared %v", keys)
	}
}

// A resumed prompt larger than the bound and still being written at the
// first read is read whole once complete, never from inside it.
func TestAResumedPromptStillBeingWrittenPastTheScanBoundIsCaptured(t *testing.T) {
	f := newRichFixture(t)
	f.server.Lock()
	f.server.ChunkBytes = 1 << 20
	f.server.Unlock()
	prompt := f.resumedAt(t)
	line := textLine("big", prompt, strings.Repeat("x", 3<<19)).Encode()
	appendSession(t, f.sessionFile(session), line[:len(line)-100])
	*f.clock = prompt.Add(20 * time.Millisecond)
	f.richHook(t, session, f.repo)
	f.tick(t)
	appendSession(t, f.sessionFile(session), line[len(line)-100:])
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("big")}) {
		t.Fatalf("declared %v", keys)
	}
	if health := richHealth(t, f); health.ParseErrors != 0 || health.ResumeScanTruncated != 0 {
		t.Fatalf("health %+v", health)
	}
}
