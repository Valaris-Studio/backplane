// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// ship() appends a "---\nBranch: X\nPR: Y" block to the card description each
// time a new PR URL shows up. When a card is re-claimed and the runner pushes
// to the SAME branch but opens a NEW PR (because the prior PR was merged or
// closed), the old block stays in place and extractPRURL walks the description
// top-down — returning the STALE PR URL. The ship step below then dispatches
// a merge against a PR that no longer exists.
//
// Fix: when ship() prepares to add a block for branch X, it must REWRITE any
// existing block for that same branch in place, instead of appending a second
// one. Blocks for a different branch stay untouched (that preserves history
// when the runner legitimately moves between branches, e.g. via a decision to
// re-scaffold).

// captureServer records the card description as it evolves across UpdateCard
// calls. Each PATCH on /cards/{id} (not /move) pushes the sent description
// onto `updates`. Returns a function the test can call to get the latest value.
func captureDescriptionServer(t *testing.T, cardID, boardID, initialDesc string) (*httptest.Server, func() string, func() int) {
	t.Helper()

	var mu sync.Mutex
	current := initialDesc
	updates := 0

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		method := r.Method

		if path == "/api/agents/me/config" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"agent_id": "agent-1",
				"workspace_config": map[string]any{
					"pipeline_config": DefaultPipelineConfig,
				},
			})
			return
		}

		if strings.Contains(path, "/cards/") && method == http.MethodGet &&
			!strings.Contains(path, "/search") && !strings.Contains(path, "/participants") {
			mu.Lock()
			desc := current
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(valaris.Card{
				ID:          cardID,
				BoardID:     boardID,
				Title:       "ship rewrite test",
				Description: desc,
			})
			return
		}

		if strings.Contains(path, "/move") && method == http.MethodPatch {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
			return
		}

		if strings.Contains(path, "/cards/") && method == http.MethodPatch {
			body, _ := io.ReadAll(r.Body)
			var payload map[string]any
			_ = json.Unmarshal(body, &payload)
			if d, ok := payload["description"].(string); ok {
				mu.Lock()
				current = d
				updates++
				mu.Unlock()
			}
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
			return
		}

		if strings.Contains(path, "/boards/") && method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":   boardID,
				"name": "Test",
				"columns": []valaris.BoardColumn{
					{ID: "col-review", Name: "Review", Position: 3072, ColumnType: "review"},
					{ID: "col-done", Name: "Done", Position: 4096, ColumnType: "done"},
				},
			})
			return
		}

		if strings.Contains(path, "/executions/") && method == http.MethodPatch {
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
			return
		}

		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)

	getCurrent := func() string {
		mu.Lock()
		defer mu.Unlock()
		return current
	}
	getUpdates := func() int {
		mu.Lock()
		defer mu.Unlock()
		return updates
	}
	return srv, getCurrent, getUpdates
}

// countBlocksForBranch counts how many "Branch: <branch>" lines appear in the
// description. Used to assert the description carries exactly one entry per
// branch (the re-claim case) or preserves multiple when branches differ.
func countBlocksForBranch(desc, branch string) int {
	n := 0
	needle := "Branch: " + branch
	for _, line := range strings.Split(desc, "\n") {
		if strings.TrimSpace(line) == needle {
			n++
		}
	}
	return n
}

func TestShip_RewritesExistingBranchBlockInsteadOfAppending(t *testing.T) {
	cardID := "card-rewrite-same-branch"
	boardID := "board-rewrite-1"
	branch := "runner/foo"
	oldPR := "https://github.com/acme/repo/pull/7"
	newPR := "https://github.com/acme/repo/pull/42"

	initialDesc := fmt.Sprintf("Some body\n\n---\nBranch: %s\nPR: %s", branch, oldPR)
	srv, getCurrent, getUpdates := captureDescriptionServer(t, cardID, boardID, initialDesc)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	card := &discoverResult{CardID: cardID, BoardID: boardID, Title: "ship rewrite test"}

	if err := loop.ship(context.Background(), card, "exec-1", branch, newPR, "review", nil); err != nil {
		t.Fatalf("ship: %v", err)
	}

	if getUpdates() == 0 {
		t.Fatal("ship must update description when a new PR replaces an old one for the same branch")
	}

	desc := getCurrent()

	if strings.Contains(desc, oldPR) {
		t.Errorf("description still contains stale PR %q; ship must rewrite the old block in place\n---\n%s", oldPR, desc)
	}
	if !strings.Contains(desc, newPR) {
		t.Errorf("description missing new PR %q\n---\n%s", newPR, desc)
	}
	if n := countBlocksForBranch(desc, branch); n != 1 {
		t.Errorf("expected exactly 1 \"Branch: %s\" line, got %d\n---\n%s", branch, n, desc)
	}
}

func TestShip_AppendsBlockForDifferentBranch(t *testing.T) {
	cardID := "card-rewrite-diff-branch"
	boardID := "board-rewrite-2"
	oldBranch := "runner/alpha"
	newBranch := "runner/beta"
	oldPR := "https://github.com/acme/repo/pull/7"
	newPR := "https://github.com/acme/repo/pull/42"

	initialDesc := fmt.Sprintf("Some body\n\n---\nBranch: %s\nPR: %s", oldBranch, oldPR)
	srv, getCurrent, _ := captureDescriptionServer(t, cardID, boardID, initialDesc)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	card := &discoverResult{CardID: cardID, BoardID: boardID, Title: "ship different branch"}

	if err := loop.ship(context.Background(), card, "exec-2", newBranch, newPR, "review", nil); err != nil {
		t.Fatalf("ship: %v", err)
	}

	desc := getCurrent()

	if countBlocksForBranch(desc, oldBranch) != 1 {
		t.Errorf("expected old branch block preserved (different branch), got desc:\n%s", desc)
	}
	if countBlocksForBranch(desc, newBranch) != 1 {
		t.Errorf("expected new branch block appended, got desc:\n%s", desc)
	}
	if !strings.Contains(desc, oldPR) {
		t.Errorf("old PR %q must remain because it belongs to a different branch\n---\n%s", oldPR, desc)
	}
	if !strings.Contains(desc, newPR) {
		t.Errorf("new PR %q must be appended\n---\n%s", newPR, desc)
	}

	// Order-preservation: the old block must appear before the new one (we
	// append rather than prepend; this keeps the description chronological).
	oldIdx := strings.Index(desc, "Branch: "+oldBranch)
	newIdx := strings.Index(desc, "Branch: "+newBranch)
	if oldIdx < 0 || newIdx < 0 || oldIdx >= newIdx {
		t.Errorf("expected old branch block before new branch block; got oldIdx=%d newIdx=%d\n---\n%s", oldIdx, newIdx, desc)
	}
}

// Historical pathology: a card description can carry MORE THAN ONE
// "---\nBranch: <branch>\nPR: <url>" block for the same branch (prior runner
// versions appended without upsert; landed cards that got re-claimed more
// than once accumulate them). Today's upsertBranchPRBlock only rewrites the
// FIRST matching block, so the second stale PR line survives — and the next
// applyApproveMergeGate tick reads the stale one via extractPRURL. Ship must
// collapse all duplicate blocks for the target branch into a single block
// carrying the new PR.
//
// PR numbers chosen to be non-prefix-overlapping (7, 11, 42 — no substring
// of one appears inside another) so assertions don't accidentally match.
func TestShip_NormalizesHistoricalDuplicateBlocksForSameBranch(t *testing.T) {
	cardID := "card-rewrite-dup-blocks"
	boardID := "board-rewrite-3"
	branch := "runner/foo"
	stalePR1 := "https://github.com/acme/repo/pull/7"
	stalePR2 := "https://github.com/acme/repo/pull/11"
	newPR := "https://github.com/acme/repo/pull/42"

	initialDesc := fmt.Sprintf(
		"Some body\n\n---\nBranch: %s\nPR: %s\n\n---\nBranch: %s\nPR: %s",
		branch, stalePR1, branch, stalePR2,
	)
	srv, getCurrent, getUpdates := captureDescriptionServer(t, cardID, boardID, initialDesc)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	card := &discoverResult{CardID: cardID, BoardID: boardID, Title: "ship dedup test"}

	if err := loop.ship(context.Background(), card, "exec-dedup", branch, newPR, "review", nil); err != nil {
		t.Fatalf("ship: %v", err)
	}

	if getUpdates() == 0 {
		t.Fatal("ship must update description when duplicate stale blocks exist for the target branch")
	}

	desc := getCurrent()

	if n := countBlocksForBranch(desc, branch); n != 1 {
		t.Errorf("expected exactly 1 \"Branch: %s\" line after dedup, got %d\n---\n%s", branch, n, desc)
	}
	if !strings.Contains(desc, newPR) {
		t.Errorf("description missing new PR %q\n---\n%s", newPR, desc)
	}
	if strings.Contains(desc, stalePR1) {
		t.Errorf("description still contains stale PR %q; ship must collapse duplicate blocks\n---\n%s", stalePR1, desc)
	}
	if strings.Contains(desc, stalePR2) {
		t.Errorf("description still contains stale PR %q; ship must collapse duplicate blocks\n---\n%s", stalePR2, desc)
	}
}
