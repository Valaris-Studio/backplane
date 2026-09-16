// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

// fakeClock drives the supervisor's backoff timer deterministically.
// Sleep blocks until Advance() pushes the simulated time past the wakeup.
type fakeClock struct {
	now    atomic.Int64 // unix nanos
	wakeCh chan struct{}
}

func newFakeClock() *fakeClock {
	c := &fakeClock{wakeCh: make(chan struct{}, 1)}
	c.now.Store(0)
	return c
}

func (c *fakeClock) Now() time.Time {
	return time.Unix(0, c.now.Load())
}

func (c *fakeClock) Sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	select {
	case <-c.wakeCh:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Advance moves the clock forward and wakes any pending Sleep call.
func (c *fakeClock) Advance(d time.Duration) {
	c.now.Add(int64(d))
	select {
	case c.wakeCh <- struct{}{}:
	default:
	}
}

// TestSupervisor_RestartsAfterPanic asserts that a panicking run function is
// recovered and re-invoked.
func TestSupervisor_RestartsAfterPanic(t *testing.T) {
	clock := newFakeClock()
	var calls atomic.Int32
	run := func(ctx context.Context) error {
		n := calls.Add(1)
		if n == 1 {
			panic("boom")
		}
		return nil
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- superviseInternal(ctx, run, supervisorOpts{
			clock:        clock,
			initialDelay: time.Second,
			maxDelay:     time.Minute,
			resetAfter:   5 * time.Minute,
		})
	}()

	// Wake the backoff sleep so the second run can start and return nil.
	waitFor(t, func() bool { return calls.Load() == 1 })
	clock.Advance(time.Second)

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Supervise returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Supervise did not exit after successful run")
	}

	if got := calls.Load(); got != 2 {
		t.Errorf("run invocations = %d, want 2", got)
	}
}

// TestSupervisor_BackoffDoubles asserts the delay doubles on each consecutive
// panic up to maxDelay.
func TestSupervisor_BackoffDoubles(t *testing.T) {
	clock := newFakeClock()
	var calls atomic.Int32
	run := func(ctx context.Context) error {
		n := calls.Add(1)
		if n <= 4 {
			panic("again")
		}
		return nil
	}

	delays := make(chan time.Duration, 8)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		done <- superviseInternal(ctx, run, supervisorOpts{
			clock:        clock,
			initialDelay: time.Second,
			maxDelay:     4 * time.Second,
			resetAfter:   5 * time.Minute,
			onBackoff:    func(d time.Duration) { delays <- d },
		})
	}()

	for i := 0; i < 4; i++ {
		select {
		case d := <-delays:
			want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 4 * time.Second}[i]
			if d != want {
				t.Errorf("backoff[%d] = %v, want %v", i, d, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("timeout waiting for backoff[%d]", i)
		}
		clock.Advance(time.Hour) // wake any duration
	}

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Supervise did not exit")
	}
}

// TestSupervisor_ResetAfterStableRun proves the delay returns to initialDelay
// once the run survives longer than resetAfter.
func TestSupervisor_ResetAfterStableRun(t *testing.T) {
	clock := newFakeClock()
	startedAt := make(chan time.Time, 8)
	finishGate := make(chan struct{})
	var calls atomic.Int32

	run := func(ctx context.Context) error {
		n := calls.Add(1)
		startedAt <- clock.Now()
		<-finishGate
		if n <= 3 {
			panic("crash")
		}
		return nil
	}

	delays := make(chan time.Duration, 8)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		_ = superviseInternal(ctx, run, supervisorOpts{
			clock:        clock,
			initialDelay: time.Second,
			maxDelay:     time.Minute,
			resetAfter:   5 * time.Minute,
			onBackoff:    func(d time.Duration) { delays <- d },
		})
	}()

	// Run 1: panic immediately.
	<-startedAt
	finishGate <- struct{}{}
	if d := <-delays; d != time.Second {
		t.Errorf("delay after run 1 = %v, want 1s", d)
	}
	clock.Advance(time.Second)

	// Run 2: panic immediately again. Backoff should double.
	<-startedAt
	finishGate <- struct{}{}
	if d := <-delays; d != 2*time.Second {
		t.Errorf("delay after run 2 = %v, want 2s", d)
	}
	clock.Advance(2 * time.Second)

	// Run 3: stay alive past resetAfter, then panic — delay must reset to 1s.
	<-startedAt
	clock.Advance(6 * time.Minute)
	finishGate <- struct{}{}
	if d := <-delays; d != time.Second {
		t.Errorf("delay after long-lived panic = %v, want 1s (reset)", d)
	}
	clock.Advance(time.Second)
	// Run 4: returns nil, supervisor exits.
	<-startedAt
	finishGate <- struct{}{}
}

// TestSupervisor_ContextCancellation proves a cancelled context shuts the
// supervisor down even mid-backoff.
func TestSupervisor_ContextCancellation(t *testing.T) {
	clock := newFakeClock()
	run := func(ctx context.Context) error {
		panic("dies")
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- superviseInternal(ctx, run, supervisorOpts{
			clock:        clock,
			initialDelay: time.Hour,
			maxDelay:     time.Hour,
			resetAfter:   5 * time.Minute,
		})
	}()

	// Let the first panic happen and the supervisor enter backoff sleep.
	time.Sleep(10 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("Supervise err = %v, want context.Canceled", err)
		}
	case <-time.After(time.Second):
		t.Fatal("Supervise did not exit on cancel")
	}
}

// TestSupervisor_NoRecoverPropagatesPanic asserts the bypass mode lets panics
// surface for development debugging.
func TestSupervisor_NoRecoverPropagatesPanic(t *testing.T) {
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic to propagate when recover disabled")
		}
	}()
	run := func(ctx context.Context) error {
		panic("debug")
	}
	_ = superviseInternal(context.Background(), run, supervisorOpts{
		disableRecover: true,
		clock:          newFakeClock(),
	})
}

// TestSupervisor_PassesThroughError asserts non-panic errors are returned to
// the caller without retry.
func TestSupervisor_PassesThroughError(t *testing.T) {
	want := errors.New("graceful exit")
	run := func(ctx context.Context) error { return want }
	got := superviseInternal(context.Background(), run, supervisorOpts{clock: newFakeClock()})
	if !errors.Is(got, want) {
		t.Errorf("Supervise err = %v, want %v", got, want)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("waitFor: condition never became true")
}
