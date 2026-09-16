// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"testing"
)

type stubStrategy struct {
	name string
}

func (s *stubStrategy) Name() string                            { return s.name }
func (s *stubStrategy) Tick(ctx context.Context, l *Loop) error { return nil }
func (s *stubStrategy) AllowedTools() []string                  { return nil }

func makeStrategies(names ...string) map[string]Strategy {
	m := make(map[string]Strategy, len(names))
	for _, n := range names {
		m[n] = &stubStrategy{name: n}
	}
	return m
}

func TestScheduler_PriorityOrder(t *testing.T) {
	strategies := makeStrategies("reviewer", "orchestrator", "documentator")
	priority := []string{"reviewer", "orchestrator", "documentator"}
	sched := NewScheduler(strategies, priority, "priority")

	got := sched.Next()
	if got == nil {
		t.Fatal("Next() returned nil")
	}
	if got.Name() != "reviewer" {
		t.Errorf("Next() = %q, want %q (highest priority)", got.Name(), "reviewer")
	}
}

func TestScheduler_RecordTick_TracksCurrentRole(t *testing.T) {
	strategies := makeStrategies("a", "b")
	priority := []string{"a", "b"}
	sched := NewScheduler(strategies, priority, "priority")

	sched.RecordTick("a", true)
	sched.RecordTick("a", true)
	if sched.CurrentRole() != "a" {
		t.Errorf("CurrentRole() = %q, want %q", sched.CurrentRole(), "a")
	}

	sched.RecordTick("b", true)
	if sched.CurrentRole() != "b" {
		t.Errorf("after switching, CurrentRole() = %q, want %q", sched.CurrentRole(), "b")
	}
}

func TestScheduler_SingleStrategy(t *testing.T) {
	strategies := makeStrategies("orchestrator")
	priority := []string{"orchestrator"}
	sched := NewScheduler(strategies, priority, "priority")

	for i := 0; i < 10; i++ {
		s := sched.Next()
		if s == nil {
			t.Fatalf("tick %d: Next() returned nil for single strategy", i)
		}
		if s.Name() != "orchestrator" {
			t.Fatalf("tick %d: got %q, want orchestrator", i, s.Name())
		}
		sched.RecordTick("orchestrator", true)
	}
}

func TestScheduler_AllIdleReset(t *testing.T) {
	strategies := makeStrategies("a", "b")
	priority := []string{"a", "b"}
	sched := NewScheduler(strategies, priority, "priority")

	sched.RecordTick("a", false)
	sched.RecordTick("b", false)

	// Every role is in cooldown — Next() must wipe cooldowns and hand back
	// the highest-priority role so the loop doesn't stall.
	s := sched.Next()
	if s == nil {
		t.Fatal("Next() returned nil when all idle")
	}
	if s.Name() != "a" {
		t.Errorf("after all-idle reset, Next() = %q, want %q", s.Name(), "a")
	}
}

func TestScheduler_NoWorkSkipsToNextRole(t *testing.T) {
	strategies := makeStrategies("reviewer", "orchestrator")
	priority := []string{"reviewer", "orchestrator"}
	sched := NewScheduler(strategies, priority, "priority")

	sched.RecordTick("reviewer", false)
	s := sched.Next()
	if s.Name() != "orchestrator" {
		t.Errorf("after reviewer idle, Next() = %q, want orchestrator", s.Name())
	}

	sched.RecordTick("orchestrator", false)
	s = sched.Next()
	if s.Name() != "reviewer" {
		t.Errorf("after all idle, Next() = %q, want reviewer (reset)", s.Name())
	}
}

func TestScheduler_WorkClearsIdleFlag(t *testing.T) {
	strategies := makeStrategies("reviewer", "orchestrator")
	priority := []string{"reviewer", "orchestrator"}
	sched := NewScheduler(strategies, priority, "priority")

	sched.RecordTick("reviewer", false)
	sched.RecordTick("orchestrator", true)

	s := sched.Next()
	if s.Name() != "orchestrator" {
		t.Errorf("Next() = %q, want orchestrator (reviewer still idle)", s.Name())
	}
}

func TestScheduler_Strategies(t *testing.T) {
	strategies := makeStrategies("a", "b", "c")
	priority := []string{"a", "b", "c"}
	sched := NewScheduler(strategies, priority, "priority")

	got := sched.Strategies()
	if len(got) != 3 {
		t.Errorf("Strategies() len = %d, want 3", len(got))
	}
	for _, name := range []string{"a", "b", "c"} {
		if _, ok := got[name]; !ok {
			t.Errorf("Strategies() missing %q", name)
		}
	}
}

func TestScheduler_Len(t *testing.T) {
	sched := NewScheduler(makeStrategies("a", "b", "c"), []string{"a", "b", "c"}, "priority")
	if sched.Len() != 3 {
		t.Errorf("Len() = %d, want 3", sched.Len())
	}
}

// T1.3: empty / unknown mode must collapse to "priority" so old platform
// payloads keep working.
func TestScheduler_UnknownModeDefaultsToPriority(t *testing.T) {
	strategies := makeStrategies("a", "b")
	priority := []string{"a", "b"}
	sched := NewScheduler(strategies, priority, "")
	if s := sched.Next(); s.Name() != "a" {
		t.Errorf("empty mode: Next() = %q, want %q", s.Name(), "a")
	}

	sched = NewScheduler(strategies, priority, "not-a-real-mode")
	if s := sched.Next(); s.Name() != "a" {
		t.Errorf("unknown mode: Next() = %q, want %q", s.Name(), "a")
	}
}

// T1.3: priority mode must NOT rotate a role away from consecutive work — the
// old max_consecutive guard used to force a switch here.
func TestScheduler_PriorityMode_NoConsecutiveGuard(t *testing.T) {
	strategies := makeStrategies("reviewer", "orchestrator")
	priority := []string{"reviewer", "orchestrator"}
	sched := NewScheduler(strategies, priority, "priority")

	for i := 0; i < 10; i++ {
		s := sched.Next()
		if s == nil {
			t.Fatalf("tick %d: Next() returned nil", i)
		}
		if s.Name() != "reviewer" {
			t.Fatalf("tick %d: got %q, want reviewer every time (no consecutive guard)", i, s.Name())
		}
		sched.RecordTick("reviewer", true)
	}
}

// T1.3: round_robin rotates through priority_order one slot per Next() call.
func TestScheduler_RoundRobin_RotatesThroughRoles(t *testing.T) {
	strategies := makeStrategies("a", "b", "c")
	priority := []string{"a", "b", "c"}
	sched := NewScheduler(strategies, priority, "round_robin")

	want := []string{"a", "b", "c", "a"}
	for i, expected := range want {
		s := sched.Next()
		if s == nil {
			t.Fatalf("tick %d: Next() returned nil", i)
		}
		if s.Name() != expected {
			t.Errorf("tick %d: Next() = %q, want %q", i, s.Name(), expected)
		}
		sched.RecordTick(s.Name(), true)
	}
}

// T1.3: round_robin must skip roles in idle cooldown and keep rotating through
// the rest without burning the pointer on the skipped slot.
func TestScheduler_RoundRobin_SkipsIdleRoles(t *testing.T) {
	strategies := makeStrategies("a", "b", "c")
	priority := []string{"a", "b", "c"}
	sched := NewScheduler(strategies, priority, "round_robin")

	sched.RecordTick("b", false) // b now in cooldown

	want := []string{"a", "c", "a"}
	for i, expected := range want {
		s := sched.Next()
		if s == nil {
			t.Fatalf("tick %d: Next() returned nil", i)
		}
		if s.Name() != expected {
			t.Errorf("tick %d: Next() = %q, want %q (b should be skipped)", i, s.Name(), expected)
		}
		sched.RecordTick(s.Name(), true)
	}
}
