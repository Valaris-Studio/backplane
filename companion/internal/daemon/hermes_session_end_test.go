// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"strings"
	"testing"
	"time"
)

func TestHermesFinalizeThroughTheDaemonEndsTheSession(t *testing.T) {
	f, project := newHermesFixture(t, "metadata")
	recorder := recordSessions(f)
	for _, event := range []string{"on_session_start", "post_tool_call", "post_approval_response"} {
		f.hermesHook(t, hermesInput(t, event, project))
		f.tick(t)
		*f.clock = f.clock.Add(3 * time.Second)
	}
	if kinds := strings.Join(recorder.kinds(), ","); kinds != "started,updated,updated" {
		t.Fatalf("a turn ended the session or went unannounced: %s", kinds)
	}
	f.hermesHook(t, hermesInput(t, "on_session_finalize", project))
	f.tick(t)
	last := recorder.last()
	if last.Kind != SessionEnded || last.Session.Harness != hermesAgent || last.Session.NativeSessionID != hermesSession {
		t.Fatalf("finalize did not end the session: %+v (kinds %v)", last, recorder.kinds())
	}
}
