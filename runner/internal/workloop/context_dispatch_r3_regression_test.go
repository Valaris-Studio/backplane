// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// redirectingPreparations answers the first preparation request (every one,
// for "loop") with a redirect and passes everything else to the invocation
// fixture, counting every request, of any method, that reaches the
// preparation route and the redirect's off-route target.
type redirectingPreparations struct {
	next   http.Handler
	status int
	target string // "same", "loop", "away_and_back" or "away"
	// replay answers preparations with the fixture's acknowledgement under
	// 200, as the server replays an already committed request.
	replay   bool
	mu       sync.Mutex
	posts    int
	offRoute int
}

// replayWriter turns the fixture's 201 acknowledgement into a 200 replay.
type replayWriter struct{ http.ResponseWriter }

func (w replayWriter) WriteHeader(status int) {
	if status == http.StatusCreated {
		status = http.StatusOK
	}
	w.ResponseWriter.WriteHeader(status)
}

const offRoutePath = "/elsewhere"

func (h *redirectingPreparations) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	switch {
	case r.URL.Path == offRoutePath:
		h.offRoute++
		h.mu.Unlock()
		if h.target == "away_and_back" {
			http.Redirect(w, r, r.URL.Query().Get("back"), h.status)
			return
		}
		h.next.ServeHTTP(w, r)
		return
	case strings.HasSuffix(r.URL.Path, "/dispatch-preparations"):
		h.posts++
		redirect := h.status != 0 && (h.posts == 1 || h.target == "loop")
		h.mu.Unlock()
		if redirect {
			switch h.target {
			case "same", "loop":
				http.Redirect(w, r, r.URL.Path, h.status)
			default:
				http.Redirect(w, r, offRoutePath+"?back="+r.URL.Path, h.status)
			}
			return
		}
		if h.replay {
			h.next.ServeHTTP(replayWriter{w}, r)
			return
		}
	default:
		h.mu.Unlock()
	}
	h.next.ServeHTTP(w, r)
}

// redirectingCase is an invocation case whose bound execution is already
// started, now preparing through h.
func redirectingCase(t *testing.T, h *redirectingPreparations) (*invocationCase, *invocationHTTP) {
	t.Helper()
	f := newInvocationHTTP()
	c := newInvocationCase(t, f, "continue_project")
	h.next = f
	server := httptest.NewServer(h)
	t.Cleanup(server.Close)
	client := valaris.NewClient(server.URL, "synthetic-key")
	client.Agent = c.loop.client.Agent
	c.loop.client = client
	return c, f
}

// A redirected preparation is a definite refusal: no redirect is followed,
// nothing is sent again or elsewhere, the failure is never an ambiguous
// (retryable) outcome, and no provider runs.
func TestContextDispatchPreparationRefusesRedirectsBeforeFollowing(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		target string
	}{
		{"same_endpoint_307", http.StatusTemporaryRedirect, "same"},
		{"same_endpoint_308", http.StatusPermanentRedirect, "same"},
		{"same_endpoint_301", http.StatusMovedPermanently, "same"},
		{"same_endpoint_302", http.StatusFound, "same"},
		{"same_endpoint_303", http.StatusSeeOther, "same"},
		{"loop_307", http.StatusTemporaryRedirect, "loop"},
		{"away_and_back_307", http.StatusTemporaryRedirect, "away_and_back"},
		{"off_route_308", http.StatusPermanentRedirect, "away"},
		{"off_route_303", http.StatusSeeOther, "away"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			h := &redirectingPreparations{status: tc.status, target: tc.target}
			c, f := redirectingCase(t, h)
			err := c.run(context.Background())
			if err == nil {
				t.Error("a redirected preparation was accepted")
			}
			if errors.Is(err, valaris.ErrAmbiguousPreparation) {
				t.Errorf("a redirect was treated as an ambiguous, retryable outcome: %v", err)
			}
			h.mu.Lock()
			posts, offRoute := h.posts, h.offRoute
			h.mu.Unlock()
			f.mu.Lock()
			defer f.mu.Unlock()
			if posts != 1 || offRoute != 0 || len(f.payloads) != 0 {
				t.Errorf("redirect was followed: preparation-route requests=%d off-route=%d fixture preparations=%d", posts, offRoute, len(f.payloads))
			}
			if c.current.CallCount()+c.stale.CallCount() != 0 {
				t.Errorf("redirected preparation reached a provider: current=%d stale=%d", c.current.CallCount(), c.stale.CallCount())
			}
		})
	}
}

func TestContextDispatchPreparationWithoutRedirectStillPrepares(t *testing.T) {
	for _, replay := range []bool{false, true} {
		name := "created_201"
		if replay {
			name = "replayed_200"
		}
		t.Run(name, func(t *testing.T) { preparesOnceThrough(t, &redirectingPreparations{replay: replay}) })
	}
}

func preparesOnceThrough(t *testing.T, h *redirectingPreparations) {
	t.Helper()
	c, f := redirectingCase(t, h)
	if err := c.run(context.Background()); err != nil {
		t.Fatalf("ordinary preparation refused: %v", err)
	}
	h.mu.Lock()
	posts := h.posts
	h.mu.Unlock()
	f.mu.Lock()
	defer f.mu.Unlock()
	if posts != 1 || len(f.payloads) != 1 || c.current.CallCount() != 1 {
		t.Errorf("ordinary preparation counts: posts=%d preparations=%d provider=%d", posts, len(f.payloads), c.current.CallCount())
	}
}

// Nested members the runner consumes are taken only in their contract types:
// a null or non-string deny entry, or a null, missing or non-list deny, never
// coerces into a list that loses the configured restriction, and null context
// values or indices never coerce to "" or 0.
func TestContextDispatchSnapshotRefusesCoercedNestedMembers(t *testing.T) {
	dispatch := func(s map[string]any) map[string]any { return s["dispatch"].(map[string]any) }
	changes := map[string]func(map[string]any){
		"deny_null_entry":           func(s map[string]any) { dispatch(s)["tool_policy"] = map[string]any{"deny": []any{nil}} },
		"deny_number_entry":         func(s map[string]any) { dispatch(s)["tool_policy"] = map[string]any{"deny": []any{1}} },
		"deny_not_list":             func(s map[string]any) { dispatch(s)["tool_policy"] = map[string]any{"deny": "Bash(rm:*)"} },
		"deny_missing":              func(s map[string]any) { dispatch(s)["tool_policy"] = map[string]any{} },
		"deny_null":                 func(s map[string]any) { dispatch(s)["tool_policy"] = map[string]any{"deny": nil} },
		"context_null_value":        func(s map[string]any) { s["context"] = map[string]any{"approved": nil} },
		"context_number_value":      func(s map[string]any) { s["context"] = map[string]any{"approved": 1} },
		"required_null_index":       func(s map[string]any) { dispatch(s)["required_source_indices"] = []any{nil} },
		"required_string_index":     func(s map[string]any) { dispatch(s)["required_source_indices"] = []any{"0"} },
		"required_fractional_index": func(s map[string]any) { dispatch(s)["required_source_indices"] = []any{0.5} },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			f := newInvocationHTTP()
			change(f.snapshot)
			c := newInvocationCase(t, f, "continue_project")
			if err := c.run(context.Background()); err == nil {
				t.Error("a snapshot with a coerced nested member was accepted")
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.payloads) != 0 || c.current.CallCount()+c.stale.CallCount() != 0 {
				t.Errorf("coerced snapshot escaped its boundary: preparations=%d current=%d stale=%d", len(f.payloads), c.current.CallCount(), c.stale.CallCount())
			}
		})
	}
}

func TestContextDispatchSnapshotKeepsValidEmptyAndNullableMembers(t *testing.T) {
	dispatch := func(s map[string]any) map[string]any { return s["dispatch"].(map[string]any) }
	changes := map[string]func(map[string]any){
		"explicit_empty_deny": func(s map[string]any) { dispatch(s)["tool_policy"] = map[string]any{"deny": []string{}} },
		"empty_string_deny":   func(s map[string]any) { dispatch(s)["tool_policy"] = map[string]any{"deny": []string{""}} },
		"null_tools":          func(s map[string]any) { dispatch(s)["tools"] = nil },
		"null_card_field":     func(s map[string]any) { s["card"].(map[string]any)["assignee_id"] = nil },
		"future_card_key":     func(s map[string]any) { s["card"].(map[string]any)["future_key"] = map[string]any{"nested": nil} },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			f := newInvocationHTTP()
			change(f.snapshot)
			c := newInvocationCase(t, f, "continue_project")
			if err := c.run(context.Background()); err != nil {
				t.Fatalf("valid snapshot refused: %v", err)
			}
			f.mu.Lock()
			defer f.mu.Unlock()
			if len(f.payloads) != 1 || c.current.CallCount() != 1 {
				t.Fatalf("valid snapshot counts: preparations=%d provider=%d", len(f.payloads), c.current.CallCount())
			}
			// An actual deny string is transported verbatim, the empty one too.
			if deny := c.current.LastCall().Options.DisallowedTools; name == "empty_string_deny" && !reflect.DeepEqual(deny, []string{""}) {
				t.Errorf("deny [\"\"] was not kept verbatim: %q", deny)
			}
		})
	}
}
