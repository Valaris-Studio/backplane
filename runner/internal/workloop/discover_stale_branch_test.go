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

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// Cluster II Gap 4: the legacy repo-WIDE open-PR gate is RETIRED.
//
// The runner now PREFERS the backend `next_assignment` scheduler, whose
// open-PR precondition is CARD-scoped (it excludes the card's own branch) and
// shipped in commit 7245e5f. `discover()` only runs as a 404-only fallback to
// an older backend. The old repo-wide block ("if ANY repo PR is open, skip
// every card") was the wrong granularity: one stale/abandoned PR silently
// wedged the whole repo (client pilot 2026-05-27). Per the platform's
// backend-authoritative + card-scoped direction, the legacy path now
// fails-open — it claims the candidate regardless of open PRs and lets the
// authoritative scheduler own stale-baseline prevention.

// newStaleBranchServer mirrors newDiscoverUnassignedServer with a realistic
// GitHub repo URL on the board.
func newStaleBranchServer(t *testing.T, cards []valaris.Card, repoURL string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
			query := r.URL.Query()
			assigneeID := query.Get("assignee_id")
			if assigneeID != "" {
				var matched []valaris.Card
				for _, c := range cards {
					for _, p := range c.Participants {
						if p.AgentID == assigneeID || p.UserID == assigneeID {
							matched = append(matched, c)
							break
						}
					}
				}
				json.NewEncoder(w).Encode(matched)
				return
			}
			var matched []valaris.Card
			for _, c := range cards {
				if len(c.Participants) > 0 {
					continue
				}
				matched = append(matched, c)
			}
			json.NewEncoder(w).Encode(matched)
			return
		}

		if strings.Contains(path, "/git-repos") {
			json.NewEncoder(w).Encode([]valaris.GitRepo{{
				ID: "r1", Name: "repo", URL: repoURL, DefaultBranch: "main",
			}})
			return
		}

		w.Write([]byte("{}"))
	}))
}

func TestDiscover_ClaimsCardEvenWhenRepoHasOpenPR(t *testing.T) {
	// Retired repo-wide gate: a board whose repo has an unrelated open PR must
	// no longer block a brand-new candidate on the legacy fallback path.
	cards := []valaris.Card{
		{ID: "card-2", BoardID: "board-1", Title: "Was wrongly blocked by open PR", Priority: "medium"},
	}
	server := newStaleBranchServer(t, cards, "https://github.com/valaris/acme.git")
	defer server.Close()

	loop := buildDiscoverLoop(t, server.URL)

	res, err := loop.discover(context.Background(), "", false)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if res.CardID != "card-2" {
		t.Fatalf("expected card-2 to be claimed (repo-wide gate retired), got %q", res.CardID)
	}
}

func TestDiscover_ReturnsCardWhenNoOpenPRs(t *testing.T) {
	cards := []valaris.Card{
		{ID: "card-1", BoardID: "board-1", Title: "Ready to claim", Priority: "medium"},
	}
	server := newStaleBranchServer(t, cards, "https://github.com/valaris/acme.git")
	defer server.Close()

	loop := buildDiscoverLoop(t, server.URL)

	res, err := loop.discover(context.Background(), "", false)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if res.CardID != "card-1" {
		t.Errorf("expected card-1, got %q", res.CardID)
	}
}

func TestDiscover_ReworkPathStillClaimsAssignedCard(t *testing.T) {
	// A card already assigned to this agent (rework) is still picked up.
	cards := []valaris.Card{
		{
			ID: "card-1", BoardID: "board-1", Title: "Rework me",
			Participants: []valaris.CardParticipant{{AgentID: "agent-1", UserID: "user-1", Role: "hero"}},
		},
	}
	server := newStaleBranchServer(t, cards, "https://github.com/valaris/acme.git")
	defer server.Close()

	loop := buildDiscoverLoop(t, server.URL)

	res, err := loop.discover(context.Background(), "", false)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if res.CardID != "card-1" || !res.Rework {
		t.Errorf("expected rework claim of card-1, got %+v", res)
	}
}
