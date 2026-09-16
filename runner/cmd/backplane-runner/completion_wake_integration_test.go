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
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"gopkg.in/yaml.v3"
	"nhooyr.io/websocket"
)

func TestLoopCLICompletionEventWakesWithoutKeepAlive(t *testing.T) {
	workSeen := make(chan struct{})
	var once sync.Once
	var loopGets atomic.Int32
	var subscribed atomic.Bool
	var unsupported atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/ws/") {
			conn, err := websocket.Accept(w, r, nil)
			if err != nil {
				return
			}
			defer conn.CloseNow()
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			_, body, err := conn.Read(ctx)
			if err != nil {
				return
			}
			subscribed.Store(strings.Contains(string(body), "completion.*"))
			select {
			case <-workSeen:
			case <-ctx.Done():
				return
			}
			_ = conn.Write(ctx, websocket.MessageText, []byte(`{"event":"completion.updated","payload":{"board_id":"board-test","actor_id":"user-test"}}`))
			_, _, _ = conn.Read(ctx)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/me":
			_, _ = w.Write([]byte(`{"id":"user-test"}`))
		case r.URL.Path == "/api/agents/me" || strings.HasSuffix(r.URL.Path, "/heartbeat"):
			_, _ = w.Write([]byte(`{"id":"agent-test","is_active":true,"allowed_workspaces":["test"]}`))
		case strings.HasSuffix(r.URL.Path, "/loop"):
			if r.Header.Get("X-Backplane-Completion-Version") != "1" {
				unsupported.Store(true)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"enabled": loopGets.Add(1) == 1, "max_iterations": 1, "budget_usd": 10, "completion_policy": map[string]any{"version": 1}, "completion_policy_hash": "policy-fixture", "completion_context": "Mandatory fixture policy."})
		case strings.HasSuffix(r.URL.Path, "/loop/history"):
			_, _ = w.Write([]byte(`{"iteration_count":0,"spent_usd":0,"lifetime_spent_usd":0,"budget_epoch":null}`))
		case strings.HasSuffix(r.URL.Path, "/completion/readiness"):
			_, _ = w.Write([]byte(`{"policy_hash":"policy-fixture","ready":true,"checks":[{"operation":"repository_binding","repo_id":"repo-1","required":true,"status":"verified","code":"verified","credential_source":"workspace_connection","connection_id":"connection-1"},{"operation":"repository_read","repo_id":"repo-1","required":true,"status":"verified","code":"verified","credential_source":"workspace_connection","connection_id":"connection-1"},{"operation":"pull_requests_read","repo_id":"repo-1","required":true,"status":"verified","code":"verified","credential_source":"workspace_connection","connection_id":"connection-1"},{"operation":"forge_write","repo_id":"repo-1","required":false,"status":"unverified","code":"write_unverified"}]}`))
		case strings.HasSuffix(r.URL.Path, "/completion/requirements"):
			_, _ = w.Write([]byte(`{"policy_hash":"policy-fixture","requirements":[]}`))
		case strings.HasSuffix(r.URL.Path, "/completion/work"):
			_, _ = w.Write([]byte(`{"pending_count":1,"actionable_count":0,"failed_count":0}`))
			once.Do(func() { close(workSeen) })
		default:
			http.Error(w, `{"detail":"unexpected request"}`, 404)
		}
	}))
	defer server.Close()
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0700); err != nil {
		t.Fatal(err)
	}
	claude := `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\n' '2.1.0 (Claude Code)'
  exit 0
fi
exit 99
`
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte(claude), 0700); err != nil {
		t.Fatal(err)
	}
	// An explicit policy now requires a working MCP before the loop may park
	// or dispatch. This fixture speaks real stdio without invoking an agent.
	mcp := `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","serverInfo":{"name":"fixture","version":"0.8.0"}}}';;
    *'"tools/list"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"get_board_loop"},{"name":"get_completion_policy"},{"name":"get_completion_status"},{"name":"submit_completion_candidate"},{"name":"request_landing"},{"name":"retry_completion"}]}}';;
    *'"tools/call"'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\"completion_policy\":{\"version\":1},\"completion_policy_hash\":\"policy-fixture\",\"completion_context\":\"Mandatory fixture policy.\"}"}]}}';;
  esac
done
`
	if err := os.WriteFile(filepath.Join(bin, "fixture-mcp"), []byte(mcp), 0700); err != nil {
		t.Fatal(err)
	}
	cfg := config.Defaults()
	cfg.Valaris.APIURL = server.URL
	cfg.Valaris.APIKey = "vlr_fixture"
	cfg.Valaris.WorkspaceSlug = "test"
	cfg.Git.BaseDir = filepath.Join(dir, "repos")
	cfg.Git.Forge = "gitea"
	cfg.LoopMode.KeepAlive = false
	cfg.WebSocket.Enabled = true
	cfg.Telemetry.Enabled = false
	cfg.LLM.MCPConfigPath = filepath.Join(dir, "mcp.json")
	if err := os.WriteFile(cfg.LLM.MCPConfigPath, []byte(`{"mcpServers":{"valaris":{"command":"fixture-mcp"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	raw, err := yaml.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "runner.yaml")
	if err = os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRunOverrideCLIProcess$", "--", "-config="+path, "-loop", "-loop-board=board-test")
	command.Env = []string{"BACKPLANE_TEST_RUN_OVERRIDE=1", "PATH=" + bin + ":/usr/bin:/bin", "HOME=" + dir}
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("completion event did not resume the actual non-keepalive loop: %v\n%s", err, output)
	}
	if !subscribed.Load() || unsupported.Load() || loopGets.Load() != 2 {
		t.Fatalf("incomplete completion wake/handshake: subscribed=%v unsupported=%v loop_gets=%d", subscribed.Load(), unsupported.Load(), loopGets.Load())
	}
	for _, want := range []string{"MCP launch verified", "mcp_version=0.8.0", "mcp_config=" + cfg.LLM.MCPConfigPath, "mcp_executable=" + filepath.Join(bin, "fixture-mcp")} {
		if !strings.Contains(string(output), want) {
			t.Errorf("launch summary is missing %q: %s", want, output)
		}
	}
}
