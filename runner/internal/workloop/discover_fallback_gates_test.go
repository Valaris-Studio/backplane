// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

// Legacy-discover fallback correctness gates (card e6d468ab).
//
// When /next-assignment is unavailable the runner falls back to its legacy
// client-side scans. Those scans must OBEY the same correctness gates the
// backend scheduler enforces:
//
//  1. Dependency gating — a stage whose discover filters declare
//     all_dependencies_done must push that predicate into every fallback
//     card search (server-side SQL gate), so a dependency-blocked card is
//     NEVER reserved via the fallback.
//  2. Model authority — a stage that declares an llm model must never be
//     dispatched on the runner's yaml default. A concrete declared model is
//     stamped onto the discover result; an unresolvable tier alias refuses
//     fallback dispatch entirely (only the backend owns tier→model mapping).

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// searchRecorder captures every /cards/search query the fallback issues.
type searchRecorder struct {
	mu      sync.Mutex
	queries []url.Values
}

func (r *searchRecorder) record(q url.Values) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.queries = append(r.queries, q)
}

func (r *searchRecorder) all() []url.Values {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]url.Values, len(r.queries))
	copy(out, r.queries)
	return out
}

// newLegacyFallbackServer simulates a backend whose /next-assignment endpoint
// is unavailable (404 — the trigger for the legacy fallback) but whose card
// search still works. searchHandler maps the incoming query to the cards the
// "database" would return — letting tests mirror the server-side
// all_dependencies_done predicate.
func newLegacyFallbackServer(t *testing.T, searchHandler func(q url.Values) []valaris.Card) (*httptest.Server, *searchRecorder) {
	t.Helper()
	rec := &searchRecorder{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		if serveDefaultPlatformConfig(w, r) {
			return
		}

		if strings.Contains(path, "/next-assignment") {
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"detail":"Not Found"}`))
			return
		}

		if strings.HasSuffix(path, "/boards") && r.Method == http.MethodGet && !strings.Contains(path, "/cards") {
			json.NewEncoder(w).Encode([]valaris.Board{{ID: "board-1", Name: "Test"}})
			return
		}

		if strings.Contains(path, "/cards/search") {
			q := r.URL.Query()
			rec.record(q)
			cards := searchHandler(q)
			if cards == nil {
				cards = []valaris.Card{}
			}
			json.NewEncoder(w).Encode(cards)
			return
		}

		if strings.Contains(path, "/git-repos") {
			json.NewEncoder(w).Encode([]valaris.GitRepo{{ID: "r1", Name: "repo", URL: "https://github.com/acme/widget.git", DefaultBranch: "main"}})
			return
		}

		w.Write([]byte("{}"))
	}))
	return server, rec
}

// depGateAwareSearch mirrors the backend predicate for a card that is
// dependency-blocked: it only appears in results when the query does NOT
// carry all_dependencies_done=true.
func depGateAwareSearch(blockedCard valaris.Card) func(q url.Values) []valaris.Card {
	return func(q url.Values) []valaris.Card {
		if q.Get("all_dependencies_done") == "true" {
			return nil
		}
		return []valaris.Card{blockedCard}
	}
}

// --- Gate 1: dependency gating ---

func TestLegacyFallback_DepGate_UnassignedScan_NeverReturnsBlockedCard(t *testing.T) {
	blocked := valaris.Card{ID: "card-dep-blocked", BoardID: "board-1", Title: "Blocked by sibling", Priority: "high"}
	server, rec := newLegacyFallbackServer(t, depGateAwareSearch(blocked))
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "builder",
		Discover: valaris.DiscoverDef{
			Strategy:          "unassigned_or_rework",
			ColumnTypeExclude: "done",
			Filters: map[string]any{
				"require_git_repo":      true,
				"all_dependencies_done": true,
			},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverWithConfig(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverWithConfig: %v", err)
	}
	if res.CardID != "" {
		t.Errorf("fallback returned dependency-blocked card %q — must be empty", res.CardID)
	}

	queries := rec.all()
	if len(queries) == 0 {
		t.Fatalf("expected at least one /cards/search call")
	}
	for i, q := range queries {
		if q.Get("all_dependencies_done") != "true" {
			t.Errorf("search query %d missing all_dependencies_done=true: %v", i, q)
		}
	}
}

func TestLegacyFallback_DepGate_ColumnScan_NeverReturnsBlockedCard(t *testing.T) {
	blocked := valaris.Card{ID: "card-dep-blocked", BoardID: "board-1", Title: "Blocked audit target", ColumnType: "done"}
	server, rec := newLegacyFallbackServer(t, depGateAwareSearch(blocked))
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "auditor",
		Discover: valaris.DiscoverDef{
			Strategy:   "column_scan",
			ColumnType: "done",
			Filters: map[string]any{
				"require_git_repo":      true,
				"all_dependencies_done": true,
			},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverWithConfig(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverWithConfig: %v", err)
	}
	if res.CardID != "" {
		t.Errorf("fallback returned dependency-blocked card %q — must be empty", res.CardID)
	}

	queries := rec.all()
	if len(queries) == 0 {
		t.Fatalf("expected at least one /cards/search call")
	}
	for i, q := range queries {
		if q.Get("all_dependencies_done") != "true" {
			t.Errorf("search query %d missing all_dependencies_done=true: %v", i, q)
		}
	}
}

func TestLegacyFallback_DepGate_AbsentFilter_UnchangedBehavior(t *testing.T) {
	// Regression guard: a stage that does NOT declare the filter keeps the
	// pre-fix wire shape bit-for-bit (no all_dependencies_done param).
	card := valaris.Card{ID: "card-free", BoardID: "board-1", Title: "No deps declared", Priority: "medium"}
	server, rec := newLegacyFallbackServer(t, func(q url.Values) []valaris.Card {
		return []valaris.Card{card}
	})
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "builder",
		Discover: valaris.DiscoverDef{
			Strategy: "unassigned_or_rework",
			Filters: map[string]any{
				"require_git_repo": true,
			},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverWithConfig(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverWithConfig: %v", err)
	}
	if res.CardID != "card-free" {
		t.Errorf("expected card-free, got %q", res.CardID)
	}
	for i, q := range rec.all() {
		if q.Has("all_dependencies_done") {
			t.Errorf("search query %d unexpectedly carries all_dependencies_done: %v", i, q)
		}
	}
}

// --- Gate 2: model authority ---

func TestLegacyFallback_RefusesDispatch_OnUnresolvableTierModel(t *testing.T) {
	// The backend default config declares stage models as tier aliases
	// (premium/mid/low) that only the backend can resolve to a concrete
	// model. Dispatching the fallback would silently downgrade to the yaml
	// default — the fallback must refuse (no-work) instead.
	server, rec := newLegacyFallbackServer(t, func(q url.Values) []valaris.Card {
		return []valaris.Card{{ID: "card-1", BoardID: "board-1", Title: "Would downgrade", Priority: "high"}}
	})
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "builder",
		Discover: valaris.DiscoverDef{
			Strategy: "unassigned_or_rework",
			Filters:  map[string]any{"require_git_repo": true},
		},
		LLM: valaris.LLMDef{
			Enabled:  true,
			Stage:    "implement",
			Provider: "claude-cli",
			Model:    "premium",
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverWithConfig(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverWithConfig: %v", err)
	}
	if res.CardID != "" {
		t.Errorf("fallback dispatched card %q despite unresolvable tier model — must refuse", res.CardID)
	}
	if calls := len(rec.all()); calls != 0 {
		t.Errorf("fallback scanned cards (%d searches) despite refusing dispatch", calls)
	}
}

func TestLegacyFallback_StampsDeclaredConcreteModel(t *testing.T) {
	// A concrete declared model must ride along on the discover result so
	// llmOpts dispatches it — never the yaml default.
	server, _ := newLegacyFallbackServer(t, func(q url.Values) []valaris.Card {
		return []valaris.Card{{ID: "card-1", BoardID: "board-1", Title: "Keep my model", Priority: "high"}}
	})
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "builder",
		Discover: valaris.DiscoverDef{
			Strategy: "unassigned_or_rework",
			Filters:  map[string]any{"require_git_repo": true},
		},
		LLM: valaris.LLMDef{
			Enabled:  true,
			Stage:    "implement",
			Provider: "claude-cli",
			Model:    "opus",
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverWithConfig(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverWithConfig: %v", err)
	}
	if res.CardID != "card-1" {
		t.Fatalf("expected card-1, got %q", res.CardID)
	}
	if res.AssignmentLLM.Model != "opus" {
		t.Errorf("expected declared model 'opus' stamped on result, got %q", res.AssignmentLLM.Model)
	}
	if res.AssignmentLLM.Provider != "claude-cli" {
		t.Errorf("expected declared provider 'claude-cli', got %q", res.AssignmentLLM.Provider)
	}
}

func TestLegacyFallback_LifecycleLLMParams_TakePrecedenceOverFlatBlock(t *testing.T) {
	// Mirrors the backend's split-brain resolution (card b8024b15): the
	// pipeline builder writes provider/model into the lifecycle llm-step
	// params; when flat and lifecycle disagree, lifecycle is authoritative.
	server, _ := newLegacyFallbackServer(t, func(q url.Values) []valaris.Card {
		return []valaris.Card{{ID: "card-1", BoardID: "board-1", Title: "Lifecycle wins", Priority: "high"}}
	})
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "builder",
		Discover: valaris.DiscoverDef{
			Strategy: "unassigned_or_rework",
			Filters:  map[string]any{"require_git_repo": true},
		},
		LLM: valaris.LLMDef{
			Enabled: true,
			Stage:   "implement",
			Model:   "sonnet",
		},
		Lifecycle: []valaris.LifecycleStep{
			{Name: "work", Kind: "llm", Params: map[string]any{"stage": "implement", "provider": "claude-cli", "model": "opus"}},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverWithConfig(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverWithConfig: %v", err)
	}
	if res.CardID != "card-1" {
		t.Fatalf("expected card-1, got %q", res.CardID)
	}
	if res.AssignmentLLM.Model != "opus" {
		t.Errorf("lifecycle-declared model must win: expected 'opus', got %q", res.AssignmentLLM.Model)
	}
}

// M1 (run-2 adversarial review): the tier-alias refusal only matters when the
// stage would actually DISPATCH an LLM. A stage whose flat llm block is
// disabled (enabled: false), or whose lifecycle is sensor-only (no llm step),
// performs no LLM dispatch — refusing its fallback for an unresolvable tier
// alias just idles work that never needed the resolver.
func TestLegacyFallback_TierAlias_DisabledFlatLLM_DoesNotRefuse(t *testing.T) {
	server, _ := newLegacyFallbackServer(t, func(q url.Values) []valaris.Card {
		return []valaris.Card{{ID: "card-1", BoardID: "board-1", Title: "No dispatch anyway", Priority: "high"}}
	})
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "mover",
		Discover: valaris.DiscoverDef{
			Strategy: "unassigned_or_rework",
			Filters:  map[string]any{"require_git_repo": true},
		},
		LLM: valaris.LLMDef{
			Enabled: false, // disabled stage — no LLM dispatch occurs
			Stage:   "implement",
			Model:   "premium",
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverWithConfig(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverWithConfig: %v", err)
	}
	if res.CardID != "card-1" {
		t.Errorf("a stage with no enabled LLM dispatch must not be refused for a tier alias, got card %q", res.CardID)
	}
}

func TestLegacyFallback_TierAlias_SensorOnlyLifecycle_DoesNotRefuse(t *testing.T) {
	server, _ := newLegacyFallbackServer(t, func(q url.Values) []valaris.Card {
		return []valaris.Card{{ID: "card-1", BoardID: "board-1", Title: "Sensor only", Priority: "high"}}
	})
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "tester",
		Discover: valaris.DiscoverDef{
			Strategy: "unassigned_or_rework",
			Filters:  map[string]any{"require_git_repo": true},
		},
		// Stale flat block: lifecycle is present, so the flat fields are
		// ignored at runtime — the tier alias here must not refuse dispatch.
		LLM: valaris.LLMDef{Enabled: true, Stage: "implement", Model: "premium"},
		Lifecycle: []valaris.LifecycleStep{
			{Name: "probe", Kind: "sensor", Params: map[string]any{"sensor": "tests"}},
			{Name: "done", Kind: "end"},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverWithConfig(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverWithConfig: %v", err)
	}
	if res.CardID != "card-1" {
		t.Errorf("a sensor-only lifecycle stage must not be refused for a tier alias, got card %q", res.CardID)
	}
}

func TestLegacyFallback_TierAlias_LifecycleLLMStep_StillRefuses(t *testing.T) {
	// Control: a lifecycle that DOES dispatch an llm step keeps the refusal —
	// only the backend resolver can translate the tier alias.
	server, rec := newLegacyFallbackServer(t, func(q url.Values) []valaris.Card {
		return []valaris.Card{{ID: "card-1", BoardID: "board-1", Title: "Would downgrade", Priority: "high"}}
	})
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "builder",
		Discover: valaris.DiscoverDef{
			Strategy: "unassigned_or_rework",
			Filters:  map[string]any{"require_git_repo": true},
		},
		LLM: valaris.LLMDef{Enabled: false},
		Lifecycle: []valaris.LifecycleStep{
			{Name: "work", Kind: "llm", Params: map[string]any{"stage": "implement", "model": "premium"}},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverWithConfig(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverWithConfig: %v", err)
	}
	if res.CardID != "" {
		t.Errorf("a lifecycle llm step with a tier-alias model must refuse fallback dispatch, got %q", res.CardID)
	}
	if calls := len(rec.all()); calls != 0 {
		t.Errorf("fallback scanned cards (%d searches) despite refusing dispatch", calls)
	}
}

func TestLegacyFallback_NoDeclaredModel_PreservesYamlFallback(t *testing.T) {
	// Regression guard: a stage with no declared model anywhere keeps the
	// pre-fix behavior — card dispatched, AssignmentLLM left empty so
	// llmOpts falls back to the runner yaml (with its existing WARN).
	server, _ := newLegacyFallbackServer(t, func(q url.Values) []valaris.Card {
		return []valaris.Card{{ID: "card-1", BoardID: "board-1", Title: "Yaml era", Priority: "high"}}
	})
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "builder",
		Discover: valaris.DiscoverDef{
			Strategy: "unassigned_or_rework",
			Filters:  map[string]any{"require_git_repo": true},
		},
		LLM: valaris.LLMDef{
			Enabled: true,
			Stage:   "implement",
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverWithConfig(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverWithConfig: %v", err)
	}
	if res.CardID != "card-1" {
		t.Fatalf("expected card-1, got %q", res.CardID)
	}
	if res.AssignmentLLM.Model != "" {
		t.Errorf("expected empty AssignmentLLM.Model (yaml fallback), got %q", res.AssignmentLLM.Model)
	}
}
