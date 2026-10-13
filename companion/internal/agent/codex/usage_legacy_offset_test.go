// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package codex

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

// legacyRolloutCursor is the usage cursor as a binary from before bounded
// draining (8c68ae1f) decodes it: it reads on from offset as from a line
// start. While a line is drained, offset stays at the oversized line's
// start, so a downgraded reader reads the line again and skips it whole.
type legacyRolloutCursor struct {
	Offset  int64           `json:"offset"`
	Thread  string          `json:"thread,omitempty"`
	Harness string          `json:"harness,omitempty"`
	Model   string          `json:"model,omitempty"`
	Desktop bool            `json:"desktop,omitempty"`
	Plan    bool            `json:"plan,omitempty"`
	Records bool            `json:"records,omitempty"`
	Counted json.RawMessage `json:"counted"`
	Pending json.RawMessage `json:"pending,omitempty"`
}

func TestRolloutUsage_AMidDrainCursorKeepsTheLegacyOffsetAtTheLineStart(t *testing.T) {
	withReadBudget(t, 256<<10)
	head := encodeRollout(t, sessionMeta("Codex Desktop"), usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(100, 0, 0, 1, 0)))
	lineStart := int64(len(head))
	lineEnd := lineStart + 5<<19 + int64(len(encodeRollout(t, usageRecord(4*time.Second, rolloutThread, "resp_leak", codexTokens(100, 0, 0, 777, 0)))))
	// Whitespace ending in a record of its own shape: read from inside the
	// line, its tail counts 777 output tokens. It outlasts two reads.
	f := newRollout(t, head+strings.Repeat(" ", 5<<19)+
		encodeRollout(t, usageRecord(4*time.Second, rolloutThread, "resp_leak", codexTokens(100, 0, 0, 777, 0)))+
		encodeRollout(t, usageRecord(5*time.Second, rolloutThread, "resp_02", codexTokens(100, 0, 0, 2, 0))))
	var emitted []int
	draining := 0
	for reads := 1; ; reads++ {
		if reads > 64 {
			t.Fatalf("no forward progress: still deferred after 64 reads, emitted %v", emitted)
		}
		emitted = append(emitted, outputs(f.read(t))...)
		if f.last.DeferredFiles == 0 {
			break
		}
		var legacy legacyRolloutCursor
		if err := json.Unmarshal(f.cursor, &legacy); err != nil {
			t.Fatalf("the old binary cannot decode the cursor: %v\n%s", err, f.cursor)
		}
		if legacy.Offset > lineStart && legacy.Offset < lineEnd {
			t.Fatalf("read %d, mid-drain: the persisted offset is %d, inside the oversized line [%d, %d); an old binary resumes there as at a line start. Want %d", reads, legacy.Offset, lineStart, lineEnd, lineStart)
		}
		if legacy.Offset == lineStart && fmt.Sprint(emitted) == "[1]" {
			draining++
		}
		if line, complete := legacyRolloutReadAt(t, f.path, legacy.Offset); complete && bytes.Contains(line, []byte("resp_leak")) {
			t.Fatalf("read %d: an old reader resuming from the cursor counts the oversized line's tail: %q", reads, line)
		}
	}
	if draining < 2 {
		t.Fatalf("fixture: the line was seen mid-drain after %d reads, want at least 2", draining)
	}
	if fmt.Sprint(emitted) != "[1 2]" {
		t.Fatalf("each record once, the tail never: %v", emitted)
	}
}

// legacyRolloutReadAt is the line the old reader's scan read at offset.
func legacyRolloutReadAt(t *testing.T, path string, offset int64) ([]byte, bool) {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.Seek(offset, 0); err != nil {
		t.Fatal(err)
	}
	content, _, complete := agent.NextLine(bufio.NewReaderSize(file, 64<<10), maxRolloutLineBytes)
	return content, complete && content != nil
}
