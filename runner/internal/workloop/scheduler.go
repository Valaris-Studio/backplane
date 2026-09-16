// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"log/slog"
	"sync"
	"time"
)

// schedulerMode enumerates the selection algorithms.
const (
	modePriority   = "priority"
	modeRoundRobin = "round_robin"
)

// defaultIdleCooldown is how long a role sleeps after a no-work tick before
// being reconsidered. Two poll intervals at the 2-minute default keeps wakeups
// responsive without busy-polling.
const defaultIdleCooldown = 4 * time.Minute

// StrategyScheduler picks which Strategy runs each tick. Selection is
// controlled by mode: "priority" honors priority_order strictly, "round_robin"
// rotates through priority_order. Idle-cooldown semantics are identical in
// both modes — a role that returned foundWork=false sleeps for idleDuration.
type StrategyScheduler struct {
	strategies    map[string]Strategy
	priorityOrder []string
	mode          string

	mu           sync.Mutex
	rrIndex      int
	idleUntil    map[string]time.Time
	lastRole     string
	idleDuration time.Duration
}

// NewScheduler wires a scheduler from platform-authoritative config. Unknown
// or empty modes collapse to "priority" so old platform payloads keep working.
func NewScheduler(strategies map[string]Strategy, priorityOrder []string, mode string) *StrategyScheduler {
	if mode != modePriority && mode != modeRoundRobin {
		mode = modePriority
	}
	return &StrategyScheduler{
		strategies:    strategies,
		priorityOrder: priorityOrder,
		mode:          mode,
		idleUntil:     make(map[string]time.Time),
		idleDuration:  defaultIdleCooldown,
	}
}

// Next returns the next strategy to run. Returns nil only when no strategies
// are registered.
func (s *StrategyScheduler) Next() Strategy {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.mode == modeRoundRobin {
		return s.nextRoundRobin()
	}
	return s.nextPriority()
}

// nextPriority iterates priority_order left-to-right and returns the first
// strategy whose role is not in idle cooldown. If every known role is idle,
// cooldowns are cleared and the highest-priority strategy is returned.
func (s *StrategyScheduler) nextPriority() Strategy {
	now := time.Now()
	for _, role := range s.priorityOrder {
		strategy, ok := s.strategies[role]
		if !ok {
			continue
		}
		if until, cooling := s.idleUntil[role]; cooling && now.Before(until) {
			continue
		}
		return strategy
	}
	return s.resetAndPickFirst()
}

// nextRoundRobin rotates through priority_order starting at rrIndex, skipping
// roles that are absent from strategies or in idle cooldown. The pointer lands
// one slot past the returned role, so two consecutive calls never re-hit the
// same strategy unless every other candidate is unavailable. If every role is
// idle, cooldowns reset and rrIndex is rewound to 0.
func (s *StrategyScheduler) nextRoundRobin() Strategy {
	now := time.Now()
	n := len(s.priorityOrder)
	if n == 0 {
		return nil
	}

	start := s.rrIndex % n
	for offset := 0; offset < n; offset++ {
		idx := (start + offset) % n
		role := s.priorityOrder[idx]
		strategy, ok := s.strategies[role]
		if !ok {
			continue
		}
		if until, cooling := s.idleUntil[role]; cooling && now.Before(until) {
			continue
		}
		s.rrIndex = (idx + 1) % n
		return strategy
	}
	return s.resetAndPickFirst()
}

// resetAndPickFirst clears all idle cooldowns, rewinds the round-robin
// pointer, and returns the first registered strategy in priority order. Used
// when every candidate is in cooldown so the loop doesn't stall.
func (s *StrategyScheduler) resetAndPickFirst() Strategy {
	for k := range s.idleUntil {
		delete(s.idleUntil, k)
	}
	s.rrIndex = 0
	for _, role := range s.priorityOrder {
		if strategy, ok := s.strategies[role]; ok {
			return strategy
		}
	}
	return nil
}

// RecordTick updates scheduler state after a strategy runs. foundWork=true
// clears the role's idle cooldown and marks it as the last-running role;
// foundWork=false puts the role into cooldown for idleDuration.
func (s *StrategyScheduler) RecordTick(role string, foundWork bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if foundWork {
		delete(s.idleUntil, role)
		s.lastRole = role
		return
	}
	s.idleUntil[role] = time.Now().Add(s.idleDuration)
}

// ResetIdle wakes up a specific role from cooldown. Used for cross-strategy
// handoffs: e.g., orchestrator ships to review → reviewer wakes.
func (s *StrategyScheduler) ResetIdle(role string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.idleUntil, role)
	slog.Debug("idle reset for role", "role", role)
}

// Strategies returns a copy of the registered strategy map.
func (s *StrategyScheduler) Strategies() map[string]Strategy {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]Strategy, len(s.strategies))
	for k, v := range s.strategies {
		out[k] = v
	}
	return out
}

// PriorityOrder returns a copy of the current scheduling order.
func (s *StrategyScheduler) PriorityOrder() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.priorityOrder))
	copy(out, s.priorityOrder)
	return out
}

// Reconfigure swaps the live strategy set + priority order under the same
// mutex Next() uses. Drops idle-cooldown entries for roles that no longer
// exist and rewinds the round-robin pointer to avoid pointing past the end.
func (s *StrategyScheduler) Reconfigure(strategies map[string]Strategy, priorityOrder []string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.strategies = strategies
	s.priorityOrder = priorityOrder
	for role := range s.idleUntil {
		if _, ok := strategies[role]; !ok {
			delete(s.idleUntil, role)
		}
	}
	if len(priorityOrder) == 0 {
		s.rrIndex = 0
	} else {
		s.rrIndex %= len(priorityOrder)
	}
}

// Len returns the number of registered strategies.
func (s *StrategyScheduler) Len() int {
	return len(s.strategies)
}

// CurrentRole returns the name of the last strategy that found work.
func (s *StrategyScheduler) CurrentRole() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastRole
}
