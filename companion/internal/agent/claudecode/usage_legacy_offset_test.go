// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package claudecode

import (
	"encoding/json"
	"testing"
	"time"
)

// legacyUsageCursor is the usage cursor as a binary from before bounded
// draining (8c68ae1f) decodes it: each transcript is read on from offset as
// from a line start. While a line is drained, offset stays at the
// oversized line's start, so a downgraded reader reads the line again and
// skips it whole, never its tail as a request of its own.
type legacyUsageCursor struct {
	Files map[string]struct {
		Offset  int64     `json:"offset"`
		ModTime time.Time `json:"mod_time"`
	} `json:"files"`
	Parents []string `json:"parents,omitempty"`
}

func TestUsageAMidDrainCursorKeepsTheLegacyOffsetAtTheLineStart(t *testing.T) {
	// No request before the line is held, so nothing else keeps the offset
	// before it.
	head := encodeLines(t, line{"type": "user", "sessionId": usageSession, "timestamp": "2026-09-25T11:00:00Z", "message": map[string]any{"role": "user", "content": "hello"}})
	lineStart := int64(len(head))
	lineEnd := lineStart + hugeLine + 1
	f := newTranscript(t, head)
	appendSparse(t, f.path, hugeLine, "\n"+requestLine(t, "B", 2, 2))
	emitted := map[int]int{}
	draining := 0
	for reads := 1; emitted[2] == 0; reads++ {
		if reads > int(hugeLine/maxUsageReadBytes)+4 {
			t.Fatalf("no forward progress past the oversized line: %v", emitted)
		}
		for _, event := range f.read(t, "Stop", usageNow) {
			emitted[number(usageOf(t, event)["output_tokens"])]++
		}
		var legacy legacyUsageCursor
		if err := json.Unmarshal(f.cursor, &legacy); err != nil {
			t.Fatalf("the old binary cannot decode the cursor: %v\n%s", err, f.cursor)
		}
		offset := legacy.Files[f.path].Offset
		if offset > lineStart && offset < lineEnd {
			t.Fatalf("read %d, mid-drain: the persisted offset is %d, inside the oversized line [%d, %d); an old binary resumes there as at a line start. Want %d", reads, offset, lineStart, lineEnd, lineStart)
		}
		if offset == lineStart && emitted[2] == 0 {
			draining++
		}
	}
	if draining < 2 {
		t.Fatalf("fixture: the line was seen mid-drain after %d reads, want at least 2", draining)
	}
	if emitted[2] != 1 || len(emitted) != 1 {
		t.Fatalf("the request after the line once, nothing else: %v", emitted)
	}
	if again := f.read(t, "Stop", usageNow); len(again) != 0 {
		t.Fatalf("read again: %v", again)
	}
}
