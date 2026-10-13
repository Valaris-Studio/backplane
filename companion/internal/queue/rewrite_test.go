// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package queue

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

// A server that refuses rich members gets the same records events-only: a
// replacement keeps its place, a record with nothing else left is deleted,
// and the others are untouched.
func TestRewriteReplacesDeletesAndKeepsInOrder(t *testing.T) {
	q, _ := openQueue(t)
	clock := time.Unix(1000, 0)
	q.WithClock(func() time.Time { clock = clock.Add(time.Second); return clock })
	enqueue(t, q, 1)
	enqueue(t, q, 2)
	enqueue(t, q, 3)
	replacement := []byte(`{"capture_id":"` + id(20) + `","events":[{"n":1}]}`)
	err := q.Rewrite(func(captureID string, record []byte) (string, []byte, bool) {
		switch captureID {
		case id(1):
			return id(20), replacement, true
		case id(2):
			return "", nil, false
		}
		return captureID, record, true
	})
	if err != nil {
		t.Fatal(err)
	}
	batch, err := q.Next(32, 8<<20)
	if err != nil || len(batch.IDs) != 2 || batch.IDs[0] != id(20) || batch.IDs[1] != id(3) {
		t.Fatalf("queue after rewrite: %v %v", batch.IDs, err)
	}
	if string(batch.Records[0]) != string(replacement) {
		t.Fatalf("replacement bytes %s", batch.Records[0])
	}
	if known, _ := q.Has(id(1)); known {
		t.Fatal("the replaced record is still queued")
	}
}

// A crash after the replacement was written but before the original was
// removed leaves both; rewriting again converges on the replacement alone.
func TestRewriteIsSafeToRepeatAfterACrash(t *testing.T) {
	q, layout := openQueue(t)
	enqueue(t, q, 1)
	replacement := []byte(`{"capture_id":"` + id(20) + `","events":[]}`)
	rewrite := func(captureID string, record []byte) (string, []byte, bool) {
		if captureID == id(1) {
			return id(20), replacement, true
		}
		return captureID, record, true
	}
	entries, _ := os.ReadDir(layout.QueueDir())
	original := entries[0].Name()
	if err := os.WriteFile(layout.QueueDir()+"/"+strings.Replace(original, id(1), id(20), 1), replacement, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := q.Rewrite(rewrite); err != nil {
		t.Fatal(err)
	}
	queued, err := q.Queued()
	if err != nil || len(queued) != 1 || !queued[id(20)] {
		t.Fatalf("queued after the repeat: %v %v", queued, err)
	}
}

func TestQueuedNamesWaitingRecordsOnly(t *testing.T) {
	q, _ := openQueue(t)
	enqueue(t, q, 1)
	enqueue(t, q, 2)
	batch, _ := q.Next(1, 8<<20)
	if _, err := q.Settle(batch, ackAll(batch)); err != nil {
		t.Fatal(err)
	}
	queued, err := q.Queued()
	if err != nil || len(queued) != 1 || !queued[id(2)] {
		t.Fatalf("queued = %v %v", queued, err)
	}
}

func ackAll(batch Batch) uplink.Ack { return uplink.Ack{Acknowledged: batch.IDs} }

// A replacement already queued under its id, under any name, is not queued
// twice: the original is only removed.
func TestRewriteNeverQueuesAnIDTwice(t *testing.T) {
	q, _ := openQueue(t)
	clock := time.Unix(1000, 0)
	q.WithClock(func() time.Time { clock = clock.Add(time.Second); return clock })
	enqueue(t, q, 1)
	enqueue(t, q, 20)
	if err := q.Rewrite(func(captureID string, record []byte) (string, []byte, bool) {
		if captureID == id(1) {
			return id(20), record, true
		}
		return captureID, record, true
	}); err != nil {
		t.Fatal(err)
	}
	if stats, _ := q.Stats(); stats.Records != 1 {
		t.Fatalf("%d records queued, want the one replacement", stats.Records)
	}
}

// Records reads every queued record, isolation or not.
func TestRecordsSeesEveryRecordWhileIsolating(t *testing.T) {
	q, _ := openQueue(t)
	clock := time.Unix(1000, 0)
	q.WithClock(func() time.Time { clock = clock.Add(time.Second); return clock })
	enqueue(t, q, 1)
	enqueue(t, q, 2)
	batch, _ := q.Next(32, 8<<20)
	if err := q.RecordUnprocessable(batch); err != nil {
		t.Fatal(err)
	}
	if isolated, _ := q.Next(32, 8<<20); len(isolated.IDs) != 1 {
		t.Fatalf("setup: not isolating (%d)", len(isolated.IDs))
	}
	seen := 0
	if err := q.Records(func(captureID string, record []byte) { seen++ }); err != nil || seen != 2 {
		t.Fatalf("saw %d records: %v", seen, err)
	}
}

// A record that cannot be read is an error, not an absence: a caller
// deciding what is declared must not take its contents for orphans.
func TestRecordsReportsARecordItCannotRead(t *testing.T) {
	q, layout := openQueue(t)
	enqueue(t, q, 1)
	entries, _ := os.ReadDir(layout.QueueDir())
	makeUnreadable(t, filepath.Join(layout.QueueDir(), entries[0].Name()))
	if err := q.Records(func(string, []byte) {}); err == nil {
		t.Fatal("an unreadable record was skipped silently")
	}
}
