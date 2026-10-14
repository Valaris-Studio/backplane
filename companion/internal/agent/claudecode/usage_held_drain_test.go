// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package claudecode

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// A request held back before a line longer than one read's budget, by a
// boundary whose hook preceded it, is still released once the hold ends:
// a jump past the line's start that a read consumed is never lost to the
// hold, no persisted offset rests inside the line, and its tail, a
// request's own shape, is never counted.
func TestUsageAnUntilHeldRequestBeforeAnOverBudgetLineIsReleasedOnce(t *testing.T) {
	f := newTranscript(t, requestLine(t, "A", 1, 1))
	lineStart := int64(len(requestLine(t, "A", 1, 1)))
	tail := strings.Repeat(" ", 12<<20) + strings.TrimSuffix(requestLine(t, "C", 3, 777), "\n") + "\n"
	lineEnd := lineStart + 250<<20 + int64(len(tail))
	appendSparse(t, f.path, 250<<20, tail+requestLine(t, "B", 2, 2))
	growingStart := lineEnd + int64(len(requestLine(t, "B", 2, 2)))
	appendSparse(t, f.path, 640<<20, "")
	emitted := map[int]int{}
	read := func(event string, until time.Time) {
		t.Helper()
		for _, usage := range f.readUntil(t, event, usageNow, until) {
			emitted[number(usageOf(t, usage)["output_tokens"])]++
		}
		var legacy legacyHeldCursor
		if err := json.Unmarshal(f.cursor, &legacy); err != nil {
			t.Fatalf("cursor: %v\n%s", err, f.cursor)
		}
		offset := legacy.Files[f.path].Offset
		if offset > lineStart && offset < lineEnd || offset > growingStart {
			t.Fatalf("after a %s read the persisted offset is %d, inside an oversized line ([%d, %d) or past %d): it is no line start", event, offset, lineStart, lineEnd, growingStart)
		}
		if emitted[777] != 0 {
			t.Fatalf("the oversized line's tail was counted as a request: %v", emitted)
		}
	}
	read("Stop", time.Time{})
	// A boundary whose hook fired before both requests holds them by Until.
	read("Stop", time.Date(2026, 9, 25, 11, 0, 0, 0, time.UTC))
	for range 6 {
		read("Stop", time.Time{})
	}
	if emitted[1] != 1 {
		t.Fatalf("livelock: the held request was not released once within 6 reads after its hold ended: %v", emitted)
	}
	for range 4 {
		if emitted[2] != 0 {
			break
		}
		read("SessionEnd", time.Time{})
	}
	read("Stop", time.Time{})
	read("Stop", time.Time{})
	if emitted[1] != 1 || emitted[2] != 1 || len(emitted) != 2 {
		t.Fatalf("each request once, the tail never: %v", emitted)
	}
}

// legacyHeldCursor is the per-file offset a reader resumes from as from a
// line start.
type legacyHeldCursor struct {
	Files map[string]struct {
		Offset int64 `json:"offset"`
	} `json:"files"`
}
