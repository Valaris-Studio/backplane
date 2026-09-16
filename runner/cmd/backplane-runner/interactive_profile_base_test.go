// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/profile"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
)

// A USE/EDIT launch must honor the loaded profile's non-wizard YAML settings
// (log level, workloop tuning, …), not rebuild the run config from shipped
// defaults — while wizard-owned fields still win via Result.Apply.
func TestInteractiveConfigUsesLoadedProfileYAMLAsBase(t *testing.T) {
	configHome := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configHome)
	store := profile.NewStore(filepath.Join(configHome, "backplane"))

	profileYAML := []byte("log_level: debug\ngit:\n  base_dir: /profile/stale/dir\n")
	creds := profile.Credentials{APIKey: "vlr_test_key", APIURL: "https://api.example.com", Workspace: "acme"}
	if err := store.SaveOverwrite("p1", creds, profileYAML, []byte("{}")); err != nil {
		t.Fatalf("SaveOverwrite: %v", err)
	}

	mcpPath := filepath.Join(t.TempDir(), "mcp-config.json")
	if err := os.WriteFile(mcpPath, []byte(`{"mcpServers":{}}`), 0o600); err != nil {
		t.Fatalf("write mcp config: %v", err)
	}
	wizardWorkDir := t.TempDir()

	cfg, err := interactiveConfig(tui.Result{
		LoadedProfileName: "p1",
		MCPConfigPath:     mcpPath,
		MCPConfigSelected: true,
		WorkDir:           wizardWorkDir,
	}, Credentials{
		APIKey:        "vlr_test_key",
		APIURL:        "https://api.example.com",
		Workspace:     "acme",
		MCPConfigPath: mcpPath,
	})
	if err != nil {
		t.Fatalf("interactiveConfig: %v", err)
	}
	if cfg.LogLevel != "debug" {
		t.Errorf("LogLevel = %q, want the profile YAML's %q", cfg.LogLevel, "debug")
	}
	if cfg.Git.BaseDir != wizardWorkDir {
		t.Errorf("Git.BaseDir = %q, want the wizard's %q to win over the profile YAML", cfg.Git.BaseDir, wizardWorkDir)
	}
}

// Without a loaded profile the base stays the shipped defaults.
func TestInteractiveConfigWithoutLoadedProfileKeepsDefaults(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	mcpPath := filepath.Join(t.TempDir(), "mcp-config.json")
	if err := os.WriteFile(mcpPath, []byte(`{"mcpServers":{}}`), 0o600); err != nil {
		t.Fatalf("write mcp config: %v", err)
	}

	cfg, err := interactiveConfig(tui.Result{WorkDir: t.TempDir()}, Credentials{
		APIKey: "vlr_test_key", APIURL: "https://api.example.com", Workspace: "acme", MCPConfigPath: mcpPath,
	})
	if err != nil {
		t.Fatalf("interactiveConfig: %v", err)
	}
	if cfg.LogLevel != "info" {
		t.Errorf("LogLevel = %q, want default %q", cfg.LogLevel, "info")
	}
}
