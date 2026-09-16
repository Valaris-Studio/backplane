// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/profile"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
	"github.com/Valaris-Studio/backplane/runner/internal/workloop"
	tea "github.com/charmbracelet/bubbletea"
)

func TestMCPSelectionWizardProfileRelaunchUsesOnlyChosenConfig(t *testing.T) {
	defer tui.ForcePlain()()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", filepath.Join(dir, "config-home"))
	store := profile.NewStore(profile.DefaultRoot())
	const secret = "fixture-mcp-key-never-display"
	var sourceCompleted atomic.Bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/loop"):
			_ = json.NewEncoder(w).Encode(map[string]any{"enabled": !sourceCompleted.Load(), "budget_usd": 10, "max_iterations": 1, "max_consecutive_failures": 1, "iteration_timeout_seconds": 5, "starvation_policy": "always_run", "loop_prompt": "Perform the disposable source iteration.", "provider": "claude-cli", "model": "fixture-source", "completion_policy": map[string]any{"version": 1}, "completion_policy_hash": "picker-policy", "completion_context": "Fixture mandatory policy."})
		case strings.HasSuffix(r.URL.Path, "/completion/readiness"):
			_, _ = w.Write([]byte(`{"policy_hash":"picker-policy","ready":true,"checks":[{"operation":"repository_binding","repo_id":"repo-1","required":true,"status":"verified","code":"verified","credential_source":"workspace_connection","connection_id":"connection-1"},{"operation":"repository_read","repo_id":"repo-1","required":true,"status":"verified","code":"verified","credential_source":"workspace_connection","connection_id":"connection-1"},{"operation":"pull_requests_read","repo_id":"repo-1","required":true,"status":"verified","code":"verified","credential_source":"workspace_connection","connection_id":"connection-1"},{"operation":"forge_write","repo_id":"repo-1","required":false,"status":"unverified","code":"write_unverified"}]}`))
		case strings.HasSuffix(r.URL.Path, "/completion/requirements"):
			_, _ = w.Write([]byte(`{"policy_hash":"picker-policy","requirements":[]}`))
		case strings.HasSuffix(r.URL.Path, "/completion/work"):
			_, _ = w.Write([]byte(`{"pending_count":0,"actionable_count":0,"failed_count":0}`))
		case strings.HasSuffix(r.URL.Path, "/loop/history"):
			_, _ = w.Write([]byte(`{"iteration_count":0,"spent_usd":0,"lifetime_spent_usd":0,"budget_epoch":null}`))
		case strings.HasSuffix(r.URL.Path, "/skills"):
			_, _ = w.Write([]byte(`{"skills":[]}`))
		case strings.HasSuffix(r.URL.Path, "/heartbeat"):
			_, _ = w.Write([]byte(`{"id":"fixture-agent","is_active":true}`))
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/executions"):
			_, _ = w.Write([]byte(`{"id":"fixture-source-execution"}`))
		case r.Method == http.MethodPatch && strings.Contains(r.URL.Path, "/executions/"):
			sourceCompleted.Store(true)
			_, _ = w.Write([]byte(`{"id":"fixture-source-execution"}`))
		default:
			t.Errorf("unexpected fixture HTTP request %s %s", r.Method, r.URL.Path)
			http.Error(w, "unexpected request", http.StatusNotFound)
		}
	}))
	defer server.Close()
	write := func(path, value string, mode os.FileMode) {
		t.Helper()
		if err := os.WriteFile(path, []byte(value), mode); err != nil {
			t.Fatal(err)
		}
	}
	markerA, markerB := filepath.Join(dir, "A-invoked"), filepath.Join(dir, "B-invoked")
	scriptA, scriptB := filepath.Join(dir, "server-A"), filepath.Join(dir, "server-B")
	write(scriptA, "#!/bin/sh\nprintf invoked > \"$MARKER\"\nexit 99\n", 0700)
	write(scriptB, `#!/bin/sh
printf invoked > "$MARKER"
while IFS= read -r line; do
 case "$line" in
 *'"initialize"'*) printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","serverInfo":{"name":"fixture-B","version":"0.8.0"}}}';;
 *'"tools/list"'*) printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"get_board_loop"},{"name":"get_completion_policy"},{"name":"get_completion_status"},{"name":"submit_completion_candidate"},{"name":"request_landing"},{"name":"retry_completion"}]}}';;
 *'"tools/call"'*) printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\"completion_policy\":{\"version\":1},\"completion_policy_hash\":\"picker-policy\",\"completion_context\":\"Fixture mandatory policy.\"}"}]}}';;
 esac
done
`, 0700)
	otherCWD := filepath.Join(dir, "other-project")
	if err := os.Mkdir(otherCWD, 0700); err != nil {
		t.Fatal(err)
	}
	configA, configB := filepath.Join(otherCWD, "mcp-config.json"), filepath.Join(dir, "chosen-arbitrary.config")
	for _, entry := range []struct{ path, executable, marker string }{{configA, scriptA, markerA}, {configB, scriptB, markerB}} {
		body, err := json.Marshal(map[string]any{"mcpServers": map[string]any{"valaris": map[string]any{"command": entry.executable, "env": map[string]string{"MARKER": entry.marker, "VALARIS_API_KEY": secret}}}})
		if err != nil {
			t.Fatal(err)
		}
		write(entry.path, string(body), 0600)
	}
	seed := fmt.Sprintf("valaris:\n  workspace_slug: fixture\nllm:\n  provider: claude-cli\n  model: fixture-source\n  mcp_config_path: %q\ngit:\n  base_dir: %q\n  forge: gitea\n", configA, filepath.Join(dir, "repos"))
	if err := store.Save("chosen-profile", profile.Credentials{APIKey: "vlr_fixture", APIURL: server.URL, Workspace: "fixture"}, []byte(seed), []byte("{}")); err != nil {
		t.Fatal(err)
	}
	deps := tui.WizardDeps{
		Profiles: store,
		Connect:  func(context.Context) (tui.Identity, error) { return tui.Identity{AgentName: "fixture-runner"}, nil },
		LoadBoards: func(context.Context, string) ([]tui.BoardChoice, error) {
			return []tui.BoardChoice{{ID: "fixture-board", Name: "Fixture board"}}, nil
		},
		ValidateWorkDir: func(string) error { return nil },
		Providers:       []string{"claude"}, DefaultWorkDir: filepath.Join(dir, "repos"), DefaultModel: "fixture-source", DefaultBudget: 10,
		MCPStatus: func() tui.MCPConfigStatus { return tui.MCPConfigStatus{Path: configA} },
		DiscoverMCPConfigs: func() []tui.MCPConfigCandidate {
			return []tui.MCPConfigCandidate{{Path: configA, Origin: "current directory"}, {Path: configB, Origin: "operator config"}}
		},
		ValidateMCPConfig: validateMCPConfig,
	}
	w := tui.NewWizard(deps)
	views := &strings.Builder{}
	update := func(msg tea.Msg) {
		model, cmd := w.Update(msg)
		w = model.(tui.Wizard)
		for cmd != nil && (w.Step() == tui.StepConnect || w.Step() == tui.StepBoard || w.Step() == tui.StepWorkspace) {
			model, cmd = w.Update(cmd())
			w = model.(tui.Wizard)
		}
		views.WriteString(w.View())
	}
	update(tea.WindowSizeMsg{Width: 240, Height: 40})
	for i := 0; i < 12 && w.Step() != tui.StepMCP; i++ {
		update(tea.KeyMsg{Type: tea.KeyEnter})
	}
	if w.Step() != tui.StepMCP {
		t.Fatalf("wizard did not offer config choice: step=%s\n%s", w.Step(), w.View())
	}
	choose := func(label string) {
		t.Helper()
		for i := 0; i < 20; i++ {
			lines := strings.Split(w.View(), "\n")
			for _, line := range lines {
				if strings.Contains(line, "▸") && strings.Contains(line, label) {
					update(tea.KeyMsg{Type: tea.KeyEnter})
					return
				}
			}
			update(tea.KeyMsg{Type: tea.KeyDown})
		}
		t.Fatalf("could not select %q in actual menu:\n%s", label, w.View())
	}
	choose("Auto-find")
	choose(filepath.Base(configB))
	if w.Step() != tui.StepReview {
		t.Fatalf("selection did not reach review: %s\n%s", w.Step(), w.View())
	}
	result := w.Result()
	if result.MCPConfigPath != configB || !result.MCPConfigSelected || result.MCPConfigOrigin == "" {
		t.Fatalf("selected config identity lost: path=%q origin=%q", result.MCPConfigPath, result.MCPConfigOrigin)
	}
	creds, err := applyWizardMCP(result, Credentials{APIURL: server.URL, APIKey: "vlr_fixture", Workspace: "fixture", MCPConfigPath: configA})
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := interactiveConfig(result, creds)
	if err != nil {
		t.Fatal(err)
	}
	if err = applyWizardProfile(result, cfg, store); err != nil {
		t.Fatal(err)
	}
	t.Chdir(otherCWD)
	saved, err := config.Load(store.ConfigPath("chosen-profile"))
	if err != nil {
		t.Fatal(err)
	}
	if saved.LLM.MCPConfigPath != configB {
		t.Fatalf("changed CWD changed profile selection to %q", saved.LLM.MCPConfigPath)
	}
	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(previousLogger)
	run := func() (int, error) {
		provider := llm.NewMockProvider("disposable source completed")
		provider.NameOverride = "claude-cli"
		provider.QueueStructured([]byte(`{"outcome":"worked","summary":"disposable source completed"}`))
		client := valaris.NewClient(server.URL, "vlr_fixture")
		client.Agent = &valaris.AgentConfig{ID: "fixture-agent", IsActive: true}
		mode := workloop.NewLoopMode(client, saved, map[string]llm.Provider{"claude-cli": provider}, provider, "fixture", "fixture-board", "fixture-agent")
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		defer cancel()
		err := mode.Run(ctx)
		return provider.CallCount(), err
	}
	if calls, err := run(); err != nil || calls != 1 {
		t.Fatalf("selected profile failed actual preflight/source seam: calls=%d err=%v\n%s", calls, err, &logs)
	}
	if _, err := os.Stat(markerB); err != nil {
		t.Fatal("selected B was not preflighted")
	}
	if _, err := os.Stat(markerA); !os.IsNotExist(err) {
		t.Fatal("unselected discovered A was executed")
	}
	if err := os.Remove(configB); err != nil {
		t.Fatal(err)
	}
	sourceCompleted.Store(false)
	calls, err := run()
	if err == nil || calls != 0 {
		t.Fatalf("missing explicit B must stop before source: calls=%d err=%v", calls, err)
	}
	if _, err := os.Stat(markerA); !os.IsNotExist(err) {
		t.Fatal("missing B silently fell back to discovered A")
	}
	if strings.Contains(views.String()+logs.String()+err.Error(), secret) {
		t.Fatal("MCP config credential leaked in views, launch logs or errors")
	}
}
