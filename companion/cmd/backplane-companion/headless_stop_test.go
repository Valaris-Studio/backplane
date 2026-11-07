// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

func TestHeadlessStop_DrainsWhatIsQueuedBeforeExiting(t *testing.T) {
	hh := newHeadlessHarness(t)
	hh.server.Lock()
	hh.server.Status[headlessIngestPath] = 503
	hh.server.Unlock()
	run := hh.start(t)
	hh.waitForSessions(t, 1)
	id := headlessCaptureID(34)
	hh.enqueue(t, id)
	// The failed attempt backs the queue off for seconds, so only the stop
	// drain can deliver it now.
	waitForWithin(t, "the failed upload to back the queue off", 10*time.Second, func() bool {
		stats, _ := queue.Open(store.Layout{Root: hh.data}).Stats()
		return stats.Failures > 0
	}, nil)
	hh.server.Lock()
	delete(hh.server.Status, headlessIngestPath)
	hh.server.Unlock()
	stopping := len(hh.server.Requests())

	elapsed, err := run.stop()
	if err != nil {
		t.Fatalf("a graceful stop must exit cleanly: %v", err)
	}
	if elapsed > drainBound+time.Second {
		t.Fatalf("stop took %v, beyond the %v drain bound", elapsed, drainBound)
	}
	if !containsID(receivedCaptureIDs(hh.server), id) {
		t.Fatalf("the stop drain did not deliver the queued record; after the signal:\n%s", describeRequests(requestsAfter(hh.server, stopping)))
	}
	if got := queuedRecords(t, store.Layout{Root: hh.data}); got != 0 {
		t.Fatalf("%d acknowledged records left queued", got)
	}
}

func TestHeadlessStop_BoundsTheDrainReadsNoSourceAndKeepsWhatWasNotAcknowledged(t *testing.T) {
	hh := newHeadlessHarness(t)
	run := hh.start(t)
	hh.waitForSessions(t, 1)
	release := stall(t, hh.server, headlessIngestPath)
	id := headlessCaptureID(35)
	hh.enqueue(t, id)
	waitForRequests(t, hh.server, headlessIngestPath, 1)
	// The capture pass already ran; an item landing now is read only by a
	// later pass, which a stopping daemon must never start.
	hh.hookIn(t, hh.repo, "SessionStart")
	if names, _ := inbox.List(filepath.Join(hh.data, "inbox")); len(names) != 1 {
		t.Fatalf("the hook should have left one inbox item, found %d", len(names))
	}
	sources := digestEntries(t, hh.data, "inbox", "usage", "rich")
	queued := digestEntries(t, hh.data, "queue")

	elapsed, err := run.stop()
	if err != nil {
		t.Fatalf("a graceful stop must exit cleanly: %v", err)
	}
	if elapsed > drainBound+1500*time.Millisecond {
		t.Fatalf("stop took %v with a stalled server; the drain is bounded to %v", elapsed, drainBound)
	}
	assertSameDigest(t, "the capture sources after the signal", sources, digestEntries(t, hh.data, "inbox", "usage", "rich"))
	assertSameDigest(t, "the unacknowledged queue", queued, digestEntries(t, hh.data, "queue"))

	release()
	hh.start(t)
	waitForWithin(t, "the restarted daemon to deliver the kept record", 10*time.Second, func() bool {
		return containsID(receivedCaptureIDs(hh.server), id)
	}, func() string { return logText(hh.logPath) })
}

func TestHeadlessStop_NeverDrainsWithARejectedToken(t *testing.T) {
	hh := newHeadlessHarness(t)
	run := hh.start(t)
	hh.waitForSessions(t, 1)
	hh.server.RevokeDeviceToken(headlessSentinelToken())
	hh.enqueue(t, headlessCaptureID(36))
	hh.waitForLogReason(t, "credential_rejected", 10*time.Second)
	sent := len(hh.server.Requests())

	elapsed, err := run.stop()
	if err != nil {
		t.Fatalf("stop: %v", err)
	}
	if elapsed > 2*time.Second {
		t.Fatalf("a held daemon took %v to stop", elapsed)
	}
	if after := requestsAfter(hh.server, sent); len(after) != 0 {
		t.Fatalf("a rejected token was used to drain on stop:\n%s", describeRequests(after))
	}
	if got := queuedRecords(t, store.Layout{Root: hh.data}); got != 1 {
		t.Fatalf("the unacknowledged record must stay queued, %d left", got)
	}
}

func TestHeadlessRun_AFullQueueWhileHeldIsNeverEvictedAndDrainsInOrder(t *testing.T) {
	hh := newHeadlessHarness(t)
	hh.bindAndStop(t)
	ids := make([]string, queue.MaxRecords)
	for index := range ids {
		ids[index] = headlessCaptureID(1000 + index)
	}
	hh.enqueue(t, ids...)
	layout := store.Layout{Root: hh.data}
	if err := queue.Open(layout).Enqueue(headlessCaptureID(9999), headlessRecord(headlessCaptureID(9999))); !errors.Is(err, queue.ErrCapacity) {
		t.Fatalf("the queue should be full: %v", err)
	}
	before := connectionScopedDigest(t, hh.data)
	statsBefore, _ := queue.Open(layout).Stats()
	hh.server.Lock()
	hh.server.Status[headlessMePath] = 503
	hh.server.Unlock()

	hh.start(t)
	hh.waitForLogReason(t, "server_unavailable", 10*time.Second)
	waitForRequests(t, hh.server, headlessMePath, requestsTo(hh.server, headlessMePath)+3)
	assertSameDigest(t, "a full queue while held", before, connectionScopedDigest(t, hh.data))
	statsHeld, _ := queue.Open(layout).Stats()
	if statsHeld.Dropped != statsBefore.Dropped || statsHeld.Rejected != statsBefore.Rejected {
		t.Fatalf("holding counted drops or rejections: %+v, was %+v", statsHeld, statsBefore)
	}

	hh.server.Lock()
	delete(hh.server.Status, headlessMePath)
	hh.server.Unlock()
	waitForWithin(t, "the full queue to drain", 20*time.Second, func() bool {
		return len(receivedCaptureIDs(hh.server)) >= len(ids)
	}, func() string { return logText(hh.logPath) })
	received := receivedCaptureIDs(hh.server)
	for index, id := range ids {
		if received[index] != id {
			t.Fatalf("record %d delivered out of order: got %s, want %s", index, received[index], id)
		}
	}
	statsAfter, _ := queue.Open(layout).Stats()
	if statsAfter.Dropped != statsBefore.Dropped {
		t.Fatalf("draining after a hold dropped records: %+v", statsAfter)
	}
	if _, err := os.Stat(filepath.Join(hh.data, "quarantine")); err == nil {
		t.Fatal("a hold quarantined the queue")
	}
}
