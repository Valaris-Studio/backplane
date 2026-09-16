// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
)

// Exercise the generation → real stdio process → loop → provider boundary.
// The uvx fixture models an older available package independently of the pin.
func TestGeneratedMCPCompletionPreflight(t *testing.T) {
	for _, scenario := range []string{"old_catalog", "policy_409", "malformed_policy", "policy_mismatch", "compatible", "paginated", "missing_executable", "hang", "rpc_error", "missing_config", "tool_error"} {
		t.Run(scenario, func(t *testing.T) {
			cfg := baseLoopConfig()
			cfg.Model = "fable"
			cfg.MaxIterations = 1
			wire := completionPolicyConfigJSON(t, cfg, completionPolicyV1, "Mandatory completion policy.")
			disabled := cfg
			disabled.Enabled = false
			srv := newCompletionWorkServer(t, wire, completionPolicyConfigJSON(t, disabled, completionPolicyV1, "Paused."))
			provider := llm.NewMockProvider("BOOTSTRAP")
			path, requests := generatedCompletionMCP(t, scenario, wire)
			if scenario == "missing_config" {
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			}
			m := newLoopModeWithMCPTemplate(t, srv.base, provider, path)
			timeout := 3 * time.Second
			if scenario == "hang" {
				timeout = 150 * time.Millisecond
			}
			ctx, cancel := context.WithTimeout(context.Background(), timeout)
			defer cancel()
			err := m.Run(ctx)
			if scenario == "compatible" || scenario == "paginated" {
				if err != nil || provider.CallCount() != 1 {
					t.Fatalf("compatible generated config must reach BOOTSTRAP: calls=%d err=%v", provider.CallCount(), err)
				}
				data, _ := os.ReadFile(requests)
				for _, want := range []string{"backplane-mcp==0.8.0", "get_board_loop", "board-1", "acme"} {
					if !strings.Contains(string(data), want) {
						t.Errorf("actual generated process did not receive %q: %s", want, data)
					}
				}
				if !strings.Contains(string(data), "ENV=all|vlr_test|https://fixture.invalid") {
					t.Errorf("preflight did not use the generated launch environment: %s", data)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), path) || !strings.Contains(err.Error(), "before model invocation") {
				t.Errorf("expected actionable setup failure with config path, got %v", err)
			}
			if scenario == "old_catalog" && (err == nil || !strings.Contains(err.Error(), "submit_completion_candidate") || !strings.Contains(err.Error(), "0.7.3")) {
				t.Errorf("must identify actual stale server and missing tools: %v", err)
			}
			if scenario == "policy_409" && (err == nil || !strings.Contains(err.Error(), "completion_runner_upgrade_required")) {
				t.Errorf("must preserve backend compatibility diagnosis: %v", err)
			}
			if provider.CallCount() != 0 || srv.base.executionStartCount() != 0 || srv.base.patchCount() != 0 {
				t.Fatalf("setup failure reached paid execution or mutated loop: calls=%d starts=%d patches=%d", provider.CallCount(), srv.base.executionStartCount(), srv.base.patchCount())
			}
		})
	}
}

func generatedCompletionMCP(t *testing.T, scenario, policy string) (string, string) {
	t.Helper()
	dir := t.TempDir()
	requests := filepath.Join(dir, "requests")
	tools := []string{"get_board_loop", "set_board_loop", "get_completion_policy", "get_completion_status", "submit_completion_candidate", "request_landing", "retry_completion"}
	version := "0.8.0"
	if scenario == "old_catalog" {
		tools = tools[:2]
		version = "0.7.3"
	}
	entries := []map[string]any{}
	for _, name := range tools {
		entries = append(entries, map[string]any{"name": name})
	}
	if scenario == "policy_409" {
		policy = `{"error":true,"status":409,"error_code":"completion_runner_upgrade_required","message":"Upgrade the MCP server"}`
	}
	if scenario == "malformed_policy" {
		policy = `{}`
	}
	if scenario == "policy_mismatch" {
		policy = strings.ReplaceAll(policy, "policy-hash-1", "different-policy")
	}
	response := func(id int, result any) string {
		b, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "result": result})
		if err != nil {
			t.Fatal(err)
		}
		return string(b)
	}
	// Test JSON contains no single quotes; shell quotes here protect JSON verbatim.
	script := fmt.Sprintf(`#!/bin/sh
printf '%%s\n' "$*" >> "$MCP_TEST_REQUESTS"
printf 'ENV=%%s|%%s|%%s\n' "$VALARIS_MCP_TOOLSETS" "$VALARIS_API_KEY" "$VALARIS_API_URL" >> "$MCP_TEST_REQUESTS"
while IFS= read -r line; do
  printf '%%s\n' "$line" >> "$MCP_TEST_REQUESTS"
  case "$line" in
    *'"initialize"'*) printf '%%s\n' '%s';;
    *'"tools/list"'*) printf '%%s\n' '%s';;
    *'"tools/call"'*) printf '%%s\n' '%s';;
  esac
done
	`, response(1, map[string]any{"protocolVersion": "2024-11-05", "capabilities": map[string]any{"tools": map[string]any{}}, "serverInfo": map[string]any{"name": "backplane-mcp", "version": version}}), response(2, map[string]any{"tools": entries}), response(3, map[string]any{"isError": scenario == "tool_error", "content": []map[string]any{{"type": "text", "text": policy}}}))
	if scenario == "paginated" {
		script = strings.Replace(script, response(2, map[string]any{"tools": entries}), response(2, map[string]any{"tools": entries[:2], "nextCursor": "second"}), 1)
		script = strings.Replace(script, "case \"$line\" in", "case \"$line\" in\n    *'\"cursor\":\"second\"'*) printf '%s\\n' '"+response(3, map[string]any{"tools": entries[2:]})+"';;", 1)
		script = strings.Replace(script, `"id":3,"jsonrpc":"2.0","result":{"content"`, `"id":4,"jsonrpc":"2.0","result":{"content"`, 1)
	}
	if scenario == "hang" {
		script = "#!/bin/sh\nwhile IFS= read -r line; do :; done\n"
	}
	if scenario == "rpc_error" {
		script = "#!/bin/sh\nread -r line\nprintf '%s\\n' '{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32603,\"message\":\"internal failure\"}}'\n"
	}
	if scenario != "missing_executable" {
		if err := os.WriteFile(filepath.Join(dir, "uvx"), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	gitPath, err := exec.LookPath("git")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(gitPath, filepath.Join(dir, "git")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("MCP_TEST_REQUESTS", requests)
	path := filepath.Join(dir, "generated-mcp.json")
	if err := tui.WriteMCPConfig(path, tui.MCPConfigSeed{Launch: tui.MCPLaunchUvx(), APIURL: "https://fixture.invalid", APIKey: "vlr_test"}); err != nil {
		t.Fatal(err)
	}
	return path, requests
}
