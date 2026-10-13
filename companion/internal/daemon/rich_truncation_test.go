// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"os"
	"strings"
	"testing"
)

func richSourceIdentity(t *testing.T, path string) os.FileInfo {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	info, statErr := file.Stat()
	closeErr := file.Close()
	if statErr != nil || closeErr != nil {
		t.Fatalf("snapshot source identity: stat %v, close %v", statErr, closeErr)
	}
	return info
}

// A rewritten source can reuse both the inode and byte offset of an
// already delivered record without making the new record a replay.
func TestARewrittenSessionDeliversItsNewFirstRecord(t *testing.T) {
	for _, mode := range []string{"truncated", "truncated after restart", "rotated control"} {
		t.Run(mode, func(t *testing.T) {
			f := newRichFixture(t)
			f.richHook(t, session, f.repo)
			originalBody := strings.Repeat("original ", 500)
			f.appendLines(t, session, textLine("e1", f.stamp(), originalBody))
			f.tickUntilSettled(t)
			if got := string(f.server.Body(itemKey("e1"))); got != originalBody {
				t.Fatalf("original body was not delivered: %q", got)
			}
			initialGeneration := mustGeneration(t, f, richMapping).ID
			path := f.sessionFile(session)
			before := richSourceIdentity(t, path)
			if mode == "truncated after restart" {
				f.daemon = New(f.daemon.config)
				// Establish the resumed capture window before writing new work.
				f.tickUntilSettled(t)
			}
			if mode == "rotated control" {
				if err := os.Rename(path, path+".old"); err != nil {
					t.Fatal(err)
				}
			} else if err := os.Truncate(path, 0); err != nil {
				t.Fatal(err)
			}
			f.appendLines(t, session, textLine("e2", f.stamp(), "new work after replacement"))
			after := richSourceIdentity(t, path)
			if os.SameFile(before, after) != (mode != "rotated control") || after.Size() >= before.Size() {
				t.Fatal("fixture did not establish the intended file identity and shorter replacement")
			}
			f.tickUntilSettled(t)
			if got := mustGeneration(t, f, richMapping).ID; got != initialGeneration {
				t.Fatalf("source replacement changed capture generation: %s -> %s", initialGeneration, got)
			}
			if got := string(f.server.Body(itemKey("e2"))); got != "new work after replacement" {
				t.Fatalf("replacement's new first record was lost: body %q, keys %v, health %+v, cursor %+v", got, declaredKeys(f), richHealth(t, f), f.cursorOf(t, session))
			}
			captures := map[string]string{}
			for _, record := range f.server.Records() {
				contents, _ := record["contents"].([]any)
				for _, content := range contents {
					captures[content.(map[string]any)["content_key"].(string)] = record["capture_id"].(string)
				}
			}
			if captures[itemKey("e1")] == "" || captures[itemKey("e1")] == captures[itemKey("e2")] {
				t.Fatalf("different source incarnations reused one capture id: %v", captures)
			}
			f.tickUntilSettled(t)
			if keys := declaredKeys(f); len(keys) != 2 {
				t.Fatalf("an unchanged poll declared content again: %v", keys)
			}
			if health := richHealth(t, f); health.SourceReplaced != 1 || health.ParseErrors != 0 {
				t.Fatalf("replacement health %+v", health)
			}
		})
	}
}
