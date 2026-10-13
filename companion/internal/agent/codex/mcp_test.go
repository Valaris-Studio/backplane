// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/mcpentry"
)

const mcpFixtureKey = "vlr_fixture_secret_key_do_not_leak_0001"

func ourServer(t *testing.T, env testEnv) map[string]any {
	t.Helper()
	servers, _ := readTOML(t, env.configFile())["mcp_servers"].(map[string]any)
	entry, _ := servers[mcpentry.Name].(map[string]any)
	return entry
}

func wantServer(env testEnv) map[string]any {
	return map[string]any{"command": env.Executable, "args": []any{"mcp"}, "startup_timeout_sec": int64(30)}
}

func TestCodexMCP_AppendsBlock_RemovalRestoresBytes(t *testing.T) {
	originals := map[string]string{
		"empty":               "",
		"settings":            "model = \"gpt-5\" # mine\n",
		"no final newline":    "model = \"gpt-5\"",
		"other mcp servers":   "# servers\n[mcp_servers.github]\ncommand = \"npx\"\nargs = [\"github-mcp\"]\n",
		"trailing blank line": "model = \"gpt-5\"\n\n",
	}
	for name, original := range originals {
		t.Run(name, func(t *testing.T) {
			env := newEnv(t)
			write(t, env.configFile(), original)
			changed, err := WriteMCP(env.Env)
			if err != nil || !changed {
				t.Fatalf("write: %v %v", changed, err)
			}
			if got := ourServer(t, env); !reflect.DeepEqual(got, wantServer(env)) {
				t.Fatalf("server %v, want %v\n%s", got, wantServer(env), read(t, env.configFile()))
			}
			text := read(t, env.configFile())
			if !strings.Contains(text, mcpBlockBegin) || !strings.Contains(text, mcpBlockEnd) {
				t.Fatalf("block markers missing:\n%s", text)
			}
			if changed, err := WriteMCP(env.Env); err != nil || changed || read(t, env.configFile()) != text {
				t.Fatalf("second write is not idempotent: %v %v", changed, err)
			}
			if changed, err := RemoveMCP(env.Env); err != nil || !changed {
				t.Fatalf("remove: %v %v", changed, err)
			}
			if got := read(t, env.configFile()); got != original {
				t.Fatalf("removal is not byte exact:\n%q\nwant\n%q", got, original)
			}
		})
	}
}

func TestCodexMCP_RecordsIntegrationChange(t *testing.T) {
	env := newEnv(t)
	env.StateDir = t.TempDir()
	if _, err := WriteMCP(env.Env); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(env.StateDir, integrationChangeFile)); err != nil {
		t.Fatalf("a new MCP entry must date the change for restart_required: %v", err)
	}
}

func TestCodexMCP_ForeignMcpServersBackplaneIsConflict(t *testing.T) {
	for name, original := range map[string]string{
		"table":  "[mcp_servers.backplane]\ncommand = \"uvx\"\nargs = [\"backplane-mcp\"]\n",
		"inline": "mcp_servers = { backplane = { command = \"uvx\" } }\n",
	} {
		t.Run(name, func(t *testing.T) {
			env := newEnv(t)
			write(t, env.configFile(), original)
			if _, err := WriteMCP(env.Env); !errors.Is(err, mcpentry.ErrNameTaken) {
				t.Fatalf("want mcp_name_taken, got %v", err)
			}
			if read(t, env.configFile()) != original {
				t.Fatal("a conflict still wrote")
			}
		})
	}
}

func TestCodexMCP_InvalidTomlNotWritten(t *testing.T) {
	env := newEnv(t)
	original := "model = \n[broken\n"
	write(t, env.configFile(), original)
	if _, err := WriteMCP(env.Env); !errors.Is(err, agent.ErrConfigInvalid) {
		t.Fatalf("want agent_config_invalid, got %v", err)
	}
	if read(t, env.configFile()) != original {
		t.Fatal("an invalid config.toml was rewritten")
	}
}

func TestCodexMCP_InlineMcpServersTableIsNotExtended(t *testing.T) {
	env := newEnv(t)
	original := "mcp_servers = { github = { command = \"npx\" } }\n"
	write(t, env.configFile(), original)
	if _, err := WriteMCP(env.Env); !errors.Is(err, agent.ErrConfigInvalid) {
		t.Fatalf("an inline mcp_servers cannot take a [mcp_servers.backplane] table: %v", err)
	}
	if read(t, env.configFile()) != original {
		t.Fatal("config.toml was rewritten")
	}
}

func TestCodexMCP_TelemetryBlockIndependent(t *testing.T) {
	original := "model = \"gpt-5\"\n[mcp_servers.github]\ncommand = \"npx\"\n"
	t.Run("telemetry first", func(t *testing.T) {
		env := newEnv(t)
		write(t, env.configFile(), original)
		if _, err := configureTelemetry(env.configFile(), env.Telemetry, true); err != nil {
			t.Fatal(err)
		}
		if _, err := WriteMCP(env.Env); err != nil {
			t.Fatal(err)
		}
		if err := removeTelemetry(env.configFile()); err != nil {
			t.Fatal(err)
		}
		if got := ourServer(t, env); !reflect.DeepEqual(got, wantServer(env)) {
			t.Fatalf("removing telemetry touched the MCP entry:\n%s", read(t, env.configFile()))
		}
		if _, err := RemoveMCP(env.Env); err != nil {
			t.Fatal(err)
		}
		if got := read(t, env.configFile()); got != original {
			t.Fatalf("both removals are not byte exact:\n%q", got)
		}
	})
	t.Run("mcp first", func(t *testing.T) {
		env := newEnv(t)
		write(t, env.configFile(), original)
		if _, err := WriteMCP(env.Env); err != nil {
			t.Fatal(err)
		}
		if _, err := configureTelemetry(env.configFile(), env.Telemetry, true); err != nil {
			t.Fatal(err)
		}
		if _, err := RemoveMCP(env.Env); err != nil {
			t.Fatal(err)
		}
		otel, _ := readTOML(t, env.configFile())["otel"].(map[string]any)
		if otel["exporter"] == nil || otel["trace_exporter"] == nil {
			t.Fatalf("removing the MCP entry touched telemetry:\n%s", read(t, env.configFile()))
		}
		if err := removeTelemetry(env.configFile()); err != nil {
			t.Fatal(err)
		}
		if got := read(t, env.configFile()); got != original {
			t.Fatalf("both removals are not byte exact:\n%q", got)
		}
	})
}

// Codex rewrites config.toml with toml_edit, which keeps a trailing comment
// last: tables it adds land between our entry and our END marker.
func TestCodexMCP_RemovalKeepsTablesCodexAppendedBeforeOurEnd(t *testing.T) {
	env := newEnv(t)
	write(t, env.configFile(), "model = \"gpt-5\"\n")
	if _, err := WriteMCP(env.Env); err != nil {
		t.Fatal(err)
	}
	text := read(t, env.configFile())
	codexAppended := "\n[projects.\"/src/app\"]\ntrust_level = \"trusted\"\n"
	text = strings.Replace(text, mcpBlockEnd+"\n", strings.TrimPrefix(codexAppended, "\n")+mcpBlockEnd+"\n", 1)
	write(t, env.configFile(), text)
	if changed, err := WriteMCP(env.Env); err != nil || changed {
		t.Fatalf("a current entry with a moved END must not be rewritten: %v %v", changed, err)
	}
	if _, err := RemoveMCP(env.Env); err != nil {
		t.Fatal(err)
	}
	config := readTOML(t, env.configFile())
	projects, _ := config["projects"].(map[string]any)
	if _, kept := projects["/src/app"]; !kept || config["mcp_servers"] != nil {
		t.Fatalf("removal result:\n%s", read(t, env.configFile()))
	}
	if strings.Contains(read(t, env.configFile()), "backplane-companion") {
		t.Fatalf("a marker survived:\n%s", read(t, env.configFile()))
	}
}

func TestCodexMCP_RemoveWithoutBlockChangesNothing(t *testing.T) {
	env := newEnv(t)
	original := "[mcp_servers.backplane]\ncommand = \"uvx\"\n"
	write(t, env.configFile(), original)
	if changed, err := RemoveMCP(env.Env); err != nil || changed {
		t.Fatalf("remove: %v %v", changed, err)
	}
	if read(t, env.configFile()) != original {
		t.Fatal("a foreign backplane entry was removed")
	}
}

func TestCodexMCP_RepairRewritesMovedExecutable(t *testing.T) {
	env := newEnv(t)
	write(t, env.configFile(), "model = \"gpt-5\"")
	moved := env.Executable
	env.Executable = filepath.Join(filepath.Dir(moved), "old", "backplane-companion")
	if _, err := WriteMCP(env.Env); err != nil {
		t.Fatal(err)
	}
	env.Executable = moved
	changed, err := RepairMCP(env.Env)
	if err != nil || !changed {
		t.Fatalf("repair: %v %v", changed, err)
	}
	if got := ourServer(t, env); !reflect.DeepEqual(got, wantServer(env)) {
		t.Fatalf("server after repair %v", got)
	}
	if _, err := RemoveMCP(env.Env); err != nil || read(t, env.configFile()) != "model = \"gpt-5\"" {
		t.Fatalf("removal after repair is not byte exact: %q", read(t, env.configFile()))
	}
}

func TestCodexMCP_RepairNeverAddsAMissingEntry(t *testing.T) {
	env := newEnv(t)
	original := "model = \"gpt-5\"\n"
	write(t, env.configFile(), original)
	if changed, err := RepairMCP(env.Env); err != nil || changed || read(t, env.configFile()) != original {
		t.Fatalf("repair added an entry: %v %v", changed, err)
	}
}

func TestCodexMCP_FindingsNameEntriesNeverValues(t *testing.T) {
	env := newEnv(t)
	write(t, env.configFile(), `[mcp_servers.valaris]
command = "uvx"
args = ["backplane-mcp"]
env = { VALARIS_API_URL = "https://backplane.example", VALARIS_API_KEY = "`+mcpFixtureKey+`" }

[mcp_servers.github]
command = "npx"
`)
	if _, err := WriteMCP(env.Env); err != nil {
		t.Fatal(err)
	}
	findings, err := MCPFindings(env.Env, "https://backplane.example")
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(findings)
	if strings.Contains(string(encoded), mcpFixtureKey) {
		t.Fatalf("findings leaked a value: %s", encoded)
	}
	if len(findings) != 1 || findings[0].EntryName != "valaris" || findings[0].Reason != mcpentry.ReasonSameEndpoint {
		t.Fatalf("findings %+v", findings)
	}
}

// A line a user typed inside our block would move to another table when
// our lines go, so any foreign line there refuses every edit.
func TestCodexMCP_ForeignLineInsideOurBlockNeverLeadsToAWrite(t *testing.T) {
	for name, foreign := range map[string]string{
		"key":           "env = { X = \"1\" }\n",
		"comment":       "# my note\n",
		"second begin":  mcpBlockBegin + "\n",
		"between lines": "",
	} {
		t.Run(name, func(t *testing.T) {
			env := newEnv(t)
			write(t, env.configFile(), "model = \"gpt-5\"\n")
			if _, err := WriteMCP(env.Env); err != nil {
				t.Fatal(err)
			}
			text := read(t, env.configFile())
			if name == "between lines" {
				text = strings.Replace(text, "args = [\"mcp\"]\n", "args = [\"mcp\"]\nenabled = true\n", 1)
			} else {
				text = strings.Replace(text, "startup_timeout_sec = 30\n", "startup_timeout_sec = 30\n"+foreign, 1)
			}
			write(t, env.configFile(), text)
			moved := env.Env
			moved.Executable = filepath.Join(filepath.Dir(env.Executable), "moved", "backplane-companion")
			for label, edit := range map[string]func() (bool, error){
				"write":  func() (bool, error) { return WriteMCP(env.Env) },
				"repair": func() (bool, error) { return RepairMCP(moved) },
				"remove": func() (bool, error) { return RemoveMCP(env.Env) },
			} {
				if _, err := edit(); !errors.Is(err, agent.ErrConfigInvalid) {
					t.Errorf("%s: want agent_config_invalid, got %v", label, err)
				}
				if read(t, env.configFile()) != text {
					t.Fatalf("%s wrote a block holding a foreign line", label)
				}
			}
		})
	}
}
