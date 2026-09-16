// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/profile"
)

func TestMCPDiscoveryEnumeratesStableAbsolutePathsWithoutExecuting(t *testing.T) {
	dir := t.TempDir()
	runner := filepath.Join(dir, "runner.yaml")
	explicit := filepath.Join(dir, "operator.config")
	sentinel := filepath.Join(dir, "executed")
	body := []byte(`{"mcpServers":{"valaris":{"command":"touch","args":["` + sentinel + `"],"env":{"SECRET":"private-sentinel"}}}}`)
	if err := os.WriteFile(explicit, body, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(runner, []byte("llm:\n  mcp_config_path: ./operator.config\n"), 0600); err != nil {
		t.Fatal(err)
	}
	conventional := filepath.Join(dir, "mcp-config.json")
	if err := os.WriteFile(conventional, []byte("malformed-private-sentinel"), 0600); err != nil {
		t.Fatal(err)
	}
	store := profile.NewStore(t.TempDir())
	if err := store.Save("saved", profile.Credentials{}, []byte("llm: {}\n"), body); err != nil {
		t.Fatal(err)
	}
	found := discoverMCPConfigs([]string{runner, runner}, store)
	if len(found) != 3 {
		t.Fatalf("want explicit, adjacent, profile; got %d", len(found))
	}
	for i, want := range []string{explicit, conventional, store.MCPConfigPath("saved")} {
		if found[i].Path != want || !filepath.IsAbs(found[i].Path) || found[i].Origin == "" {
			t.Fatalf("candidate %d incorrect: %+v", i, found[i])
		}
		if strings.Contains(found[i].Issue, "private-sentinel") {
			t.Fatal("candidate issue exposed raw contents")
		}
	}
	if found[1].Issue == "" {
		t.Fatal("malformed candidate must explain issue")
	}
	if _, err := os.Stat(sentinel); !os.IsNotExist(err) {
		t.Fatal("discovery executed candidate")
	}
}

func TestMCPStaticValidationAllowsRecipesAndRejectsUnsafeStructureWithoutSecrets(t *testing.T) {
	for _, tc := range []struct {
		body  string
		valid bool
	}{
		{`{"mcpServers":{"valaris":{"command":"/opt/custom/mcp","args":["--mode","custom"],"env":{"TOKEN":"private-sentinel"}}}}`, true},
		{`{"mcpServers":{"valaris":{"command":"uvx","args":["--from","backplane-mcp==0.8.0","valaris-mcp"]}}}`, true},
		{`private-sentinel`, false},
		{`{"mcpServers":{"valaris":{"command":"server","args":[{"private-sentinel":true}]}}}`, false},
		{`{"mcpServers":{"valaris":{"command":"server","env":{"TOKEN":{"private-sentinel":true}}}}}`, false},
	} {
		path := filepath.Join(t.TempDir(), "chosen.config")
		if err := os.WriteFile(path, []byte(tc.body), 0600); err != nil {
			t.Fatal(err)
		}
		err := validateMCPConfig(path)
		if (err == nil) != tc.valid {
			t.Fatalf("valid=%v error=%v", tc.valid, err)
		}
		if err != nil && strings.Contains(err.Error(), "private-sentinel") {
			t.Fatal("validation leaked credential/content")
		}
	}
}

func TestDeclaredMCPPathRejectsOversizedYAML(t *testing.T) {
	path := filepath.Join(t.TempDir(), "runner.yaml")
	body := "llm:\n  mcp_config_path: selected.config\n#" + strings.Repeat("x", 1024*1024)
	if err := os.WriteFile(path, []byte(body), 0600); err != nil {
		t.Fatal(err)
	}
	if got := declaredMCPPath(path); got != "" {
		t.Fatalf("oversized discovery input must be skipped, got %q", got)
	}
}

func TestDeclaredMCPPathSkipsNamedPipeWithoutOpening(t *testing.T) {
	command, err := exec.LookPath("mkfifo")
	if err != nil {
		t.Skip("mkfifo unavailable on this platform")
	}
	path := filepath.Join(t.TempDir(), "runner.yaml")
	if err := exec.Command(command, path).Run(); err != nil {
		t.Fatal(err)
	}
	if got := declaredMCPPath(path); got != "" {
		t.Fatalf("named pipe cannot declare config: %q", got)
	}
}

func TestDeclaredMCPPathsMatchConfigLoaderExpansion(t *testing.T) {
	home, dir := t.TempDir(), t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("SELECTED_MCP_PATH", "should-not-expand")
	for _, tc := range []struct{ value, want string }{
		{"~", home}, {"~/selected.json", filepath.Join(home, "selected.json")},
		{"$SELECTED_MCP_PATH", filepath.Join(dir, "$SELECTED_MCP_PATH")},
	} {
		path := filepath.Join(dir, "runner.yaml")
		if err := os.WriteFile(path, []byte("llm:\n  mcp_config_path: '"+tc.value+"'\n"), 0600); err != nil {
			t.Fatal(err)
		}
		if got := declaredMCPPath(path); got != tc.want {
			t.Errorf("%q resolves %q, want %q", tc.value, got, tc.want)
		}
	}
}
