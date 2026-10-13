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

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// controlPlaneRedirect answers the first request matching route with a
// redirect (to itself, or off-route for "away") and passes everything else
// to next, counting every request on the route and on the off-route target.
type controlPlaneRedirect struct {
	next     http.Handler
	route    func(*http.Request) bool
	status   int
	away     bool
	mu       sync.Mutex
	hits     int
	offRoute int
}

func (h *controlPlaneRedirect) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	if r.URL.Path == offRoutePath {
		h.offRoute++
		h.mu.Unlock()
		h.next.ServeHTTP(w, r)
		return
	}
	redirect := false
	if h.route(r) {
		h.hits++
		redirect = h.status != 0 && h.hits == 1
	}
	h.mu.Unlock()
	if redirect {
		target := r.URL.RequestURI()
		if h.away {
			target = offRoutePath
		}
		http.Redirect(w, r, target, h.status)
		return
	}
	h.next.ServeHTTP(w, r)
}

func (h *controlPlaneRedirect) counts() (hits, offRoute int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.hits, h.offRoute
}

var controlPlaneRedirects = []struct {
	name   string
	status int
	away   bool
}{
	{"same_endpoint_307", http.StatusTemporaryRedirect, false},
	{"same_endpoint_308", http.StatusPermanentRedirect, false},
	{"same_endpoint_303", http.StatusSeeOther, false},
	{"off_route_307", http.StatusTemporaryRedirect, true},
}

// routePath matches every request on the route, whatever its method, so a
// redirect rewritten from POST to GET still counts as reaching it.
func routePath(suffix string) func(*http.Request) bool {
	return func(r *http.Request) bool { return strings.HasSuffix(r.URL.Path, suffix) }
}

// redirectingNegotiation is the negotiation fixture served through h.
func redirectingNegotiation(t *testing.T, f *runnerDispatchHTTP, h *controlPlaneRedirect, compat bool) (*Loop, *DataDrivenStrategy, *llm.MockProvider) {
	t.Helper()
	loop, strategy, provider := runnerDispatchLoop(t, f, false, compat, "hero")
	h.next = f
	server := httptest.NewServer(h)
	t.Cleanup(server.Close)
	client := valaris.NewClient(server.URL, "synthetic-key")
	client.Agent = loop.client.Agent
	loop.client = client
	return loop, strategy, provider
}

// Every negotiated control-plane request refuses a redirect before following
// it: nothing is sent again or elsewhere, no work is started or assigned
// past it, and no provider runs.
func TestContextDispatchControlPlaneRefusesRedirectsBeforeFollowing(t *testing.T) {
	for _, call := range []struct {
		name  string
		route func(*http.Request) bool
	}{
		{"contract_get", routePath("/context-dispatch-contract")},
		{"assignment_post", routePath("/next-assignment")},
		{"bound_start_post", routePath("/executions")},
	} {
		for _, redirect := range controlPlaneRedirects {
			t.Run(call.name+"_"+redirect.name, func(t *testing.T) {
				h := &controlPlaneRedirect{route: call.route, status: redirect.status, away: redirect.away}
				f := newRunnerDispatchHTTP()
				loop, strategy, provider := redirectingNegotiation(t, f, h, false)
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				card, err := strategy.discoverWithConfig(ctx, loop)
				if err == nil && card != nil {
					_, err = strategy.claimWithConfig(ctx, loop, card)
				}
				if err == nil {
					t.Error("a redirected control-plane request was accepted")
				}
				hits, offRoute := h.counts()
				if hits != 1 || offRoute != 0 {
					t.Errorf("redirect was followed: route requests=%d off-route=%d", hits, offRoute)
				}
				f.mu.Lock()
				defer f.mu.Unlock()
				if f.legacyCalls != 0 || f.startCalls != 0 || provider.CallCount() != 0 {
					t.Errorf("redirect escaped into fallback, a start or inference: legacy=%d starts=%d provider=%d", f.legacyCalls, f.startCalls, provider.CallCount())
				}
			})
		}
	}
}

func TestContextDispatchControlPlaneWithoutRedirectStillNegotiates(t *testing.T) {
	t.Run("negotiated_assignment_and_bound_start", func(t *testing.T) {
		h := &controlPlaneRedirect{route: routePath("/next-assignment")}
		f := newRunnerDispatchHTTP()
		loop, strategy, _ := redirectingNegotiation(t, f, h, false)
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		card, err := strategy.discoverWithConfig(ctx, loop)
		if err != nil || card == nil {
			t.Fatalf("ordinary negotiated discovery: card=%v err=%v", card, err)
		}
		if execution, err := strategy.claimWithConfig(ctx, loop, card); err != nil || execution != runnerDispatchExecution {
			t.Fatalf("ordinary bound start: execution=%q err=%v", execution, err)
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.assignmentCalls != 1 || f.startCalls != 1 || f.legacyCalls != 0 {
			t.Errorf("ordinary counts: assignments=%d starts=%d legacy=%d", f.assignmentCalls, f.startCalls, f.legacyCalls)
		}
	})
	t.Run("old_backend_explicit_compat_404", func(t *testing.T) {
		f := newRunnerDispatchHTTP()
		f.contractStatus, f.assignmentStatus = 404, 404
		h := &controlPlaneRedirect{route: routePath("/context-dispatch-contract")}
		loop, strategy, _ := redirectingNegotiation(t, f, h, true)
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if _, err := strategy.discoverWithConfig(ctx, loop); err != nil {
			t.Fatalf("explicit old-backend compatibility refused: %v", err)
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		if f.legacyCalls != 1 {
			t.Errorf("old backend's bare 404 did not take the legacy path: legacy searches=%d", f.legacyCalls)
		}
	})
}

// The execution's snapshot refresh refuses a redirect the same way: nothing
// is prepared and no provider runs.
func TestContextDispatchSnapshotRefreshRefusesRedirectsBeforeFollowing(t *testing.T) {
	for _, redirect := range controlPlaneRedirects {
		t.Run(redirect.name, func(t *testing.T) {
			f := newInvocationHTTP()
			c := newInvocationCase(t, f, "continue_project")
			h := &controlPlaneRedirect{next: f, route: routePath("/dispatch-context"), status: redirect.status, away: redirect.away}
			server := httptest.NewServer(h)
			t.Cleanup(server.Close)
			client := valaris.NewClient(server.URL, "synthetic-key")
			client.Agent = c.loop.client.Agent
			c.loop.client = client
			if err := c.run(context.Background()); err == nil {
				t.Error("a redirected snapshot refresh was accepted")
			}
			hits, offRoute := h.counts()
			if hits != 1 || offRoute != 0 {
				t.Errorf("redirect was followed: refresh requests=%d off-route=%d", hits, offRoute)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.payloads) != 0 || c.current.CallCount()+c.stale.CallCount() != 0 {
				t.Errorf("redirected refresh escaped: preparations=%d current=%d stale=%d", len(f.payloads), c.current.CallCount(), c.stale.CallCount())
			}
		})
	}
}
