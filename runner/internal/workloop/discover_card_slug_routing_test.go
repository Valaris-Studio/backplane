// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

// M3 (run-2 adversarial review): the legacy discover constructors stamped
// repos[0].Slug onto every result, ignoring the card's OWN git_repo_slug. On a
// multi-repo board that silently re-routes a card registered against repo B to
// repo A — the exact misroute the backend's repo-slug-unresolved park exists to
// catch. Rule (mirrors discoverResultFromAssignment): the card's slug is
// authoritative — when it names a registered repo, that repo is the clone
// target and the slug rides along; when it names NO registered repo the slug
// stays EMPTY (never invented) and repos[0] remains the clone target so the
// backend park catches the misroute.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

func slugRoutingRepos() []valaris.GitRepo {
	return []valaris.GitRepo{
		{ID: "r1", Slug: "backend", Name: "Backend Display", URL: "https://example.com/backend.git", DefaultBranch: "main"},
		{ID: "r2", Slug: "frontend", Name: "Frontend Display", URL: "https://example.com/frontend.git", DefaultBranch: "develop"},
	}
}

type slugRoutingCase struct {
	name     string
	cardSlug string
	wantSlug string
	wantURL  string
}

func slugRoutingCases() []slugRoutingCase {
	repos := slugRoutingRepos()
	return []slugRoutingCase{
		{
			name:     "card slug matching a registered repo resolves that repo",
			cardSlug: "frontend",
			wantSlug: "frontend",
			wantURL:  repos[1].URL,
		},
		{
			name:     "unknown card slug stays empty and keeps first repo as clone target",
			cardSlug: "ghost",
			wantSlug: "", // never invent a slug — the backend park catches the misroute
			wantURL:  repos[0].URL,
		},
		{
			name:     "card without a slug keeps historic first-repo behavior",
			cardSlug: "",
			wantSlug: "backend",
			wantURL:  repos[0].URL,
		},
	}
}

// newMultiRepoFallbackServer mirrors newLegacyFallbackServer (404 on
// /next-assignment → legacy fallback engages) but serves a configurable
// multi-repo /git-repos list.
func newMultiRepoFallbackServer(t *testing.T, repos []valaris.GitRepo, search func(q url.Values) []valaris.Card) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		if serveDefaultPlatformConfig(w, r) {
			return
		}

		switch {
		case strings.Contains(path, "/next-assignment"):
			w.WriteHeader(http.StatusNotFound)
			w.Write([]byte(`{"detail":"Not Found"}`))
		case strings.HasSuffix(path, "/boards") && r.Method == http.MethodGet && !strings.Contains(path, "/cards"):
			json.NewEncoder(w).Encode([]valaris.Board{{ID: "board-1", Name: "Test"}})
		case strings.Contains(path, "/cards/search"):
			cards := search(r.URL.Query())
			if cards == nil {
				cards = []valaris.Card{}
			}
			json.NewEncoder(w).Encode(cards)
		case strings.Contains(path, "/git-repos"):
			json.NewEncoder(w).Encode(repos)
		default:
			w.Write([]byte("{}"))
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestLegacyDiscover_UnassignedScan_RoutesByCardOwnSlug(t *testing.T) {
	for _, tc := range slugRoutingCases() {
		t.Run(tc.name, func(t *testing.T) {
			card := valaris.Card{
				ID: "card-1", BoardID: "board-1", Title: "Routed",
				Priority: "high", GitRepoSlug: tc.cardSlug,
			}
			// Only the unassigned pass (has_assignee=false) sees the card.
			server := newMultiRepoFallbackServer(t, slugRoutingRepos(), func(q url.Values) []valaris.Card {
				if q.Get("has_assignee") == "false" {
					return []valaris.Card{card}
				}
				return nil
			})

			loop := mustNewLoop(t, testClientWithURL(server.URL), llm.NewMockProvider(),
				&git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}, testConfig())

			res, err := loop.discover(context.Background(), "", false)
			if err != nil {
				t.Fatalf("discover: %v", err)
			}
			if res.CardID != "card-1" {
				t.Fatalf("expected card-1, got %q", res.CardID)
			}
			if res.GitRepoSlug != tc.wantSlug {
				t.Errorf("GitRepoSlug = %q, want %q", res.GitRepoSlug, tc.wantSlug)
			}
			if res.GitRepoURL != tc.wantURL {
				t.Errorf("GitRepoURL = %q, want %q", res.GitRepoURL, tc.wantURL)
			}
		})
	}
}

func TestLegacyDiscover_ReworkScan_RoutesByCardOwnSlug(t *testing.T) {
	for _, tc := range slugRoutingCases() {
		t.Run(tc.name, func(t *testing.T) {
			card := valaris.Card{
				ID: "card-1", BoardID: "board-1", Title: "Rework",
				ColumnType: "active", GitRepoSlug: tc.cardSlug,
			}
			// Only the rework pass (assignee_id set) sees the card.
			server := newMultiRepoFallbackServer(t, slugRoutingRepos(), func(q url.Values) []valaris.Card {
				if q.Get("assignee_id") != "" {
					return []valaris.Card{card}
				}
				return nil
			})

			loop := mustNewLoop(t, testClientWithURL(server.URL), llm.NewMockProvider(),
				&git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}, testConfig())

			res, err := loop.discover(context.Background(), "", false)
			if err != nil {
				t.Fatalf("discover: %v", err)
			}
			if res.CardID != "card-1" {
				t.Fatalf("expected card-1, got %q", res.CardID)
			}
			if !res.Rework {
				t.Error("expected the rework pass to produce the result")
			}
			if res.GitRepoSlug != tc.wantSlug {
				t.Errorf("GitRepoSlug = %q, want %q", res.GitRepoSlug, tc.wantSlug)
			}
			if res.GitRepoURL != tc.wantURL {
				t.Errorf("GitRepoURL = %q, want %q", res.GitRepoURL, tc.wantURL)
			}
		})
	}
}

func TestDiscoverColumnScan_RoutesByCardOwnSlug(t *testing.T) {
	for _, tc := range slugRoutingCases() {
		t.Run(tc.name, func(t *testing.T) {
			card := valaris.Card{
				ID: "card-1", BoardID: "board-1", Title: "Audit target",
				ColumnType: "done", GitRepoSlug: tc.cardSlug,
			}
			server := newMultiRepoFallbackServer(t, slugRoutingRepos(), func(q url.Values) []valaris.Card {
				return []valaris.Card{card}
			})

			stage := valaris.StageConfig{
				Role: "auditor",
				Discover: valaris.DiscoverDef{
					Strategy:   "column_scan",
					ColumnType: "done",
					Filters:    map[string]any{"require_git_repo": true},
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
			if res.GitRepoSlug != tc.wantSlug {
				t.Errorf("GitRepoSlug = %q, want %q", res.GitRepoSlug, tc.wantSlug)
			}
			if res.GitRepoURL != tc.wantURL {
				t.Errorf("GitRepoURL = %q, want %q", res.GitRepoURL, tc.wantURL)
			}
		})
	}
}
