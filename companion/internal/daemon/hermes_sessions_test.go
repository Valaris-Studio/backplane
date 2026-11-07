// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"testing"
	"time"
)

// Hermes fires on_session_end after every turn; only on_session_finalize
// ends the session.
func TestSessionEvents_HermesFinalizeEndsTheSessionAndPerTurnEventsDoNot(t *testing.T) {
	var tracker sessionTracker
	steps := []struct{ event, want string }{
		{"on_session_start", SessionStarted},
		{"on_session_end", SessionUpdated},
		{"post_tool_call", SessionUpdated},
		{"post_approval_response", SessionUpdated},
		{"on_session_end", SessionUpdated},
		{"on_session_finalize", SessionEnded},
	}
	for index, step := range steps {
		at := now.Add(time.Duration(index) * 3 * time.Second)
		tracker.noteQueued("hermes_agent", "20260924_115958_a1b2c3", "", "m-hermes", at, step.event, nil)
		due := tracker.flush(at)
		if len(due) != 1 || due[0].Kind != step.want {
			t.Fatalf("after %s: %+v, want %s", step.event, due, step.want)
		}
	}
	if len(tracker.sessions) != 0 {
		t.Fatal("an ended session is still tracked")
	}
}
