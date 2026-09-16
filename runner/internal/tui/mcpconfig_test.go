// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMCPLaunchShapes(t *testing.T) {
	uvx := MCPLaunchUvx()
	if uvx.Command != "uvx" {
		t.Fatalf("MCPLaunchUvx().Command = %q, want %q", uvx.Command, "uvx")
	}
	if len(uvx.Args) != 1 || uvx.Args[0] != "backplane-mcp==0.8.0" {
		t.Fatalf("MCPLaunchUvx().Args = %v, want [backplane-mcp==0.8.0]", uvx.Args)
	}

	checkout := MCPLaunchCheckout("/src/backplane/mcp-server")
	if checkout.Command != "uv" {
		t.Fatalf("MCPLaunchCheckout().Command = %q, want %q", checkout.Command, "uv")
	}
	want := []string{"--directory", "/src/backplane/mcp-server", "run", "valaris-mcp"}
	if len(checkout.Args) != len(want) {
		t.Fatalf("MCPLaunchCheckout().Args = %v, want %v", checkout.Args, want)
	}
	for i, arg := range want {
		if checkout.Args[i] != arg {
			t.Fatalf("MCPLaunchCheckout().Args = %v, want %v", checkout.Args, want)
		}
	}
}

// mcpConfigDoc mirrors the Claude mcpServers shape internal/llm's
// readValarisMCPServerTemplate requires. It is redeclared here rather than
// imported: internal/tui must not depend on internal/llm.
type mcpConfigDoc struct {
	MCPServers map[string]struct {
		Command string            `json:"command"`
		Args    []string          `json:"args"`
		Env     map[string]string `json:"env"`
	} `json:"mcpServers"`
}

func parseMCPConfig(t *testing.T, data []byte) mcpConfigDoc {
	t.Helper()
	var doc mcpConfigDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("unmarshaling config: %v\n%s", err, data)
	}
	return doc
}

func TestMarshalMCPConfigLaunchShapes(t *testing.T) {
	tests := []struct {
		name        string
		seed        MCPConfigSeed
		wantCommand string
		wantArgs    []string
	}{
		{
			name: "uvx launch",
			seed: MCPConfigSeed{
				Launch:     MCPLaunchUvx(),
				APIURL:     "https://backplane.example.com",
				APIKey:     "vlr_test_key",
				AgentEmail: "runner@valaris.dev",
			},
			wantCommand: "uvx",
			wantArgs:    []string{"backplane-mcp==0.8.0"},
		},
		{
			name: "source checkout launch",
			seed: MCPConfigSeed{
				Launch:     MCPLaunchCheckout("/src/backplane/mcp-server"),
				APIURL:     "http://localhost:8000",
				APIKey:     "vlr_dev_xyz",
				AgentEmail: "dev@valaris.dev",
			},
			wantCommand: "uv",
			wantArgs:    []string{"--directory", "/src/backplane/mcp-server", "run", "valaris-mcp"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, err := MarshalMCPConfig(tt.seed)
			if err != nil {
				t.Fatalf("MarshalMCPConfig() error = %v", err)
			}
			doc := parseMCPConfig(t, data)
			server, ok := doc.MCPServers["valaris"]
			if !ok {
				t.Fatalf("mcpServers.valaris missing, got keys %v", doc.MCPServers)
			}
			if server.Command != tt.wantCommand {
				t.Errorf("command = %q, want %q", server.Command, tt.wantCommand)
			}
			if strings.Join(server.Args, "\x00") != strings.Join(tt.wantArgs, "\x00") {
				t.Errorf("args = %v, want %v", server.Args, tt.wantArgs)
			}
			if got := server.Env["VALARIS_API_URL"]; got != tt.seed.APIURL {
				t.Errorf("VALARIS_API_URL = %q, want %q", got, tt.seed.APIURL)
			}
			if got := server.Env["VALARIS_API_KEY"]; got != tt.seed.APIKey {
				t.Errorf("VALARIS_API_KEY = %q, want %q", got, tt.seed.APIKey)
			}
			if got := server.Env["VALARIS_AGENT_EMAIL"]; got != tt.seed.AgentEmail {
				t.Errorf("VALARIS_AGENT_EMAIL = %q, want %q", got, tt.seed.AgentEmail)
			}
		})
	}
}

// The runner hands this file to the coding agent by path and never expands
// ${VAR} placeholders — a placeholder would reach the MCP server literally.
func TestMarshalMCPConfigWritesRealKeyNotPlaceholder(t *testing.T) {
	data, err := MarshalMCPConfig(MCPConfigSeed{
		Launch: MCPLaunchUvx(),
		APIURL: "https://backplane.example.com",
		APIKey: "vlr_test_real_value",
	})
	if err != nil {
		t.Fatalf("MarshalMCPConfig() error = %v", err)
	}
	if !strings.Contains(string(data), "vlr_test_real_value") {
		t.Errorf("config does not contain the real API key:\n%s", data)
	}
	if strings.Contains(string(data), "${VALARIS_API_KEY}") {
		t.Errorf("config contains an env placeholder, which the runner never expands:\n%s", data)
	}
}

func TestMarshalMCPConfigFormatting(t *testing.T) {
	data, err := MarshalMCPConfig(MCPConfigSeed{
		Launch: MCPLaunchUvx(),
		APIURL: "https://backplane.example.com",
		APIKey: "vlr_test_key",
	})
	if err != nil {
		t.Fatalf("MarshalMCPConfig() error = %v", err)
	}
	if !strings.HasSuffix(string(data), "\n") {
		t.Errorf("config does not end with a trailing newline: %q", data)
	}
	if !strings.Contains(string(data), "\n  \"mcpServers\"") {
		t.Errorf("config is not 2-space indented:\n%s", data)
	}
}

func TestMarshalMCPConfigOmitsEmptyAgentEmail(t *testing.T) {
	data, err := MarshalMCPConfig(MCPConfigSeed{
		Launch: MCPLaunchUvx(),
		APIURL: "https://backplane.example.com",
		APIKey: "vlr_test_key",
	})
	if err != nil {
		t.Fatalf("MarshalMCPConfig() error = %v", err)
	}
	if strings.Contains(string(data), "VALARIS_AGENT_EMAIL") {
		t.Errorf("empty agent email should be omitted entirely, got:\n%s", data)
	}
	doc := parseMCPConfig(t, data)
	if _, ok := doc.MCPServers["valaris"].Env["VALARIS_AGENT_EMAIL"]; ok {
		t.Errorf("VALARIS_AGENT_EMAIL present with empty agent email")
	}
}

func TestMarshalMCPConfigRejectsIncompleteSeeds(t *testing.T) {
	tests := []struct {
		name    string
		seed    MCPConfigSeed
		wantErr string
	}{
		{
			name:    "missing api url",
			seed:    MCPConfigSeed{Launch: MCPLaunchUvx(), APIKey: "vlr_test_key"},
			wantErr: "api url",
		},
		{
			name:    "missing api key",
			seed:    MCPConfigSeed{Launch: MCPLaunchUvx(), APIURL: "https://backplane.example.com"},
			wantErr: "api key",
		},
		{
			name:    "missing launch command",
			seed:    MCPConfigSeed{APIURL: "https://backplane.example.com", APIKey: "vlr_test_key"},
			wantErr: "command",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := MarshalMCPConfig(tt.seed); err == nil {
				t.Fatalf("MarshalMCPConfig() error = nil, want an error mentioning %q", tt.wantErr)
			} else if !strings.Contains(strings.ToLower(err.Error()), tt.wantErr) {
				t.Fatalf("MarshalMCPConfig() error = %v, want it to mention %q", err, tt.wantErr)
			}

			path := filepath.Join(t.TempDir(), "mcp.json")
			if err := WriteMCPConfig(path, tt.seed); err == nil {
				t.Fatalf("WriteMCPConfig() error = nil, want an error mentioning %q", tt.wantErr)
			}
			if _, err := os.Stat(path); !os.IsNotExist(err) {
				t.Errorf("rejected seed still created %s", path)
			}
		})
	}
}

func TestWriteMCPConfigIsOwnerOnlyAndCreatesParents(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "dir", "mcp.json")
	seed := MCPConfigSeed{
		Launch:     MCPLaunchUvx(),
		APIURL:     "https://backplane.example.com",
		APIKey:     "vlr_test_key",
		AgentEmail: "runner@valaris.dev",
	}
	if err := WriteMCPConfig(path, seed); err != nil {
		t.Fatalf("WriteMCPConfig() error = %v", err)
	}

	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat %s: %v", path, err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Errorf("mode = %04o, want 0600 — the key is written in the clear, permissions are the control", mode)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading %s: %v", path, err)
	}
	doc := parseMCPConfig(t, data)
	server, ok := doc.MCPServers["valaris"]
	if !ok {
		t.Fatalf("written file lacks mcpServers.valaris:\n%s", data)
	}
	if server.Command == "" {
		t.Errorf("written file has an empty command:\n%s", data)
	}
	if server.Env["VALARIS_API_KEY"] != seed.APIKey {
		t.Errorf("written file lost the real API key:\n%s", data)
	}
}

func TestWriteMCPConfigRefusesToClobber(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp.json")
	existing := []byte(`{"mcpServers":{"valaris":{"command":"hand-tuned"}}}`)
	if err := os.WriteFile(path, existing, 0o600); err != nil {
		t.Fatalf("seeding %s: %v", path, err)
	}

	err := WriteMCPConfig(path, MCPConfigSeed{
		Launch: MCPLaunchUvx(),
		APIURL: "https://backplane.example.com",
		APIKey: "vlr_test_key",
	})
	if !errors.Is(err, ErrMCPConfigExists) {
		t.Fatalf("WriteMCPConfig() error = %v, want ErrMCPConfigExists", err)
	}
	if !strings.Contains(err.Error(), path) {
		t.Errorf("error %v does not name the offending path %s", err, path)
	}

	after, readErr := os.ReadFile(path)
	if readErr != nil {
		t.Fatalf("reading %s: %v", path, readErr)
	}
	if string(after) != string(existing) {
		t.Errorf("existing file was modified:\ngot  %s\nwant %s", after, existing)
	}
}

func TestUvxAvailableMatchesPATH(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	if UvxAvailable() {
		t.Fatalf("UvxAvailable() = true with an empty PATH")
	}

	stub := filepath.Join(dir, "uvx")
	if err := os.WriteFile(stub, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatalf("writing stub: %v", err)
	}
	if !UvxAvailable() {
		t.Fatalf("UvxAvailable() = false with uvx on PATH")
	}
}

// The runner's static template is full-surface: every launch pins the key
// itself, but the loop pre-flight spawns the server from this exact env, and
// the server's interactive default hand omits the autonomous-operations tools
// (enqueue_pr_for_merge, list_skills/get_skill, the approvals tools) — so a
// template without the key would show a clipped surface to anything that
// spawns from it verbatim. Every seed shape pins VALARIS_MCP_TOOLSETS to "all".
func TestMarshalMCPConfigPinsToolsetsToAll(t *testing.T) {
	seeds := []struct {
		name string
		seed MCPConfigSeed
	}{
		{
			name: "uvx launch",
			seed: MCPConfigSeed{
				Launch:     MCPLaunchUvx(),
				APIURL:     "https://backplane.example.com",
				APIKey:     "vlr_test_key",
				AgentEmail: "runner@valaris.dev",
			},
		},
		{
			name: "source checkout launch",
			seed: MCPConfigSeed{
				Launch:     MCPLaunchCheckout("/src/backplane/mcp-server"),
				APIURL:     "http://localhost:8000",
				APIKey:     "vlr_dev_xyz",
				AgentEmail: "dev@valaris.dev",
			},
		},
		{
			name: "no agent email",
			seed: MCPConfigSeed{
				Launch: MCPLaunchUvx(),
				APIURL: "https://backplane.example.com",
				APIKey: "vlr_test_key",
			},
		},
	}

	for _, tt := range seeds {
		t.Run(tt.name, func(t *testing.T) {
			data, err := MarshalMCPConfig(tt.seed)
			if err != nil {
				t.Fatalf("MarshalMCPConfig() error = %v", err)
			}
			doc := parseMCPConfig(t, data)
			server, ok := doc.MCPServers["valaris"]
			if !ok {
				t.Fatalf("mcpServers.valaris missing, got keys %v", doc.MCPServers)
			}
			if got := server.Env["VALARIS_MCP_TOOLSETS"]; got != "all" {
				t.Errorf("VALARIS_MCP_TOOLSETS = %q, want %q — the runner template is full-surface:\n%s", got, "all", data)
			}
			// The placeholder guard holds for the new key too: the runner never
			// expands ${VAR}, so the value must be the literal word.
			if strings.Contains(string(data), "${") {
				t.Errorf("config contains an env placeholder, which the runner never expands:\n%s", data)
			}
			if got := server.Env["VALARIS_API_KEY"]; got != tt.seed.APIKey {
				t.Errorf("VALARIS_API_KEY = %q, want %q", got, tt.seed.APIKey)
			}
		})
	}
}
