// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
)

// drainTestLoop builds the smallest Loop that can walk a strategy set: the walk
// touches cfg (per-role token lookup) and git (token injection) before calling
// Tick, and nothing else.
func drainTestLoop(t *testing.T, strategies map[string]Strategy, order []string) *Loop {
	t.Helper()
	return &Loop{
		cfg:       testConfig(),
		git:       &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"},
		scheduler: NewScheduler(strategies, order, modePriority),
	}
}

// drainRecordingStrategy records whether its Tick ran, and can cancel a drain
// signal from inside the tick to simulate a restart/SIGTERM arriving mid-cycle.
type drainRecordingStrategy struct {
	name      string
	onTick    func()
	mu        sync.Mutex
	tickCount int
}

func (s *drainRecordingStrategy) Name() string           { return s.name }
func (s *drainRecordingStrategy) AllowedTools() []string { return nil }

func (s *drainRecordingStrategy) Tick(_ context.Context, _ *Loop) error {
	s.mu.Lock()
	s.tickCount++
	s.mu.Unlock()
	if s.onTick != nil {
		s.onTick()
	}
	return nil
}

func (s *drainRecordingStrategy) TickCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tickCount
}

// R14 finding (card 5edd3609): a drain must stop the runner reserving NEW work
// the moment it starts, not at the next poll-cycle boundary. scheduledTick
// fast-forwards through every strategy inside ONE cycle, so a drain that lands
// while role A is ticking used to still let roles B and C reserve fresh cards
// via /next-assignment — 48s into the drain in the live capture. Those cards
// are then either failed spuriously or force-killed at drain_timeout, breaking
// the restart contract ("finish the in-flight card, take no new work").
//
// The strategy walk must observe the drain signal between strategies.
func TestScheduledTick_DrainStopsStrategyWalk(t *testing.T) {
	drainCtx, startDrain := context.WithCancel(context.Background())
	defer startDrain()

	// first ticks, and while it is ticking the operator hits Restart.
	first := &drainRecordingStrategy{name: "planner", onTick: startDrain}
	second := &drainRecordingStrategy{name: "implementer"}

	loop := drainTestLoop(t,
		map[string]Strategy{"planner": first, "implementer": second},
		[]string{"planner", "implementer"})
	loop.observeDrain(drainCtx)

	if err := loop.scheduledTick(context.Background()); err != nil {
		t.Fatalf("scheduledTick returned error: %v", err)
	}

	if got := first.TickCount(); got != 1 {
		t.Fatalf("in-flight strategy tick count = %d, want 1 (the drain must not abort work already under way)", got)
	}
	if got := second.TickCount(); got != 0 {
		t.Errorf("strategy ticked %d time(s) after the drain started, want 0 — "+
			"a draining runner must never reserve new work (card 5edd3609)", got)
	}
}

// A drain that lands before the cycle even begins must stop the walk outright:
// no strategy reserves anything.
func TestScheduledTick_DrainBeforeCycleTicksNothing(t *testing.T) {
	drainCtx, startDrain := context.WithCancel(context.Background())
	startDrain()

	only := &drainRecordingStrategy{name: "planner"}
	loop := drainTestLoop(t, map[string]Strategy{"planner": only}, []string{"planner"})
	loop.observeDrain(drainCtx)

	if err := loop.scheduledTick(context.Background()); err != nil {
		t.Fatalf("scheduledTick returned error: %v", err)
	}
	if got := only.TickCount(); got != 0 {
		t.Errorf("strategy ticked %d time(s) during an already-started drain, want 0", got)
	}
}

// The single-role path (scheduler == nil) reserves through the same
// /next-assignment call, so it needs the same boundary.
func TestTick_SingleRoleDrainReservesNothing(t *testing.T) {
	drainCtx, startDrain := context.WithCancel(context.Background())
	startDrain()

	only := &drainRecordingStrategy{name: "planner"}
	loop := &Loop{cfg: testConfig(), strategy: only}
	loop.observeDrain(drainCtx)

	if err := loop.tick(context.Background()); err != nil {
		t.Fatalf("tick returned error: %v", err)
	}
	if got := only.TickCount(); got != 0 {
		t.Errorf("single-role strategy ticked %d time(s) during a drain, want 0", got)
	}
}

// Absent a drain signal (nothing ever called observeDrain — e.g. a test loop or
// a caller that never drains), the walk must behave exactly as before.
func TestScheduledTick_NoDrainSignalWalksAllStrategies(t *testing.T) {
	first := &drainRecordingStrategy{name: "planner"}
	second := &drainRecordingStrategy{name: "implementer"}

	loop := drainTestLoop(t,
		map[string]Strategy{"planner": first, "implementer": second},
		[]string{"planner", "implementer"})

	if err := loop.scheduledTick(context.Background()); err != nil {
		t.Fatalf("scheduledTick returned error: %v", err)
	}
	if first.TickCount() != 1 || second.TickCount() != 1 {
		t.Errorf("walk visited planner=%d implementer=%d, want 1 and 1 "+
			"(no drain signal must not change fast-forward behaviour)",
			first.TickCount(), second.TickCount())
	}
}
