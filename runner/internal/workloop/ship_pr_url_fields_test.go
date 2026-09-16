// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
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

// UX-3: ship must dual-write pr_url + branch_name as first-class card fields
// alongside the legacy description footer. The backend schema columns are the
// new authoritative surface; the footer stays for one deploy cycle so old
// readers (and historical rows) keep working.
//
// The PATCH body sent to /cards/{id} must include `pr_url` and `branch_name`
// keys whenever ship runs.

func capturePatchBodyServer(t *testing.T, cardID, boardID string) (*httptest.Server, func() []map[string]any) {
	t.Helper()

	var mu sync.Mutex
	var bodies []map[string]any
	current := ""

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
				Title:       "pr url dual-write test",
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
			mu.Lock()
			bodies = append(bodies, payload)
			if d, ok := payload["description"].(string); ok {
				current = d
			}
			mu.Unlock()
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

	getBodies := func() []map[string]any {
		mu.Lock()
		defer mu.Unlock()
		out := make([]map[string]any, len(bodies))
		copy(out, bodies)
		return out
	}
	return srv, getBodies
}

func TestShip_PatchIncludesPRUrlAndBranchName(t *testing.T) {
	cardID := "card-pr-url-fields"
	boardID := "board-pr-url-fields"
	branch := "runner/ux3-pr-url"
	prURL := "https://github.com/acme/repo/pull/99"

	srv, getBodies := capturePatchBodyServer(t, cardID, boardID)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	card := &discoverResult{CardID: cardID, BoardID: boardID, Title: "pr url dual-write test"}

	if err := loop.ship(context.Background(), card, "exec-1", branch, prURL, "review", nil); err != nil {
		t.Fatalf("ship: %v", err)
	}

	bodies := getBodies()
	var found map[string]any
	for _, b := range bodies {
		if _, ok := b["pr_url"]; ok {
			found = b
			break
		}
		if _, ok := b["branch_name"]; ok {
			found = b
			break
		}
	}
	if found == nil {
		t.Fatalf("ship must PATCH pr_url + branch_name; saw bodies: %+v", bodies)
	}
	if got, _ := found["pr_url"].(string); got != prURL {
		t.Errorf("pr_url: got %q, want %q", got, prURL)
	}
	if got, _ := found["branch_name"].(string); got != branch {
		t.Errorf("branch_name: got %q, want %q", got, branch)
	}
	// The legacy footer dual-write must still happen — frontend rollover guard.
	if got, _ := found["description"].(string); !strings.Contains(got, "PR: "+prURL) {
		t.Errorf("description footer dual-write missing PR URL; got %q", got)
	}
}
