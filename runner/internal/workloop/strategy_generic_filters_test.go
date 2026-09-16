// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// buildFilterScanLoop wires a Loop with a given stage config against an httptest server.
// The stage is attached as both a single-strategy loop and used directly by discoverColumnScan.
func buildFilterScanLoop(t *testing.T, serverURL string, stage valaris.StageConfig) (*Loop, *DataDrivenStrategy) {
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
	s := NewDataDrivenStrategy(stage, nil)
	loop.strategy = s
	return loop, s
}

// --- Change 1: skip_if_participant_role filter ---

func TestDiscoverColumnScan_SkipIfParticipantRole_SkipsMatchingRole(t *testing.T) {
	// A tester role configured with skip_if_participant_role: "tester" should skip
	// any card where a participant has role "tester".
	cards := []valaris.Card{
		{
			ID: "card-1", BoardID: "board-1", Title: "Already tested",
			Participants: []valaris.CardParticipant{
				{UserID: "user-1", AgentID: "agent-1", Role: "tester"},
			},
		},
		{
			ID: "card-2", BoardID: "board-1", Title: "Fresh",
		},
	}
	server := newFilterScanServer(t, cards, true)
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "tester",
		Discover: valaris.DiscoverDef{
			Strategy:   "column_scan",
			ColumnType: "review",
			Filters: map[string]any{
				"skip_if_participant_role": "tester",
				"require_git_repo":         true,
			},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverColumnScan(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverColumnScan: %v", err)
	}
	if res.CardID != "card-2" {
		t.Errorf("expected card-2 (fresh), got %q", res.CardID)
	}
}

func TestDiscoverColumnScan_SkipIfParticipantRole_DifferentRoleNotSkipped(t *testing.T) {
	// A reviewer on the card should not block discovery for a tester role.
	cards := []valaris.Card{
		{
			ID: "card-1", BoardID: "board-1", Title: "Reviewed but not tested",
			Participants: []valaris.CardParticipant{
				{UserID: "user-1", AgentID: "agent-1", Role: "reviewer"},
			},
		},
	}
	server := newFilterScanServer(t, cards, true)
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "tester",
		Discover: valaris.DiscoverDef{
			Strategy:   "column_scan",
			ColumnType: "review",
			Filters: map[string]any{
				"skip_if_participant_role": "tester",
				"require_git_repo":         true,
			},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverColumnScan(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverColumnScan: %v", err)
	}
	if res.CardID != "card-1" {
		t.Errorf("expected card-1 (different participant role), got %q", res.CardID)
	}
}

func TestDiscoverColumnScan_SkipSelfReviewed_BackCompat(t *testing.T) {
	// Legacy boolean filter must still work exactly like skip_if_participant_role: "reviewer".
	cards := []valaris.Card{
		{
			ID: "card-1", BoardID: "board-1", Title: "Already reviewed by me",
			Participants: []valaris.CardParticipant{
				{UserID: "user-1", AgentID: "agent-1", Role: "reviewer"},
			},
		},
		{
			ID: "card-2", BoardID: "board-1", Title: "Fresh",
		},
	}
	server := newFilterScanServer(t, cards, true)
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "reviewer",
		Discover: valaris.DiscoverDef{
			Strategy:   "column_scan",
			ColumnType: "review",
			Filters: map[string]any{
				"skip_self_reviewed": true,
				"require_git_repo":   true,
			},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverColumnScan(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverColumnScan: %v", err)
	}
	if res.CardID != "card-2" {
		t.Errorf("expected card-2 (back-compat skip_self_reviewed), got %q", res.CardID)
	}
}

// --- Bonus: require_git_repo: false honored ---

func TestDiscoverColumnScan_RequireGitRepoFalse_AllowsCardsWithoutRepos(t *testing.T) {
	// When filter is explicitly false, cards should match even if the board has no git repo.
	cards := []valaris.Card{
		{ID: "card-1", BoardID: "board-1", Title: "No repo needed"},
	}
	server := newFilterScanServer(t, cards, false) // no git repos
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "secretary",
		Discover: valaris.DiscoverDef{
			Strategy:   "column_scan",
			ColumnType: "review",
			Filters: map[string]any{
				"require_git_repo": false,
			},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverColumnScan(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverColumnScan: %v", err)
	}
	if res.CardID != "card-1" {
		t.Errorf("expected card-1 (repos not required), got %q", res.CardID)
	}
}

func TestDiscoverColumnScan_RequireGitRepoTrue_SkipsCardsWithoutRepos(t *testing.T) {
	// Sanity check the positive case: when true, boards without repos skip the card.
	cards := []valaris.Card{
		{ID: "card-1", BoardID: "board-1", Title: "No repo"},
	}
	server := newFilterScanServer(t, cards, false) // no git repos
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
	if res.CardID != "" {
		t.Errorf("expected empty result (repo required but missing), got %q", res.CardID)
	}
}

// --- Change 2: addLabel generic (no tagDocumented side-effects on non-doc stages) ---

func TestAddLabel_GenericPath_AddsLabelViaREST_NoExecutionUpdate(t *testing.T) {
	// Calling addLabel directly (not through the documentator flow) must:
	//   - GET the card
	//   - PATCH the card with labels including the new label
	//   - NOT call LogExecutionUpdate (that was documentator-specific)
	var (
		mu               sync.Mutex
		getCardCalled    bool
		patchCalled      bool
		patchedLabels    []string
		execUpdateCalled bool
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		path := r.URL.Path

		if strings.Contains(path, "/executions/") && r.Method == http.MethodPatch {
			execUpdateCalled = true
			w.Write([]byte("{}"))
			return
		}

		if strings.Contains(path, "/cards/card-1") && r.Method == http.MethodGet {
			getCardCalled = true
			json.NewEncoder(w).Encode(valaris.Card{
				ID: "card-1", BoardID: "board-1", Title: "A", Labels: []string{"existing"},
			})
			return
		}

		if strings.Contains(path, "/cards/card-1") && r.Method == http.MethodPatch {
			patchCalled = true
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			if labels, ok := body["labels"].([]any); ok {
				for _, l := range labels {
					patchedLabels = append(patchedLabels, fmt.Sprintf("%v", l))
				}
			}
			w.Write([]byte("{}"))
			return
		}

		w.Write([]byte("{}"))
	}))
	defer server.Close()

	stage := valaris.StageConfig{Role: "tester"}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	card := &discoverResult{CardID: "card-1", BoardID: "board-1", Title: "A"}
	s.addLabel(context.Background(), loop, card, "tested")

	mu.Lock()
	defer mu.Unlock()
	if !getCardCalled {
		t.Error("addLabel should GET the card to read current labels")
	}
	if !patchCalled {
		t.Error("addLabel should PATCH the card with updated labels")
	}
	if execUpdateCalled {
		t.Error("generic addLabel must NOT call LogExecutionUpdate (doc-specific behavior)")
	}
	// Verify the new label is present alongside existing labels.
	foundNew, foundExisting := false, false
	for _, l := range patchedLabels {
		if l == "tested" {
			foundNew = true
		}
		if l == "existing" {
			foundExisting = true
		}
	}
	if !foundNew {
		t.Errorf("PATCH labels should contain new label 'tested', got %v", patchedLabels)
	}
	if !foundExisting {
		t.Errorf("PATCH labels should preserve 'existing', got %v", patchedLabels)
	}
}

func TestAddLabel_IdempotentWhenLabelAlreadyPresent(t *testing.T) {
	// If the card already has the label, we should not PATCH again.
	var (
		mu          sync.Mutex
		patchCalled bool
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		path := r.URL.Path

		if strings.Contains(path, "/cards/card-1") && r.Method == http.MethodGet {
			json.NewEncoder(w).Encode(valaris.Card{
				ID: "card-1", BoardID: "board-1", Labels: []string{"tested"},
			})
			return
		}

		if strings.Contains(path, "/cards/card-1") && r.Method == http.MethodPatch {
			patchCalled = true
			w.Write([]byte("{}"))
			return
		}

		w.Write([]byte("{}"))
	}))
	defer server.Close()

	stage := valaris.StageConfig{Role: "tester"}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	card := &discoverResult{CardID: "card-1", BoardID: "board-1"}
	s.addLabel(context.Background(), loop, card, "tested")

	mu.Lock()
	defer mu.Unlock()
	if patchCalled {
		t.Error("addLabel should be idempotent: no PATCH when label already present")
	}
}

// --- Change 3: RemoveLabel field + REST wiring ---

func TestActionDef_RemoveLabel_JSONField(t *testing.T) {
	// RemoveLabel should round-trip through JSON as "remove_label".
	data := `{"remove_label": "needs-testing"}`
	var action valaris.ActionDef
	if err := json.Unmarshal([]byte(data), &action); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if action.RemoveLabel != "needs-testing" {
		t.Errorf("RemoveLabel = %q, want needs-testing", action.RemoveLabel)
	}
}

func TestRemoveLabel_RemovesLabelViaREST(t *testing.T) {
	var (
		mu            sync.Mutex
		patchCalled   bool
		patchedLabels []string
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		path := r.URL.Path

		if strings.Contains(path, "/cards/card-1") && r.Method == http.MethodGet {
			json.NewEncoder(w).Encode(valaris.Card{
				ID: "card-1", BoardID: "board-1", Labels: []string{"tested", "keep"},
			})
			return
		}

		if strings.Contains(path, "/cards/card-1") && r.Method == http.MethodPatch {
			patchCalled = true
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			if labels, ok := body["labels"].([]any); ok {
				for _, l := range labels {
					patchedLabels = append(patchedLabels, fmt.Sprintf("%v", l))
				}
			}
			w.Write([]byte("{}"))
			return
		}

		w.Write([]byte("{}"))
	}))
	defer server.Close()

	stage := valaris.StageConfig{Role: "tester"}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	card := &discoverResult{CardID: "card-1", BoardID: "board-1"}
	s.removeLabel(context.Background(), loop, card, "tested")

	mu.Lock()
	defer mu.Unlock()
	if !patchCalled {
		t.Fatal("removeLabel should PATCH the card")
	}
	for _, l := range patchedLabels {
		if l == "tested" {
			t.Errorf("PATCH labels should not contain removed 'tested', got %v", patchedLabels)
		}
	}
	foundKeep := false
	for _, l := range patchedLabels {
		if l == "keep" {
			foundKeep = true
		}
	}
	if !foundKeep {
		t.Errorf("PATCH labels should preserve 'keep', got %v", patchedLabels)
	}
}

func TestRemoveLabel_NoopWhenLabelAbsent(t *testing.T) {
	var (
		mu          sync.Mutex
		patchCalled bool
	)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		path := r.URL.Path

		if strings.Contains(path, "/cards/card-1") && r.Method == http.MethodGet {
			json.NewEncoder(w).Encode(valaris.Card{
				ID: "card-1", BoardID: "board-1", Labels: []string{"other"},
			})
			return
		}

		if strings.Contains(path, "/cards/card-1") && r.Method == http.MethodPatch {
			patchCalled = true
			w.Write([]byte("{}"))
			return
		}

		w.Write([]byte("{}"))
	}))
	defer server.Close()

	stage := valaris.StageConfig{Role: "tester"}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	card := &discoverResult{CardID: "card-1", BoardID: "board-1"}
	s.removeLabel(context.Background(), loop, card, "tested")

	mu.Lock()
	defer mu.Unlock()
	if patchCalled {
		t.Error("removeLabel should be a no-op when label not present")
	}
}

// --- Default config compatibility ---

func TestDefaultPipelineConfig_ReviewerUsesNewFilterKey(t *testing.T) {
	// The default reviewer stage should use skip_if_participant_role ("reviewer")
	// instead of the legacy skip_self_reviewed key.
	stage := StageForRole(DefaultPipelineConfig, "reviewer")
	if stage == nil {
		t.Fatal("reviewer stage missing")
	}
	got, _ := stage.Discover.Filters["skip_if_participant_role"].(string)
	if got != "reviewer" {
		t.Errorf("reviewer skip_if_participant_role = %q, want 'reviewer'", got)
	}
}

// --- Helpers ---

// newFilterScanServer spins up a minimal API server for discoverColumnScan tests.
// If includeGitRepo is true, /git-repos returns one repo; otherwise it returns an empty list.
func newFilterScanServer(t *testing.T, cards []valaris.Card, includeGitRepo bool) *httptest.Server {
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
			wantColumnType := r.URL.Query().Get("column_type")
			hydrated := make([]valaris.Card, 0, len(cards))
			for _, c := range cards {
				if c.ColumnType == "" && wantColumnType != "" {
					c.ColumnType = wantColumnType
				}
				hydrated = append(hydrated, c)
			}
			json.NewEncoder(w).Encode(hydrated)
			return
		}

		if strings.Contains(path, "/git-repos") {
			if includeGitRepo {
				// NOTE: this fixture intentionally omits Provider/RequireBranchProtection
				// (leaving them zero-valued) to exercise the LEGACY back-compat path
				// through shouldEnsureBranchProtection — blank provider → treated as
				// github, RequireBranchProtection=false → gate skips protection setup.
				// If you're adding a new fixture that SHOULD exercise the protection
				// path, set Provider="github" and RequireBranchProtection=true
				// explicitly. See TestDiscoverColumnScan_PropagatesProviderAndBranchProtection
				// below for the shape — this is the footgun that caused ST#12's
				// missed 4th seed site (T2.3c) to ship green.
				json.NewEncoder(w).Encode([]valaris.GitRepo{{ID: "r1", Name: "repo", URL: "https://github.com/acme/widget.git", DefaultBranch: "main"}})
			} else {
				json.NewEncoder(w).Encode([]valaris.GitRepo{})
			}
			return
		}

		w.Write([]byte("{}"))
	}))
}

// T2.3c regression: discoverColumnScan must propagate GitRepoProvider and
// RequireBranchProtection from the backend's git_repo record into discoverResult.
// The 4th seed site (strategy_generic.go:639-648) was missed in a56b9a9 and the
// resulting zero-valued fields silently short-circuited shouldEnsureBranchProtection,
// breaking Alpha auto-merge end-to-end in smoke test ST#12.
func TestDiscoverColumnScan_PropagatesProviderAndBranchProtection(t *testing.T) {
	cards := []valaris.Card{
		{ID: "card-1", BoardID: "board-1", Title: "Backlog pick"},
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		path := r.URL.Path
		method := r.Method

		if strings.HasSuffix(path, "/boards") && method == http.MethodGet && !strings.Contains(path, "/cards") {
			json.NewEncoder(w).Encode([]valaris.Board{{ID: "board-1", Name: "Test"}})
			return
		}
		if strings.Contains(path, "/cards/search") {
			wantColumnType := r.URL.Query().Get("column_type")
			hydrated := make([]valaris.Card, 0, len(cards))
			for _, c := range cards {
				if c.ColumnType == "" && wantColumnType != "" {
					c.ColumnType = wantColumnType
				}
				hydrated = append(hydrated, c)
			}
			json.NewEncoder(w).Encode(hydrated)
			return
		}
		if strings.Contains(path, "/git-repos") {
			json.NewEncoder(w).Encode([]valaris.GitRepo{{
				ID:                      "r1",
				Name:                    "repo",
				URL:                     "https://github.com/acme/widget.git",
				DefaultBranch:           "main",
				Provider:                "github",
				RequireBranchProtection: true,
			}})
			return
		}
		w.Write([]byte("{}"))
	}))
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "implementer",
		Discover: valaris.DiscoverDef{
			Strategy:   "column_scan",
			ColumnType: "backlog",
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
		t.Fatalf("expected card-1, got %q", res.CardID)
	}
	if res.GitRepoProvider != "github" {
		t.Errorf("GitRepoProvider = %q, want \"github\"", res.GitRepoProvider)
	}
	if !res.RequireBranchProtection {
		t.Errorf("RequireBranchProtection = false, want true")
	}
}

// --- Card f11f32dc: canonical skip key + default-on guard for review stages ---

// TestDiscoverColumnScan_SelfParticipationGuard covers the resolution order of
// the self-participation guard and the review-kind default. Each case scans two
// cards: card-1 carries a self-participant with the stage's own role, card-2 is
// untouched. wantCard says which one the stage is allowed to pick up.
func TestDiscoverColumnScan_SelfParticipationGuard(t *testing.T) {
	tests := []struct {
		name       string
		role       string
		columnType string
		filters    map[string]any
		selfRole   string
		wantCard   string
	}{
		{
			name:       "canonical skip_if_pipeline_role is honored",
			role:       "security_auditor",
			columnType: "review",
			filters:    map[string]any{"skip_if_pipeline_role": "security_auditor"},
			selfRole:   "security_auditor",
			wantCard:   "card-2",
		},
		{
			name:       "canonical key wins over the deprecated alias",
			role:       "security_auditor",
			columnType: "review",
			filters: map[string]any{
				"skip_if_pipeline_role":    "security_auditor",
				"skip_if_participant_role": "someone_else",
			},
			selfRole: "security_auditor",
			wantCard: "card-2",
		},
		{
			name:       "review stage with no skip key defaults to its own role",
			role:       "security_auditor",
			columnType: "review",
			filters:    map[string]any{},
			selfRole:   "security_auditor",
			wantCard:   "card-2",
		},
		{
			name:       "allow_self_participant opts out of the default",
			role:       "security_auditor",
			columnType: "review",
			filters:    map[string]any{"allow_self_participant": true},
			selfRole:   "security_auditor",
			wantCard:   "card-1",
		},
		{
			name:       "explicit skip key still wins over allow_self_participant",
			role:       "security_auditor",
			columnType: "review",
			filters: map[string]any{
				"skip_if_pipeline_role":  "security_auditor",
				"allow_self_participant": true,
			},
			selfRole: "security_auditor",
			wantCard: "card-2",
		},
		{
			name:       "non-review column types get no defaulted guard",
			role:       "implementer",
			columnType: "backlog",
			filters:    map[string]any{},
			selfRole:   "implementer",
			wantCard:   "card-1",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cards := []valaris.Card{
				{
					ID: "card-1", BoardID: "board-1", Title: "Self-participated",
					Participants: []valaris.CardParticipant{
						{UserID: "user-1", AgentID: "agent-1", Role: tc.selfRole},
					},
				},
				{ID: "card-2", BoardID: "board-1", Title: "Fresh"},
			}
			server := newFilterScanServer(t, cards, true)
			defer server.Close()

			filters := map[string]any{"require_git_repo": true}
			for k, v := range tc.filters {
				filters[k] = v
			}
			stage := valaris.StageConfig{
				Role: tc.role,
				Discover: valaris.DiscoverDef{
					Strategy:   "column_scan",
					ColumnType: tc.columnType,
					Filters:    filters,
				},
			}
			loop, s := buildFilterScanLoop(t, server.URL, stage)

			res, err := s.discoverColumnScan(context.Background(), loop)
			if err != nil {
				t.Fatalf("discoverColumnScan: %v", err)
			}
			if res.CardID != tc.wantCard {
				t.Errorf("CardID = %q, want %q", res.CardID, tc.wantCard)
			}
		})
	}
}
