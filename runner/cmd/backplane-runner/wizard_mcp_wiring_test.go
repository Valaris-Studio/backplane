// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/tui"
)

// The wizard's MCP step only exists if the composition root wires it: a nil
// MCPStatus silently removes the step and the operator dead-ends on "no MCP
// server config found" AFTER a green review. Guard every injected func, not
// just the MCP ones — this is the one place building the real WizardDeps and
// it had zero coverage when the MCP step shipped dead.
func TestNewWizardDeps_EveryInjectedFuncIsWired(t *testing.T) {
	deps := newWizardDeps(Credentials{}, t.TempDir(), t.TempDir(), "test")

	v := reflect.ValueOf(deps)
	for i := 0; i < v.NumField(); i++ {
		field := v.Type().Field(i)
		if field.Type.Kind() != reflect.Func || field.Name == "RunDoctor" {
			continue
		}
		if v.Field(i).IsNil() {
			t.Errorf("WizardDeps.%s is nil — the wizard silently degrades without it", field.Name)
		}
	}
}

func TestNewWizardDeps_MCPStatusReflectsDiscovery(t *testing.T) {
	home := t.TempDir()
	work := t.TempDir()

	t.Run("nothing found: setup needed, write target beside the work dir", func(t *testing.T) {
		deps := newWizardDeps(Credentials{}, home, work, "test")
		status := deps.MCPStatus()
		if !status.NeedsSetup() {
			t.Fatal("no discovered config must mean setup is needed")
		}
		if want := filepath.Join(work, "mcp-config.json"); status.WriteTo != want {
			t.Errorf("WriteTo = %q, want %q", status.WriteTo, want)
		}
	})

	t.Run("template found: still needs setup, real file replaces it in place", func(t *testing.T) {
		dir := t.TempDir()
		template := filepath.Join(dir, mcpConfigTemplateFilename)
		creds := Credentials{MCPConfigPath: template}
		deps := newWizardDeps(creds, home, work, "test")
		status := deps.MCPStatus()
		if !status.IsTemplate || !status.NeedsSetup() {
			t.Fatalf("the shipped template must count as unconfigured, got %+v", status)
		}
		if want := filepath.Join(dir, "mcp-config.json"); status.WriteTo != want {
			t.Errorf("WriteTo = %q, want %q", status.WriteTo, want)
		}
	})

	t.Run("real config found: no setup needed", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "mcp-config.json")
		if err := os.WriteFile(path, []byte(`{"mcpServers":{"valaris":{"command":"fixture-mcp"}}}`), 0600); err != nil {
			t.Fatal(err)
		}
		deps := newWizardDeps(Credentials{MCPConfigPath: path}, home, work, "test")
		if status := deps.MCPStatus(); status.NeedsSetup() || status.Path != path {
			t.Errorf("a discovered real config needs nothing, got %+v", status)
		}
	})
}

func TestApplyWizardMCP_WritesTheChosenConfig(t *testing.T) {
	target := filepath.Join(t.TempDir(), "mcp-config.json")
	creds := Credentials{APIKey: "vlr_test_key", APIURL: "https://backplane.example.com"}
	result := tui.Result{MCPWrite: true, MCPConfigPath: target, MCPLaunch: tui.MCPLaunchUvx()}

	got, err := applyWizardMCP(result, creds)
	if err != nil {
		t.Fatalf("applyWizardMCP: %v", err)
	}
	if got.MCPConfigPath != target {
		t.Errorf("creds should point at the written config, got %q", got.MCPConfigPath)
	}

	info, err := os.Stat(target)
	if err != nil {
		t.Fatalf("the config was not written: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("the config carries a real key and must be 0600, got %o", perm)
	}
	body, _ := os.ReadFile(target)
	for _, want := range []string{"vlr_test_key", "https://backplane.example.com", "uvx"} {
		if !strings.Contains(string(body), want) {
			t.Errorf("written config is missing %q:\n%s", want, body)
		}
	}
}

// A file that appeared between discovery and the write is an operator's work:
// leave it untouched and require explicit selection instead of silently adopting it.
func TestApplyWizardMCP_NeverClobbersAnExistingFile(t *testing.T) {
	target := filepath.Join(t.TempDir(), "mcp-config.json")
	const existing = `{"mcpServers":{"valaris":{"command":"hand-tuned"}}}`
	if err := os.WriteFile(target, []byte(existing), 0o600); err != nil {
		t.Fatal(err)
	}

	creds := Credentials{APIKey: "vlr_k", APIURL: "https://x.example.com"}
	result := tui.Result{MCPWrite: true, MCPConfigPath: target, MCPLaunch: tui.MCPLaunchUvx()}

	got, err := applyWizardMCP(result, creds)
	if !errors.Is(err, tui.ErrMCPConfigExists) {
		t.Fatalf("want ErrMCPConfigExists, got %v", err)
	}
	if got.MCPConfigPath != creds.MCPConfigPath {
		t.Errorf("generation collision must not select the existing file, got %q", got.MCPConfigPath)
	}
	if body, _ := os.ReadFile(target); string(body) != existing {
		t.Errorf("existing config was clobbered:\n%s", body)
	}
}

func TestApplyWizardMCP_SkipAndDiscoveredPaths(t *testing.T) {
	t.Run("operator skipped: nothing written, creds untouched", func(t *testing.T) {
		creds := Credentials{MCPConfigPath: ""}
		got, err := applyWizardMCP(tui.Result{}, creds)
		if err != nil || got.MCPConfigPath != "" {
			t.Errorf("skip must be a no-op, got path=%q err=%v", got.MCPConfigPath, err)
		}
	})
	t.Run("already configured: the discovered path flows through", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "mcp-config.json")
		if err := os.WriteFile(path, []byte(`{"mcpServers":{"valaris":{"command":"fixture-mcp"}}}`), 0600); err != nil {
			t.Fatal(err)
		}
		got, err := applyWizardMCP(tui.Result{MCPConfigPath: path}, Credentials{})
		if err != nil || got.MCPConfigPath != path {
			t.Errorf("discovered path must reach creds, got %q err=%v", got.MCPConfigPath, err)
		}
	})
}

func TestValidateMCPServerDir(t *testing.T) {
	t.Run("a real mcp-server checkout passes", func(t *testing.T) {
		dir := t.TempDir()
		pyproject := "[project]\nname = \"backplane-mcp\"\n[project.scripts]\nvalaris-mcp = \"valaris_mcp.server:main\"\n"
		if err := os.WriteFile(filepath.Join(dir, "pyproject.toml"), []byte(pyproject), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := validateMCPServerDir(dir); err != nil {
			t.Errorf("valid checkout rejected: %v", err)
		}
	})
	t.Run("a directory without the valaris-mcp entry point is not the server", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "pyproject.toml"), []byte("[project]\nname = \"other\"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := validateMCPServerDir(dir); err == nil {
			t.Error("an unrelated python project must be rejected before the operator is told setup is done")
		}
	})
	t.Run("a missing directory is named in the error", func(t *testing.T) {
		if err := validateMCPServerDir(filepath.Join(t.TempDir(), "nope")); err == nil {
			t.Error("nonexistent path must be rejected")
		}
	})
}
