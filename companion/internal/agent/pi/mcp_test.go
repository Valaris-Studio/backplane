// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package pi

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent/mcpentry"
)

const mcpFixtureKey = "vlr_fixture_secret_key_do_not_leak_0001"

func writeText(t *testing.T, path, content string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o700)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func (e testEnv) agentDir() string    { return filepath.Join(e.Home, ".pi", "agent") }
func (e testEnv) adapterFile() string { return filepath.Join(e.agentDir(), "mcp-adapter.json") }

func installAdapter(t *testing.T, env testEnv) {
	t.Helper()
	writeText(t, filepath.Join(env.agentDir(), "settings.json"), `{"defaultModel":"x","packages":["npm:some-other","npm:pi-mcp-adapter@1.4.0"]}`)
}

func TestPiMCP_WritesAdapterConfigWhenAdapterInstalled(t *testing.T) {
	env := newEnv(t)
	installAdapter(t, env)
	writeText(t, env.adapterFile(), `{"settings":{"toolPrefix":"mcp"},"mcpServers":{"github":{"command":"npx","args":["github-mcp"]}}}`)
	changed, err := WriteMCP(env.Env)
	if err != nil || !changed {
		t.Fatalf("write: %v %v", changed, err)
	}
	var config map[string]any
	json.Unmarshal([]byte(read(t, env.adapterFile())), &config)
	servers := config["mcpServers"].(map[string]any)
	want := map[string]any{"command": env.Executable, "args": []any{"mcp"}}
	if !reflect.DeepEqual(servers[mcpentry.Name], want) || servers["github"] == nil || config["settings"] == nil {
		t.Fatalf("adapter config %v", config)
	}
	if changed, err := WriteMCP(env.Env); err != nil || changed {
		t.Fatalf("second write: %v %v", changed, err)
	}
	if changed, err := RemoveMCP(env.Env); err != nil || !changed {
		t.Fatalf("remove: %v %v", changed, err)
	}
	json.Unmarshal([]byte(read(t, env.adapterFile())), &config)
	if servers := config["mcpServers"].(map[string]any); servers[mcpentry.Name] != nil || servers["github"] == nil {
		t.Fatalf("remove result %v", servers)
	}
}

func TestPiMCP_AdapterMissingIsUnsupported(t *testing.T) {
	env := newEnv(t)
	writeText(t, filepath.Join(env.agentDir(), "settings.json"), `{"packages":["npm:some-other"]}`)
	if MCPAdapterInstalled(env.Env) {
		t.Fatal("adapter reported installed")
	}
	if _, err := WriteMCP(env.Env); !errors.Is(err, ErrMCPAdapterMissing) {
		t.Fatalf("want mcp_adapter_missing, got %v", err)
	}
	if _, err := os.Stat(env.adapterFile()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("an adapter config was written without the adapter")
	}
}

func TestPiMCP_AdapterDetectedFromPackageObject(t *testing.T) {
	env := newEnv(t)
	writeText(t, filepath.Join(env.agentDir(), "settings.json"), `{"packages":[{"source":"npm:pi-mcp-adapter","extensions":["*"]}]}`)
	if !MCPAdapterInstalled(env.Env) {
		t.Fatal("a package object naming the adapter was not detected")
	}
}

func TestPiMCP_HonoursPI_CODING_AGENT_DIR(t *testing.T) {
	env := newEnv(t)
	custom := filepath.Join(filepath.Dir(env.Home), "custom-pi")
	env.Getenv = func(key string) string {
		if key == "PI_CODING_AGENT_DIR" {
			return custom
		}
		return ""
	}
	writeText(t, filepath.Join(custom, "settings.json"), `{"packages":["npm:pi-mcp-adapter"]}`)
	if _, err := WriteMCP(env.Env); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(custom, "mcp-adapter.json")); err != nil {
		t.Fatalf("not written under PI_CODING_AGENT_DIR: %v", err)
	}
	if _, err := os.Stat(env.adapterFile()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("written to ~/.pi/agent despite the override")
	}
}

func TestPiMCP_ForeignBackplaneInAnyUserFileIsConflict(t *testing.T) {
	for _, relative := range []string{".config/mcp/mcp.json", ".agents/mcp.json", ".agents/mcp/mcp.json", ".pi/agent/mcp-adapter.json"} {
		t.Run(relative, func(t *testing.T) {
			env := newEnv(t)
			installAdapter(t, env)
			path := filepath.Join(env.Home, relative)
			original := `{"mcpServers":{"backplane":{"command":"uvx","args":["backplane-mcp"]}}}`
			writeText(t, path, original)
			if _, err := WriteMCP(env.Env); !errors.Is(err, mcpentry.ErrNameTaken) {
				t.Fatalf("want mcp_name_taken, got %v", err)
			}
			if read(t, path) != original {
				t.Fatal("a foreign entry was touched")
			}
		})
	}
}

func TestPiMCP_RepairRewritesMovedExecutable(t *testing.T) {
	env := newEnv(t)
	installAdapter(t, env)
	writeText(t, env.adapterFile(), `{"mcpServers":{"backplane":{"command":"/old/backplane-companion","args":["mcp"]}}}`)
	if changed, err := RepairMCP(env.Env); err != nil || !changed {
		t.Fatalf("repair: %v %v", changed, err)
	}
	if !strings.Contains(read(t, env.adapterFile()), env.Executable) {
		t.Fatal("owned entry not repointed")
	}
}

func TestPiMCP_FindingsNameEntriesNeverValues(t *testing.T) {
	env := newEnv(t)
	installAdapter(t, env)
	writeText(t, filepath.Join(env.Home, ".config", "mcp", "mcp.json"), `{"mcpServers":{"valaris":{"command":"uvx","args":["backplane-mcp"],"env":{"VALARIS_API_URL":"https://backplane.example","VALARIS_API_KEY":"`+mcpFixtureKey+`"}}}}`)
	findings, err := MCPFindings(env.Env, "https://backplane.example")
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(findings)
	if strings.Contains(string(encoded), mcpFixtureKey) {
		t.Fatalf("leaked: %s", encoded)
	}
	if len(findings) != 1 || findings[0].EntryName != "valaris" || findings[0].Reason != mcpentry.ReasonSameEndpoint {
		t.Fatalf("findings %+v", findings)
	}
}
