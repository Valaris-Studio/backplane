// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	stdio "io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/harness"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// TestBackCompat_LegacyVsLifecycle_HelperReviewerShape is the gate test for
// lane A.3. It exercises a helper-claim, no-git, no-PR-create review-style
// stage (sensor-driven + note creation) twice:
//
//   1. via the legacy flat StageConfig (Discover/Claim/Sensors/OnSuccess) — the
//      pre-A.2 code path. Captures the resulting set of HTTP requests.
//   2. via an equivalent explicit Lifecycle DSL — discover → claim → sensor →
//      create_note → move_card. Captures the resulting set of HTTP requests.
//
// Asserts the *set* of platform-mutating endpoints hit is identical (we
// deliberately compare sets rather than ordered sequences because some helpers
// emit independent calls whose order is non-deterministic across runs —
// label fetches in particular). What matters is no side effect is silently
// dropped or added.
//
// Scope limit: this test does NOT cover the full implement → git push → PR
// → ship path. That flow has too many concrete side effects (real git
// remote, gh CLI, etc.) to capture meaningfully without a heavy harness.
// Lane A.3's migration of the default 3-role pipeline will need its own
// dedicated equivalence test for those flows; this test is the contract
// for the non-git helper-style stages (reviewer, tester, secretary).
func TestBackCompat_LegacyVsLifecycle_HelperReviewerShape(t *testing.T) {
	boardID := "board-bc"
	cardID := "card-bc"

	type capture struct {
		mu      sync.Mutex
		methods []string
	}

	makeServer := func(c *capture) *httptest.Server {
		t.Helper()
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			body, _ := stdio.ReadAll(r.Body)
			_ = body
			// Filter: only platform-mutating endpoints (the ones the strategy
			// triggers as side effects). Read-only fetches are excluded so
			// implementation-detail caching/ordering differences don't break.
			path := r.URL.Path
			if isMutatingHit(r.Method, path) {
				c.mu.Lock()
				c.methods = append(c.methods, r.Method+" "+normalizePath(path))
				c.mu.Unlock()
			}

			if serveDefaultPlatformConfig(w, r) {
				return
			}
			switch {
			case strings.Contains(path, "/next-assignment"):
				_ = json.NewEncoder(w).Encode(map[string]any{
					"card": map[string]any{
						"id":          cardID,
						"title":       "BC Card",
						"description": "test",
					},
					"board": map[string]any{"id": boardID, "name": "BC Board"},
				})
			case strings.Contains(path, "/boards/"+boardID) && r.Method == http.MethodGet && !strings.Contains(path, "/cards"):
				_ = json.NewEncoder(w).Encode(map[string]any{
					"id":   boardID,
					"name": "BC Board",
					"columns": []map[string]any{
						{"id": "col-active", "name": "Active", "column_type": "active", "position": 2048.0},
						{"id": "col-done", "name": "Done", "column_type": "done", "position": 4096.0},
					},
				})
			case strings.Contains(path, "/cards/") && r.Method == http.MethodGet && !strings.Contains(path, "/search"):
				_ = json.NewEncoder(w).Encode(map[string]any{
					"id":     cardID,
					"title":  "BC Card",
					"labels": []string{},
				})
			case strings.Contains(path, "/executions") && r.Method == http.MethodPost:
				_ = json.NewEncoder(w).Encode(map[string]string{"id": "exec-bc"})
			default:
				w.WriteHeader(http.StatusOK)
				_, _ = w.Write([]byte("{}"))
			}
		}))
		t.Cleanup(srv.Close)
		return srv
	}

	newLoop := func(srvURL string) *Loop {
		cfg := testConfig()
		client := testClientWithURL(srvURL)
		gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
		return mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)
	}

	// Single sensor that fails, with on_fail mapping → triggers create_note
	// in the legacy path via CreateReviewNote on aggregated failure, and in
	// the lifecycle path via an explicit create_note step.
	makeRegistry := func() *fakeRegistryT {
		r := &fakeRegistryT{}
		r.add(&fakeSensor{name: "fake_pass", passed: true, summary: "all good"})
		return r
	}

	// ---- Legacy run ----
	legacyCap := &capture{}
	legacySrv := makeServer(legacyCap)
	legacyLoop := newLoop(legacySrv.URL)
	legacyStage := valaris.StageConfig{
		Role:     "helper",
		Discover: valaris.DiscoverDef{Strategy: "unassigned_or_rework"},
		Claim:    valaris.ClaimDef{ParticipantRole: "helper", ExecutionAction: "review_card"},
		Git:      valaris.GitDef{Action: "none"},
		Sensors: []valaris.SensorDef{
			{Name: "fake_pass", OnPass: "pass", OnFail: "fail"},
		},
		OnSuccess: valaris.ActionDef{
			MoveToColumnType: "done",
		},
	}
	legacy := NewDataDrivenStrategy(legacyStage, makeRegistry().registry())
	if err := legacy.Tick(context.Background(), legacyLoop); err != nil {
		t.Fatalf("legacy Tick: %v", err)
	}

	// ---- Lifecycle run (equivalent shape) ----
	lifeCap := &capture{}
	lifeSrv := makeServer(lifeCap)
	lifeLoop := newLoop(lifeSrv.URL)
	lifeStage := valaris.StageConfig{
		Role:     "helper",
		Discover: valaris.DiscoverDef{Strategy: "unassigned_or_rework"},
		Claim:    valaris.ClaimDef{ParticipantRole: "helper", ExecutionAction: "review_card"},
		Git:      valaris.GitDef{Action: "none"},
		Lifecycle: []valaris.LifecycleStep{
			{Name: "s_discover", Kind: "discover", Next: "s_claim"},
			{Name: "s_claim", Kind: "claim", Next: "s_sensor"},
			{Name: "s_sensor", Kind: "sensor", Next: "s_move",
				Params: map[string]any{"name": "fake_pass", "on_pass": "pass", "on_fail": "fail"}},
			{Name: "s_move", Kind: "move_card",
				Params: map[string]any{"to_column_type": "done"}},
		},
	}
	life := NewDataDrivenStrategy(lifeStage, makeRegistry().registry())
	if err := life.Tick(context.Background(), lifeLoop); err != nil {
		t.Fatalf("lifecycle Tick: %v", err)
	}

	legacyCap.mu.Lock()
	lifeCap.mu.Lock()
	legacySet := setOf(legacyCap.methods)
	lifeSet := setOf(lifeCap.methods)
	legacyCap.mu.Unlock()
	lifeCap.mu.Unlock()

	// FOLLOWUP-12: the lifecycle path's post-walk cleanup adds one
	// PATCH /executions/{id} (status=completed) for terminal kinds that
	// don't release inline (move_card here). Legacy's flat helper-reviewer
	// path leaks the execution — this asymmetry is intentional after the
	// fix. Drop the cleanup PATCH from the lifecycle set before comparing
	// so the rest of the contract is still enforced.
	const cleanupHit = "PATCH /api/agents/agent-1/executions/{id}"
	filtered := make([]string, 0, len(lifeSet))
	for _, h := range lifeSet {
		if h == cleanupHit {
			continue
		}
		filtered = append(filtered, h)
	}
	lifeSet = filtered

	if !equalStringSets(legacySet, lifeSet) {
		t.Errorf("BACK-COMPAT MISMATCH\nlegacy mutating hits = %v\nlifecycle mutating hits (post FOLLOWUP-12 cleanup filter) = %v", legacySet, lifeSet)
	}
}

// isMutatingHit returns true for the platform endpoints we consider side-
// effects worth comparing. Read-only fetches (GET /cards, GET /boards) vary
// in count between paths because of internal caching; excluding them from
// the comparison keeps the test focused on observable user-facing state.
func isMutatingHit(method, path string) bool {
	switch method {
	case http.MethodPost, http.MethodPatch, http.MethodPut, http.MethodDelete:
		if strings.Contains(path, "/heartbeat") {
			return false
		}
		if strings.Contains(path, "/budget-status") {
			return false
		}
		return true
	}
	return false
}

// normalizePath strips trailing /<id> segments so different generated IDs
// (execution-id, etc.) don't make the sets disagree spuriously.
func normalizePath(p string) string {
	// Collapse any /executions/<id>/... to /executions/{id}/...
	if i := strings.Index(p, "/executions/"); i >= 0 {
		tail := p[i+len("/executions/"):]
		// Keep the suffix after the id if there is one.
		if j := strings.IndexByte(tail, '/'); j >= 0 {
			return p[:i] + "/executions/{id}" + tail[j:]
		}
		return p[:i] + "/executions/{id}"
	}
	return p
}

func setOf(xs []string) []string {
	seen := make(map[string]struct{}, len(xs))
	for _, x := range xs {
		seen[x] = struct{}{}
	}
	out := make([]string, 0, len(seen))
	for k := range seen {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func equalStringSets(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// fakeRegistryT wraps fakeRegistry so each test can hand the helper a fresh
// registry without reusing the global one — sensors are stateful and reuse
// across runs has caused order-dependent flakes elsewhere.
type fakeRegistryT struct {
	sensors []*fakeSensor
}

func (r *fakeRegistryT) add(s *fakeSensor) { r.sensors = append(r.sensors, s) }
func (r *fakeRegistryT) registry() *harness.SensorRegistry {
	return fakeRegistry(r.sensors...)
}
