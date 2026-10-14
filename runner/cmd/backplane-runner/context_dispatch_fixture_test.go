// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"gopkg.in/yaml.v3"
)

const (
	cliDispatchAgentID     = "11111111-1111-4111-8111-111111111111"
	cliDispatchWorkspaceID = "22222222-2222-4222-8222-222222222222"
	cliDispatchHeader      = "X-Backplane-Context-Dispatch-Version"
)

type cliDispatchFixture struct {
	workspaceSlug    string
	contractRequests atomic.Int32
}

func cliLegacyDispatchContract() map[string]any {
	return map[string]any{
		"protocol": "context-dispatch", "supported_versions": []int{1},
		"minimum_version": 0, "mode": "legacy",
		"agent_id": cliDispatchAgentID, "workspace_id": cliDispatchWorkspaceID,
		"policy_revision": strings.Repeat("a", 64),
		"supported_flows": []string{"scheduled_active_execution"},
	}
}

func (f *cliDispatchFixture) serve(t *testing.T, w http.ResponseWriter, r *http.Request) bool {
	t.Helper()
	if r.Method != http.MethodGet {
		return false
	}
	switch r.URL.Path {
	case "/api/workspaces/" + f.workspaceSlug + "/agents/" + cliDispatchAgentID + "/context-dispatch-contract":
		f.contractRequests.Add(1)
		if got := r.Header.Get(cliDispatchHeader); got != "1" {
			t.Errorf("contract request acknowledgement version = %q, want 1", got)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set(cliDispatchHeader, "1")
		_ = json.NewEncoder(w).Encode(cliLegacyDispatchContract())
		return true
	case "/api/workspaces":
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode([]map[string]string{{"id": cliDispatchWorkspaceID, "slug": f.workspaceSlug}})
		return true
	default:
		return false
	}
}

func (f *cliDispatchFixture) assertRequested(t *testing.T) {
	t.Helper()
	if f.contractRequests.Load() == 0 {
		t.Fatal("CLI did not negotiate the context dispatch contract")
	}
}

func TestLoopCLIRefusesUnavailableContextDispatchBeforeExecution(t *testing.T) {
	for _, response := range []string{"missing_route", "required_mode", "missing_acknowledgement"} {
		t.Run(response, func(t *testing.T) {
			dispatch := cliDispatchFixture{workspaceSlug: "test"}
			var unexpected atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch {
				case r.Method == http.MethodGet && r.URL.Path == "/api/me":
					_, _ = w.Write([]byte(`{"id":"user-fixture"}`))
				case r.URL.Path == "/api/agents/me" || strings.HasSuffix(r.URL.Path, "/heartbeat"):
					_ = json.NewEncoder(w).Encode(map[string]any{"id": cliDispatchAgentID, "is_active": true, "allowed_workspaces": []string{"test"}})
				case r.Method == http.MethodGet && r.URL.Path == "/api/workspaces/test/boards/board-fixture/loop":
					_, _ = w.Write([]byte(`{"enabled":true,"max_iterations":1,"budget_usd":10,"starvation_policy":"always_run"}`))
				case r.Method == http.MethodGet && r.URL.Path == "/api/workspaces/test/agents/"+cliDispatchAgentID+"/context-dispatch-contract":
					dispatch.contractRequests.Add(1)
					if r.Header.Get(cliDispatchHeader) != "1" {
						t.Error("CLI did not send the context dispatch version")
					}
					if response == "missing_route" {
						w.WriteHeader(http.StatusNotFound)
						_, _ = w.Write([]byte(`{"detail":"Not Found","error_code":"not_found"}`))
						return
					}
					contract := cliLegacyDispatchContract()
					if response == "required_mode" {
						contract["mode"], contract["minimum_version"] = "required", 1
						w.Header().Set(cliDispatchHeader, "1")
					}
					_ = json.NewEncoder(w).Encode(contract)
				case dispatch.serve(t, w, r):
				default:
					unexpected.Add(1)
					t.Errorf("refused contract reached work route: %s %s", r.Method, r.URL.Path)
					http.Error(w, `{"detail":"unexpected work request"}`, http.StatusNotFound)
				}
			}))
			defer server.Close()
			dir := t.TempDir()
			bin := filepath.Join(dir, "bin")
			if err := os.Mkdir(bin, 0700); err != nil {
				t.Fatal(err)
			}
			providerMarker := filepath.Join(dir, "provider-invoked")
			script := "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf '2.1.0 (Claude Code)\\n'; exit 0; fi\nprintf invoked > \"$PROVIDER_MARKER\"\nexit 99\n"
			if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			cfg := config.Defaults()
			if cfg.ContextDispatch.AllowLegacyServer || cfg.ContextDispatch.Require {
				t.Fatal("refusal control requires the default negotiation policy")
			}
			cfg.Valaris.APIURL, cfg.Valaris.APIKey, cfg.Valaris.WorkspaceSlug = server.URL, "vlr_fixture", "test"
			cfg.Git.BaseDir, cfg.Git.Forge = filepath.Join(dir, "repos"), "gitea"
			cfg.WebSocket.Enabled, cfg.Telemetry.Enabled = false, false
			cfg.LLM.MCPConfigPath = filepath.Join(dir, "mcp.json")
			if err := os.WriteFile(cfg.LLM.MCPConfigPath, []byte(`{"mcpServers":{"valaris":{"command":"must-not-run"}}}`), 0600); err != nil {
				t.Fatal(err)
			}
			raw, err := yaml.Marshal(cfg)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(dir, "runner.yaml")
			if err := os.WriteFile(path, raw, 0600); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRunOverrideCLIProcess$", "--", "-config="+path, "-loop", "-loop-board=board-fixture")
			command.Env = []string{"BACKPLANE_TEST_RUN_OVERRIDE=1", "PATH=" + bin + ":/usr/bin:/bin", "HOME=" + dir, "PROVIDER_MARKER=" + providerMarker}
			output, err := command.CombinedOutput()
			if err == nil || ctx.Err() != nil || !strings.Contains(string(output), "context dispatch") {
				t.Fatalf("contract must refuse promptly with a dispatch error: err=%v context=%v\n%s", err, ctx.Err(), output)
			}
			dispatch.assertRequested(t)
			if unexpected.Load() != 0 {
				t.Fatal("unsupported contract reached assignment or execution routes")
			}
			if _, err := os.Stat(providerMarker); !os.IsNotExist(err) {
				t.Fatalf("unsupported contract invoked the provider: %v", err)
			}
		})
	}
}
