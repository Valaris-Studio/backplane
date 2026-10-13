// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// An unrecorded release recovers through the runner's own poll: once the
// cleanup endpoint answers again, a poll cycle finishes only the cleanup
// steps still pending, then refreshes the role, and only then lets the role
// take new work, under the refreshed configuration.

// orderLog sits in front of a releaseRecorder and records, in arrival order,
// the requests whose order the recovery is judged by.
type orderLog struct {
	next   http.Handler
	mu     sync.Mutex
	events []string
}

func (o *orderLog) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	event := ""
	switch {
	case r.URL.Path == "/api/agents/me/config":
		event = "config"
	case r.Method == http.MethodDelete && strings.Contains(r.URL.Path, "/cards/"+runnerDispatchCard+"/participants"):
		event = "unassign"
	case strings.HasSuffix(r.URL.Path, "/next-assignment"):
		event = "assign"
	case strings.HasSuffix(r.URL.Path, "/executions") && r.Method == http.MethodPost:
		event = "start"
	case strings.HasSuffix(r.URL.Path, "/dispatch-preparations"):
		event = "prepare"
	}
	if event != "" {
		o.mu.Lock()
		o.events = append(o.events, event)
		o.mu.Unlock()
	}
	o.next.ServeHTTP(w, r)
}

func (o *orderLog) since(mark int) []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.events[mark:]...)
}

func (o *orderLog) size() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.events)
}

func indexOf(events []string, event string) int {
	for index, e := range events {
		if e == event {
			return index
		}
	}
	return -1
}

func countOf(events []string, event string) int {
	count := 0
	for _, e := range events {
		if e == event {
			count++
		}
	}
	return count
}

func TestContextDispatchCallSemanticsUnrecordedReleaseRecoversThroughPollCycle(t *testing.T) {
	for _, tc := range []struct {
		name                 string
		failAbort, failUnset bool
	}{
		{"abort_fails", true, false},
		{"unassign_fails", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, f := semanticsCase(t, "continue_project", "produces_decision")
			h := recordReleases(t, c, f)
			o := &orderLog{next: h}
			server := httptest.NewServer(o)
			t.Cleanup(server.Close)
			client := valaris.NewClient(server.URL, "synthetic-key")
			client.Agent, client.UserID = c.loop.client.Agent, c.loop.client.UserID
			c.loop.client = client
			// Hold the poll's routine prompt and config refreshes back, so a
			// config request is the released role's own refresh.
			c.loop.refreshTTL = time.Hour
			c.loop.lastPromptCacheRefresh, c.loop.lastPlatformCfgRefresh = time.Now(), time.Now()
			h.mu.Lock()
			h.failAbort, h.failUnassign = tc.failAbort, tc.failUnset
			h.mu.Unlock()
			h.serve(servedConfig(2, withKind(c.strategy.config, "produces_note")))

			if err := duringRateWait(t, c, f, startedAgain(f), setFlag("post_process_kind", "produces_note"), c.loop.tick); !configurationChanged(err) {
				t.Errorf("a release that failed to record was reported as done: %v", err)
			}
			released := o.size()
			_ = nextTick(t, c, f, c.loop.tick)
			if pending := o.since(released); countOf(pending, "assign")+countOf(pending, "start")+countOf(pending, "prepare") != 0 {
				t.Errorf("new work before the cleanup was acknowledged: %v", pending)
			}
			if gets := h.configRequests(); gets != 0 {
				t.Errorf("the role was refreshed before its cleanup was recorded: %d config requests", gets)
			}

			h.mu.Lock()
			h.failAbort, h.failUnassign = false, false
			h.mu.Unlock()
			next := noteProvider(c, f)
			h.mu.Lock()
			cleanupMark := len(h.cleanup)
			h.mu.Unlock()
			mark := o.size()
			for polls := 0; polls < 2 && next.CallCount() == 0; polls++ {
				_ = nextTick(t, c, f, func(ctx context.Context) error {
					c.loop.pollCycle(ctx, ctx)
					return nil
				})
			}
			recovery := o.since(mark)

			unassign, config, start, prepare := indexOf(recovery, "unassign"), indexOf(recovery, "config"), indexOf(recovery, "start"), indexOf(recovery, "prepare")
			if countOf(recovery, "unassign") != 1 {
				t.Errorf("want the pending unassign finished once in recovery, got %v", recovery)
			}
			h.mu.Lock()
			aborts := 0
			for _, update := range h.statusUpdates {
				if update["status"] == "aborted" {
					aborts++
				}
			}
			finished := strings.Join(h.cleanup[cleanupMark:], ",")
			h.mu.Unlock()
			// Only the steps still pending are finished: a failed abort is
			// acknowledged, then the participant removed; an acknowledged
			// abort is not repeated, only the unassign.
			want := "unassign"
			if tc.failAbort {
				want = "abort,unassign"
			}
			if finished != want {
				t.Errorf("recovery cleanup = %q, want %q", finished, want)
			}
			if tc.failUnset && aborts != 1 {
				t.Errorf("the acknowledged abort was repeated: %d aborted PATCHes overall", aborts)
			}
			if unassign < 0 || config < unassign {
				t.Errorf("the role was not refreshed after its cleanup was recorded: %v", recovery)
			}
			if indexOf(recovery[:max(unassign, 0)], "config") >= 0 {
				t.Errorf("the role was refreshed before its cleanup was recorded: %v", recovery)
			}
			if start < config || prepare < config {
				t.Errorf("new work did not wait for the role's refresh: %v", recovery)
			}
			expectNoteCall(t, f, h, next, 1)
		})
	}
}
