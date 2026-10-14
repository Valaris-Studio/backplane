// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/contracttest"
	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

// richRecords are the queued records that declare content.
func richRecords(t *testing.T, f *fixture) []uplink.Record {
	t.Helper()
	var records []uplink.Record
	for _, record := range readQueue(t, f) {
		if record.Contents != nil {
			records = append(records, record)
		}
	}
	return records
}

// Record caps split records; they never cut a body. Every queued record is
// one the server accepts.
func checkRecords(t *testing.T, records []uplink.Record) (declared int) {
	t.Helper()
	for _, record := range records {
		if err := record.ValidateRich(); err != nil {
			t.Fatalf("queued an invalid record: %v", err)
		}
		encoded, _ := json.Marshal(record)
		var inline int64
		for _, content := range record.Contents {
			if content.InlineText != nil {
				inline += int64(len(*content.InlineText))
			}
			if content.Coverage == "truncated" {
				t.Fatalf("a record cap truncated %s", content.ContentKey)
			}
		}
		if len(record.Contents) > 256 || inline > 1<<20 || len(encoded) > queue.MaxRecordBytes {
			t.Fatalf("record over its caps: %d contents, %d inline bytes, %d bytes", len(record.Contents), inline, len(encoded))
		}
		declared += len(record.Contents)
	}
	return declared
}

func manyItems(count, size int) []contracttest.Item {
	items := make([]contracttest.Item, count)
	for index := range items {
		items[index] = contracttest.TextItem(fmt.Sprintf("text:%d", index), "assistant", "reply", "text/plain", strings.Repeat("x", size))
	}
	return items
}

func TestMoreThan256DeclarationsSplitIntoRecords(t *testing.T) {
	f := newRichFixture(t)
	f.holdUploads(t, true)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, contracttest.Line{ID: "many", At: f.stamp(), Items: manyItems(300, 10)})
	*f.clock = f.clock.Add(time.Second)
	f.tick(t)
	records := richRecords(t, f)
	if declared := checkRecords(t, records); declared != 300 || len(records) < 2 {
		t.Fatalf("%d declarations in %d records", declared, len(records))
	}
}

func TestInlineBodiesOverAMebibyteSplitIntoRecords(t *testing.T) {
	f := newRichFixture(t)
	f.holdUploads(t, true)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, contracttest.Line{ID: "inline", At: f.stamp(), Items: manyItems(80, 15<<10)})
	*f.clock = f.clock.Add(time.Second)
	f.tick(t)
	records := richRecords(t, f)
	if declared := checkRecords(t, records); declared != 80 || len(records) < 2 {
		t.Fatalf("%d declarations in %d records", declared, len(records))
	}
	for _, record := range records {
		for _, content := range record.Contents {
			if content.Delivery != uplink.DeliveryInline || *content.ByteCount != 15<<10 {
				t.Fatalf("an inline body was moved or cut: %s %d", content.Delivery, *content.ByteCount)
			}
		}
	}
}

// A pass reads at most 16 MiB of session files; the rest waits, uncut.
func TestAPassReadsAtMostSixteenMebibytes(t *testing.T) {
	f := newRichFixture(t)
	f.server.Lock()
	f.server.ChunkBytes = 4 << 20
	f.server.Unlock()
	f.richHook(t, session, f.repo)
	for index := range 6 {
		f.appendLines(t, session, replyLine(fmt.Sprintf("big%d", index), f.stamp(), strings.Repeat("b", 4<<20)))
	}
	*f.clock = f.clock.Add(time.Second)
	f.tick(t)
	cursor := f.cursorOf(t, session)
	if cursor.Offset <= 0 || cursor.Offset > 17<<20 {
		t.Fatalf("first pass read to %d", cursor.Offset)
	}
	for range 5 {
		*f.clock = f.clock.Add(time.Second)
		f.tick(t)
	}
	for _, declaration := range f.server.Declarations() {
		if declaration["byte_count"] != float64(4<<20) {
			t.Fatalf("a body was cut: %v", declaration["byte_count"])
		}
	}
	if len(f.server.Declarations()) != 6 {
		t.Fatalf("declared %d of 6", len(f.server.Declarations()))
	}
}

// One line over the pass budget is read alone, in a pass of its own.
func TestALineOverThePassBudgetIsReadAlone(t *testing.T) {
	f := newRichFixture(t)
	f.server.Lock()
	f.server.ChunkBytes = 4 << 20
	f.server.Unlock()
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, replyLine("huge", f.stamp(), strings.Repeat("h", 20<<20)))
	alone := fileSize(t, f.sessionFile(session))
	f.appendLines(t, session, textLine("next", f.stamp(), "after it"))
	*f.clock = f.clock.Add(time.Second)
	f.tick(t)
	if cursor := f.cursorOf(t, session); cursor.Offset != alone {
		t.Fatalf("cursor at %d, want %d", cursor.Offset, alone)
	}
}

// A line over 32 MiB cannot be parsed; it is declared as such.
func TestALineOverThirtyTwoMebibytesIsRecordTooLarge(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, replyLine("enormous", f.stamp(), strings.Repeat("e", 33<<20)), textLine("next", f.stamp(), "after it"))
	f.tickUntilSettled(t)
	var tooLarge int
	for _, declaration := range f.server.Declarations() {
		if declaration["coverage_reason"] == "record_too_large" {
			tooLarge++
		}
	}
	if tooLarge != 1 || f.server.Body(itemKey("next")) == nil || richHealth(t, f).RecordTooLarge != 1 {
		t.Fatalf("record_too_large %d, health %+v", tooLarge, richHealth(t, f))
	}
}

func TestAPassReadsAtMostSixtyFourSessions(t *testing.T) {
	f := newRichFixture(t)
	for index := range 70 {
		id := fmt.Sprintf("s%02d", index)
		f.richHook(t, id, f.repo)
		f.appendLines(t, id, textLine("only", f.stamp(), "hello"))
	}
	*f.clock = f.clock.Add(time.Second)
	f.tick(t)
	if declared := len(f.server.Declarations()); declared != 64 {
		t.Fatalf("first pass declared %d sessions' items, want 64", declared)
	}
	f.tickUntilSettled(t)
	if declared := len(f.server.Declarations()); declared != 70 {
		t.Fatalf("declared %d of 70", declared)
	}
}

func TestAPassUploadsAtMostFourChunks(t *testing.T) {
	f := newRichFixture(t)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, replyLine("e1", f.stamp(), strings.Repeat("c", 48<<10)))
	*f.clock = f.clock.Add(time.Second)
	f.tick(t)
	if f.server.ChunkPuts != 4 {
		t.Fatalf("first pass put %d chunks, want 4", f.server.ChunkPuts)
	}
}
