// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/richcapture"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// One session file named two ways (a directory link here, a verbatim
// path on Windows) is one source with one cursor: never read twice.

// linkedSession is a session file under a real directory of the sessions
// root and the same file's spelling through a link to that directory.
func (f *fixture) linkedSession(t *testing.T) (real, linked string) {
	t.Helper()
	dir := filepath.Join(sessionsDir(f.home), "2026")
	os.MkdirAll(dir, 0o700)
	if err := os.Symlink(dir, filepath.Join(sessionsDir(f.home), "latest")); err != nil {
		t.Fatal(err)
	}
	return filepath.Join(dir, "s.jsonl"), filepath.Join(sessionsDir(f.home), "latest", "s.jsonl")
}

func TestASessionFileNamedTwoWaysIsReadOnce(t *testing.T) {
	f := newRichFixture(t)
	real, linked := f.linkedSession(t)
	f.writeSessionAt(t, linked, "e1")
	f.richHookNaming(t, session, linked)
	f.tickUntilSettled(t)
	appendSession(t, real, textLine("e2", f.stamp(), "said e2").Encode())
	f.richHookNaming(t, session, real)
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e1"), itemKey("e2")}) {
		t.Fatalf("declared %v", keys)
	}
	if parsed := f.parsed.Load(); parsed != 2 {
		t.Fatalf("parsed %d lines, want each once", parsed)
	}
	if len(f.daemon.sources.Sources) != 1 {
		t.Fatalf("sources %v", f.daemon.sources.Sources)
	}
}

// storedSpellings saves a source under both spellings, each with its own
// cursor, as an earlier daemon keyed by the raw path would have.
func (f *fixture) storedSpellings(t *testing.T, cursors map[string]richcapture.Cursor) {
	t.Helper()
	sources := contentSources{Sources: map[string]contentSource{}}
	for path, cursor := range cursors {
		cursor.Path = path
		if err := contentCursors(f.layout).Save(cursor); err != nil {
			t.Fatal(err)
		}
		sources.Sources[path] = contentSource{Agent: richAgent, SessionID: session, Cwd: f.repo, FirstSeen: *f.clock, SeenAt: *f.clock}
	}
	if err := store.WriteJSON(f.daemon.contentSourcesPath(), sources); err != nil {
		t.Fatal(err)
	}
	f.daemon.sources, f.daemon.sourceFacts = nil, nil
}

func markedAt(t *testing.T, path string, offset int64) richcapture.Cursor {
	t.Helper()
	file, _, err := richcapture.OpenSource(path, richcapture.Cursor{Harness: richAgent}, false)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if offset < 0 {
		offset = file.Size()
	}
	return file.Mark(offset)
}

// Spellings stored apart collapse on load to the cursor that read furthest
// in the same file, so the collapse never rewinds.
func TestStoredSpellingsCollapseToTheFurthestCursor(t *testing.T) {
	f := newRichFixture(t)
	real, linked := f.linkedSession(t)
	f.writeSessionAt(t, real, "e1")
	f.storedSpellings(t, map[string]richcapture.Cursor{linked: markedAt(t, real, -1), real: markedAt(t, real, 0)})
	appendSession(t, real, textLine("e2", f.stamp(), "said e2").Encode())
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e2")}) {
		t.Fatalf("declared %v", keys)
	}
	if len(f.daemon.sources.Sources) != 1 {
		t.Fatalf("sources %v", f.daemon.sources.Sources)
	}
}

// Across files at the path, the newer file's cursor wins.
func TestStoredSpellingsOfReplacedFilesCollapseToTheNewerFile(t *testing.T) {
	f := newRichFixture(t)
	real, linked := f.linkedSession(t)
	f.writeSessionAt(t, real, "old")
	past := f.clock.Add(-time.Hour)
	os.Chtimes(real, past, past)
	older := markedAt(t, real, -1)
	os.Remove(real)
	f.writeSessionAt(t, real, "e1")
	f.storedSpellings(t, map[string]richcapture.Cursor{linked: older, real: markedAt(t, real, -1)})
	appendSession(t, real, textLine("e2", f.stamp(), "said e2").Encode())
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e2")}) {
		t.Fatalf("declared %v", keys)
	}
}

// A file named before its directory exists is keyed by its cleaned spelling;
// once the directory appears, its next sighting takes that source over.
func TestAFileNamedBeforeItsDirectoryExistsStaysOneSource(t *testing.T) {
	f := newRichFixture(t)
	linked := filepath.Join(sessionsDir(f.home), "latest", "s.jsonl")
	f.richHookNaming(t, session, linked)
	f.tickUntilSettled(t)
	real, _ := f.linkedSession(t)
	f.writeSessionAt(t, real, "e1")
	f.tickUntilSettled(t)
	f.richHookNaming(t, session, linked)
	appendSession(t, real, textLine("e2", f.stamp(), "said e2").Encode())
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e1"), itemKey("e2")}) {
		t.Fatalf("declared %v", keys)
	}
	if parsed := f.parsed.Load(); parsed != 2 || len(f.daemon.sources.Sources) != 1 {
		t.Fatalf("parsed %d lines from %d sources, want each line once from one", parsed, len(f.daemon.sources.Sources))
	}
}

// An identity can be reused for another file (ext4 recreates at the old
// inode): the cursor kept is the one the file on disk still matches.
func TestStoredSpellingsWithAReusedIdentityCollapseToTheFileOnDisk(t *testing.T) {
	f := newRichFixture(t)
	real, linked := f.linkedSession(t)
	f.writeSessionAt(t, real, "old")
	appendSession(t, real, textLine("old2", f.stamp(), "a longer old file").Encode())
	older := markedAt(t, real, -1)
	os.Remove(real)
	f.writeSessionAt(t, real, "e1")
	newer := markedAt(t, real, -1)
	older.Identity = newer.Identity
	f.storedSpellings(t, map[string]richcapture.Cursor{linked: older, real: newer})
	appendSession(t, real, textLine("e2", f.stamp(), "said e2").Encode())
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e2")}) {
		t.Fatalf("declared %v", keys)
	}
}
