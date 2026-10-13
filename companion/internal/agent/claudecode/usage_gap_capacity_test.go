// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package claudecode

import (
	"bytes"
	"encoding/json"
	"fmt"
	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"os"
	"testing"
	"time"
)

func TestUsageGapCapacityRollsBackEligiblePrefixAndFinalizes(t *testing.T) {
	f := newTranscript(t, requestLine(t, "prefix", 0, 400)+requestLine(t, "held", 1, 1))
	for output := 2; output <= 130; output++ {
		appendSparse(t, f.path, 33<<20, "\n"+requestLine(t, fmt.Sprintf("held_%d", output), 1, output))
	}
	early := time.Date(2026, 9, 25, 10, 59, 59, 0, time.UTC)
	read := func(event string, until time.Time) agent.UsageResult {
		t.Helper()
		r, err := New().ReadUsage(agent.UsageRead{Transcript: f.path, SessionID: usageSession, Event: event, Now: usageNow, Until: until}, f.cursor)
		if err != nil {
			t.Fatal(err)
		}
		f.cursor = r.Cursor
		return r
	}
	limited := false
	for range 24 {
		r := read("Stop", early)
		if len(r.Events) != 0 {
			t.Fatal("warmup emitted held main usage")
		}
		if r.CapacityLimitedFiles == 1 {
			limited = true
			break
		}
	}
	if !limited {
		t.Fatal("129 gaps never reported capacity")
	}
	var before usageCursor
	if err := json.Unmarshal(f.cursor, &before); err != nil {
		t.Fatal(err)
	}
	if len(before.Files[f.path].Skips) != 128 {
		t.Fatalf("test did not retain exactly128 prior runs: %d", len(before.Files[f.path].Skips))
	}
	healthy := f.subagent(t, "healthy.jsonl", encodeLines(t, assistant("msg_healthy", "req_healthy", "2026-09-25T10:59:59Z", tokens(3, 0, 0, 30000))), usageNow.Add(-time.Minute))
	r := read("Stop", time.Date(2026, 9, 25, 11, 0, 0, 0, time.UTC))
	if r.CapacityLimitedFiles != 1 {
		t.Fatalf("capacity outcome %d", r.CapacityLimitedFiles)
	}
	var after usageCursor
	if err := json.Unmarshal(r.Cursor, &after); err != nil {
		t.Fatal(err)
	}
	oldCursor, _ := json.Marshal(before.Files[f.path])
	newCursor, _ := json.Marshal(after.Files[f.path])
	if !bytes.Equal(oldCursor, newCursor) {
		t.Fatal("capacity advanced failing file")
	}
	if len(r.Events) != 1 {
		t.Fatalf("capacity leaked eligible prefix or discarded healthy result: %d", len(r.Events))
	}
	var evt map[string]any
	if err := json.Unmarshal(r.Events[0], &evt); err != nil {
		t.Fatal(err)
	}
	if number(usageOf(t, evt)["output_tokens"]) != 30000 {
		t.Fatal("eligible main prefix leaked from rolled-back file")
	}
	info, err := os.Stat(healthy)
	if err != nil {
		t.Fatal(err)
	}
	if after.Files[healthy].Offset != info.Size() {
		t.Fatal("healthy cursor not preserved")
	}
	counts := map[int]int{}
	for range 3 {
		r = read("SessionEnd", time.Time{})
		if r.CapacityLimitedFiles != 0 {
			t.Fatal("final read remains capacity limited despite held boundary ending")
		}
		for _, raw := range r.Events {
			var e map[string]any
			if err := json.Unmarshal(raw, &e); err != nil {
				t.Fatal(err)
			}
			counts[number(usageOf(t, e)["output_tokens"])]++
		}
	}
	if len(counts) != 131 || counts[400] != 1 {
		t.Fatalf("wrong final result: %v", counts)
	}
	for output := 1; output <= 130; output++ {
		if counts[output] != 1 {
			t.Fatalf("held output%d delivered%d times", output, counts[output])
		}
	}
}
