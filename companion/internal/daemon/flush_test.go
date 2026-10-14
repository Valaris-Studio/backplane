// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

func (f *fixture) batchCount() int {
	f.server.Lock()
	defer f.server.Unlock()
	return len(f.server.Batches)
}

func (f *fixture) failUploads() {
	f.server.Lock()
	f.server.Respond = func([]string) (int, any) { return 503, map[string]any{"detail": "down"} }
	f.server.Unlock()
}

// backingOff queues one record whose upload failed, so the queue waits out
// a backoff under the fixture's frozen clock.
func (f *fixture) backingOff(t *testing.T) *FlushSignal {
	t.Helper()
	signal := NewFlushSignal()
	f.daemon.config.Flush = signal
	f.failUploads()
	f.hook(t, f.repo, "SessionStart", "")
	f.tick(t)
	f.tick(t)
	if f.batchCount() != 1 {
		t.Fatalf("setup: the backoff must hold the second pass, got %d batches", f.batchCount())
	}
	return signal
}

func TestQueueFlush_DuringBackoffTriggersAnImmediateAttempt(t *testing.T) {
	f := newFixture(t)
	signal := f.backingOff(t)
	signal.Request()
	f.tick(t)
	if f.batchCount() != 2 {
		t.Fatalf("a flush during backoff must attempt at once, got %d batches", f.batchCount())
	}
	f.server.Lock()
	f.server.Respond = nil
	f.server.Unlock()
	*f.clock = f.clock.Add(FlushFloor)
	signal.Request()
	f.tick(t)
	if f.queueCount(t) != 0 {
		t.Fatal("a flushed attempt that succeeds must settle the queue")
	}
}

func TestQueueFlush_KeepsTheBackoffPolicyForLaterFailures(t *testing.T) {
	f := newFixture(t)
	signal := f.backingOff(t)
	signal.Request()
	f.tick(t)
	stats, _ := queue.Open(f.layout).Stats()
	if stats.Failures != 2 || !stats.NextAttempt.After(now) {
		t.Fatalf("a failed flushed attempt must escalate the backoff as any failure: %+v", stats)
	}
	f.tick(t)
	if f.batchCount() != 2 {
		t.Fatalf("a flush is spent by one attempt; the backoff must hold again, got %d batches", f.batchCount())
	}
}

func TestQueueFlush_RateFloorAllowsOneSkippedBackoffPerSecond(t *testing.T) {
	f := newFixture(t)
	signal := f.backingOff(t)
	signal.Request()
	f.tick(t)
	signal.Request()
	f.tick(t)
	if f.batchCount() != 2 {
		t.Fatalf("a second flush within the floor must not skip the backoff again, got %d batches", f.batchCount())
	}
	*f.clock = f.clock.Add(FlushFloor)
	if stats, _ := queue.Open(f.layout).Stats(); !stats.NextAttempt.After(*f.clock) {
		t.Fatalf("setup: still backing off after the floor: %+v", stats)
	}
	signal.Request()
	f.tick(t)
	if f.batchCount() != 3 {
		t.Fatalf("a flush after the floor must skip the backoff, got %d batches", f.batchCount())
	}
}

func TestFlushSignal_AttachedOnlyWhileTheLoopRuns(t *testing.T) {
	f := newFixture(t)
	signal := NewFlushSignal()
	f.daemon.config.Flush = signal
	if signal.Attached() {
		t.Fatal("no loop runs yet")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- f.daemon.RunLocked(ctx) }()
	deadline := time.Now().Add(2 * time.Second)
	for !signal.Attached() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	attached := signal.Attached()
	cancel()
	<-done
	if !attached || signal.Attached() {
		t.Fatalf("attached while running: %v, after: %v", attached, signal.Attached())
	}
}

func TestQueueFlush_StormCoalescesIntoOneAttempt(t *testing.T) {
	f := newFixture(t)
	signal := f.backingOff(t)
	for range 100 {
		signal.Request()
	}
	f.tick(t)
	f.tick(t)
	if f.batchCount() != 2 {
		t.Fatalf("100 flushes before a pass must coalesce into one attempt, got %d batches", f.batchCount())
	}
}

func TestQueueFlush_WithoutARequestTheBackoffHolds(t *testing.T) {
	f := newFixture(t)
	f.backingOff(t)
	f.tick(t)
	if f.batchCount() != 1 {
		t.Fatalf("no flush, no early attempt: got %d batches", f.batchCount())
	}
}

func TestQueueFlush_RevokedDeviceIsNeverRetried(t *testing.T) {
	f := newFixture(t)
	signal := f.backingOff(t)
	store.WriteJSON(f.layout.Admission(), state.Admission{Unauthorized: true, InstallationID: fixtureInstallation})
	signal.Request()
	f.daemon.Tick(context.Background())
	if f.batchCount() != 1 {
		t.Fatalf("a flush must not upload for a revoked device, got %d batches", f.batchCount())
	}
}

// concurrencyProbe records how many uploads run at once.
type concurrencyProbe struct {
	API
	inFlight, peak, calls atomic.Int32
}

func (p *concurrencyProbe) Ingest(ctx context.Context, records []json.RawMessage) (uplink.Ack, error) {
	current := p.inFlight.Add(1)
	defer p.inFlight.Add(-1)
	p.calls.Add(1)
	for {
		peak := p.peak.Load()
		if current <= peak || p.peak.CompareAndSwap(peak, current) {
			break
		}
	}
	time.Sleep(20 * time.Millisecond)
	return p.API.Ingest(ctx, records)
}

func TestQueueFlush_StormNeverRunsParallelUploads(t *testing.T) {
	f := newFixture(t)
	signal := f.backingOff(t)
	probe := &concurrencyProbe{API: f.daemon.config.Client}
	f.daemon.config.Client = probe
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- f.daemon.RunLocked(ctx) }()
	var storm sync.WaitGroup
	for range 32 {
		storm.Add(1)
		go func() {
			defer storm.Done()
			for range 50 {
				signal.Request()
				time.Sleep(time.Millisecond)
			}
		}()
	}
	storm.Wait()
	time.Sleep(100 * time.Millisecond)
	cancel()
	<-done
	if probe.calls.Load() == 0 || probe.peak.Load() != 1 {
		t.Fatalf("a flush storm must run uploads one at a time: calls=%d peak=%d", probe.calls.Load(), probe.peak.Load())
	}
}

func TestQueueFlush_WakesTheRunningLoopBeforeTheNextPoll(t *testing.T) {
	f := newFixture(t)
	signal := f.backingOff(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- f.daemon.RunLocked(ctx) }()
	// Let the loop's immediate first pass run and settle into its wait.
	time.Sleep(150 * time.Millisecond)
	before := f.batchCount()
	signal.Request()
	deadline := time.Now().Add(PollInterval / 2)
	for f.batchCount() == before && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	if f.batchCount() == before {
		t.Fatal("a flush must wake the loop instead of waiting for the next poll")
	}
}

func TestFlushSignal_NilIsANoOp(t *testing.T) {
	var signal *FlushSignal
	signal.Request()
	signal.Attach()()
	if signal.take() || signal.Attached() {
		t.Fatal("a nil signal never requests a flush")
	}
}
