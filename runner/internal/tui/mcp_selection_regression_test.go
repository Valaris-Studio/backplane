// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/profile"
)

func TestMCPSelectionExistingConfigRemainsEditable(t *testing.T) {
	defer ForcePlain()()
	deps := needsSetupDeps()
	deps.MCPStatus = func() MCPConfigStatus { return MCPConfigStatus{Path: "/different-project/mcp.json"} }
	w := drive(atProvider(t, deps), key("enter"))
	if w.Step() != StepMCP {
		t.Errorf("discovery must not bypass config selection; got %s", w.Step())
	}
	// Reopen the existing row independently of forward navigation.
	w.step = StepReview
	for i, row := range w.reviewRows() {
		if row.owner == StepMCP {
			model, _ := w.jumpToReviewRow(i + 1)
			w = model.(Wizard)
			if w.Step() != StepMCP {
				t.Fatalf("review cannot change discovered config; got %s", w.Step())
			}
			return
		}
	}
	t.Fatal("review omitted selected MCP config")
}

func TestMCPSelectionProfilePathBeatsDiscoveryAndSurvivesMissingFile(t *testing.T) {
	for _, missing := range []bool{false, true} {
		t.Run(map[bool]string{false: "existing", true: "missing"}[missing], func(t *testing.T) {
			deps := needsSetupDeps()
			deps.Profiles = profile.NewStore(t.TempDir())
			deps.MCPStatus = func() MCPConfigStatus { return MCPConfigStatus{Path: "/cwd-other-project/mcp.json"} }
			name := "undertow"
			if err := deps.Profiles.Save(name, profile.Credentials{}, []byte("llm:\n  mcp_config_path: ./chosen-arbitrary-name.config\n"), []byte("{}\n")); err != nil {
				t.Fatal(err)
			}
			path := filepath.Join(filepath.Dir(deps.Profiles.ConfigPath(name)), "chosen-arbitrary-name.config")
			if !missing {
				if err := os.WriteFile(path, []byte(`{"mcpServers":{"valaris":{"command":"chosen-mcp","env":{"VALARIS_API_KEY":"fixture-private-token"}}}}`), 0600); err != nil {
					t.Fatal(err)
				}
			}
			p, err := deps.Profiles.Load(name)
			if err != nil {
				t.Fatal(err)
			}
			w := NewWizard(deps).loadProfile(p)
			if got := w.Result().MCPConfigPath; got != path {
				t.Fatalf("profile MCP path must remain selected even if missing, without CWD fallback: got %q want %q", got, path)
			}
			w.step = StepMCP
			if strings.Contains(w.View(), "fixture-private-token") {
				t.Fatal("config bytes leaked into selection UI")
			}
		})
	}
}

func TestMCPSelectionExplicitSkipClearsInheritedPath(t *testing.T) {
	deps := needsSetupDeps()
	deps.MCPStatus = func() MCPConfigStatus { return MCPConfigStatus{Path: "/discovered/mcp.json"} }
	w := NewWizard(deps)
	for i, choice := range mcpChoices {
		if choice.choice == mcpChoiceSkip {
			w.mcpStep.cursor = i
		}
	}
	model, _ := w.commitMCPChoice()
	result := model.(Wizard).Result()
	base := config.Defaults()
	base.LLM.MCPConfigPath = "/saved-profile/mcp.json"
	if got := result.Apply(base).LLM.MCPConfigPath; got != "" {
		t.Fatalf("explicit Skip restored inherited MCP path %q", got)
	}
	if base.LLM.MCPConfigPath != "/saved-profile/mcp.json" {
		t.Fatal("selection mutated saved config")
	}
}
