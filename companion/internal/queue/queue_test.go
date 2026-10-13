// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package queue

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

func openQueue(t *testing.T) (*Queue, store.Layout) {
	t.Helper()
	layout, err := store.Open(filepath.Join(t.TempDir(), "data"))
	if err != nil {
		t.Fatal(err)
	}
	return Open(layout), layout
}

func id(n int) string { return fmt.Sprintf("%032x", n) }

func enqueue(t *testing.T, q *Queue, n int) []byte {
	t.Helper()
	record := []byte(fmt.Sprintf(`{"capture_id":%q,"events":[{"n":9007199254740993}]}`, id(n)))
	if err := q.Enqueue(id(n), record); err != nil {
		t.Fatal(err)
	}
	return record
}

func pending(t *testing.T, q *Queue) int {
	t.Helper()
	stats, err := q.Stats()
	if err != nil {
		t.Fatal(err)
	}
	return stats.Records
}

func TestFullAckDeletesRecordsAfterPersistingAck(t *testing.T) {
	q, layout := openQueue(t)
	first := enqueue(t, q, 1)
	enqueue(t, q, 2)
	batch, err := q.Next(32, 8<<20)
	if err != nil || len(batch.IDs) != 2 || batch.IDs[0] != id(1) {
		t.Fatalf("batch not ordered by enqueue: %+v %v", batch.IDs, err)
	}
	if string(batch.Records[0]) != string(first) {
		t.Fatal("record bytes or numeric precision changed")
	}
	if _, err := q.Settle(batch, uplink.Ack{Acknowledged: batch.IDs}); err != nil {
		t.Fatal(err)
	}
	if pending(t, q) != 0 {
		t.Fatal("acknowledged records not deleted")
	}
	var state ledger
	if err := store.ReadJSON(layout.Ledger(), maxLedgerBytes, &state); err != nil || len(state.Settled) != 0 {
		t.Fatalf("persisted acks not cleared after reclaim: %+v %v", state.Settled, err)
	}
}

func TestPartialAckKeepsUnmentionedRecordsPending(t *testing.T) {
	q, _ := openQueue(t)
	for n := 1; n <= 3; n++ {
		enqueue(t, q, n)
	}
	batch, _ := q.Next(32, 8<<20)
	result, err := q.Settle(batch, uplink.Ack{Acknowledged: []string{id(1)}, Rejected: []uplink.Rejection{{CaptureID: id(3), Reason: "schema_invalid"}}})
	if err != nil || result.Acknowledged != 1 || result.Rejected != 1 {
		t.Fatalf("settle: %+v %v", result, err)
	}
	next, _ := q.Next(32, 8<<20)
	if len(next.IDs) != 1 || next.IDs[0] != id(2) {
		t.Fatalf("unmentioned record not retained alone: %+v", next.IDs)
	}
	stats, _ := q.Stats()
	if stats.Rejected != 1 || stats.RejectReasons["schema_invalid"] != 1 || stats.Acknowledged != 1 {
		t.Fatalf("rejection not counted: %+v", stats)
	}
}

func TestMalformedAckDeletesNothing(t *testing.T) {
	for name, ack := range map[string]uplink.Ack{
		"unknown id":           {Acknowledged: []string{id(99)}},
		"duplicate ack":        {Acknowledged: []string{id(1), id(1)}},
		"acked and rejected":   {Acknowledged: []string{id(1)}, Rejected: []uplink.Rejection{{CaptureID: id(1)}}},
		"unknown rejection id": {Rejected: []uplink.Rejection{{CaptureID: id(42)}}},
	} {
		t.Run(name, func(t *testing.T) {
			q, _ := openQueue(t)
			enqueue(t, q, 1)
			enqueue(t, q, 2)
			batch, _ := q.Next(32, 8<<20)
			if _, err := q.Settle(batch, ack); !errors.Is(err, ErrMalformedAck) {
				t.Fatalf("accepted malformed ack: %v", err)
			}
			if pending(t, q) != 2 {
				t.Fatal("malformed ack consumed records")
			}
		})
	}
}

func TestRestartReclaimsPersistedAckBeforeResending(t *testing.T) {
	q, layout := openQueue(t)
	enqueue(t, q, 1)
	enqueue(t, q, 2)
	// Simulate a crash after the ack was persisted but before any unlink.
	if err := store.WriteJSON(layout.Ledger(), ledger{Version: ledgerVersion, Settled: map[string]string{id(1): settledAcknowledged}}); err != nil {
		t.Fatal(err)
	}
	restarted := Open(layout)
	batch, err := restarted.Next(32, 8<<20)
	if err != nil || len(batch.IDs) != 1 || batch.IDs[0] != id(2) {
		t.Fatalf("persisted ack not reclaimed on restart: %+v %v", batch.IDs, err)
	}
	if pending(t, restarted) != 1 {
		t.Fatal("acknowledged record survived restart")
	}
}

func TestCapacityNeverEvictsUnackedRecords(t *testing.T) {
	q, _ := openQueue(t)
	q.maxRecords = 2
	enqueue(t, q, 1)
	enqueue(t, q, 2)
	if err := q.Enqueue(id(3), []byte(`{}`)); !errors.Is(err, ErrCapacity) {
		t.Fatalf("record bound ignored: %v", err)
	}
	q.maxRecords = 100
	q.maxBytes = 200
	if err := q.Enqueue(id(4), make([]byte, 150)); !errors.Is(err, ErrCapacity) {
		t.Fatalf("byte bound ignored: %v", err)
	}
	if pending(t, q) != 2 {
		t.Fatal("capacity pressure evicted retained records")
	}
	if err := q.Enqueue("not-a-capture-id", []byte(`{}`)); !errors.Is(err, ErrInvalidRecord) {
		t.Fatal("invalid capture id accepted")
	}
}

func TestBatchRespectsCountAndByteBounds(t *testing.T) {
	q, _ := openQueue(t)
	for n := 1; n <= 5; n++ {
		enqueue(t, q, n)
	}
	batch, _ := q.Next(2, 8<<20)
	if len(batch.IDs) != 2 {
		t.Fatalf("count bound ignored: %d", len(batch.IDs))
	}
	record := enqueue(t, q, 6)
	batch, _ = q.Next(32, len(record)*2+1)
	if len(batch.IDs) != 2 || batch.Bytes > len(record)*2+1 {
		t.Fatalf("byte bound ignored: %d records %d bytes", len(batch.IDs), batch.Bytes)
	}
}

func TestBackoffIsPersistedAndBoundedAgainstClockRollback(t *testing.T) {
	q, layout := openQueue(t)
	now := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	q.now = func() time.Time { return now }
	for attempt := 0; attempt < 20; attempt++ {
		if err := q.RecordFailure("unavailable"); err != nil {
			t.Fatal(err)
		}
	}
	if ready, _ := q.Ready(); ready {
		t.Fatal("failure did not back off")
	}
	restarted := Open(layout)
	restarted.now = q.now
	stats, _ := restarted.Stats()
	if stats.Failures == 0 || stats.LastError != "unavailable" || stats.NextAttempt.Sub(now) > maxBackoff {
		t.Fatalf("backoff not persisted or not capped: %+v", stats)
	}
	now = now.Add(-24 * time.Hour)
	if ready, _ := restarted.Ready(); !ready {
		t.Fatal("clock rollback turned bounded backoff into a long pause")
	}
	if err := restarted.RecordSuccess(); err != nil {
		t.Fatal(err)
	}
	if stats, _ := restarted.Stats(); stats.Failures != 0 || stats.LastError != "" {
		t.Fatalf("success did not reset backoff: %+v", stats)
	}
}

func TestUnprocessableBatchIsIsolatedThenSingletonRejected(t *testing.T) {
	q, _ := openQueue(t)
	for n := 1; n <= 3; n++ {
		enqueue(t, q, n)
	}
	batch, _ := q.Next(32, 8<<20)
	if err := q.RecordUnprocessable(batch); err != nil {
		t.Fatal(err)
	}
	if pending(t, q) != 3 {
		t.Fatal("unattributed batch rejection deleted records")
	}
	single, _ := q.Next(32, 8<<20)
	if len(single.IDs) != 1 {
		t.Fatalf("batch not isolated after 422: %d", len(single.IDs))
	}
	if err := q.RecordUnprocessable(single); err != nil {
		t.Fatal(err)
	}
	if pending(t, q) != 2 {
		t.Fatal("singleton 422 must reject that record")
	}
	stats, _ := q.Stats()
	if stats.RejectReasons["unprocessable"] != 1 {
		t.Fatalf("singleton rejection not counted: %+v", stats)
	}
	next, _ := q.Next(32, 8<<20)
	if _, err := q.Settle(next, uplink.Ack{Acknowledged: next.IDs}); err != nil {
		t.Fatal(err)
	}
	if pending(t, q) != 1 {
		t.Fatal("isolated neighbors did not drain")
	}
}

func TestStrayFilesAreIgnoredAndCounted(t *testing.T) {
	q, layout := openQueue(t)
	enqueue(t, q, 1)
	os.WriteFile(filepath.Join(layout.QueueDir(), "garbage.json"), []byte("x"), 0o600)
	batch, err := q.Next(32, 8<<20)
	if err != nil || len(batch.IDs) != 1 {
		t.Fatalf("stray file broke batching: %v", err)
	}
	var decoded map[string]any
	if json.Unmarshal(batch.Records[0], &decoded) != nil {
		t.Fatal("batch record not JSON")
	}
}

func TestZeroProgressAckIsAFailureThatBacksOff(t *testing.T) {
	q, _ := openQueue(t)
	now := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	q.now = func() time.Time { return now }
	enqueue(t, q, 1)
	if err := q.RecordFailure("unavailable"); err != nil {
		t.Fatal(err)
	}
	now = now.Add(time.Hour)
	batch, _ := q.Next(32, 8<<20)
	if _, err := q.Settle(batch, uplink.Ack{}); !errors.Is(err, ErrNoProgress) {
		t.Fatalf("empty ack accepted: %v", err)
	}
	stats, _ := q.Stats()
	if stats.Records != 1 || stats.Failures != 1 {
		t.Fatalf("empty ack reset the backoff or consumed records: %+v", stats)
	}
}

func TestHasSeesPendingAndRecentlySettledRecords(t *testing.T) {
	q, layout := openQueue(t)
	enqueue(t, q, 1)
	enqueue(t, q, 2)
	for _, n := range []int{1, 2} {
		if has, err := q.Has(id(n)); err != nil || !has {
			t.Fatalf("pending %d not found: %v", n, err)
		}
	}
	batch, _ := q.Next(32, 8<<20)
	if _, err := q.Settle(batch, uplink.Ack{Acknowledged: []string{id(1)}, Rejected: []uplink.Rejection{{CaptureID: id(2), Reason: "x"}}}); err != nil {
		t.Fatal(err)
	}
	restarted := Open(layout)
	for _, n := range []int{1, 2} {
		if has, _ := restarted.Has(id(n)); !has {
			t.Fatalf("settled %d forgotten, so a replayed inbox item would upload twice", n)
		}
	}
	if has, _ := restarted.Has(id(3)); has {
		t.Fatal("unknown id reported present")
	}
	restarted.maxRecent = 1
	enqueue(t, restarted, 4)
	batch, _ = restarted.Next(32, 8<<20)
	restarted.Settle(batch, uplink.Ack{Acknowledged: batch.IDs})
	if stats, _ := restarted.Stats(); stats.Records != 0 {
		t.Fatal("record not settled")
	}
	if has, _ := restarted.Has(id(1)); has {
		t.Fatal("recently-settled memory is not bounded")
	}
}

func TestEveryContractRejectReasonIsCounted(t *testing.T) {
	q, _ := openQueue(t)
	reasons := []string{"invalid", "too_large", "conflict", "mapping_unavailable", "mapping_disabled", "paused", "agent_disabled", "excluded"}
	for n := range reasons {
		enqueue(t, q, n+1)
	}
	batch, _ := q.Next(32, 8<<20)
	var rejections []uplink.Rejection
	for index, reason := range reasons {
		rejections = append(rejections, uplink.Rejection{CaptureID: batch.IDs[index], Reason: reason})
	}
	if _, err := q.Settle(batch, uplink.Ack{Rejected: rejections}); err != nil {
		t.Fatal(err)
	}
	stats, _ := q.Stats()
	for _, reason := range reasons {
		if stats.RejectReasons[reason] != 1 {
			t.Errorf("%s not counted: %v", reason, stats.RejectReasons)
		}
	}
	if stats.Records != 0 {
		t.Fatal("rejected records kept")
	}
}

func TestDroppedRecordsAreDeliveredAndCountedPerReason(t *testing.T) {
	q, _ := openQueue(t)
	for n := 1; n <= 3; n++ {
		enqueue(t, q, n)
	}
	batch, _ := q.Next(10, 1<<20)
	ack := uplink.Ack{Acknowledged: batch.IDs, Dropped: []uplink.Drop{{CaptureID: id(1), Reason: "session_deleted"}, {CaptureID: id(2), Reason: "session_deleted"}, {CaptureID: id(9), Reason: "session_deleted"}}}
	if _, err := q.Settle(batch, ack); err != nil {
		t.Fatal(err)
	}
	stats, _ := q.Stats()
	if pending(t, q) != 0 || stats.Dropped != 2 || stats.DropReasons["session_deleted"] != 2 || stats.Acknowledged != 3 {
		t.Fatalf("dropped records not settled and counted: %+v", stats)
	}
}

func TestStatsReportTheOldestPendingRecord(t *testing.T) {
	q, _ := openQueue(t)
	if stats, _ := q.Stats(); stats.OldestPendingAt != nil {
		t.Fatalf("empty queue has an oldest record: %v", stats.OldestPendingAt)
	}
	enqueue(t, q, 1)
	enqueue(t, q, 2)
	stats, _ := q.Stats()
	if stats.OldestPendingAt == nil || stats.OldestPendingAt.After(time.Now()) || time.Since(*stats.OldestPendingAt) > time.Minute {
		t.Fatalf("oldest pending: %v", stats.OldestPendingAt)
	}
}
