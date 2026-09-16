// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/profile"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
)

func TestMCPSelectionUnreadableProfileConfigDoesNotSavePlaceholder(t *testing.T) {
	for _, kind := range []string{"missing", "directory"} {
		t.Run(kind, func(t *testing.T) {
			store := profile.NewStore(t.TempDir())
			result := profileResult()
			result.MCPConfigPath = filepath.Join(t.TempDir(), "selected.config")
			if kind == "directory" {
				if err := os.Mkdir(result.MCPConfigPath, 0700); err != nil {
					t.Fatal(err)
				}
			}
			cfg := result.Apply(nil)
			cfg.LLM.MCPConfigPath = result.MCPConfigPath
			if err := applyWizardProfile(result, cfg, store); err == nil {
				t.Fatal("unreadable explicitly selected MCP config must fail instead of saving {} and claiming profile success")
			}
			if _, err := os.Stat(store.ConfigPath(result.ProfileName)); !os.IsNotExist(err) {
				t.Fatalf("failed config selection partially saved profile: %v", err)
			}
		})
	}
}

func TestMCPSelectionDeclaredPathBeatsAdjacentDiscoveryEvenWhenMissing(t *testing.T) {
	for _, missing := range []bool{false, true} {
		t.Run(map[bool]string{false: "existing", true: "missing"}[missing], func(t *testing.T) {
			for _, name := range []string{"VALARIS_API_KEY", "VALARIS_API_URL", "VALARIS_WORKSPACE"} {
				t.Setenv(name, "")
			}
			home, dir := t.TempDir(), t.TempDir()
			yamlPath := filepath.Join(dir, "runner.yaml")
			selected := filepath.Join(dir, "operator-selected.config")
			if err := os.WriteFile(yamlPath, []byte("valaris:\n  api_key: vlr_fixture\n  api_url: https://example.test\n  workspace_slug: test\nllm:\n  mcp_config_path: ./operator-selected.config\n"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(dir, "mcp-config.json"), []byte(`{"mcpServers":{"valaris":{"command":"wrong-current-directory"}}}`), 0600); err != nil {
				t.Fatal(err)
			}
			if !missing {
				if err := os.WriteFile(selected, []byte(`{"mcpServers":{"valaris":{"command":"chosen-mcp"}}}`), 0600); err != nil {
					t.Fatal(err)
				}
			}
			creds := resolveCredentials(home, []string{yamlPath})
			if creds.MCPConfigPath != selected {
				t.Fatalf("declared MCP path must outrank adjacent discovery, including missing explicit file: got %q want %q", creds.MCPConfigPath, selected)
			}
		})
	}
}

func TestMCPSelectionGenerationCollisionNeverAdoptsExistingConfig(t *testing.T) {
	target := filepath.Join(t.TempDir(), "mcp-config.json")
	original := `{"mcpServers":{"valaris":{"command":"old-incompatible-server","env":{"VALARIS_API_KEY":"private-old-fixture"}}}}`
	if err := os.WriteFile(target, []byte(original), 0600); err != nil {
		t.Fatal(err)
	}
	result := tui.Result{MCPWrite: true, MCPConfigPath: target, MCPLaunch: tui.MCPLaunchUvx()}
	creds := Credentials{APIKey: "vlr_new_fixture", APIURL: "https://example.test", MCPConfigPath: "/previous/selection.config"}
	if err := validateLaunchResult(result, creds); err == nil {
		t.Error("review accepted a generation destination already holding another MCP config")
	}
	got, err := applyWizardMCP(result, creds)
	if err == nil {
		t.Fatal("generation must fail on existing output")
	}
	if got.MCPConfigPath == target {
		t.Error("generation collision silently adopted existing artifact instead of requiring explicit selection")
	}
	if strings.Contains(err.Error(), "private-old-fixture") {
		t.Fatal("collision error leaked existing config credential")
	}
	after, err := os.ReadFile(target)
	if err != nil || string(after) != original {
		t.Fatal("generation collision changed the existing config")
	}
}

func TestMCPSelectionExplicitDecisionsNeverRestoreDiscovery(t *testing.T) {
	for _, scenario := range []string{"skip", "selected_missing", "selected_empty"} {
		t.Run(scenario, func(t *testing.T) {
			result := tui.Result{MCPConfigSelected: true, MCPConfigOrigin: "entered here"}
			if scenario == "skip" {
				result.MCPConfigSkipped = true
			}
			if scenario == "selected_missing" {
				result.MCPConfigPath = filepath.Join(t.TempDir(), "missing-explicit.config")
			}
			creds := Credentials{MCPConfigPath: "/unrelated-current-directory/mcp.json"}
			if got := effectiveMCPConfigPath(result, creds); got != result.MCPConfigPath {
				t.Fatalf("explicit choice fell back to discovery: got %q want %q", got, result.MCPConfigPath)
			}
			applied, err := applyWizardMCP(result, creds)
			if err == nil && applied.MCPConfigPath == creds.MCPConfigPath {
				t.Fatalf("explicit choice restored discovered config; err=%v", err)
			}
			if err := validateLaunchResult(result, creds); err == nil {
				t.Fatal("explicit empty/missing choice passed launch validation")
			}
		})
	}
}
