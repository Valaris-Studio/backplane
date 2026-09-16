// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package events

import "testing"

func TestCompletionUpdatedWakesOnlyBoundBoardIncludingOwnResult(t *testing.T) {
	for _, board := range []string{"board-1", "other", ""} {
		t.Run(board, func(t *testing.T) {
			wake := make(chan struct{}, 1)
			client := newBoardLoopClient("board-1", wake)
			client.routeEvent(Event{Type: "completion.updated", Payload: EventPayload{BoardID: board, ActorID: "user-1", AgentID: "agent-1"}})
			if (len(wake) == 1) != (board == "board-1") {
				t.Fatalf("completion wake mismatch for board %q", board)
			}
		})
	}
	found := false
	for _, pattern := range subscribePatterns() {
		if pattern == "completion.*" {
			found = true
		}
	}
	if !found {
		t.Fatal("completion events absent from subscription")
	}
}
