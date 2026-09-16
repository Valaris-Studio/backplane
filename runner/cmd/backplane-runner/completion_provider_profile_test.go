// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/profile"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
)

func TestCompletionProviderUnionSurvivesProfileSaveAndDifferentWorkingDirectory(t *testing.T) {
	store := profile.NewStore(t.TempDir())
	base := config.Defaults()
	base.Valaris.APIURL = "https://example.test"
	base.Valaris.APIKey = "fixture-key"
	base.Valaris.WorkspaceSlug = "default"
	base.LLM.Provider = "claude-cli"
	base.LLM.Model = "saved-source-model"
	base.LLM.ExtraProviders = []string{"gemini-cli"}
	base.LLM.TierProviders = map[string][]string{"premium": {"gemini-cli", "claude-cli"}}
	base.Git.BaseDir = filepath.Join(t.TempDir(), "work")
	mcp := filepath.Join(t.TempDir(), "selected-mcp.json")
	if err := os.WriteFile(mcp, []byte(`{"mcpServers":{"valaris":{"command":"fixture-mcp"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	result := tui.Result{Mode: tui.ModeLoop, ProfileName: "mixed", APIURL: base.Valaris.APIURL, APIKey: base.Valaris.APIKey, Workspace: "default", MCPConfigSelected: true, MCPConfigPath: mcp,
		RunOverride: &config.ModelSelection{Provider: "claude-cli", Model: "fable"}, ExtraProviders: []string{"codex-cli"}, CompletionProvidersConfirmed: true}
	applied := result.Apply(base)
	if err := applyWizardProfile(result, applied, store); err != nil {
		t.Fatal(err)
	}
	t.Chdir(t.TempDir())
	loaded, err := config.Load(store.ConfigPath("mixed"))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(loaded.LLM.ExtraProviders, []string{"gemini-cli", "codex-cli"}) {
		t.Fatalf("provider union not retained: %v", loaded.LLM.ExtraProviders)
	}
	if !reflect.DeepEqual(loaded.LLM.TierProviders, base.LLM.TierProviders) {
		t.Fatal("tier routes changed")
	}
	if loaded.LLM.Provider != "claude-cli" || loaded.LLM.Model != "saved-source-model" || loaded.LLM.RunOverride != nil {
		t.Fatal("ephemeral Fable selection replaced saved defaults")
	}
	if loaded.Git.BaseDir != base.Git.BaseDir {
		t.Fatal("profile workdir changed with cwd")
	}
}
