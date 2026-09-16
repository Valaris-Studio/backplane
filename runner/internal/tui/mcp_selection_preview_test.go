// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// Opt-in terminal fixture: no backend, external MCP process, or model is used.
// Run a compiled out-of-tree test binary in a PTY with
// BACKPLANE_MCP_PICKER_PREVIEW=1 and -test.run=^TestMCPSelectionPreview$.
func TestMCPSelectionPreview(t *testing.T) {
	if os.Getenv("BACKPLANE_MCP_PICKER_PREVIEW") != "1" {
		t.Skip("interactive terminal fixture")
	}
	dir := t.TempDir()
	paths := []string{filepath.Join(dir, "current-project.json"), filepath.Join(dir, "selected-workflow.config")}
	body := []byte(`{"mcpServers":{"valaris":{"command":"fixture-unused-server","env":{"VALARIS_API_KEY":"preview-secret-never-display"}}}}`)
	for _, path := range paths {
		if err := os.WriteFile(path, body, 0600); err != nil {
			t.Fatal(err)
		}
	}
	deps := needsSetupDeps()
	deps.MCPStatus = func() MCPConfigStatus {
		return MCPConfigStatus{Path: paths[0], Origin: "current directory", WriteTo: filepath.Join(dir, "generated.json")}
	}
	deps.DiscoverMCPConfigs = func() []MCPConfigCandidate {
		return []MCPConfigCandidate{{Path: paths[0], Origin: "current directory"}, {Path: paths[1], Origin: `profile "undertow"`}}
	}
	deps.ValidateMCPConfig = func(path string) error {
		data, err := os.ReadFile(path)
		if err != nil || !json.Valid(data) {
			return fmt.Errorf("Choose an existing readable MCP configuration")
		}
		return nil
	}
	deps.ValidateMCPWritePath = func(path string) error {
		if _, err := os.Lstat(path); err == nil {
			return ErrMCPConfigExists
		}
		return nil
	}
	w := NewWizard(deps)
	w.step = StepMCP
	w.width, w.height = 80, 24
	final, err := tea.NewProgram(w, tea.WithAltScreen()).Run()
	if err != nil {
		t.Fatal(err)
	}
	result := final.(Wizard).Result()
	t.Logf("fixture result: cancelled=%v selected=%v origin=%q", result.Cancelled, result.MCPConfigSelected, result.MCPConfigOrigin)
}
