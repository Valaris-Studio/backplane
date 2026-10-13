// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package richcapture

import (
	"encoding/json"
	"path/filepath"
	"testing"
)

func TestACursorKeepsItsSourceIncarnationAcrossPersistenceAndMarks(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	writeSession(t, path, "{}\n")
	file, _ := open(t, path, Cursor{}, false)
	cursor := file.Mark(0)
	file.Close()
	cursor.Committing = &Commit{CaptureID: captureA, End: 3}
	encoded, err := json.Marshal(cursor)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	fields["source_incarnation"] = json.RawMessage(`7`)
	encoded, err = json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &cursor); err != nil {
		t.Fatal(err)
	}
	cursors := OpenCursors(filepath.Join(t.TempDir(), "cursors"))
	if err := cursors.Save(cursor); err != nil {
		t.Fatal(err)
	}
	loaded, found, err := cursors.Load(path)
	if err != nil || !found {
		t.Fatalf("load cursor: found %v, error %v", found, err)
	}
	file, change := open(t, path, loaded, true)
	if change != Grown || loaded.Identity != cursor.Identity || !file.Describes(loaded) {
		t.Fatalf("incarnation changed physical source identity: change %v, cursor %+v", change, loaded)
	}
	marked := file.Mark(3)
	encoded, err = json.Marshal(marked)
	if err != nil {
		t.Fatal(err)
	}
	fields = nil
	if err := json.Unmarshal(encoded, &fields); err != nil {
		t.Fatal(err)
	}
	if string(fields["source_incarnation"]) != "7" || marked.Committing == nil || marked.Committing.CaptureID != captureA {
		t.Fatalf("source incarnation or pending delivery identity lost: %s", encoded)
	}
}
