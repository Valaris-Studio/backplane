// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package claudecode

import (
	"bytes"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

// A single request can span many content blocks, each repeating its usage.
// Oversized gaps must not make the last, most complete copy unreachable
// after a boundary stops holding that request.
func TestUsageARequestAcrossManyOversizedGapsEventuallyCompletes(t *testing.T) {
	for _, distinct := range []bool{false, true} {
		name := "one request across content blocks"
		if distinct {
			name = "distinct requests control"
		}
		t.Run(name, func(t *testing.T) {
			request := func(output int) string {
				id := "held"
				if distinct {
					id = fmt.Sprintf("request_%d", output)
				}
				return requestLine(t, id, 1, output)
			}
			f := newTranscript(t, request(1))
			for output := 2; output <= 65; output++ {
				appendSparse(t, f.path, 33<<20, "\n"+request(output))
			}
			appendSparse(t, f.path, 640<<20, "\n"+request(66)+requestLine(t, "after", 2, 100))
			emitted := map[int]int{}
			read := func(until time.Time) {
				t.Helper()
				for _, usage := range f.readUntil(t, "Stop", usageNow, until) {
					emitted[number(usageOf(t, usage)["output_tokens"])]++
				}
			}
			early := time.Date(2026, 9, 25, 11, 0, 0, 0, time.UTC)
			for range 12 {
				read(early)
			}
			if len(emitted) != 0 {
				t.Fatalf("a request was emitted before the hook boundary allowed it: %v", emitted)
			}
			unchanged := 0
			for range 6 {
				previous := append([]byte(nil), f.cursor...)
				read(time.Time{})
				if bytes.Equal(previous, f.cursor) {
					unchanged++
				}
			}
			if emitted[66] != 1 || emitted[100] != 1 {
				t.Fatalf("no forward progress after the hold ended: final request and following request must each arrive once; emitted %v, unchanged cursors %d/6", emitted, unchanged)
			}
			if distinct {
				for output := 1; output <= 66; output++ {
					if emitted[output] != 1 {
						t.Fatalf("request %d was lost or repeated: %v", output, emitted)
					}
				}
			} else if len(emitted) != 2 {
				t.Fatalf("a partial copy of the held request was emitted: %v", emitted)
			}
			read(time.Time{})
			if emitted[66] != 1 || emitted[100] != 1 {
				t.Fatalf("completed usage repeated: %v", emitted)
			}
		})
	}
}

// The remaining allowance is shared with the session's other transcripts.
// Revisiting cached gaps still reads their validation windows, so a small
// allowance cannot reach requests beyond arbitrarily many cached gaps.
func TestUsageChargesGapValidationToTheSharedReadBudget(t *testing.T) {
	f := newTranscript(t, requestLine(t, "held", 1, 1))
	for output := 2; output <= 9; output++ {
		appendSparse(t, f.path, 33<<20, "\n"+requestLine(t, "held", 1, output))
	}
	f.appendText(t, requestLine(t, "after", 2, 100))
	early := time.Date(2026, 9, 25, 11, 0, 0, 0, time.UTC)
	for range 3 {
		if events := f.readUntil(t, "Stop", usageNow, early); len(events) != 0 {
			t.Fatalf("setup emitted held usage: %v", events)
		}
	}
	var persisted usageCursor
	if err := json.Unmarshal(f.cursor, &persisted); err != nil {
		t.Fatal(err)
	}
	reader := usageReader{
		read:  agent.UsageRead{SessionID: usageSession, Event: "SessionEnd", Now: usageNow},
		final: true, budget: 32 << 10,
		byKey: map[string]*usageEntry{}, parents: map[string]bool{},
	}
	reader.readFile(f.path, false, persisted.Files[f.path])
	for _, entry := range reader.entries {
		if entry.tokens.OutputTokens == 100 {
			t.Fatalf("read crossed eight cached oversized gaps with only 32KiB left: validating their windows alone reads 64KiB; remaining budget %d", reader.budget)
		}
	}
}
