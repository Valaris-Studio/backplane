// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package richcapture

import (
	"os"
	"path/filepath"
	"testing"
)

// A file rewritten in place, its identity, its first 4 KiB and its length
// kept, is not told from one that grew, so its read position is trusted, as
// it always was. A drain persisted there must not be: the line it was
// draining now ends before it, and a record starting where the drain stood
// is read, as the reader read it before bounded draining.
func TestAStaleDrainNeverSkipsARecordARewritePutAtItsPosition(t *testing.T) {
	const limit = 1024
	path := filepath.Join(t.TempDir(), "session.jsonl")
	head := "{\"n\":1}\n"
	writeSparse(t, path, []byte(head), 1<<20, nil)
	source, _ := open(t, path, Cursor{}, false)
	if first, state := source.Next(limit); state != LineComplete || string(first.Bytes) != `{"n":1}` {
		t.Fatalf("first line %q %v", first.Bytes, state)
	}
	position := firstOversized(t, source, limit, int64(len(head))).End
	for steps := 0; ; steps++ {
		if steps > (1<<20)/limit+16 {
			t.Fatalf("draining stalled at %d", position)
		}
		next, state := source.Next(limit)
		if state == LineIncomplete {
			break
		}
		position = next.End
	}
	written := int64(len(head)) + 1<<20
	if position != written {
		t.Fatalf("fixture: the drain stood at %d, %d bytes are written", position, written)
	}
	cursor := source.Mark(position)
	source.Close()

	// The rewrite ends that line just before where the drain stood, and
	// records begin there; the first 4 KiB are as they were.
	file, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteAt([]byte("\n{\"n\":7}\n{\"n\":2}\n"), written-1); err != nil {
		t.Fatal(err)
	}
	file.Close()
	again, change := open(t, path, cursor, true)
	if change != Grown {
		t.Fatalf("fixture: the rewrite was told apart (%v); it must look grown", change)
	}
	if err := again.SeekTo(cursor.Offset); err != nil {
		t.Fatal(err)
	}
	var complete []string
	for calls := 0; calls < int(written/limit)+16; calls++ {
		line, state := again.Next(limit)
		if state == LineIncomplete {
			break
		}
		if state == LineComplete {
			complete = append(complete, string(line.Bytes))
		}
	}
	if len(complete) != 2 || complete[0] != `{"n":7}` || complete[1] != `{"n":2}` {
		t.Fatalf("the record at the stale drain's position was lost: read %q, want [{\"n\":7} {\"n\":2}]", complete)
	}
}
