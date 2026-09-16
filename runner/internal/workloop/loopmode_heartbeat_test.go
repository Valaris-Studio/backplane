// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// Loop-state heartbeats (card 442ff0f2). Parking was runner-local and
// invisible: the parked tick heartbeat carried no body, so the platform saw
// the same "agent was here recently, nothing in flight" it sees from a runner
// that died between iterations. These tests pin the payload, not the count.

// TestLoopMode_ParkedHeartbeat_ReportsLoopState proves the readiness-park site
// tells the platform it is parked, on which board, and why.
func TestLoopMode_ParkedHeartbeat_ReportsLoopState(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	srv.readinessBodies = []string{
		readinessJSON(false, 0, 3, 3, 3),
		readinessJSON(true, 2, 1, 0, 3),
	}
	m := newLoopModeForServer(t, srv, llm.NewMockProvider("worked the ready card"))

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	parked := srv.heartbeatBodyAt(0)
	if parked == nil {
		t.Fatal("parked heartbeat sent no body — the platform cannot tell parked from dead")
	}
	if got := parked["loop_state"]; got != "parked" {
		t.Errorf("loop_state = %v, want parked", got)
	}
	if got := parked["loop_board_id"]; got != "board-1" {
		t.Errorf("loop_board_id = %v, want board-1", got)
	}
	if got, _ := parked["loop_park_reason"].(string); got == "" {
		t.Error("loop_park_reason empty — a park with no reason is the same opaque silence this card removes")
	}
	if got, _ := parked["loop_parked_since"].(string); got == "" {
		t.Error("loop_parked_since empty — the operator cannot tell a 30s nap from a 3h one")
	}
}

// TestLoopMode_TickingHeartbeat_ReportsLoopState proves the per-iteration
// heartbeat claims the board too: without it a runner that has been ticking
// for hours reports no loop attribution at all, which is the board-attribution
// half of the card's gap.
func TestLoopMode_TickingHeartbeat_ReportsLoopState(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	m := newLoopModeForServer(t, srv, llm.NewMockProvider("did the work"))

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	tick := srv.heartbeatBodyAt(0)
	if tick == nil {
		t.Fatal("iteration heartbeat sent no body")
	}
	if got := tick["loop_state"]; got != "ticking" {
		t.Errorf("loop_state = %v, want ticking", got)
	}
	if got := tick["loop_board_id"]; got != "board-1" {
		t.Errorf("loop_board_id = %v, want board-1", got)
	}
	if reason, ok := tick["loop_park_reason"]; ok && reason != nil && reason != "" {
		t.Errorf("loop_park_reason = %v on a ticking heartbeat, want absent/empty", reason)
	}
}

// TestLoopMode_ParkedSince_StableAcrossConsecutiveParks proves parked_since is
// the start of the CURRENT park streak, not the instant of each tick. A value
// that advanced every tick would always read "parked just now" — the exact
// question the field exists to answer, answered wrong.
func TestLoopMode_ParkedSince_StableAcrossConsecutiveParks(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	srv.readinessBodies = []string{
		readinessJSON(false, 0, 3, 3, 3),
		readinessJSON(false, 0, 3, 3, 3),
		readinessJSON(true, 2, 1, 0, 3),
	}
	m := newLoopModeForServer(t, srv, llm.NewMockProvider("worked the ready card"))

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	first, _ := srv.heartbeatBodyAt(0)["loop_parked_since"].(string)
	second, _ := srv.heartbeatBodyAt(1)["loop_parked_since"].(string)
	if first == "" || second == "" {
		t.Fatalf("loop_parked_since missing: first=%q second=%q", first, second)
	}
	if first != second {
		t.Errorf("loop_parked_since drifted across a park streak: %q then %q", first, second)
	}
}

// TestLoopMode_NothingReadyPark_ReportsLoopState covers the SECOND park site:
// the session itself returning outcome "nothing_ready" after readiness said
// actionable. It parks identically, so it must report identically.
func TestLoopMode_NothingReadyPark_ReportsLoopState(t *testing.T) {
	enabled := baseLoopConfig()
	disabled := baseLoopConfig()
	disabled.Enabled = false
	srv := newLoopModeServer(t,
		loopConfigJSON(t, enabled),
		loopConfigJSON(t, disabled),
	)
	provider := llm.NewMockProvider("no workable cards")
	provider.QueueStructured([]byte(`{"outcome":"nothing_ready","summary":"no workable cards"}`))
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	var sawParked bool
	for i := 0; i < srv.heartbeatCount(); i++ {
		if srv.heartbeatBodyAt(i)["loop_state"] == "parked" {
			sawParked = true
		}
	}
	if !sawParked {
		t.Error("no heartbeat reported loop_state=parked after a nothing_ready session — the second park site is silent")
	}
}
