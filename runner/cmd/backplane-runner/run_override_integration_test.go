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
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
	"gopkg.in/yaml.v3"
)

func TestRunOverrideCLIExecutesExactModelWithoutPersisting(t *testing.T) {
	var mu sync.Mutex
	var starts []map[string]any
	var completions []map[string]any
	var forbiddenWrites []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/me":
			w.Write([]byte(`{"id":"user-test"}`))
		case r.URL.Path == "/api/agents/me":
			w.Write([]byte(`{"id":"agent-test","name":"Synthetic runner","is_active":true,"allowed_workspaces":["test"]}`))
		case strings.HasSuffix(r.URL.Path, "/heartbeat"):
			w.Write([]byte(`{"id":"agent-test","is_active":true,"allowed_workspaces":["test"]}`))
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/loop"):
			json.NewEncoder(w).Encode(valaris.BoardLoopConfig{Enabled: true, Provider: "claude-cli", Model: "premium", LoopPrompt: "Complete a synthetic iteration", BudgetUSD: 10, MaxIterations: 1, IterationTimeoutSeconds: 5, MaxConsecutiveFailures: 1, StarvationPolicy: "always_run"})
		case strings.HasSuffix(r.URL.Path, "/loop/history"):
			w.Write([]byte(`{"iteration_count":0,"spent_usd":0,"lifetime_spent_usd":0,"budget_epoch":null}`))
		case r.Method == http.MethodPatch && strings.HasSuffix(r.URL.Path, "/loop/state"):
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			for key := range body {
				if key != "enabled" && key != "reason" && key != "reason_code" && key != "reason_params" {
					forbiddenWrites = append(forbiddenWrites, key)
				}
			}
			w.Write([]byte(`{}`))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/executions"):
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			starts = append(starts, body)
			w.Write([]byte(`{"id":"execution-test"}`))
		case r.Method == http.MethodPatch && strings.Contains(r.URL.Path, "/executions/"):
			var body map[string]any
			json.NewDecoder(r.Body).Decode(&body)
			completions = append(completions, body)
			w.Write([]byte(`{"id":"execution-test"}`))
		case strings.HasSuffix(r.URL.Path, "/skills"):
			w.Write([]byte(`{"skills":[]}`))
		default:
			if r.Method != http.MethodGet {
				forbiddenWrites = append(forbiddenWrites, r.Method+" "+r.URL.Path)
			}
			http.Error(w, `{"detail":"unexpected fixture request"}`, http.StatusNotFound)
		}
	}))
	defer server.Close()
	dir := t.TempDir()
	bin := filepath.Join(dir, "bin")
	os.Mkdir(bin, 0700)
	argvPath := filepath.Join(dir, "argv")
	script := `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\n' 'codex-cli 0.154.0'
  exit 0
fi
printf '%s\n' "$@" > "$CAPTURE_ARGV"
printf '%s\n' '{"type":"thread.started","thread_id":"synthetic"}' '{"type":"item.completed","item":{"type":"agent_message","text":"{\"outcome\":\"worked\",\"summary\":\"synthetic test\"}"}}' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`
	if err := os.WriteFile(filepath.Join(bin, "codex"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	mcp := filepath.Join(dir, "mcp.json")
	os.WriteFile(mcp, []byte(`{"mcpServers":{"valaris":{"command":"synthetic-unused-mcp"}}}`), 0600)
	cfg := config.Defaults()
	cfg.Valaris.APIURL = server.URL
	cfg.Valaris.APIKey = "vlr_synthetic_test"
	cfg.Valaris.WorkspaceSlug = "test"
	cfg.Git.BaseDir = filepath.Join(dir, "repos")
	cfg.Git.Forge = "gitea"
	cfg.LLM.Provider = "claude-cli"
	cfg.LLM.Model = "saved-model"
	cfg.LLM.MCPConfigPath = mcp
	cfg.WebSocket.Enabled = false
	cfg.Telemetry.Enabled = false
	raw, err := yaml.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "runner.yaml")
	os.WriteFile(path, raw, 0600)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRunOverrideCLIProcess$", "--", "-config="+path, "-loop", "-loop-board=board-test", "-run-provider=codex-cli", "-run-model=custom-exact-model")
	cmd.Env = []string{"BACKPLANE_TEST_RUN_OVERRIDE=1", "PATH=" + bin + ":/usr/bin:/bin", "HOME=" + dir, "CODEX_HOME=" + filepath.Join(dir, "codex-home"), "CAPTURE_ARGV=" + argvPath}
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("bounded subprocess failed: %v\n%s", err, output)
	}
	argv, err := os.ReadFile(argvPath)
	if err != nil {
		t.Fatalf("fake CLI never invoked: %v\n%s", err, output)
	}
	if !strings.Contains(string(argv), "--model\ncustom-exact-model\n") {
		t.Fatalf("actual CLI model args: %s", argv)
	}
	after, _ := os.ReadFile(path)
	if string(after) != string(raw) {
		t.Fatal("invocation changed saved config")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(forbiddenWrites) > 0 {
		t.Fatalf("unexpected configuration mutations: %v", forbiddenWrites)
	}
	if len(starts) != 1 {
		t.Fatalf("want exactly one execution, got %v\n%s", starts, output)
	}
	if len(completions) != 1 || completions[0]["status"] != "completed" {
		t.Fatalf("want one successful execution completion: %v\n%s", completions, output)
	}
	start := starts[0]
	if start["provider"] != "codex-cli" || start["model"] != "custom-exact-model" {
		t.Fatalf("effective telemetry: %v", start)
	}
	summary, _ := start["input_summary"].(string)
	if !strings.Contains(summary, `board requested provider="claude-cli" model="premium"`) || !strings.Contains(summary, `run override provider="codex-cli" model="custom-exact-model"`) {
		t.Fatalf("requested/effective summary: %s", summary)
	}
}
