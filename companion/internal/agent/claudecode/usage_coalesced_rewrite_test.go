// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package claudecode

import (
	"fmt"
	"os"
	"testing"
	"time"
)

// Usage that is still held can change before it is emitted. Remembering
// the oversized gaps around it must not make the request itself opaque.
func TestUsageRevisitsAHeldRequestBetweenRememberedGaps(t *testing.T) {
	request := func(output int) string {
		return requestLine(t, fmt.Sprintf("request_%d", output), 1, output)
	}
	f := newTranscript(t, request(201))
	var changedAt int64
	for output := 202; output <= 266; output++ {
		line := request(output)
		end := appendSparse(t, f.path, 33<<20, "\n"+line)
		if output == 202 {
			changedAt = end - int64(len(line))
		}
	}
	early := time.Date(2026, 9, 25, 11, 0, 0, 0, time.UTC)
	for range 12 {
		if events := f.readUntil(t, "Stop", usageNow, early); len(events) != 0 {
			t.Fatalf("setup emitted usage before its boundary: %v", events)
		}
	}
	replacement := requestLine(t, "request_202", 1, 702)
	if len(replacement) != len(request(202)) {
		t.Fatal("replacement must preserve every later byte's position")
	}
	file, err := os.OpenFile(f.path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteAt([]byte(replacement), changedAt); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	emitted := map[int]int{}
	for range 3 {
		for _, event := range f.readUntil(t, "Stop", usageNow, time.Time{}) {
			emitted[number(usageOf(t, event)["output_tokens"])]++
		}
	}
	if emitted[702] != 1 || emitted[202] != 0 {
		t.Fatalf("held usage was emitted from stale remembered metadata: revised count702=%d, old count202=%d", emitted[702], emitted[202])
	}
	for output := 201; output <= 266; output++ {
		if output != 202 && emitted[output] != 1 {
			t.Fatalf("neighbor request %d lost or repeated: %v", output, emitted)
		}
	}
}
