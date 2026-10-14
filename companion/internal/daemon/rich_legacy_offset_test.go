// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// legacySessionCursor is what a binary from before bounded draining
// (8c68ae1f) takes from a session file's cursor as line starts: Offset,
// and Committing.End once the commit is found queued. While a line is
// drained both stay at the oversized line's start, so a downgraded daemon
// reads the line again from there and never admits its tail as a record.
type legacySessionCursor struct {
	Offset     int64 `json:"offset"`
	Committing *struct {
		CaptureID string   `json:"capture_id"`
		End       int64    `json:"end"`
		Keys      []string `json:"keys"`
	} `json:"committing"`
}

func legacyCursorOf(t *testing.T, f *fixture, id string) legacySessionCursor {
	t.Helper()
	sum := sha256.Sum256([]byte(f.sessionFile(id)))
	raw, err := os.ReadFile(filepath.Join(f.layout.RichDir(), "cursors", hex.EncodeToString(sum[:16])+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var legacy legacySessionCursor
	if err := json.Unmarshal(raw, &legacy); err != nil {
		t.Fatalf("the old binary cannot decode the cursor: %v\n%s", err, raw)
	}
	return legacy
}

func e1LineEnd(f *fixture) int64 {
	return int64(len(textLine("e1", f.stamp(), "before the malformed line").Encode()))
}

func TestAMidDrainSessionCursorKeepsTheLegacyOffsetAtTheLineStart(t *testing.T) {
	f := newRichFixture(t)
	lineStart := e1LineEnd(f)
	lineEnd := lineStart + 128<<20 + 1
	reach := malformedSession(t, f)
	draining := 0
	for ticks := 1; ; ticks++ {
		if ticks > 64 {
			t.Fatal("no forward progress: e2 never declared in 64 passes")
		}
		f.daemon = New(f.daemon.config)
		*f.clock = f.clock.Add(time.Second)
		f.tick(t)
		if _, keys := declaredContent(f); fmt.Sprint(keys) == fmt.Sprint([]string{itemKey("e1"), itemKey("e2")}) {
			break
		}
		legacy := legacyCursorOf(t, f, session)
		if legacy.Offset > lineStart && legacy.Offset < lineEnd {
			t.Fatalf("pass %d, mid-drain: the persisted offset is %d, inside the oversized line [%d, %d); an old daemon resumes there as at a line start. Want %d",
				ticks, legacy.Offset, lineStart, lineEnd, lineStart)
		}
		if legacy.Offset == lineStart {
			draining++
		}
	}
	if draining == 0 {
		t.Fatal("fixture: the line was never seen mid-drain")
	}
	f.tickUntilSettled(t)
	if tooLarge, keys := declaredContent(f); tooLarge != 1 || fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e1"), itemKey("e2")}) {
		t.Fatalf("want e1, one record_too_large and e2, each once: %d too large, %v", tooLarge, keys)
	}
	if legacy := legacyCursorOf(t, f, session); legacy.Offset != reach {
		t.Fatalf("read to its end, the offset is %d, want %d", legacy.Offset, reach)
	}
}

// A crash between a record's intent and the cursor's advance leaves the
// intent on disk; an old daemon finding the record queued resumes at its
// End, so a record ending mid-drain records the line's start there.
func TestACommitIntentMidDrainKeepsTheLegacyEndAtTheLineStart(t *testing.T) {
	for _, point := range []string{"committing", "enqueued"} {
		t.Run(point, func(t *testing.T) {
			f := newRichFixture(t)
			lineStart := e1LineEnd(f)
			malformedSession(t, f)
			setFault(t, point)
			*f.clock = f.clock.Add(time.Second)
			f.daemon.Tick(context.Background())
			clearFault()
			legacy := legacyCursorOf(t, f, session)
			if legacy.Committing == nil {
				t.Fatal("fixture: no commit intent on disk after the crash")
			}
			if legacy.Committing.End != lineStart {
				t.Fatalf("the commit intent ends at %d, inside the oversized line; an old daemon resumes there as at a line start. Want %d", legacy.Committing.End, lineStart)
			}
			f.daemon = New(f.daemon.config)
			ticksUntilDeclared(t, f, itemKey("e2"), false)
			f.tickUntilSettled(t)
			if tooLarge, keys := declaredContent(f); tooLarge != 1 || fmt.Sprint(keys) != fmt.Sprint([]string{itemKey("e1"), itemKey("e2")}) {
				t.Fatalf("want e1, one record_too_large and e2, each once: %d too large, %v", tooLarge, keys)
			}
		})
	}
}
