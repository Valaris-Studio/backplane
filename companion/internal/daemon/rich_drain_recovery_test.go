// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package daemon

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

// Acked crashes retry identical transport records; count logical deliveries.
// requireStableContentCaptures also checks for rekeyed or conflicting retries.
func drainDeliveryCounts(f *fixture) (int, int) {
	reports, keys := map[string]bool{}, map[string]bool{}
	for _, record := range f.server.Records() {
		contents, _ := record["contents"].([]any)
		for _, value := range contents {
			content := value.(map[string]any)
			key := content["content_key"].(string)
			if content["coverage_reason"] == "record_too_large" {
				reports[record["capture_id"].(string)+"\x00"+key] = true
			} else {
				keys[key] = true
			}
		}
	}
	return len(reports), len(keys)
}

// A commit can end inside an oversized line. Its drain position and source
// incarnation must recover together, including when the inode is reused.
func TestARewrittenSourceKeepsItsDrainAcrossCommitCrashes(t *testing.T) {
	for _, point := range []string{"staged", "committing", "enqueued", "acked"} {
		t.Run(point, func(t *testing.T) {
			f := newRichFixture(t)
			f.richHook(t, session, f.repo)
			bodies := map[string]string{"e1": strings.Repeat("original ", 500), "e2": "before oversized line", "e3": "after its newline", "e4": "second rewrite"}
			f.appendLines(t, session, textLine("e1", f.stamp(), bodies["e1"]))
			f.tickUntilSettled(t)
			generation := mustGeneration(t, f, richMapping).ID
			path := f.sessionFile(session)
			identity := richSourceIdentity(t, path)
			if err := os.Truncate(path, 0); err != nil {
				t.Fatal(err)
			}
			f.appendLines(t, session, textLine("e2", f.stamp(), bodies["e2"]))
			lineStart := fileSize(t, path)
			size := appendSparse(t, path, 64<<20, "\n"+textLine("e3", f.stamp(), bodies["e3"]).Encode())
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
				t.Fatalf("rewrite never reached %s", point)
			}
			cursor := f.cursorOf(t, session)
			intentID := ""
			if cursor.Committing != nil {
				intentID = cursor.Committing.CaptureID
				if cursor.Committing.Drain == nil || cursor.Committing.End != lineStart || cursor.Committing.Drain.To <= lineStart || cursor.Committing.Drain.To >= size {
					t.Fatalf("fixture did not interrupt a midline commit: %+v", cursor.Committing)
				}
			} else if point == "acked" && (cursor.Drain == nil || cursor.Offset != lineStart || cursor.Drain.To <= lineStart || cursor.Drain.To >= size) {
				t.Fatalf("acked fixture did not retain a midline cursor: %+v", cursor)
			}
			f.daemon = New(f.daemon.config)
			if point == "enqueued" {
				*f.clock = f.clock.Add(time.Second)
				f.tick(t)
				if position := f.cursorOf(t, session).Position(); position <= cursor.Committing.Drain.To {
					t.Fatalf("recovery reread the committed drain: position %d, committed progress %d", position, cursor.Committing.Drain.To)
				}
			}
			f.tickUntilSettled(t)
			if tooLarge, _ := drainDeliveryCounts(f); tooLarge != 1 {
				t.Fatalf("oversized line declared %d times after recovery", tooLarge)
			}
			if health := richHealth(t, f); health.ParseErrors != 0 {
				t.Fatalf("drained suffix was parsed after recovery: %+v", health)
			}
			if err := os.Truncate(path, 0); err != nil {
				t.Fatal(err)
			}
			f.appendLines(t, session, textLine("e4", f.stamp(), bodies["e4"]))
			if !os.SameFile(identity, richSourceIdentity(t, path)) {
				t.Fatal("fixture changed physical identity")
			}
			f.tickUntilSettled(t)
			f.daemon = New(f.daemon.config)
			f.tickUntilSettled(t)
			captures := requireStableContentCaptures(t, f, bodies)
			if captures[itemKey("e1")] == captures[itemKey("e2")] || captures[itemKey("e2")] == captures[itemKey("e4")] || captures[itemKey("e1")] == captures[itemKey("e4")] {
				t.Fatalf("rewrite incarnation was lost across drain/recovery: %v", captures)
			}
			if intentID != "" && captures[itemKey("e2")] != intentID {
				t.Fatalf("recovery changed delivery intent: %s -> %s", intentID, captures[itemKey("e2")])
			}
			if tooLarge, keys := drainDeliveryCounts(f); tooLarge != 1 || keys != len(bodies) {
				t.Fatalf("repeated declarations: %d too large, keys %v", tooLarge, keys)
			}
			if got := mustGeneration(t, f, richMapping).ID; got != generation {
				t.Fatalf("drain/rewrite changed generation: %s -> %s", generation, got)
			}
		})
	}
}
