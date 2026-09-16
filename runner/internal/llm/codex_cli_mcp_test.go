// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readCodexConfigToml(t *testing.T, home string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(home, "config.toml"))
	if err != nil {
		t.Fatalf("reading config.toml: %v", err)
	}
	return string(raw)
}

func TestCodexMCPHome_WritesCommandArgsAndAllowlistEnv(t *testing.T) {
	template := writeStaticTemplate(t) // shared fixture from claude_cli_mcp_test.go

	home, cleanup, err := codexMCPHome(template, []string{"mcp__valaris__get_card", "mcp__valaris__create_note"}, scratchCodexHome(t))
	if err != nil {
		t.Fatalf("codexMCPHome: %v", err)
	}
	defer cleanup()

	toml := readCodexConfigToml(t, home)
	if !strings.Contains(toml, `command = "bash"`) {
		t.Errorf("config.toml missing command, got:\n%s", toml)
	}
	if !strings.Contains(toml, `args = ["/opt/valaris/mcp-server/run.sh"]`) {
		t.Errorf("config.toml missing args, got:\n%s", toml)
	}
	if !strings.Contains(toml, `VALARIS_MCP_ALLOWLIST = "get_card,create_note"`) {
		t.Errorf("config.toml missing stripped+joined allowlist, got:\n%s", toml)
	}
	// The template's other env entries (API URL/key/email) must still reach
	// the spawned server — Codex gets no static config file passed on argv,
	// so every env key the template carries must land in this file.
	if !strings.Contains(toml, `VALARIS_API_URL = "https://example.test"`) {
		t.Errorf("config.toml missing VALARIS_API_URL, got:\n%s", toml)
	}
	if !strings.Contains(toml, `VALARIS_API_KEY = "vlr_test_key"`) {
		t.Errorf("config.toml missing VALARIS_API_KEY, got:\n%s", toml)
	}
}

// The whole point of codexMCPHome: config.toml is chmod 0600, same posture as
// Claude's --mcp-config temp file and codex's own auth.json.
func TestCodexMCPHome_ConfigFileIsPrivate(t *testing.T) {
	template := writeStaticTemplate(t)

	home, cleanup, err := codexMCPHome(template, []string{"mcp__valaris__get_card"}, scratchCodexHome(t))
	if err != nil {
		t.Fatalf("codexMCPHome: %v", err)
	}
	defer cleanup()

	info, err := os.Stat(filepath.Join(home, "config.toml"))
	if err != nil {
		t.Fatalf("stat config.toml: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("config.toml mode = %o, want 0600", perm)
	}
}

func TestCodexMCPHome_SymlinksAuthFromRealCodexHome(t *testing.T) {
	template := writeStaticTemplate(t)

	realHome := t.TempDir()
	authPath := filepath.Join(realHome, "auth.json")
	if err := os.WriteFile(authPath, []byte(`{"OPENAI_API_KEY":"sk-test"}`), 0o600); err != nil {
		t.Fatalf("write fake auth.json: %v", err)
	}

	home, cleanup, err := codexMCPHome(template, []string{"mcp__valaris__get_card"}, realHome)
	if err != nil {
		t.Fatalf("codexMCPHome: %v", err)
	}
	defer cleanup()

	linked := filepath.Join(home, "auth.json")
	target, err := os.Readlink(linked)
	if err != nil {
		t.Fatalf("auth.json is not a symlink: %v", err)
	}
	if target != authPath {
		t.Errorf("auth.json symlink target = %q, want %q", target, authPath)
	}
	// Follows through to the real content, proving codex would read real auth.
	content, err := os.ReadFile(linked)
	if err != nil {
		t.Fatalf("reading through symlink: %v", err)
	}
	if string(content) != `{"OPENAI_API_KEY":"sk-test"}` {
		t.Errorf("auth.json content via symlink = %q", content)
	}
}

// A host with no prior `codex login` (CODEX_API_KEY-only auth, injected by
// the runner itself) has no auth.json to link — that must not be an error.
func TestCodexMCPHome_MissingRealAuthIsNotFatal(t *testing.T) {
	template := writeStaticTemplate(t)

	home, cleanup, err := codexMCPHome(template, []string{"mcp__valaris__get_card"}, t.TempDir() /* empty, no auth.json */)
	if err != nil {
		t.Fatalf("codexMCPHome must not fail when auth.json is absent: %v", err)
	}
	defer cleanup()

	if _, err := os.Stat(filepath.Join(home, "config.toml")); err != nil {
		t.Errorf("config.toml must still be written: %v", err)
	}
}

// A grant with no valaris tool in it (built-ins only) is a deny-all for the
// server: the __none__ sentinel, never the unrestricted empty string.
func TestCodexMCPHome_BuiltinsOnlyGrantUsesDenyAllSentinel(t *testing.T) {
	template := writeStaticTemplate(t)

	home, cleanup, err := codexMCPHome(template, []string{"Bash", "Read"}, scratchCodexHome(t))
	if err != nil {
		t.Fatalf("codexMCPHome: %v", err)
	}
	defer cleanup()

	toml := readCodexConfigToml(t, home)
	if !strings.Contains(toml, `VALARIS_MCP_ALLOWLIST = "__none__"`) {
		t.Errorf("config.toml missing deny-all sentinel, got:\n%s", toml)
	}
}

// The EMPTY grant is the loop contract's full platform surface, not a
// deny-all: the server is wired with toolsets pinned to all and NO allowlist
// key (an empty allowlist means no restriction server-side). nil and an
// empty slice must behave identically.
func TestCodexMCPHome_EmptyGrantIsFullSurface(t *testing.T) {
	grants := []struct {
		name  string
		grant []string
	}{
		{name: "nil", grant: nil},
		{name: "empty slice", grant: []string{}},
	}
	for _, tt := range grants {
		t.Run(tt.name, func(t *testing.T) {
			template := writeStaticTemplate(t)

			home, cleanup, err := codexMCPHome(template, tt.grant, scratchCodexHome(t))
			if err != nil {
				t.Fatalf("codexMCPHome: %v", err)
			}
			defer cleanup()

			toml := readCodexConfigToml(t, home)
			if !strings.Contains(toml, "[mcp_servers.valaris]") {
				t.Fatalf("the empty grant must still wire the valaris MCP server, got:\n%s", toml)
			}
			if !strings.Contains(toml, `VALARIS_MCP_TOOLSETS = "all"`) {
				t.Errorf("config.toml missing VALARIS_MCP_TOOLSETS = \"all\", got:\n%s", toml)
			}
			if strings.Contains(toml, "VALARIS_MCP_ALLOWLIST") {
				t.Errorf("the empty grant must carry no allowlist key at all (full surface, never __none__), got:\n%s", toml)
			}
			if !strings.Contains(toml, `VALARIS_API_KEY = "vlr_test_key"`) {
				t.Errorf("config.toml missing VALARIS_API_KEY, got:\n%s", toml)
			}
		})
	}
}

func TestCodexMCPHome_MissingTemplateErrors(t *testing.T) {
	if _, _, err := codexMCPHome("/nonexistent/mcp-config.json", nil, scratchCodexHome(t)); err == nil {
		t.Error("expected error for missing template, got nil")
	}
}

func TestCodexMCPHome_CleanupRemovesDir(t *testing.T) {
	template := writeStaticTemplate(t)

	home, cleanup, err := codexMCPHome(template, []string{"mcp__valaris__get_card"}, scratchCodexHome(t))
	if err != nil {
		t.Fatalf("codexMCPHome: %v", err)
	}
	cleanup()

	if _, err := os.Stat(home); !os.IsNotExist(err) {
		t.Errorf("cleanup must remove the temp CODEX_HOME, stat err = %v", err)
	}
}

func TestEncodeValarisMCPServerTOML_EscapesSpecialCharacters(t *testing.T) {
	toml := encodeValarisMCPServerTOML("bash", []string{`/path/with "quotes"`}, map[string]string{
		"KEY": `value with "quotes" and \backslash`,
	})
	if !strings.Contains(toml, `\"quotes\"`) {
		t.Errorf("quotes must be escaped, got:\n%s", toml)
	}
	if !strings.Contains(toml, `\\backslash`) {
		t.Errorf("backslash must be escaped, got:\n%s", toml)
	}
}

// Codex gets the same toolsets pin as Claude: the launch's config.toml must
// carry VALARIS_MCP_TOOLSETS = "all" so the stage allowlist is the only
// narrowing (a default-hand template would otherwise clip the grant twice).
func TestCodexMCPHome_PinsToolsetsToAll(t *testing.T) {
	tests := []struct {
		name          string
		allowedTools  []string
		wantAllowlist string
	}{
		{
			name:          "normal grant",
			allowedTools:  []string{"mcp__valaris__get_card", "mcp__valaris__create_note"},
			wantAllowlist: `VALARIS_MCP_ALLOWLIST = "get_card,create_note"`,
		},
		{
			name:          "deny-all sentinel (built-ins only)",
			allowedTools:  []string{"Bash", "Read"},
			wantAllowlist: `VALARIS_MCP_ALLOWLIST = "__none__"`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			template := writeStaticTemplate(t)

			home, cleanup, err := codexMCPHome(template, tt.allowedTools, scratchCodexHome(t))
			if err != nil {
				t.Fatalf("codexMCPHome: %v", err)
			}
			defer cleanup()

			toml := readCodexConfigToml(t, home)
			if !strings.Contains(toml, tt.wantAllowlist) {
				t.Fatalf("config.toml missing %s, got:\n%s", tt.wantAllowlist, toml)
			}
			if !strings.Contains(toml, `VALARIS_MCP_TOOLSETS = "all"`) {
				t.Errorf("config.toml missing VALARIS_MCP_TOOLSETS = \"all\", got:\n%s", toml)
			}
		})
	}
}

func TestCodexMCPHome_OverridesTemplateToolsets(t *testing.T) {
	template := writeStaticTemplateWithToolsets(t, "default") // shared fixture from claude_cli_mcp_test.go

	home, cleanup, err := codexMCPHome(template, []string{"mcp__valaris__set_board_loop"}, scratchCodexHome(t))
	if err != nil {
		t.Fatalf("codexMCPHome: %v", err)
	}
	defer cleanup()

	toml := readCodexConfigToml(t, home)
	if strings.Contains(toml, `VALARIS_MCP_TOOLSETS = "default"`) {
		t.Errorf("template's default-hand toolsets leaked into the launch config:\n%s", toml)
	}
	if !strings.Contains(toml, `VALARIS_MCP_TOOLSETS = "all"`) {
		t.Errorf("config.toml must override the template's toolsets with \"all\", got:\n%s", toml)
	}
}
