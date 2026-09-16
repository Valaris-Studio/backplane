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

// Exercise the executable's real config -> provider registry -> claim -> native
// driver seam. All control-plane, MCP, git and agent fixtures are disposable.
func TestRunOverrideCLIClaimsIndependentConfiguredReviewer(t *testing.T) {
	for _, declaration := range []string{"extra", "saved-default"} {
		t.Run(declaration, func(t *testing.T) {
			runOverrideCLIClaimsIndependentConfiguredReviewer(t, declaration, false)
		})
	}
}

func TestRunOverrideCLIReviewThenSourcePreservesSeparateModels(t *testing.T) {
	runOverrideCLIClaimsIndependentConfiguredReviewer(t, "extra", true)
}

func runOverrideCLIClaimsIndependentConfiguredReviewer(t *testing.T, declaration string, continueSource bool) {
	dir := t.TempDir()
	repo := filepath.Join(dir, "source")
	write := func(path, content string, mode os.FileMode) {
		t.Helper()
		if err := os.WriteFile(path, []byte(content), mode); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(repo, 0700); err != nil {
		t.Fatal(err)
	}
	git := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
		cmd.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("fixture git %v: %v: %s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	git("init")
	write(filepath.Join(repo, "source.txt"), "accepted candidate\n", 0600)
	git("add", "source.txt")
	git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "candidate")
	sha := git("rev-parse", "HEAD")

	const role = "operator-defined-independent-inspector"
	const reviewerModel = "configured-codex-review-model"
	var mu sync.Mutex
	var claims []valaris.CompletionCapabilities
	var receipts []valaris.CompletionResult
	var unexpected []string
	var sourceStarts, sourceCompletions []map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/api/me":
			_, _ = w.Write([]byte(`{"id":"user-fixture"}`))
		case r.URL.Path == "/api/agents/me" || strings.HasSuffix(r.URL.Path, "/heartbeat"):
			_, _ = w.Write([]byte(`{"id":"agent-fixture","is_active":true,"allowed_workspaces":["test"]}`))
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/loop"):
			_ = json.NewEncoder(w).Encode(map[string]any{"enabled": len(receipts) == 0 || (continueSource && len(sourceCompletions) == 0), "budget_usd": 10, "max_iterations": 1, "iteration_timeout_seconds": 5, "max_consecutive_failures": 1, "starvation_policy": "always_run", "loop_prompt": "Implement the next disposable card after independent review.", "provider": "claude-cli", "model": "saved-source-model", "completion_policy": map[string]any{"version": 1, "source_review": "independent", "review_role": role}, "completion_policy_hash": "policy-fixture", "completion_context": "Review with the configured independent role."})
		case strings.HasSuffix(r.URL.Path, "/loop/history"):
			_, _ = w.Write([]byte(`{"iteration_count":1,"spent_usd":0,"lifetime_spent_usd":0,"budget_epoch":null}`))
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/completion/readiness"):
			_, _ = w.Write([]byte(`{"policy_hash":"policy-fixture","ready":true,"checks":[{"operation":"repository_binding","repo_id":"repo-1","required":true,"status":"verified","code":"verified","credential_source":"workspace_connection","connection_id":"connection-1"},{"operation":"repository_read","repo_id":"repo-1","required":true,"status":"verified","code":"verified","credential_source":"workspace_connection","connection_id":"connection-1"},{"operation":"pull_requests_read","repo_id":"repo-1","required":true,"status":"verified","code":"verified","credential_source":"workspace_connection","connection_id":"connection-1"},{"operation":"forge_write","repo_id":"repo-1","required":false,"status":"unverified","code":"write_unverified"}]}`))
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/completion/requirements"):
			_ = json.NewEncoder(w).Encode(map[string]any{"policy_hash": "policy-fixture", "requirements": []any{map[string]any{"kind": "review", "role": role, "provider": "codex-cli", "model": reviewerModel, "checks": []any{}}}})
		case r.Method == http.MethodGet && strings.HasSuffix(r.URL.Path, "/completion/work"):
			if len(receipts) == 0 {
				_, _ = w.Write([]byte(`{"pending_count":1,"actionable_count":1,"failed_count":0}`))
			} else {
				_, _ = w.Write([]byte(`{"pending_count":0,"actionable_count":0,"failed_count":0}`))
			}
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/completion/work/claim"):
			var body struct {
				Capabilities valaris.CompletionCapabilities `json:"capabilities"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			claims = append(claims, body.Capabilities)
			if !strings.Contains(","+strings.Join(body.Capabilities.Providers, ",")+",", ",codex-cli,") {
				http.Error(w, `{"detail":"completion_runner_incompatible: configured reviewer codex-cli unavailable"}`, http.StatusConflict)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"work": map[string]any{"attempt_id": "review-attempt", "lease_token": "fixture-private-lease", "candidate_id": "preserved-candidate", "card_id": "card-fixture", "kind": "review", "role": role, "provider": "codex-cli", "model": reviewerModel, "repo_url": repo, "source_sha": sha, "policy_hash": "policy-fixture", "contract_hash": "contract-fixture", "context": "Inspect accepted candidate independently.", "expires_at": time.Now().Add(time.Minute)}})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/completion/work/review-attempt/result"):
			var result valaris.CompletionResult
			if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
				t.Error(err)
			}
			receipts = append(receipts, result)
			_, _ = w.Write([]byte(`{"status":"accepted"}`))
		case continueSource && strings.HasSuffix(r.URL.Path, "/skills"):
			_, _ = w.Write([]byte(`{"skills":[]}`))
		case continueSource && r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/executions"):
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			sourceStarts = append(sourceStarts, body)
			_, _ = w.Write([]byte(`{"id":"next-card-source-execution"}`))
		case continueSource && r.Method == http.MethodPatch && strings.Contains(r.URL.Path, "/executions/"):
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			sourceCompletions = append(sourceCompletions, body)
			_, _ = w.Write([]byte(`{"id":"next-card-source-execution"}`))
		default:
			unexpected = append(unexpected, r.Method+" "+r.URL.Path)
			http.Error(w, `{"detail":"unexpected fixture request"}`, 404)
		}
	}))
	defer server.Close()
	bin := filepath.Join(dir, "bin")
	if err := os.Mkdir(bin, 0700); err != nil {
		t.Fatal(err)
	}
	write(filepath.Join(bin, "claude"), `#!/bin/sh
if [ "$*" = '--version' ]; then printf '2.1.0 (Claude Code)\n'; exit 0; fi
printf '%s\n' "$@" > "$SOURCE_MARKER"
printf '%s\n' '{"type":"result","subtype":"success","result":"next disposable card implemented","structured_output":{"outcome":"worked","summary":"next disposable card implemented"},"session_id":"fresh-source-fixture","total_cost_usd":0,"usage":{"input_tokens":1,"output_tokens":1}}'
`, 0700)
	write(filepath.Join(bin, "codex"), `#!/bin/sh
if [ "$*" = '--version' ]; then printf 'codex-cli 0.144.1\n'; exit 0; fi
printf '%s\n' "$@" > "$REVIEW_ARGV"
git rev-parse HEAD > "$REVIEW_SHA"
printf '%s\n' "${BACKPLANE_SOURCE_EXECUTION_ID-}" > "$REVIEW_SOURCE_EXECUTION"
printf '%s\n' '{"type":"thread.started","thread_id":"independent-fixture"}' '{"type":"item.completed","item":{"type":"agent_message","text":"{\"outcome\":\"passed\",\"summary\":\"accepted candidate reviewed independently\"}"}}' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`, 0700)
	write(filepath.Join(bin, "fixture-mcp"), `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","serverInfo":{"name":"fixture","version":"0.8.0"}}}';;
    *'"tools/list"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"get_board_loop"},{"name":"get_completion_policy"},{"name":"get_completion_status"},{"name":"submit_completion_candidate"},{"name":"request_landing"},{"name":"retry_completion"}]}}';;
    *'"tools/call"'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\"completion_policy\":{\"version\":1},\"completion_policy_hash\":\"policy-fixture\",\"completion_context\":\"Review with the configured independent role.\"}"}]}}';;
  esac
done
`, 0700)
	cfg := config.Defaults()
	cfg.Valaris.APIURL, cfg.Valaris.APIKey, cfg.Valaris.WorkspaceSlug = server.URL, "vlr_fixture", "test"
	cfg.Git.BaseDir, cfg.Git.Forge = filepath.Join(dir, "repos"), "gitea"
	cfg.LLM.Provider, cfg.LLM.Model = "claude-cli", "saved-source-model"
	if declaration == "saved-default" {
		cfg.LLM.Provider = "codex-cli"
	} else {
		cfg.LLM.ExtraProviders = []string{"codex-cli"}
	}
	cfg.LLM.MCPConfigPath = filepath.Join(dir, "mcp.json")
	cfg.WebSocket.Enabled, cfg.Telemetry.Enabled = false, false
	write(cfg.LLM.MCPConfigPath, `{"mcpServers":{"valaris":{"command":"fixture-mcp"}}}`, 0600)
	raw, err := yaml.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "runner.yaml")
	write(path, string(raw), 0600)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRunOverrideCLIProcess$", "--", "-config="+path, "-loop", "-loop-board=board-fixture", "-run-provider=claude-cli", "-run-model=fable")
	cmd.Env = []string{"BACKPLANE_TEST_RUN_OVERRIDE=1", "PATH=" + bin + ":/usr/bin:/bin", "HOME=" + dir, "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "SOURCE_MARKER=" + filepath.Join(dir, "source-invoked"), "REVIEW_ARGV=" + filepath.Join(dir, "review-argv"), "REVIEW_SHA=" + filepath.Join(dir, "review-sha"), "REVIEW_SOURCE_EXECUTION=" + filepath.Join(dir, "review-source-execution")}
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("Claude/Fable source selection prevented independent configured Codex review: %v\n%s", err, output)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(unexpected) != 0 || len(claims) != 1 || len(receipts) != 1 || receipts[0].Outcome != "passed" || receipts[0].SourceSHA != sha || receipts[0].CandidateID != "preserved-candidate" {
		t.Fatalf("independent review did not complete the preserved candidate: claims=%+v receipts=%+v unexpected=%v\n%s", claims, receipts, unexpected, output)
	}
	if !claims[0].ExactCheckout || !claims[0].ArgvChecks {
		t.Errorf("lost exact-source completion capabilities: %+v", claims[0])
	}
	if !continueSource {
		if _, err := os.Stat(filepath.Join(dir, "source-invoked")); !os.IsNotExist(err) {
			t.Fatal("existing candidate caused source implementation to run again")
		}
	} else {
		sourceArgv, err := os.ReadFile(filepath.Join(dir, "source-invoked"))
		if err != nil || !strings.Contains(string(sourceArgv), "--model\nfable\n") || strings.Contains(string(sourceArgv), reviewerModel) {
			t.Fatalf("source did not retain Claude/Fable after Codex independent review: argv=%s err=%v", sourceArgv, err)
		}
		if len(sourceStarts) != 1 || sourceStarts[0]["provider"] != "claude-cli" || sourceStarts[0]["model"] != "fable" || len(sourceCompletions) != 1 || sourceCompletions[0]["status"] != "completed" {
			t.Fatalf("expected exactly one successful subsequent Fable source execution: starts=%v completions=%v", sourceStarts, sourceCompletions)
		}
	}
	argv, err := os.ReadFile(filepath.Join(dir, "review-argv"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(argv), "--model\n"+reviewerModel+"\n") || !strings.Contains(string(argv), role) || strings.Contains(string(argv), "fixture-private-lease") || strings.Contains(string(argv), "fable") {
		t.Fatalf("review lost independent role/model or exposed private lease: %s", argv)
	}
	actualSHA, err := os.ReadFile(filepath.Join(dir, "review-sha"))
	if err != nil || strings.TrimSpace(string(actualSHA)) != sha {
		t.Fatalf("review did not execute at accepted source: %s %v", actualSHA, err)
	}
	sourceExecution, err := os.ReadFile(filepath.Join(dir, "review-source-execution"))
	if err != nil || strings.TrimSpace(string(sourceExecution)) != "" {
		t.Fatalf("review inherited source execution identity: %q %v", sourceExecution, err)
	}
	after, err := os.ReadFile(path)
	if err != nil || string(after) != string(raw) {
		t.Fatal("per-run override changed saved config")
	}
}
