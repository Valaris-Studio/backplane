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

type oldServerProbe struct {
	mu                               sync.Mutex
	contracts, assignments, searches int
}

// oldServerProbeLoop builds a loop whose server answers the contract route
// with a 404 carrying contractBody and counts what discovery asks next.
func oldServerProbeLoop(t *testing.T, contractBody string, policy config.ContextDispatchConfig, withAgent bool) (*Loop, *DataDrivenStrategy, *oldServerProbe) {
	t.Helper()
	probe := &oldServerProbe{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		probe.mu.Lock()
		defer probe.mu.Unlock()
		switch {
		case strings.HasSuffix(r.URL.Path, contextDispatchContractRoute):
			probe.contracts++
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(contractBody))
		case strings.Contains(r.URL.Path, "/next-assignment"):
			probe.assignments++
			w.WriteHeader(http.StatusNotFound)
		case strings.Contains(r.URL.Path, "/cards/search"):
			probe.searches++
			_, _ = w.Write([]byte("[]"))
		case strings.HasSuffix(r.URL.Path, "/boards") && r.Method == http.MethodGet:
			_, _ = w.Write([]byte(`[{"id":"board-1","name":"Board"}]`))
		case serveDefaultPlatformConfig(w, r):
		default:
			_, _ = w.Write([]byte("{}"))
		}
	}))
	t.Cleanup(server.Close)
	cfg := &config.Config{Valaris: config.ValarisConfig{WorkspaceSlug: "test-workspace"}, ContextDispatch: policy}
	client := valaris.NewClient(server.URL, "vlr_test")
	client.Agent = &valaris.AgentConfig{ID: "agent-1", Name: "test", AgentType: "coding", IsActive: true}
	loop, err := New(context.Background(), client, llm.NewMockProvider(), &git.Manager{BaseDir: t.TempDir()}, cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if !withAgent {
		client.Agent = nil
	}
	strategy := NewDataDrivenStrategy(valaris.StageConfig{Role: "builder", Discover: valaris.DiscoverDef{Strategy: "unassigned_or_rework", ColumnTypeExclude: "done"}}, nil)
	return loop, strategy, probe
}

// Only a 404 for the route itself is an old server. A server that has the
// route answers an unknown agent or workspace with a typed 404, and that is
// never a reason to run the legacy path, opt-in or not.
func TestContextDispatchOnlyARouteMissing404IsAnOldServer(t *testing.T) {
	const (
		typedAgent     = `{"detail":"Agent not found","error_code":"agent_not_found","error_params":{},"context":null}`
		typedWorkspace = `{"detail":"Workspace 'test-workspace' not found","error_code":"not_found","error_params":{},"context":null}`
		routeEnvelope  = `{"detail":"Not Found","error_code":"not_found","error_params":{},"context":null}`
		routeBare      = `{"detail":"Not Found"}`
	)
	allow := config.ContextDispatchConfig{AllowLegacyServer: true}
	for _, tt := range []struct {
		name, body string
		policy     config.ContextDispatchConfig
		legacy     bool
	}{
		{name: "typed_unknown_agent_with_opt_in", body: typedAgent, policy: allow},
		{name: "typed_unknown_workspace_with_opt_in", body: typedWorkspace, policy: allow},
		{name: "route_missing_envelope_with_opt_in", body: routeEnvelope, policy: allow, legacy: true},
		{name: "route_missing_bare_with_opt_in", body: routeBare, policy: allow, legacy: true},
		{name: "route_missing_envelope_without_opt_in", body: routeEnvelope},
		{name: "route_missing_bare_without_opt_in", body: routeBare},
		{name: "route_missing_with_require", body: routeEnvelope, policy: config.ContextDispatchConfig{AllowLegacyServer: true, Require: true}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			loop, strategy, probe := oldServerProbeLoop(t, tt.body, tt.policy, true)
			_, err := strategy.discoverWithConfig(context.Background(), loop)
			probe.mu.Lock()
			defer probe.mu.Unlock()
			if probe.contracts == 0 {
				t.Fatal("discovery did not negotiate")
			}
			if tt.legacy {
				if err != nil || probe.searches == 0 {
					t.Errorf("an old server with the opt-in keeps the legacy path: err=%v legacy searches=%d", err, probe.searches)
				}
				return
			}
			if err == nil || probe.assignments != 0 || probe.searches != 0 {
				t.Errorf("not an old server, or not allowed: err=%v next-assignment=%d legacy searches=%d", err, probe.assignments, probe.searches)
			}
		})
	}
}

// A runner required to negotiate has no legacy path, not even without an
// agent identity to negotiate with.
func TestContextDispatchRequireWithoutAgentIdentityRefuses(t *testing.T) {
	loop, strategy, probe := oldServerProbeLoop(t, `{"detail":"Not Found"}`, config.ContextDispatchConfig{Require: true}, false)
	_, err := strategy.discoverWithConfig(context.Background(), loop)
	probe.mu.Lock()
	defer probe.mu.Unlock()
	if err == nil || probe.searches != 0 {
		t.Errorf("require without an agent identity ran the legacy path: err=%v legacy searches=%d", err, probe.searches)
	}
}
