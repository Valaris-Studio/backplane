// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// A card parked for approval keeps the strategy its role had at park time.
// Once that role is paused, or withdrawn by its refresh, after a stage
// configuration change, the approval is never resumed on that stale
// strategy: no claim, no label removal, nothing on the card.

const (
	parkedCardID     = "00000000-0000-4000-8000-000000000170"
	parkedApprovalID = "00000000-0000-4000-8000-000000000171"
)

// parkedCardWatch answers the parked approval's status (approved unless
// status is set) and records every request that touches the parked card.
type parkedCardWatch struct {
	next    http.Handler
	status  string
	mu      sync.Mutex
	touched []string
}

func (w *parkedCardWatch) ServeHTTP(rw http.ResponseWriter, r *http.Request) {
	if strings.HasSuffix(r.URL.Path, "/approvals/"+parkedApprovalID) {
		rw.Header().Set("Content-Type", "application/json")
		status := w.status
		if status == "" {
			status = "approved"
		}
		_ = json.NewEncoder(rw).Encode(map[string]any{"id": parkedApprovalID, "status": status})
		return
	}
	if strings.Contains(r.URL.Path, parkedCardID) {
		w.mu.Lock()
		w.touched = append(w.touched, r.Method+" "+r.URL.Path)
		w.mu.Unlock()
	}
	w.next.ServeHTTP(rw, r)
}

func TestContextDispatchCallSemanticsParkedApprovalOfADisabledRoleIsNotResumed(t *testing.T) {
	for _, why := range []string{"paused", "withdrawn"} {
		for _, flow := range []string{"legacy", "required"} {
			t.Run(why+"_"+flow, func(t *testing.T) {
				c, f := semanticsCase(t, "continue_project", "produces_decision")
				h := recordReleases(t, c, f)
				watch := &parkedCardWatch{next: h}
				server := httptest.NewServer(watch)
				t.Cleanup(server.Close)
				client := valaris.NewClient(server.URL, "synthetic-key")
				client.Agent, client.UserID = c.loop.client.Agent, c.loop.client.UserID
				c.loop.client = client
				c.loop.parkedApprovals = map[string]*parkedApproval{}

				// Another card of the role, parked for approval before the
				// release with the role's strategy as it was then. A legacy
				// park has no required hold.
				parked := *c.card
				parked.CardID = parkedCardID
				if flow == "legacy" {
					parked.Dispatch = nil
				}
				c.loop.parkApproval(&parkedApproval{
					ApprovalID: parkedApprovalID, CardID: parkedCardID, Role: c.strategy.config.Role,
					Card: &parked, Strategy: c.strategy, ParkedAt: time.Now(),
				})

				if why == "paused" {
					// The release cannot be recorded, so the role pauses.
					h.mu.Lock()
					h.failAbort = true
					h.mu.Unlock()
				} else {
					h.serve(servedConfig(2, otherStage()))
				}
				_ = duringRateWait(t, c, f, startedAgain(f), setFlag("post_process_kind", "produces_note"), c.loop.tick)

				if flow == "legacy" {
					// The server's policy is legacy again when the approval
					// is decided, so nothing but the role's state stands
					// between the park and a resume.
					f.base.mu.Lock()
					f.base.contract["mode"], f.base.contract["minimum_version"] = "legacy", 0
					f.base.mu.Unlock()
				}
				before := claims(f)
				providerCalls := c.current.CallCount() + c.stale.CallCount()
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				c.loop.resumeDecidedApprovals(ctx)

				watch.mu.Lock()
				touched := append([]string(nil), watch.touched...)
				watch.mu.Unlock()
				if len(touched) != 0 {
					t.Errorf("the approval of a %s role was resumed on its stale strategy: %v", why, touched)
				}
				if after := claims(f); after != before {
					t.Errorf("resuming the approval of a %s role started %d executions or assignments", why, after-before)
				}
				if calls := c.current.CallCount() + c.stale.CallCount(); calls != providerCalls {
					t.Errorf("resuming the approval of a %s role called a provider %d times", why, calls-providerCalls)
				}
				if why == "paused" {
					c.loop.parkedApprovalsMu.Lock()
					_, stillParked := c.loop.parkedApprovals[parkedCardID]
					c.loop.parkedApprovalsMu.Unlock()
					if !stillParked {
						t.Error("the approval of a paused role was let go instead of staying parked")
					}
				}
			})
		}
	}
}

// A rejected approval of a disabled role is never silently dropped: its
// terminal handling (the card blocked, its failures counted to the
// threshold) is applied exactly once.
//   - paused: the rejection waits, parked, while the role is paused, and is
//     applied by the poll that records the role's release and refreshes it.
//   - withdrawn: the rejection is applied when it is decided, as the base
//     before the pause change (edc05869) does; whether a withdrawn role's
//     rejection should instead wait for a human is left to root.
func TestContextDispatchCallSemanticsRejectedApprovalOfADisabledRoleIsNotDropped(t *testing.T) {
	for _, why := range []string{"paused", "withdrawn"} {
		t.Run(why, func(t *testing.T) {
			c, f := semanticsCase(t, "continue_project", "produces_decision")
			h := recordReleases(t, c, f)
			watch := &parkedCardWatch{next: h, status: "rejected"}
			server := httptest.NewServer(watch)
			t.Cleanup(server.Close)
			client := valaris.NewClient(server.URL, "synthetic-key")
			client.Agent, client.UserID = c.loop.client.Agent, c.loop.client.UserID
			c.loop.client = client
			c.loop.parkedApprovals = map[string]*parkedApproval{}
			parked := *c.card
			parked.CardID = parkedCardID
			c.loop.parkApproval(&parkedApproval{
				ApprovalID: parkedApprovalID, CardID: parkedCardID, Role: c.strategy.config.Role,
				Card: &parked, Strategy: c.strategy, ParkedAt: time.Now(),
			})
			if why == "paused" {
				h.mu.Lock()
				h.failAbort = true
				h.mu.Unlock()
			} else {
				h.serve(servedConfig(2, otherStage()))
			}
			_ = duringRateWait(t, c, f, startedAgain(f), setFlag("post_process_kind", "produces_note"), c.loop.tick)

			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			c.loop.resumeDecidedApprovals(ctx)
			isParked := func() bool {
				c.loop.parkedApprovalsMu.Lock()
				defer c.loop.parkedApprovalsMu.Unlock()
				_, ok := c.loop.parkedApprovals[parkedCardID]
				return ok
			}
			threshold := c.loop.WorkspaceConfig().MaxReworkAttempts
			if why == "withdrawn" {
				if count := c.loop.CardFailureCount(parkedCardID); count != threshold {
					t.Errorf("the rejection of a withdrawn role's approval was dropped: failures %d, want %d", count, threshold)
				}
				return
			}

			if !isParked() {
				t.Error("the rejection of a paused role's approval was let go instead of waiting parked")
			}
			if count := c.loop.CardFailureCount(parkedCardID); count != 0 {
				t.Errorf("the rejection was applied on the paused role's stale strategy: failures %d", count)
			}
			h.mu.Lock()
			h.failAbort = false
			h.mu.Unlock()
			h.serve(servedConfig(2, withKind(c.strategy.config, "produces_note")))
			_ = nextTick(t, c, f, func(ctx context.Context) error {
				c.loop.pollCycle(ctx, ctx)
				return nil
			})
			if count := c.loop.CardFailureCount(parkedCardID); count != threshold {
				t.Errorf("the rejection was not applied once the role recovered: failures %d, want %d", count, threshold)
			}
			if isParked() {
				t.Error("the rejected approval is still parked after it was applied")
			}
		})
	}
}
