// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package events

import (
	"encoding/json"
	"testing"
)

// board.loop_updated → loop-mode wake (card 5ffe97cf). A keep-alive runner
// polls the board every ≤60s as a fallback, but the WS event is what makes
// re-enabling a loop feel instant. Routing it wrong is worse than not routing
// it: a wake on the runner's OWN disable would resurrect a finished run.
//
// The payload has no actor_id/agent_id (BoardService._publish_loop_updated
// sends {workspace_id, board_id, enabled, version, disabled_reason}), so the
// client's self-filter is INERT here — `enabled == true` is the only guard
// standing between a rail-tripped disable and an infinite wake loop.

func newBoardLoopClient(boardID string, wake chan struct{}) *Client {
	c := NewClient("http://example.test", "key", "acme", "agent-1", "user-1", nil)
	c.SetLoopBoardWake(boardID, wake)
	return c
}

func loopUpdatedEvent(t *testing.T, boardID string, enabled bool) Event {
	t.Helper()
	// Round-tripped through JSON rather than built as a struct literal: the
	// wire shape is the contract, and `enabled` is a pointer field precisely
	// so an ABSENT key stays distinguishable from `false`.
	raw := map[string]any{
		"event":     "board.loop_updated",
		"timestamp": "2026-08-16T00:00:00Z",
		"event_id":  "evt-loop-1",
		"payload": map[string]any{
			"board_id":     boardID,
			"workspace_id": "ws-1",
			"enabled":      enabled,
			"version":      3,
		},
	}
	data, err := json.Marshal(raw)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var ev Event
	if err := json.Unmarshal(data, &ev); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return ev
}

func TestRouteEvent_BoardLoopEnabled_WakesBoundBoard(t *testing.T) {
	wake := make(chan struct{}, 1)
	c := newBoardLoopClient("board-1", wake)

	c.routeEvent(loopUpdatedEvent(t, "board-1", true))

	select {
	case <-wake:
	default:
		t.Fatal("no wake signal — an operator re-enabling the loop leaves the runner asleep until its poll fallback")
	}
}

func TestRouteEvent_BoardLoopDisabled_DoesNotWake(t *testing.T) {
	wake := make(chan struct{}, 1)
	c := newBoardLoopClient("board-1", wake)

	c.routeEvent(loopUpdatedEvent(t, "board-1", false))

	select {
	case <-wake:
		t.Fatal("woke on enabled=false — the runner's OWN rail-tripped disable publishes exactly this event, so it would resurrect a finished run")
	default:
	}
}

func TestRouteEvent_BoardLoopOtherBoard_DoesNotWake(t *testing.T) {
	wake := make(chan struct{}, 1)
	c := newBoardLoopClient("board-1", wake)

	c.routeEvent(loopUpdatedEvent(t, "board-OTHER", true))

	select {
	case <-wake:
		t.Fatal("woke on another board's loop event — the subscription is workspace-wide, so board scoping is the client's job")
	default:
	}
}

// A payload that omits `enabled` entirely must not wake: absent is unknown,
// and treating unknown as true would wake on any future board.* event that
// happens to carry a board_id.
func TestRouteEvent_BoardLoopEnabledAbsent_DoesNotWake(t *testing.T) {
	wake := make(chan struct{}, 1)
	c := newBoardLoopClient("board-1", wake)

	raw := `{"event":"board.loop_updated","payload":{"board_id":"board-1","workspace_id":"ws-1"}}`
	var ev Event
	if err := json.Unmarshal([]byte(raw), &ev); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if ev.Payload.Enabled != nil {
		t.Fatalf("Enabled = %v, want nil for an absent key — the field must be a pointer or absent collapses into false", *ev.Payload.Enabled)
	}

	c.routeEvent(ev)

	select {
	case <-wake:
		t.Fatal("woke on a payload with no `enabled` key")
	default:
	}
}

// The wake channel is a coalescing signal, not a queue: a burst of toggles
// must never block routeEvent (it runs on the single read loop, so a blocking
// send would stall every other event).
func TestRouteEvent_BoardLoopWake_CoalescesAndNeverBlocks(t *testing.T) {
	wake := make(chan struct{}, 1)
	c := newBoardLoopClient("board-1", wake)

	for i := 0; i < 5; i++ {
		c.routeEvent(loopUpdatedEvent(t, "board-1", true))
	}

	if got := len(wake); got != 1 {
		t.Errorf("wake channel holds %d signals, want 1 — the send must be non-blocking and coalescing", got)
	}
}

// A client with no loop-board wake wired (pipeline mode) must ignore the event
// rather than panic on a nil channel.
func TestRouteEvent_BoardLoopNoWakeWired_Ignored(t *testing.T) {
	c := NewClient("http://example.test", "key", "acme", "agent-1", "user-1", nil)
	c.routeEvent(loopUpdatedEvent(t, "board-1", true))
}

func TestSubscribeList_IncludesBoardEvents(t *testing.T) {
	// board.loop_updated only reaches routeEvent if the subscribe frame asks
	// for it — the backend fnmatch-routes on the patterns the client sends.
	found := false
	for _, pattern := range subscribePatterns() {
		if pattern == "board.*" {
			found = true
		}
	}
	if !found {
		t.Errorf("subscribe patterns %v omit board.* — the wake event never arrives", subscribePatterns())
	}
}
