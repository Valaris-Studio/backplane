// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// newLabelAwareScanServer mirrors newFilterScanServer but honors the `label` query
// parameter on /cards/search — reflecting the real backend's server-side label filter.
func newLabelAwareScanServer(t *testing.T, cards []valaris.Card, includeGitRepo bool) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		method := r.Method

		if serveDefaultPlatformConfig(w, r) {
			return
		}

		if strings.HasSuffix(path, "/boards") && method == http.MethodGet && !strings.Contains(path, "/cards") {
			json.NewEncoder(w).Encode([]valaris.Board{{ID: "board-1", Name: "Test"}})
			return
		}

		if strings.Contains(path, "/cards/search") {
			wantLabel := r.URL.Query().Get("label")
			if wantLabel == "" {
				json.NewEncoder(w).Encode(cards)
				return
			}
			var filtered []valaris.Card
			for _, c := range cards {
				for _, l := range c.Labels {
					if l == wantLabel {
						filtered = append(filtered, c)
						break
					}
				}
			}
			json.NewEncoder(w).Encode(filtered)
			return
		}

		if strings.Contains(path, "/git-repos") {
			if includeGitRepo {
				json.NewEncoder(w).Encode([]valaris.GitRepo{{ID: "r1", Name: "repo", URL: "https://github.com/acme/widget.git", DefaultBranch: "main"}})
			} else {
				json.NewEncoder(w).Encode([]valaris.GitRepo{})
			}
			return
		}

		w.Write([]byte("{}"))
	}))
}

// serveDefaultPlatformConfig answers GET /api/agents/me/config with
// DefaultPipelineConfig — Loop.New requires a pipeline at construction time.
// Returns true when the request was handled.
func serveDefaultPlatformConfig(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != "/api/agents/me/config" {
		return false
	}
	json.NewEncoder(w).Encode(map[string]any{
		"agent_id":   "agent-1",
		"name":       "test",
		"agent_type": "coding",
		"is_active":  true,
		"workspace_config": map[string]any{
			"pipeline_config": DefaultPipelineConfig,
		},
	})
	return true
}

// --- I.1.i: include_label filter — column_scan path ---

func TestDiscoverColumnScan_IncludeLabel_Matches(t *testing.T) {
	cards := []valaris.Card{
		{ID: "card-1", BoardID: "board-1", Title: "Reviewer card", ColumnType: "review", Labels: []string{"role:reviewer"}},
	}
	server := newLabelAwareScanServer(t, cards, true)
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "reviewer",
		Discover: valaris.DiscoverDef{
			Strategy:   "column_scan",
			ColumnType: "review",
			Filters: map[string]any{
				"include_label":    "role:reviewer",
				"require_git_repo": true,
			},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverColumnScan(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverColumnScan: %v", err)
	}
	if res.CardID != "card-1" {
		t.Errorf("expected card-1 (label matches), got %q", res.CardID)
	}
}

func TestDiscoverColumnScan_IncludeLabel_NoMatch(t *testing.T) {
	cards := []valaris.Card{
		{ID: "card-1", BoardID: "board-1", Title: "Implementer card", Labels: []string{"role:implementer"}},
	}
	server := newLabelAwareScanServer(t, cards, true)
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "reviewer",
		Discover: valaris.DiscoverDef{
			Strategy:   "column_scan",
			ColumnType: "review",
			Filters: map[string]any{
				"include_label":    "role:reviewer",
				"require_git_repo": true,
			},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverColumnScan(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverColumnScan: %v", err)
	}
	if res.CardID != "" {
		t.Errorf("expected empty result (no label match), got %q", res.CardID)
	}
}

func TestDiscoverColumnScan_IncludeLabel_Empty(t *testing.T) {
	// Regression guard: when include_label is absent, all candidates are considered
	// (today's behavior must stay bit-for-bit identical).
	cards := []valaris.Card{
		{ID: "card-1", BoardID: "board-1", Title: "No labels", ColumnType: "review"},
	}
	server := newLabelAwareScanServer(t, cards, true)
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "reviewer",
		Discover: valaris.DiscoverDef{
			Strategy:   "column_scan",
			ColumnType: "review",
			Filters: map[string]any{
				"require_git_repo": true,
			},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverColumnScan(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverColumnScan: %v", err)
	}
	if res.CardID != "card-1" {
		t.Errorf("expected card-1 (no filter), got %q", res.CardID)
	}
}

func TestDiscoverColumnScan_IncludeLabel_CombinedWithExcludeLabel(t *testing.T) {
	// include match + exclude non-match → candidate returned.
	cards := []valaris.Card{
		{ID: "card-1", BoardID: "board-1", Title: "Ready", ColumnType: "review", Labels: []string{"role:reviewer"}},
	}
	server := newLabelAwareScanServer(t, cards, true)
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "reviewer",
		Discover: valaris.DiscoverDef{
			Strategy:   "column_scan",
			ColumnType: "review",
			Filters: map[string]any{
				"include_label":    "role:reviewer",
				"exclude_label":    "reviewed",
				"require_git_repo": true,
			},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverColumnScan(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverColumnScan: %v", err)
	}
	if res.CardID != "card-1" {
		t.Errorf("expected card-1 (include matches, exclude doesn't), got %q", res.CardID)
	}
}

func TestDiscoverColumnScan_IncludeLabel_CombinedWithExcludeLabel_Conflict(t *testing.T) {
	// Card carries both the include and exclude labels → exclude wins.
	// Rationale: exclude_label marks "already handled"; we never pick up
	// work that's already been completed, even if the role tag still matches.
	cards := []valaris.Card{
		{ID: "card-1", BoardID: "board-1", Title: "Done twice", Labels: []string{"role:reviewer", "reviewed"}},
	}
	server := newLabelAwareScanServer(t, cards, true)
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "reviewer",
		Discover: valaris.DiscoverDef{
			Strategy:   "column_scan",
			ColumnType: "review",
			Filters: map[string]any{
				"include_label":    "role:reviewer",
				"exclude_label":    "reviewed",
				"require_git_repo": true,
			},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverColumnScan(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverColumnScan: %v", err)
	}
	if res.CardID != "" {
		t.Errorf("expected empty (exclude wins on conflict), got %q", res.CardID)
	}
}

// --- I.1.i: include_label filter — unassigned_or_rework path ---

func TestDiscover_IncludeLabel_UnassignedFlow_Matches(t *testing.T) {
	// Unassigned card in backlog with matching label → returned.
	cards := []valaris.Card{
		{ID: "card-1", BoardID: "board-1", Title: "Research me", Priority: "medium", Labels: []string{"role:researcher"}},
	}
	server := newDiscoverUnassignedServer(t, cards, true)
	defer server.Close()

	loop := buildDiscoverLoop(t, server.URL)
	res, err := loop.discover(context.Background(), "role:researcher", false)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if res.CardID != "card-1" {
		t.Errorf("expected card-1 (label matches), got %q", res.CardID)
	}
}

func TestDiscover_IncludeLabel_UnassignedFlow_NoMatch(t *testing.T) {
	// Unassigned card lacking the label → skipped.
	cards := []valaris.Card{
		{ID: "card-1", BoardID: "board-1", Title: "Ship me", Priority: "medium", Labels: []string{"role:implementer"}},
	}
	server := newDiscoverUnassignedServer(t, cards, true)
	defer server.Close()

	loop := buildDiscoverLoop(t, server.URL)
	res, err := loop.discover(context.Background(), "role:researcher", false)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if res.CardID != "" {
		t.Errorf("expected empty (no label match), got %q", res.CardID)
	}
}

func TestDiscover_IncludeLabel_Empty_UnchangedBehavior(t *testing.T) {
	// Regression guard for the default pipeline: empty include_label means
	// no filtering — any unassigned card qualifies.
	cards := []valaris.Card{
		{ID: "card-1", BoardID: "board-1", Title: "Unlabeled", Priority: "medium"},
	}
	server := newDiscoverUnassignedServer(t, cards, true)
	defer server.Close()

	loop := buildDiscoverLoop(t, server.URL)
	res, err := loop.discover(context.Background(), "", false)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if res.CardID != "card-1" {
		t.Errorf("expected card-1 (no filter), got %q", res.CardID)
	}
}

func TestDiscover_IncludeLabel_ReworkFlow_Matches(t *testing.T) {
	// Rework card assigned to this agent with matching label → returned.
	cards := []valaris.Card{
		{
			ID: "card-1", BoardID: "board-1", Title: "Rework me", Labels: []string{"role:researcher"},
			Participants: []valaris.CardParticipant{{AgentID: "agent-1", UserID: "user-1", Role: "hero"}},
		},
	}
	server := newDiscoverReworkServer(t, cards, true)
	defer server.Close()

	loop := buildDiscoverLoop(t, server.URL)
	res, err := loop.discover(context.Background(), "role:researcher", false)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if res.CardID != "card-1" {
		t.Errorf("expected card-1 (rework w/ matching label), got %q", res.CardID)
	}
	if !res.Rework {
		t.Errorf("expected Rework=true")
	}
}

func TestDiscover_IncludeLabel_ReworkFlow_NoMatch(t *testing.T) {
	// Rework card assigned to this agent but lacking the label → skipped.
	// Critical: a researcher shouldn't pick up rework cards they didn't originate.
	cards := []valaris.Card{
		{
			ID: "card-1", BoardID: "board-1", Title: "Other rework", Labels: []string{"role:implementer"},
			Participants: []valaris.CardParticipant{{AgentID: "agent-1", UserID: "user-1", Role: "hero"}},
		},
	}
	server := newDiscoverReworkServer(t, cards, true)
	defer server.Close()

	loop := buildDiscoverLoop(t, server.URL)
	res, err := loop.discover(context.Background(), "role:researcher", false)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if res.CardID != "" {
		t.Errorf("expected empty (no label match on rework), got %q", res.CardID)
	}
}

// --- Untyped-column defense-in-depth: runner must skip cards whose column_type is empty ---

func TestDiscoverColumnScan_SkipsCardWithEmptyColumnType(t *testing.T) {
	// Even with both cards present in the server response, only the typed one is picked.
	cards := []valaris.Card{
		{ID: "card-untyped", BoardID: "board-1", Title: "Not claimable", ColumnType: ""},
		{ID: "card-active", BoardID: "board-1", Title: "Claimable", ColumnType: "active"},
	}
	server := newLabelAwareScanServer(t, cards, true)
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "implementer",
		Discover: valaris.DiscoverDef{
			Strategy:   "column_scan",
			ColumnType: "active",
			Filters: map[string]any{
				"require_git_repo": true,
			},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverColumnScan(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverColumnScan: %v", err)
	}
	if res.CardID != "card-active" {
		t.Errorf("expected card-active (typed), got %q", res.CardID)
	}
}

func TestDiscoverColumnScan_HonorsBackendFilterButDefendsInDepth(t *testing.T) {
	// Backend mistakenly returns an untyped card alone. Runner must refuse
	// to claim it — empty result, not card-untyped.
	cards := []valaris.Card{
		{ID: "card-untyped", BoardID: "board-1", Title: "Not claimable", ColumnType: ""},
	}
	server := newLabelAwareScanServer(t, cards, true)
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "implementer",
		Discover: valaris.DiscoverDef{
			Strategy:   "column_scan",
			ColumnType: "active",
			Filters: map[string]any{
				"require_git_repo": true,
			},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverColumnScan(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverColumnScan: %v", err)
	}
	if res.CardID != "" {
		t.Errorf("expected empty (runner rejects untyped), got %q", res.CardID)
	}
}

// --- helpers scoped to this file ---

func buildDiscoverLoop(t *testing.T, serverURL string) *Loop {
	t.Helper()
	cfg := &config.Config{
		Valaris: config.ValarisConfig{
			WorkspaceSlug: "test-workspace",
		},
	}
	client := valaris.NewClient(serverURL, "vlr_test")
	client.UserID = "user-1"
	client.Agent = &valaris.AgentConfig{ID: "agent-1", Name: "test", AgentType: "coding", IsActive: true}
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop, err := New(context.Background(), client, llm.NewMockProvider(), gitMgr, cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return loop
}

// newDiscoverUnassignedServer handles the "unassigned card" branch: SearchCards
// is called with has_assignee=false plus (optionally) a label filter.
func newDiscoverUnassignedServer(t *testing.T, cards []valaris.Card, includeGitRepo bool) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		method := r.Method

		if serveDefaultPlatformConfig(w, r) {
			return
		}

		if strings.HasSuffix(path, "/boards") && method == http.MethodGet && !strings.Contains(path, "/cards") {
			json.NewEncoder(w).Encode([]valaris.Board{{ID: "board-1", Name: "Test"}})
			return
		}

		if strings.Contains(path, "/cards/search") {
			query := r.URL.Query()
			wantLabel := query.Get("label")
			assigneeID := query.Get("assignee_id")

			// Rework search path — only return assigned cards.
			if assigneeID != "" {
				var matched []valaris.Card
				for _, c := range cards {
					for _, p := range c.Participants {
						if p.AgentID == assigneeID || p.UserID == assigneeID {
							if wantLabel == "" || cardHasLabel(c, wantLabel) {
								matched = append(matched, c)
							}
							break
						}
					}
				}
				json.NewEncoder(w).Encode(matched)
				return
			}

			// Unassigned search path — skip cards with participants.
			var matched []valaris.Card
			for _, c := range cards {
				if len(c.Participants) > 0 {
					continue
				}
				if wantLabel != "" && !cardHasLabel(c, wantLabel) {
					continue
				}
				matched = append(matched, c)
			}
			json.NewEncoder(w).Encode(matched)
			return
		}

		if strings.Contains(path, "/git-repos") {
			if includeGitRepo {
				json.NewEncoder(w).Encode([]valaris.GitRepo{{ID: "r1", Name: "repo", URL: "https://github.com/acme/widget.git", DefaultBranch: "main"}})
			} else {
				json.NewEncoder(w).Encode([]valaris.GitRepo{})
			}
			return
		}

		w.Write([]byte("{}"))
	}))
}

// newDiscoverReworkServer handles the "rework" branch: SearchCards with assignee_id
// returns cards assigned to that agent. Used to probe the rework path specifically.
func newDiscoverReworkServer(t *testing.T, cards []valaris.Card, includeGitRepo bool) *httptest.Server {
	return newDiscoverUnassignedServer(t, cards, includeGitRepo)
}

// --- Cluster II Gap 3: list-valued label filters (string-or-list parity) ---

func TestDiscoverColumnScan_ExcludeLabel_List_RejectsAnyListed(t *testing.T) {
	// exclude_label as a list rejects a card carrying ANY of the labels.
	cards := []valaris.Card{
		{ID: "card-1", BoardID: "board-1", Title: "carries 2nd excluded", ColumnType: "review", Labels: []string{"needs-ui-validation"}},
		{ID: "card-2", BoardID: "board-1", Title: "clean", ColumnType: "review", Labels: []string{"backend"}},
	}
	server := newLabelAwareScanServer(t, cards, true)
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "reviewer",
		Discover: valaris.DiscoverDef{
			Strategy:   "column_scan",
			ColumnType: "review",
			Filters: map[string]any{
				"exclude_label":    []any{"planned", "needs-ui-validation"},
				"require_git_repo": true,
			},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverColumnScan(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverColumnScan: %v", err)
	}
	if res.CardID != "card-2" {
		t.Errorf("expected card-2 (card-1 has a listed excluded label), got %q", res.CardID)
	}
}

func TestDiscoverColumnScan_IncludeLabel_List_RequiresAllTokens(t *testing.T) {
	// include_label as a list keeps only cards carrying EVERY listed label.
	cards := []valaris.Card{
		{ID: "card-1", BoardID: "board-1", Title: "only one", ColumnType: "review", Labels: []string{"ui"}},
		{ID: "card-2", BoardID: "board-1", Title: "has both", ColumnType: "review", Labels: []string{"ui", "needs-validation", "backend"}},
	}
	server := newLabelAwareScanServer(t, cards, true)
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "reviewer",
		Discover: valaris.DiscoverDef{
			Strategy:   "column_scan",
			ColumnType: "review",
			Filters: map[string]any{
				"include_label":    []any{"ui", "needs-validation"},
				"require_git_repo": true,
			},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverColumnScan(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverColumnScan: %v", err)
	}
	if res.CardID != "card-2" {
		t.Errorf("expected card-2 (carries both required labels), got %q", res.CardID)
	}
}
