// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writePathConfig writes a config whose two path fields are both caller-chosen,
// unlike writeConfig which pins mcp_config_path to an absolute literal.
func writePathConfig(t *testing.T, dir, mcpConfigPath, baseDir string) string {
	t.Helper()
	content := `
valaris:
  api_key: "vlr_test"
  workspace_slug: "test"
llm:
  mcp_config_path: "` + mcpConfigPath + `"
git:
  base_dir: "` + baseDir + `"
`
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

// The sibling of TestValidation_RelativeBaseDirResolvesAgainstConfigDir. Both
// fields name files the runner reads on behalf of a config, so resolving them
// against different bases (config dir vs process CWD) is a trap for whoever
// reads the YAML next.
func TestValidation_RelativeMCPConfigPathResolvesAgainstConfigDir(t *testing.T) {
	configDir := t.TempDir()
	cwdDir := t.TempDir()
	path := writePathConfig(t, configDir, "./mcp-config.json", "/tmp/backplane-runner-repos")

	t.Chdir(cwdDir)

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("expected relative mcp_config_path to load, got: %v", err)
	}

	got := realPath(t, filepath.Dir(cfg.LLM.MCPConfigPath))
	want := realPath(t, configDir)
	if got != want {
		t.Errorf("LLM.MCPConfigPath resolved under %q, want %q — a relative mcp_config_path must resolve against the config file's directory, not the process CWD (%q)", got, want, cwdDir)
	}
	if base := filepath.Base(cfg.LLM.MCPConfigPath); base != "mcp-config.json" {
		t.Errorf("LLM.MCPConfigPath = %q, want it to end in %q", cfg.LLM.MCPConfigPath, "mcp-config.json")
	}
}

// With no config file there is no anchor, so CWD stays the only available base.
func TestValidation_RelativeMCPConfigPathFallsBackToCWDWithoutConfigFile(t *testing.T) {
	cwdDir := t.TempDir()
	t.Chdir(cwdDir)

	cfg := defaults()
	cfg.Valaris.APIKey = "vlr_test"
	cfg.Valaris.WorkspaceSlug = "test"
	cfg.LLM.MCPConfigPath = "./mcp-config.json"
	cfg.Git.BaseDir = "/tmp/backplane-runner-repos"

	if err := validate(cfg, ""); err != nil {
		t.Fatalf("expected anchorless config to validate, got: %v", err)
	}

	got := realPath(t, filepath.Dir(cfg.LLM.MCPConfigPath))
	want := realPath(t, cwdDir)
	if got != want {
		t.Errorf("LLM.MCPConfigPath resolved under %q, want the process CWD %q — with no config file there is no directory to anchor to", got, want)
	}
}

// backend/app/services/agents/export.py emits ~-prefixed paths in exported
// agent YAML, so this is the shape a new operator is most likely to paste in.
// Left unexpanded it resolves to a literal "~" directory under the config dir
// and fails confusingly at clone time instead of at startup.
func TestValidation_ExpandsTildeInBaseDir(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	path := writePathConfig(t, t.TempDir(), "/tmp/mcp.json", "~/.valaris/repos")

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("expected ~-prefixed base_dir to load, got: %v", err)
	}

	want := filepath.Join(home, ".valaris", "repos")
	if cfg.Git.BaseDir != want {
		t.Errorf("Git.BaseDir = %q, want %q — a leading ~ must expand to the home directory, not become a literal %q directory", cfg.Git.BaseDir, want, "~")
	}
}

func TestValidation_ExpandsTildeInMCPConfigPath(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	path := writePathConfig(t, t.TempDir(), "~/.valaris/mcp-config.json", "/tmp/backplane-runner-repos")

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("expected ~-prefixed mcp_config_path to load, got: %v", err)
	}

	want := filepath.Join(home, ".valaris", "mcp-config.json")
	if cfg.LLM.MCPConfigPath != want {
		t.Errorf("LLM.MCPConfigPath = %q, want %q — a leading ~ must expand to the home directory", cfg.LLM.MCPConfigPath, want)
	}
}

// A ~ that is not a path prefix is an ordinary character: "~foo" is another
// user's home in shell syntax, which we do not resolve, and a bare directory
// named "~backup" must not be silently rewritten.
func TestValidation_LeavesNonPrefixTildeAlone(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	configDir := t.TempDir()
	path := writePathConfig(t, configDir, "/tmp/mcp.json", "./repos~backup")

	cfg, err := Load(path)
	if err != nil {
		t.Fatalf("expected base_dir with an embedded ~ to load, got: %v", err)
	}

	if strings.Contains(cfg.Git.BaseDir, home) {
		t.Errorf("Git.BaseDir = %q must not expand against HOME %q — only a leading ~/ is a home reference", cfg.Git.BaseDir, home)
	}
	if base := filepath.Base(cfg.Git.BaseDir); base != "repos~backup" {
		t.Errorf("Git.BaseDir = %q, want it to end in %q", cfg.Git.BaseDir, "repos~backup")
	}
}

// The worktree guard runs on the EXPANDED path: expanding after the guard
// would let a ~-prefixed base_dir smuggle a live worktree past it.
func TestValidation_WorktreeGuardSeesExpandedTildePath(t *testing.T) {
	home := t.TempDir()
	initGitRepo(t, home)
	t.Setenv("HOME", home)

	path := writePathConfig(t, t.TempDir(), "/tmp/mcp.json", "~/repos")

	_, err := Load(path)
	if err == nil {
		t.Fatalf("expected error: ~/repos expands into git worktree %q, which a reset --hard would rewind", home)
	}
	if !strings.Contains(err.Error(), home) {
		t.Errorf("error must name the offending git worktree %q so an operator can act on it, got: %v", home, err)
	}
}
