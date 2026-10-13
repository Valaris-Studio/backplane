// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package claudecode

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

func readHeldTranscript(t *testing.T, path string, budget int64, cursor fileCursor) (fileCursor, []int64) {
	t.Helper()
	reader := usageReader{
		read:   agent.UsageRead{SessionID: usageSession, Event: "Stop", Now: usageNow},
		budget: budget, byKey: map[string]*usageEntry{}, parents: map[string]bool{},
	}
	next := reader.readFile(path, false, cursor)
	var outputs []int64
	for _, entry := range reader.entries {
		outputs = append(outputs, entry.tokens.OutputTokens)
	}
	// Each read starts from only the state a daemon restart can recover.
	encoded, err := json.Marshal(next)
	if err != nil {
		t.Fatal(err)
	}
	var persisted fileCursor
	if err := json.Unmarshal(encoded, &persisted); err != nil {
		t.Fatal(err)
	}
	return persisted, outputs
}

func TestUsageRevisitsAHeldRangeWhenItsTranscriptChanges(t *testing.T) {
	for _, mode := range []string{"rewritten in place", "replaced", "ordinary append"} {
		t.Run(mode, func(t *testing.T) {
			dir := t.TempDir()
			requireSparse(t, dir)
			path := filepath.Join(dir, "session.jsonl")
			head := requestLine(t, "held", 1, 1)
			file, err := os.Create(path)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := file.WriteString(head); err != nil {
				t.Fatal(err)
			}
			if err := file.Truncate(64 << 20); err != nil {
				t.Fatal(err)
			}
			before, err := file.Stat()
			if err != nil {
				t.Fatal(err)
			}
			if err := file.Close(); err != nil {
				t.Fatal(err)
			}
			// A transcript can inherit this remaining shared budget after
			// another transcript consumed most of the read's allowance.
			cursor, outputs := readHeldTranscript(t, path, 1<<20, fileCursor{})
			if cursor.Offset != 0 || len(outputs) != 0 {
				t.Fatalf("the request before the unfinished line was not held: cursor %+v, outputs %v", cursor, outputs)
			}
			flags := os.O_WRONLY | os.O_APPEND
			if mode != "ordinary append" {
				flags = os.O_WRONLY | os.O_CREATE | os.O_TRUNC
				if mode == "replaced" {
					if err := os.Rename(path, path+".previous"); err != nil {
						t.Fatal(err)
					}
				}
			}
			file, err = os.OpenFile(path, flags, 0o600)
			if err != nil {
				t.Fatal(err)
			}
			if mode != "ordinary append" {
				// Keep the held request byte-identical, then put new valid
				// usage exactly where the prior non-usage range began.
				if _, err := file.WriteString(head + requestLine(t, "new", 2, 7)); err != nil {
					t.Fatal(err)
				}
				if err := file.Truncate(64 << 20); err != nil {
					t.Fatal(err)
				}
				if _, err := file.Seek(64<<20, 0); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := file.WriteString("\n" + requestLine(t, "after", 3, 2)); err != nil {
				t.Fatal(err)
			}
			after, err := file.Stat()
			if err != nil {
				t.Fatal(err)
			}
			if err := file.Close(); err != nil {
				t.Fatal(err)
			}
			if os.SameFile(before, after) != (mode != "replaced") || after.Size() <= before.Size() {
				t.Fatal("fixture did not establish the intended identity and larger file")
			}
			cursor, outputs = readHeldTranscript(t, path, maxUsageReadBytes, cursor)
			want := "[1 7 2]"
			if mode == "ordinary append" {
				want = "[1 2]"
			}
			if fmt.Sprint(outputs) != want {
				t.Fatalf("new usage in the held range was lost: got %v, want %s", outputs, want)
			}
			if _, repeated := readHeldTranscript(t, path, maxUsageReadBytes, cursor); len(repeated) != 0 {
				t.Fatalf("a settled request was repeated: %v", repeated)
			}
		})
	}
}
