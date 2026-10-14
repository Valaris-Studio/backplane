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

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

const contextDispatchContractRoute = "/context-dispatch-contract"

// servePreNegotiationBackend answers the context dispatch contract route as a
// backend from before negotiation does: it has none (404). Every other route,
// and any error or empty success the stub gives it, is left to the stub. The
// legacy-path tests built on these stubs run with
// context_dispatch.allow_legacy_server.
func servePreNegotiationBackend(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasSuffix(r.URL.Path, contextDispatchContractRoute) {
		return false
	}
	http.NotFound(w, r)
	return true
}

func TestServePreNegotiationBackendAnswersOnlyTheContractRoute(t *testing.T) {
	for path, answered := range map[string]bool{
		"/api/workspaces/ws/agents/agent-1/context-dispatch-contract": true,
		"/api/workspaces/ws/agents/agent-1/next-assignment":           false,
		"/api/workspaces/ws/boards/board-1/cards/search":              false,
		"/api/agents/me/config":                                       false,
	} {
		recorder := httptest.NewRecorder()
		if got := servePreNegotiationBackend(recorder, httptest.NewRequest(http.MethodGet, path, nil)); got != answered {
			t.Errorf("%s: answered = %v, want %v", path, got, answered)
		}
		if answered && recorder.Code != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404", path, recorder.Code)
		}
		if !answered && recorder.Body.Len() != 0 {
			t.Errorf("%s: the helper wrote to a route it does not own", path)
		}
	}
}

// Without context_dispatch.allow_legacy_server the runner keeps negotiating:
// an unacknowledged success, an outage and even an old server's 404 refuse
// work, reaching neither the scheduler nor the legacy scans.
func TestDefaultNegotiationRefusesWithoutTheLegacyServerOptIn(t *testing.T) {
	for name, answer := range map[string]func(http.ResponseWriter){
		"undeclared_empty_success":      func(w http.ResponseWriter) { _, _ = w.Write([]byte("{}")) },
		"outage":                        func(w http.ResponseWriter) { w.WriteHeader(http.StatusInternalServerError) },
		"old_server_404_without_opt_in": func(w http.ResponseWriter) { w.WriteHeader(http.StatusNotFound) },
	} {
		t.Run(name, func(t *testing.T) {
			var mu sync.Mutex
			var contracts, assignments, searches int
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				mu.Lock()
				defer mu.Unlock()
				switch {
				case strings.HasSuffix(r.URL.Path, contextDispatchContractRoute):
					contracts++
					answer(w)
				case strings.Contains(r.URL.Path, "/next-assignment"):
					assignments++
					w.WriteHeader(http.StatusNoContent)
				case strings.Contains(r.URL.Path, "/cards/search"):
					searches++
					_, _ = w.Write([]byte("[]"))
				case serveDefaultPlatformConfig(w, r):
				default:
					_, _ = w.Write([]byte("{}"))
				}
			}))
			t.Cleanup(server.Close)
			cfg := &config.Config{Valaris: config.ValarisConfig{WorkspaceSlug: "test-workspace"}}
			client := valaris.NewClient(server.URL, "vlr_test")
			client.Agent = &valaris.AgentConfig{ID: "agent-1", Name: "test", AgentType: "coding", IsActive: true}
			loop, err := New(context.Background(), client, llm.NewMockProvider(), &git.Manager{BaseDir: t.TempDir()}, cfg)
			if err != nil {
				t.Fatalf("New: %v", err)
			}
			strategy := NewDataDrivenStrategy(valaris.StageConfig{Role: "builder", Discover: valaris.DiscoverDef{Strategy: "column_scan", ColumnType: "todo"}}, nil)
			if _, err := strategy.discoverWithConfig(context.Background(), loop); err == nil {
				t.Error("discovery accepted work without a negotiated contract or the legacy-server opt-in")
			}
			mu.Lock()
			defer mu.Unlock()
			if contracts == 0 || assignments != 0 || searches != 0 {
				t.Errorf("contract=%d next-assignment=%d legacy searches=%d, want contract>0 and no scheduler or legacy call", contracts, assignments, searches)
			}
		})
	}
}
