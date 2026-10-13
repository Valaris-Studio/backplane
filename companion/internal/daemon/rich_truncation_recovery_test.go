// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

func requireStableContentCaptures(t *testing.T, f *fixture, bodies map[string]string) map[string]string {
	t.Helper()
	captures := map[string]string{}
	for _, record := range f.server.Records() {
		contents, _ := record["contents"].([]any)
		for _, content := range contents {
			key := content.(map[string]any)["content_key"].(string)
			capture := record["capture_id"].(string)
			if prior := captures[key]; prior != "" && prior != capture {
				t.Fatalf("%s replayed under different capture ids: %s, %s", key, prior, capture)
			}
			captures[key] = capture
		}
	}
	for id, body := range bodies {
		if got := string(f.server.Body(itemKey(id))); got != body {
			t.Fatalf("%s body differs: got %d bytes, want %d; keys %v", id, len(got), len(body), declaredKeys(f))
		}
		if captures[itemKey(id)] == "" {
			t.Fatalf("%s was never declared", id)
		}
	}
	f.server.Lock()
	defer f.server.Unlock()
	if len(f.server.Rejections) != 0 {
		t.Fatalf("server rejected %v", f.server.Rejections)
	}
	return captures
}

func TestRepeatedInPlaceRewritesKeepNewContentAndDeduplicateOldKeys(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	bodies := map[string]string{"e1": strings.Repeat("original ", 500), "e2": strings.Repeat("second ", 100), "e3": "third", "e4": "appended after restart"}
	f.appendLines(t, session, textLine("e1", f.stamp(), bodies["e1"]))
	f.tickUntilSettled(t)
	generation := mustGeneration(t, f, richMapping).ID
	path := f.sessionFile(session)
	before := richSourceIdentity(t, path)
	for _, id := range []string{"e2", "e3"} {
		if err := os.Truncate(path, 0); err != nil {
			t.Fatal(err)
		}
		f.appendLines(t, session, textLine(id, f.stamp(), bodies[id]), textLine("e1", f.stamp(), "duplicate must not overwrite original"))
		if !os.SameFile(before, richSourceIdentity(t, path)) {
			t.Fatal("rewrite changed physical file identity")
		}
		f.tickUntilSettled(t)
		if got := string(f.server.Body(itemKey(id))); got != bodies[id] {
			t.Fatalf("%s was lost after an in-place rewrite: keys %v", id, declaredKeys(f))
		}
	}
	f.daemon = New(f.daemon.config)
	f.tickUntilSettled(t)
	f.appendLines(t, session, textLine("e4", f.stamp(), bodies["e4"]))
	f.tickUntilSettled(t)
	f.tickUntilSettled(t)
	captures := requireStableContentCaptures(t, f, bodies)
	if captures[itemKey("e1")] == captures[itemKey("e2")] || captures[itemKey("e2")] == captures[itemKey("e3")] || captures[itemKey("e1")] == captures[itemKey("e3")] {
		t.Fatalf("source incarnations reused capture ids: %v", captures)
	}
	if got := mustGeneration(t, f, richMapping).ID; got != generation {
		t.Fatalf("rewrites changed capture generation: %s -> %s", generation, got)
	}
	if keys := declaredKeys(f); len(keys) != len(bodies) {
		t.Fatalf("old keys were declared again: %v", keys)
	}
}

func TestAnInPlaceRewriteSurvivesEveryCommitCrash(t *testing.T) {
	for _, point := range []string{"staged", "committing", "enqueued", "acked"} {
		t.Run(point, func(t *testing.T) {
			f := newRichFixture(t)
			f.richHook(t, session, f.repo)
			bodies := map[string]string{"e1": strings.Repeat("a", 40<<10), "e2": strings.Repeat("b", 20<<10), "e3": "appended after recovery"}
			f.appendLines(t, session, textLine("e1", f.stamp(), bodies["e1"]))
			f.tickUntilSettled(t)
			generation := mustGeneration(t, f, richMapping).ID
			path := f.sessionFile(session)
			before := richSourceIdentity(t, path)
			if err := os.Truncate(path, 0); err != nil {
				t.Fatal(err)
			}
			f.appendLines(t, session, textLine("e2", f.stamp(), bodies["e2"]))
			if !os.SameFile(before, richSourceIdentity(t, path)) {
				t.Fatal("rewrite changed physical file identity")
			}
			reached := false
			commitFault = func(at string) error {
				if at == point {
					reached = true
					return errors.New("crash at " + point)
				}
				return nil
			}
			t.Cleanup(clearFault)
			*f.clock = f.clock.Add(time.Second)
			f.daemon.Tick(context.Background())
			clearFault()
			if !reached {
				t.Fatalf("rewrite never reached crash seam %s", point)
			}
			intentID := ""
			if cursor := f.cursorOf(t, session); cursor.Committing != nil {
				intentID = cursor.Committing.CaptureID
			}
			f.daemon = New(f.daemon.config)
			f.tickUntilSettled(t)
			f.appendLines(t, session, textLine("e3", f.stamp(), bodies["e3"]))
			f.tickUntilSettled(t)
			f.tickUntilSettled(t)
			captures := requireStableContentCaptures(t, f, bodies)
			if captures[itemKey("e1")] == captures[itemKey("e2")] {
				t.Fatalf("rewrite reused original capture id %s", captures[itemKey("e1")])
			}
			if intentID != "" && captures[itemKey("e2")] != intentID {
				t.Fatalf("recovery changed the durable intent id: %s -> %s", intentID, captures[itemKey("e2")])
			}
			if got := mustGeneration(t, f, richMapping).ID; got != generation {
				t.Fatalf("recovery changed capture generation: %s -> %s", generation, got)
			}
			if stats, err := f.daemon.spool.Stats(); err != nil || stats.PendingBodies != 0 {
				t.Fatalf("spool did not drain: %+v, %v", stats, err)
			}
		})
	}
}
