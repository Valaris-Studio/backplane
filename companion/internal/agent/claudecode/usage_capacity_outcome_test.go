// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package claudecode

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

// An oversized held set is an explicit per-file limitation. It must not
// silently discard progress, accept incomplete usage, or discard results
// from healthy transcripts sharing the read.
func TestUsageReportsHeldCapacityWithoutDiscardingHealthyResults(t *testing.T) {
	f := newTranscript(t, requestLine(t, "held", 1, 1))
	var between strings.Builder
	for index := range 1025 {
		between.WriteString(requestLine(t, fmt.Sprintf("inside_%d", index), 1, 1000+index))
	}
	for output := 2; output <= 66; output++ {
		tail := "\n" + requestLine(t, "held", 1, output)
		if output == 2 {
			tail += between.String()
		}
		appendSparse(t, f.path, 33<<20, tail)
	}
	early := time.Date(2026, 9, 25, 11, 0, 0, 0, time.UTC)
	for boundary := range 12 {
		// A fresh, eligible sibling proves the capacity report is partial,
		// not a generic error that discards the whole read's valid results.
		healthyOutput := 30000 + boundary
		healthy := f.subagent(t, fmt.Sprintf("healthy-%02d.jsonl", boundary), encodeLines(t,
			assistant(fmt.Sprintf("msg_healthy_%d", boundary), fmt.Sprintf("req_healthy_%d", boundary),
				"2026-09-25T10:59:59Z", tokens(3, 0, 0, healthyOutput))), usageNow.Add(-time.Minute))
		previous := append(json.RawMessage(nil), f.cursor...)
		result, err := New().ReadUsage(agent.UsageRead{
			Transcript: f.path, SessionID: usageSession, Event: "Stop", Now: usageNow, Until: early,
		}, previous)
		if err != nil {
			t.Fatalf("capacity must preserve partial results through an explicit per-file outcome, not a whole-read error: %v", err)
		}
		encoded, err := json.Marshal(result)
		if err != nil {
			t.Fatal(err)
		}
		// JSON keeps this regression behavioral on the pre-field revision.
		var outcome struct{ CapacityLimitedFiles int }
		if err := json.Unmarshal(encoded, &outcome); err != nil {
			t.Fatal(err)
		}
		f.cursor = result.Cursor
		if outcome.CapacityLimitedFiles == 0 {
			continue
		}
		if outcome.CapacityLimitedFiles != 1 {
			t.Fatalf("one source exceeded held capacity, got %d", outcome.CapacityLimitedFiles)
		}
		var before, after usageCursor
		if len(previous) > 0 {
			if err := json.Unmarshal(previous, &before); err != nil {
				t.Fatal(err)
			}
		}
		if err := json.Unmarshal(result.Cursor, &after); err != nil {
			t.Fatal(err)
		}
		oldFile, _ := json.Marshal(before.Files[f.path])
		newFile, _ := json.Marshal(after.Files[f.path])
		if !bytes.Equal(oldFile, newFile) {
			t.Fatal("the capacity-limited file's cursor advanced past unreported held usage")
		}
		foundHealthy := false
		for _, raw := range result.Events {
			var event map[string]any
			if err := json.Unmarshal(raw, &event); err != nil {
				t.Fatal(err)
			}
			output := number(usageOf(t, event)["output_tokens"])
			if output < 30000 {
				t.Fatalf("capacity released unready main-transcript usage: %d", output)
			}
			foundHealthy = foundHealthy || output == healthyOutput
		}
		if !foundHealthy {
			t.Fatal("the fresh healthy sibling's usage was discarded with the capacity-limited source")
		}
		info, err := os.Stat(healthy)
		if err != nil {
			t.Fatal(err)
		}
		if after.Files[healthy].Offset != info.Size() {
			t.Fatal("the healthy sibling's successfully read cursor was not preserved")
		}
		return
	}
	t.Fatal("held-state capacity overflow remained a silent success for twelve bounded reads; expected CapacityLimitedFiles")
}
