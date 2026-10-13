// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package richcapture

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeSession(t *testing.T, path, content string) {
	t.Helper()
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.WriteString(content); err != nil {
		t.Fatal(err)
	}
}

func open(t *testing.T, path string, cursor Cursor, known bool) (*SourceFile, Change) {
	t.Helper()
	source, change, err := OpenSource(path, cursor, known)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { source.Close() })
	return source, change
}

// Only LF-terminated lines are read; a line still being written waits, and
// is read whole once its writer finishes it.
func TestAnUnfinishedLineWaitsAndIsReadWholeLater(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	writeSession(t, path, "{\"n\":1}\n{\"n\":2")
	source, change := open(t, path, Cursor{}, false)
	if change != FirstSeen {
		t.Fatalf("change = %v", change)
	}
	first, state := source.Next(MaxLineBytes)
	if state != LineComplete || string(first.Bytes) != `{"n":1}` || first.Offset != 0 || first.End != 8 {
		t.Fatalf("first line %+v %v", first, state)
	}
	if partial, state := source.Next(MaxLineBytes); state != LineIncomplete || partial.Bytes != nil {
		t.Fatalf("partial line %q %v", partial.Bytes, state)
	}
	cursor := source.Mark(first.End)
	source.Close()
	writeSession(t, path, "}\n")
	again, change := open(t, path, cursor, true)
	if change != Grown {
		t.Fatalf("change = %v", change)
	}
	if err := again.SeekTo(cursor.Offset); err != nil {
		t.Fatal(err)
	}
	second, state := again.Next(MaxLineBytes)
	if state != LineComplete || string(second.Bytes) != `{"n":2}` || second.Offset != 8 {
		t.Fatalf("second line %+v %v", second, state)
	}
}

func TestAnOversizedLineIsConsumedWholeAndReadingGoesOn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	writeSession(t, path, strings.Repeat("x", 4096)+"\n{\"n\":2}\n")
	source, _ := open(t, path, Cursor{}, false)
	line, state := source.Next(1024)
	if state != LineOversized || line.Bytes != nil || line.Offset != 0 || line.End != 4097 {
		t.Fatalf("oversized line %+v %v", line, state)
	}
	if next, state := source.Next(1024); state != LineComplete || string(next.Bytes) != `{"n":2}` {
		t.Fatalf("after the oversized line: %q %v", next.Bytes, state)
	}
}

func TestAnUnchangedFileIsUnchanged(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	writeSession(t, path, "{\"n\":1}\n")
	source, _ := open(t, path, Cursor{}, false)
	cursor := source.Mark(8)
	source.Close()
	if _, change := open(t, path, cursor, true); change != Unchanged {
		t.Fatalf("change = %v", change)
	}
}

// A file whose old position means nothing is replaced: another file at the
// path (rotation), a truncation, or the same size rewritten in place.
func TestReplacedRotatedAndRewrittenFilesAreRecognized(t *testing.T) {
	cases := map[string]func(t *testing.T, path string){
		"rotated": func(t *testing.T, path string) {
			os.Rename(path, path+".1")
			writeSession(t, path, "{\"n\":9}\n{\"n\":9}\n")
		},
		"truncated": func(t *testing.T, path string) {
			os.Truncate(path, 4)
		},
		"rewritten in place": func(t *testing.T, path string) {
			os.WriteFile(path, []byte("{\"m\":1}\n{\"m\":2}\n"), 0o600)
		},
	}
	for name, replace := range cases {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "session.jsonl")
			writeSession(t, path, "{\"n\":1}\n{\"n\":2}\n")
			source, _ := open(t, path, Cursor{}, false)
			cursor := source.Mark(16)
			source.Close()
			replace(t, path)
			if _, change := open(t, path, cursor, true); change != Replaced {
				t.Fatalf("change = %v", change)
			}
		})
	}
}

func TestAMissingFileIsMissing(t *testing.T) {
	if _, _, err := OpenSource(filepath.Join(t.TempDir(), "gone.jsonl"), Cursor{}, false); !errors.Is(err, ErrSourceMissing) {
		t.Fatalf("err = %v", err)
	}
}

func TestFirstLineIsTheHeader(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	writeSession(t, path, "{\"type\":\"session\"}\n{\"n\":1}\n")
	source, _ := open(t, path, Cursor{}, false)
	if first, ok := source.FirstLine(MaxLineBytes); !ok || string(first) != `{"type":"session"}` {
		t.Fatalf("first line %q %v", first, ok)
	}
}

func TestCursorsPersistAndRememberABoundedSetOfKeys(t *testing.T) {
	cursors := OpenCursors(filepath.Join(t.TempDir(), "cursors"))
	cursor := Cursor{Path: "/agent/session.jsonl", Identity: "1:2", Offset: 42, Parser: json.RawMessage(`{"lines":3}`), Committing: &Commit{CaptureID: captureA, End: 99}}
	for index := range maxSeenKeys + 5 {
		cursor.Remember(fmt.Sprintf("%064d", index))
	}
	if cursor.Seen(fmt.Sprintf("%064d", 0)) || !cursor.Seen(fmt.Sprintf("%064d", maxSeenKeys+4)) || len(cursor.SeenKeys) != maxSeenKeys {
		t.Fatalf("seen keys kept %d, oldest seen %v", len(cursor.SeenKeys), cursor.Seen(fmt.Sprintf("%064d", 0)))
	}
	if err := cursors.Save(cursor); err != nil {
		t.Fatal(err)
	}
	loaded, found, err := cursors.Load("/agent/session.jsonl")
	if err != nil || !found || loaded.Offset != 42 || string(loaded.Parser) != `{"lines":3}` || loaded.Committing == nil || loaded.Committing.End != 99 || len(loaded.SeenKeys) != maxSeenKeys {
		t.Fatalf("loaded %+v %v %v", loaded, found, err)
	}
	if _, found, _ := cursors.Load("/agent/other.jsonl"); found {
		t.Fatal("a cursor for another file")
	}
}

// A cursor describes the file it was marked on, however its identity was
// reused (ext4 hands a recreated file the old inode): the content decides.
func TestASourceFileDescribesOnlyCursorsOfItsOwnContent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.jsonl")
	writeSession(t, path, "{\"a\":1}\n")
	file, _, err := OpenSource(path, Cursor{}, false)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	own := file.Mark(file.Size())
	if !file.Describes(own) {
		t.Fatal("a file does not describe its own cursor")
	}
	rewritten := own
	rewritten.PrefixSHA256 = strings.Repeat("0", 64)
	beyond := own
	beyond.Offset, beyond.Size = own.Size+10, own.Size+10
	for name, cursor := range map[string]Cursor{"another prefix, same identity": rewritten, "past its end": beyond} {
		if file.Describes(cursor) {
			t.Errorf("%s: described", name)
		}
	}
}
