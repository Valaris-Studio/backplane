// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package richcapture

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

// A binary from before bounded draining (8c68ae1f) reads only these
// members of a cursor and takes Offset, or Committing.End, as a line start.
// While a line is drained, both stay at the oversized line's start, so a
// downgraded reader reads the line again from there and skips it whole,
// never its tail as a line of its own.
type legacyCursor struct {
	Path            string          `json:"path"`
	Identity        string          `json:"identity"`
	Size            int64           `json:"size"`
	ModTime         time.Time       `json:"mod_time"`
	PrefixSHA256    string          `json:"prefix_sha256"`
	Offset          int64           `json:"offset"`
	SeenKeys        []string        `json:"seen_keys,omitempty"`
	Parser          json.RawMessage `json:"parser,omitempty"`
	Began           time.Time       `json:"began,omitzero"`
	ParentSessionID string          `json:"parent_session_id,omitempty"`
	HeaderBegan     bool            `json:"header_began,omitempty"`
	Harness         string          `json:"harness,omitempty"`
	StalledSince    time.Time       `json:"stalled_since,omitzero"`
	Committing      *legacyCommit   `json:"committing,omitempty"`
}

type legacyCommit struct {
	CaptureID string          `json:"capture_id"`
	End       int64           `json:"end"`
	Keys      []string        `json:"keys,omitempty"`
	Parser    json.RawMessage `json:"parser,omitempty"`
}

// savedLegacy saves cursor and decodes the file on disk as the old binary.
func savedLegacy(t *testing.T, cursors Cursors, cursor Cursor) legacyCursor {
	t.Helper()
	if err := cursors.Save(cursor); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(cursors.path(cursor.Path))
	if err != nil {
		t.Fatal(err)
	}
	var legacy legacyCursor
	if err := json.Unmarshal(raw, &legacy); err != nil {
		t.Fatalf("the old binary cannot decode the cursor: %v\n%s", err, raw)
	}
	return legacy
}

// legacyReadAt is what the old reader's Next made of the line at offset.
func legacyReadAt(t *testing.T, path string, offset int64, limit int) ([]byte, bool) {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.Seek(offset, 0); err != nil {
		t.Fatal(err)
	}
	content, _, complete := agent.NextLine(bufio.NewReaderSize(file, readBufferBytes), limit)
	return content, complete && content != nil
}

func TestAMidDrainCursorKeepsTheLegacyOffsetAtTheLineStart(t *testing.T) {
	// The oversized line is whitespace ending in a record of its own shape:
	// read from inside the line, its tail would parse as that record.
	const limit = 256 << 10
	suffix := `{"id":"SUFFIX","items":[{"text":"SECRET_SUFFIX_BODY"}]}`
	head := "{\"n\":1}\n"
	lineStart := int64(len(head))
	content := head + strings.Repeat(" ", 700<<10) + suffix + "\n{\"n\":2}\n"
	lineEnd := int64(strings.Index(content, "\n{\"n\":2}") + 1)
	path := filepath.Join(t.TempDir(), "session.jsonl")
	writeSession(t, path, content)
	cursors := OpenCursors(filepath.Join(t.TempDir(), "cursors"))
	expectLegacySafe := func(when string, legacy legacyCursor) {
		t.Helper()
		if legacy.Offset != lineStart {
			t.Fatalf("%s: the persisted offset is %d, inside the oversized line; an old binary resumes there as at a line start. Want the line's start, %d", when, legacy.Offset, lineStart)
		}
		if line, complete := legacyReadAt(t, path, legacy.Offset, limit); complete && bytes.Contains(line, []byte("SUFFIX")) {
			t.Fatalf("%s: an old reader resuming from the cursor reads the oversized line's tail as a record: %q", when, line)
		}
	}

	source, _ := open(t, path, Cursor{}, false)
	if first, state := source.Next(limit); state != LineComplete || string(first.Bytes) != `{"n":1}` {
		t.Fatalf("first line %q %v", first.Bytes, state)
	}
	report := firstOversized(t, source, limit, lineStart)
	expectLegacySafe("after the oversized report", savedLegacy(t, cursors, source.Mark(report.End)))
	source.Close()

	loaded, found, err := cursors.Load(path)
	if err != nil || !found {
		t.Fatalf("cursor %v %v", found, err)
	}
	again, change := open(t, path, loaded, true)
	if change != Grown {
		t.Fatalf("change = %v", change)
	}
	if err := again.SeekTo(loaded.Offset); err != nil {
		t.Fatal(err)
	}
	step := drainStep(t, again, limit, report.End)
	if step.End >= lineEnd {
		t.Fatalf("fixture: one step ended the line (%d..%d of %d); the line must outlast it", step.Offset, step.End, lineEnd)
	}
	expectLegacySafe("after a step resumed from the saved cursor", savedLegacy(t, cursors, again.Mark(step.End)))

	drainTo(t, again, limit, step.End, lineEnd)
	expectRecordAfter(t, again, limit, lineEnd)
	if done := savedLegacy(t, cursors, again.Mark(lineEnd+8)); done.Offset != lineEnd+8 {
		t.Fatalf("past the line the offset is the read position again: %d, want %d", done.Offset, lineEnd+8)
	}
}
