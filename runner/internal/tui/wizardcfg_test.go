// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
)

// The server-state cases speak the SAME vocabulary as the web chip
// (off/running/waiting/unattended/parked, see use-board-loop-status.ts) so one
// board never reads two different dialects across the two surfaces. The
// serverState=="" cases are the fail-soft path for a backend too old to serve
// /loop/status, where the runner falls back to deriving the phrase itself.
func TestStateNoteFor(t *testing.T) {
	tests := []struct {
		name           string
		serverState    string
		loopEnabled    bool
		loopConfigured bool
		actionable     bool
		ready          int
		blocked        int
		repos          int
		want           string
	}{
		{
			name:        "server says off, with ready work",
			serverState: "off",
			actionable:  true,
			ready:       3,
			repos:       1,
			want:        "off · 3 ready",
		},
		{
			name:        "server says running",
			serverState: "running",
			loopEnabled: true,
			actionable:  true,
			ready:       2,
			repos:       1,
			want:        "running · 2 ready",
		},
		{
			name:        "server says waiting with work available",
			serverState: "waiting",
			loopEnabled: true,
			actionable:  true,
			ready:       5,
			repos:       1,
			want:        "waiting · 5 ready",
		},
		{
			name:        "server says parked",
			serverState: "parked",
			loopEnabled: true,
			repos:       1,
			want:        "parked · nothing ready",
		},
		{
			name:        "server says unattended, blocked cards surface",
			serverState: "unattended",
			loopEnabled: true,
			blocked:     4,
			repos:       1,
			want:        "unattended · nothing ready · 4 blocked",
		},
		{
			// Older backends resolve `waiting` without knowing about parking;
			// the readiness inference may only ever upgrade waiting, matching
			// resolveLoopChipState's fallback in the web chip.
			name:        "waiting and not actionable is inferred as parked",
			serverState: "waiting",
			loopEnabled: true,
			blocked:     2,
			repos:       1,
			want:        "parked · nothing ready · 2 blocked",
		},
		{
			name:        "server state still names a missing repo",
			serverState: "unattended",
			loopEnabled: true,
			want:        "unattended · nothing ready · no repo linked",
		},
		{
			name: "no server state and no loop config names both gaps",
			want: "loop not set up · no repo linked",
		},
		{
			name:  "no server state, unconfigured board with a repo",
			repos: 1,
			want:  "loop not set up",
		},
		{
			name:           "no server state, configured but off, with ready work",
			loopConfigured: true,
			actionable:     true,
			ready:          3,
			repos:          1,
			want:           "loop off · 3 ready",
		},
		{
			name:           "no server state, running loop with ready work",
			loopEnabled:    true,
			loopConfigured: true,
			actionable:     true,
			ready:          2,
			repos:          1,
			want:           "loop on · 2 ready",
		},
		{
			name:           "no server state, running loop with nothing actionable but blocked cards",
			loopEnabled:    true,
			loopConfigured: true,
			blocked:        4,
			repos:          1,
			want:           "loop on · nothing ready · 4 blocked",
		},
		{
			name:           "no server state, idle configured loop with an empty board",
			loopConfigured: true,
			repos:          1,
			want:           "loop off · nothing ready",
		},
		{
			name:           "no server state, ready and blocked both surface",
			loopEnabled:    true,
			loopConfigured: true,
			actionable:     true,
			ready:          1,
			blocked:        2,
			repos:          2,
			want:           "loop on · 1 ready · 2 blocked",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := StateNoteFor(tt.serverState, tt.loopEnabled, tt.loopConfigured, tt.actionable, tt.ready, tt.blocked, tt.repos)
			if got != tt.want {
				t.Errorf("StateNoteFor() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestPipelineStateNoteFor(t *testing.T) {
	tests := []struct {
		name       string
		configured bool
		ready      int
		blocked    int
		repos      int
		want       string
	}{
		{
			name: "untyped board with no repo names both gaps",
			want: "pipeline not set up · no repo linked",
		},
		{
			name:  "untyped board with a repo only names the pipeline gap",
			repos: 1,
			want:  "pipeline not set up",
		},
		{
			name:       "set up with ready work",
			configured: true,
			ready:      3,
			repos:      1,
			want:       "3 ready",
		},
		{
			name:       "set up but idle",
			configured: true,
			repos:      1,
			want:       "nothing ready",
		},
		{
			name:       "ready and blocked both surface",
			configured: true,
			ready:      1,
			blocked:    2,
			repos:      1,
			want:       "1 ready · 2 blocked",
		},
		{
			name:       "set up but no repo linked",
			configured: true,
			ready:      2,
			want:       "2 ready · no repo linked",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := PipelineStateNoteFor(tt.configured, tt.ready, tt.blocked, tt.repos)
			if got != tt.want {
				t.Errorf("PipelineStateNoteFor() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestResultApply_OverlaysEveryChoice(t *testing.T) {
	base := config.Defaults()
	r := Result{
		Mode:      ModeLoop,
		BoardID:   "board-abc",
		BoardName: "Backplane",
		WorkDir:   "/tmp/runner-repos",
		Provider:  "codex-cli",
		Model:     "gpt-5",
		BudgetUSD: 7.5,
	}

	cfg := r.Apply(base)

	if cfg.Git.BaseDir != "/tmp/runner-repos" {
		t.Errorf("Git.BaseDir = %q", cfg.Git.BaseDir)
	}
	if cfg.LLM.Provider != "codex-cli" {
		t.Errorf("LLM.Provider = %q", cfg.LLM.Provider)
	}
	if cfg.LLM.Model != "gpt-5" {
		t.Errorf("LLM.Model = %q", cfg.LLM.Model)
	}
	if cfg.LLM.MaxBudgetUSD != 7.5 {
		t.Errorf("LLM.MaxBudgetUSD = %v", cfg.LLM.MaxBudgetUSD)
	}
	if len(cfg.Valaris.BoardIDs) != 1 || cfg.Valaris.BoardIDs[0] != "board-abc" {
		t.Errorf("Valaris.BoardIDs = %v, want exactly [board-abc]", cfg.Valaris.BoardIDs)
	}
}

func TestNormalizeProvider(t *testing.T) {
	tests := map[string]string{
		"claude":     "claude-cli",
		"codex":      "codex-cli",
		"claude-cli": "claude-cli",
		"codex-cli":  "codex-cli",
		"":           "",
		"future-cli": "future-cli",
	}
	for in, want := range tests {
		if got := NormalizeProvider(in); got != want {
			t.Errorf("NormalizeProvider(%q) = %q, want %q", in, got, want)
		}
	}
}

// The picker offers bare binary names; config.LLMConfig.Provider only accepts
// the "-cli" ids, and buildProviders exits loudly on anything else.
func TestResultApply_NormalizesTheProviderLabel(t *testing.T) {
	cfg := Result{Mode: ModeLoop, Provider: "codex"}.Apply(config.Defaults())
	if cfg.LLM.Provider != "codex-cli" {
		t.Errorf("LLM.Provider = %q, want codex-cli", cfg.LLM.Provider)
	}
}

func TestResultApply_ZeroValuesKeepDefaults(t *testing.T) {
	base := config.Defaults()
	base.Git.BaseDir = "/keep/me"

	cfg := Result{Mode: ModePipeline}.Apply(base)

	if cfg.Git.BaseDir != "/keep/me" {
		t.Errorf("empty WorkDir clobbered Git.BaseDir: %q", cfg.Git.BaseDir)
	}
	if cfg.LLM.Provider != "claude-cli" {
		t.Errorf("empty Provider clobbered the default: %q", cfg.LLM.Provider)
	}
	if cfg.LLM.Model != "sonnet" {
		t.Errorf("empty Model clobbered the default: %q", cfg.LLM.Model)
	}
	if cfg.LLM.MaxBudgetUSD != 1.0 {
		t.Errorf("zero BudgetUSD clobbered the default: %v", cfg.LLM.MaxBudgetUSD)
	}
}

// A non-loop mode must not pin board_ids: the pipeline work loop reads it as
// "boards to monitor", where empty means the whole workspace.
func TestResultApply_BoardIDOnlyBindsInLoopMode(t *testing.T) {
	cfg := Result{Mode: ModePipeline, BoardID: "board-abc"}.Apply(config.Defaults())
	if len(cfg.Valaris.BoardIDs) != 0 {
		t.Errorf("pipeline mode pinned board_ids: %v", cfg.Valaris.BoardIDs)
	}
}

func TestResultApply_NilBaseUsesDefaults(t *testing.T) {
	cfg := Result{Mode: ModeLoop, BoardID: "b1"}.Apply(nil)
	if cfg == nil {
		t.Fatal("Apply(nil) returned nil")
	}
	if cfg.LLM.Provider != "claude-cli" {
		t.Errorf("Apply(nil) did not start from defaults: %q", cfg.LLM.Provider)
	}
}

// Apply must not mutate the caller's config in place — the wizard may run
// Apply repeatedly as the user walks back and forth through the steps.
func TestResultApply_DoesNotMutateBase(t *testing.T) {
	base := config.Defaults()
	Result{Mode: ModeLoop, BoardID: "b1", Provider: "codex-cli"}.Apply(base)
	if base.LLM.Provider != "claude-cli" {
		t.Errorf("Apply mutated the base config: %q", base.LLM.Provider)
	}
	if len(base.Valaris.BoardIDs) != 0 {
		t.Errorf("Apply mutated the base config's board_ids: %v", base.Valaris.BoardIDs)
	}
}

const fakeAPIKey = "vlr_secret123"

func TestMarshalConfigYAML_NeverWritesTheAPIKey(t *testing.T) {
	cfg := config.Defaults()
	cfg.Valaris.APIKey = fakeAPIKey
	cfg.Valaris.WorkspaceSlug = "acme"
	cfg.LLM.MCPConfigPath = "/tmp/mcp.json"

	data, err := MarshalConfigYAML(cfg)
	if err != nil {
		t.Fatalf("MarshalConfigYAML: %v", err)
	}
	if strings.Contains(string(data), fakeAPIKey) {
		t.Fatalf("serialized config leaked the API key:\n%s", data)
	}
	if !strings.Contains(string(data), APIKeyPlaceholder) {
		t.Errorf("serialized config missing the %s placeholder:\n%s", APIKeyPlaceholder, data)
	}
}

// The saved file must survive a real config.Load — a config the wizard writes
// but the runner cannot read is worse than no file at all.
func TestMarshalConfigYAML_RoundTripsThroughLoad(t *testing.T) {
	cfg := config.Defaults()
	cfg.Valaris.APIKey = fakeAPIKey
	cfg.Valaris.WorkspaceSlug = "acme"
	cfg.Valaris.BoardIDs = []string{"board-abc"}
	cfg.LLM.MCPConfigPath = filepath.Join(t.TempDir(), "mcp.json")
	cfg.LLM.Provider = "codex-cli"
	cfg.LLM.Model = "gpt-5"
	cfg.LLM.MaxBudgetUSD = 4.25
	cfg.Git.BaseDir = t.TempDir()

	data, err := MarshalConfigYAML(cfg)
	if err != nil {
		t.Fatalf("MarshalConfigYAML: %v", err)
	}
	path := filepath.Join(t.TempDir(), "runner.yaml")
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}

	// config.Load validates api_key non-empty; the placeholder is meant to be
	// filled from the environment, which is exactly how the runner reads it.
	t.Setenv("VALARIS_API_KEY", fakeAPIKey)

	loaded, err := config.Load(path)
	if err != nil {
		t.Fatalf("config.Load on the wizard-written file: %v", err)
	}
	if loaded.Valaris.WorkspaceSlug != "acme" {
		t.Errorf("workspace_slug = %q", loaded.Valaris.WorkspaceSlug)
	}
	if loaded.LLM.Provider != "codex-cli" || loaded.LLM.Model != "gpt-5" {
		t.Errorf("llm round-trip lost values: %+v", loaded.LLM)
	}
	if loaded.LLM.MaxBudgetUSD != 4.25 {
		t.Errorf("max_budget_usd = %v", loaded.LLM.MaxBudgetUSD)
	}
	if len(loaded.Valaris.BoardIDs) != 1 || loaded.Valaris.BoardIDs[0] != "board-abc" {
		t.Errorf("board_ids = %v", loaded.Valaris.BoardIDs)
	}
	if loaded.Git.BaseDir != cfg.Git.BaseDir {
		t.Errorf("git.base_dir = %q, want %q", loaded.Git.BaseDir, cfg.Git.BaseDir)
	}
}

// The anthropic key is the second plaintext secret on the struct; it must be
// elided the same way as the platform key.
func TestMarshalConfigYAML_ElidesAnthropicKey(t *testing.T) {
	cfg := config.Defaults()
	cfg.LLM.AnthropicAPIKey = "sk-ant-topsecret"
	cfg.Git.ForgeToken = "forge-topsecret"
	cfg.Git.Tokens = map[string]string{"reviewer": "ghp_topsecret"}

	data, err := MarshalConfigYAML(cfg)
	if err != nil {
		t.Fatalf("MarshalConfigYAML: %v", err)
	}
	for _, secret := range []string{"sk-ant-topsecret", "forge-topsecret", "ghp_topsecret"} {
		if strings.Contains(string(data), secret) {
			t.Errorf("serialized config leaked %q:\n%s", secret, data)
		}
	}
}

func TestSaveConfig_WritesPrivateFileAndCreatesParents(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "deeper", "runner.yaml")
	cfg := config.Defaults()
	cfg.Valaris.APIKey = fakeAPIKey

	if err := SaveConfig(path, cfg); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("perms = %o, want 600", perm)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), fakeAPIKey) {
		t.Errorf("saved file leaked the API key:\n%s", data)
	}
}

func TestSaveConfig_RefusesToClobber(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runner.yaml")
	if err := os.WriteFile(path, []byte("original: true\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	err := SaveConfig(path, config.Defaults())
	if !errors.Is(err, ErrConfigExists) {
		t.Fatalf("err = %v, want ErrConfigExists", err)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "original: true\n" {
		t.Errorf("existing file was modified: %q", data)
	}
}

func TestSaveConfigOverwrite_ReplacesExisting(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runner.yaml")
	if err := os.WriteFile(path, []byte("original: true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := config.Defaults()
	cfg.Valaris.WorkspaceSlug = "acme"

	if err := SaveConfigOverwrite(path, cfg); err != nil {
		t.Fatalf("SaveConfigOverwrite: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "acme") {
		t.Errorf("overwrite did not write the new config:\n%s", data)
	}
}
