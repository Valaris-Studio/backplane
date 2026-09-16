// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

const completionPolicyV1 = `{"version":1,"landing_actor":"agent","landing_methods":["merge_queue"],"source_review":"none","review_role":null,"require_forge_checks":false,"postmerge_validation":null,"evidence_only":{"enabled":false,"approval":"none","review_role":null},"dependency_release":"done","auto_complete":true}`

func completionPolicyConfigJSON(t *testing.T, cfg valaris.BoardLoopConfig, policy, mandatoryContext string) string {
	t.Helper()
	var wire map[string]any
	if err := json.Unmarshal([]byte(loopConfigJSON(t, cfg)), &wire); err != nil {
		t.Fatal(err)
	}
	var policyValue any
	if err := json.Unmarshal([]byte(policy), &policyValue); err != nil {
		t.Fatal(err)
	}
	wire["completion_policy"] = policyValue
	wire["completion_policy_hash"] = "policy-hash-1"
	wire["completion_context"] = mandatoryContext
	encoded, err := json.Marshal(wire)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func decodeCompletionLoopConfig(t *testing.T, wire string) valaris.BoardLoopConfig {
	t.Helper()
	var cfg valaris.BoardLoopConfig
	if err := json.Unmarshal([]byte(wire), &cfg); err != nil {
		t.Fatal(err)
	}
	return cfg
}

func TestLandingPolicy_CodeInjectsMandatoryContextWithoutTemplateSlot(t *testing.T) {
	const mandatory = "MANDATORY COMPLETION POLICY: policy-hash-1; source work lands through request_landing; use exact accepted revisions."
	cfg := decodeCompletionLoopConfig(t, completionPolicyConfigJSON(t, baseLoopConfig(), completionPolicyV1, mandatory))
	provider := llm.NewMockProvider("worked")
	srv := newLoopModeServer(t)
	m := newLoopModeForServer(t, srv, provider)
	failed, _, _ := m.runIteration(context.Background(), &cfg, 1, "exec-fixture", provider, "model-1", 1, 0)
	if failed || provider.CallCount() != 1 {
		t.Fatalf("iteration failed=%v calls=%d", failed, provider.CallCount())
	}
	call := provider.Calls[0]
	if !strings.Contains(call.Prompt+"\n"+call.Options.SystemPrompt, mandatory) {
		t.Fatal("mandatory backend completion context was omitted when the authored templates have no policy slot")
	}
}

// These use the production provider launch paths and inspect the actual
// generated argv/config/rules. Fake CLI executables prevent any model spend or
// real forge mutation; they do not claim native CLI enforcement evidence.
func TestLandingPolicy_MediatedLandingPreservesProviderDenyFloor(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fixture CLI uses POSIX shell")
	}
	for _, providerName := range []string{"claude-cli", "codex-cli"} {
		t.Run(providerName, func(t *testing.T) {
			dir := t.TempDir()
			capturePath := filepath.Join(dir, "capture")
			t.Setenv("BACKPLANE_COMPLETION_CAPTURE", capturePath)
			// This is the provider's intended test-home configuration, keeping
			// sessions/config/auth discovery away from the operator's real home.
			t.Setenv("CODEX_HOME", filepath.Join(dir, "codex-test-home"))
			if err := os.MkdirAll(filepath.Join(dir, "codex-test-home"), 0o700); err != nil {
				t.Fatal(err)
			}
			fakeCLI := filepath.Join(dir, "fixture-cli")
			script := `#!/bin/sh
printf '%s\n' "$@" > "$BACKPLANE_COMPLETION_CAPTURE"
if [ -f "$CODEX_HOME/rules/backplane-deny.rules" ]; then
  cat "$CODEX_HOME/rules/backplane-deny.rules" >> "$BACKPLANE_COMPLETION_CAPTURE"
  cat "$CODEX_HOME/config.toml" >> "$BACKPLANE_COMPLETION_CAPTURE"
fi
previous=''
for argument in "$@"; do
  if [ "$previous" = '--mcp-config' ]; then cat "$argument" >> "$BACKPLANE_COMPLETION_CAPTURE"; fi
  previous="$argument"
done
printf '%s\n' '{"type":"result","result":"worked"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"worked"}}'
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}'
`
			if err := os.WriteFile(fakeCLI, []byte(script), 0o700); err != nil {
				t.Fatal(err)
			}
			var provider llm.Provider
			if providerName == "claude-cli" {
				provider = &llm.ClaudeCLI{ClaudeBin: fakeCLI}
			} else {
				provider = &llm.CodexCLI{CodexBin: fakeCLI}
			}
			cfg := decodeCompletionLoopConfig(t, completionPolicyConfigJSON(t, baseLoopConfig(), completionPolicyV1, "Use request_landing for permitted merges."))
			cfg.Tools = []string{"mcp__valaris__request_landing"}
			srv := newLoopModeServer(t)
			m := newLoopModeForServer(t, srv, provider)
			m.cfg.LLM.DangerouslySkipPermissions = true
			mcpPath := filepath.Join(dir, "mcp.json")
			if err := os.WriteFile(mcpPath, []byte(`{"mcpServers":{"valaris":{"command":"fixture-mcp","env":{"VALARIS_API_KEY":"vlr_fixture"}}}}`), 0o600); err != nil {
				t.Fatal(err)
			}
			m.cfg.LLM.MCPConfigPath = mcpPath
			failed, _, _ := m.runIteration(context.Background(), &cfg, 1, "exec-fixture", provider, "fixture-model", 1, 0)
			if failed {
				t.Fatal("fixture provider launch failed")
			}
			capture, err := os.ReadFile(capturePath)
			if err != nil {
				t.Fatal(err)
			}
			got := string(capture)
			for _, want := range []string{"request_landing", "VALARIS_MCP_ALLOWLIST", "gh pr merge", "git push origin main", "git push --force"} {
				if !strings.Contains(got, want) {
					t.Errorf("%s production launch lost %q", providerName, want)
				}
			}
			if strings.Contains(got, "--ignore-rules") {
				t.Fatal("agent-managed policy disabled provider rules")
			}
		})
	}
}
