// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Minimal valid static template used by the dynamic-config tests.
// Keeps tests hermetic — does not depend on runner/configs/mcp-config-prod.json.
const testStaticMCPConfig = `{
  "mcpServers": {
    "valaris": {
      "command": "bash",
      "args": ["/opt/valaris/mcp-server/run.sh"],
      "env": {
        "VALARIS_API_URL": "https://example.test",
        "VALARIS_API_KEY": "vlr_test_key",
        "VALARIS_AGENT_EMAIL": "runner@example.test"
      }
    }
  }
}`

func writeStaticTemplate(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp-config-static.json")
	if err := os.WriteFile(path, []byte(testStaticMCPConfig), 0o644); err != nil {
		t.Fatalf("write static template: %v", err)
	}
	return path
}

// readValarisEnv parses the dynamic MCP config and returns the env map of the
// valaris server entry. Fails the test if the structure is missing.
func readValarisEnv(t *testing.T, path string) map[string]string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read dynamic config: %v", err)
	}
	var parsed struct {
		McpServers map[string]struct {
			Command string            `json:"command"`
			Args    []string          `json:"args"`
			Env     map[string]string `json:"env"`
		} `json:"mcpServers"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		t.Fatalf("parse dynamic config: %v\n%s", err, string(raw))
	}
	val, ok := parsed.McpServers["valaris"]
	if !ok {
		t.Fatalf("dynamic config missing mcpServers.valaris: %s", string(raw))
	}
	return val.Env
}

func TestWriteDynamicMCPConfig_EmbedsAllowlistEnv(t *testing.T) {
	template := writeStaticTemplate(t)

	path, cleanup, err := writeDynamicMCPConfig(template, []string{"mcp__valaris__get_card"})
	if err != nil {
		t.Fatalf("writeDynamicMCPConfig: %v", err)
	}
	defer cleanup()

	env := readValarisEnv(t, path)
	if env["VALARIS_MCP_ALLOWLIST"] != "get_card" {
		t.Errorf("VALARIS_MCP_ALLOWLIST = %q, want %q", env["VALARIS_MCP_ALLOWLIST"], "get_card")
	}
}

func TestWriteDynamicMCPConfig_StripsPrefixBeforeEmbed(t *testing.T) {
	template := writeStaticTemplate(t)

	path, cleanup, err := writeDynamicMCPConfig(template, []string{
		"mcp__valaris__create_note",
		"mcp__valaris__get_card",
	})
	if err != nil {
		t.Fatalf("writeDynamicMCPConfig: %v", err)
	}
	defer cleanup()

	env := readValarisEnv(t, path)
	got := env["VALARIS_MCP_ALLOWLIST"]
	// Order preserved from input slice; comma-joined; prefixes stripped.
	if got != "create_note,get_card" {
		t.Errorf("VALARIS_MCP_ALLOWLIST = %q, want %q", got, "create_note,get_card")
	}
	if strings.Contains(got, "mcp__valaris__") {
		t.Errorf("VALARIS_MCP_ALLOWLIST still contains prefix: %q", got)
	}
}

func TestWriteDynamicMCPConfig_DropsNonValarisTools(t *testing.T) {
	template := writeStaticTemplate(t)

	// A stage that grants valaris MCP tools alongside built-ins (Bash/Read/Skill,
	// e.g. the ui_validator visual-testing stage). Only the mcp__valaris__* tools
	// belong in the server's allowlist; built-ins must be dropped.
	path, cleanup, err := writeDynamicMCPConfig(template, []string{
		"mcp__valaris__get_card",
		"Bash",
		"mcp__valaris__create_note",
		"Read",
		"Skill",
	})
	if err != nil {
		t.Fatalf("writeDynamicMCPConfig: %v", err)
	}
	defer cleanup()

	env := readValarisEnv(t, path)
	got := env["VALARIS_MCP_ALLOWLIST"]
	if got != "get_card,create_note" {
		t.Errorf("VALARIS_MCP_ALLOWLIST = %q, want %q", got, "get_card,create_note")
	}
	for _, builtin := range []string{"Bash", "Read", "Skill"} {
		if strings.Contains(got, builtin) {
			t.Errorf("VALARIS_MCP_ALLOWLIST leaked non-valaris tool %q: %q", builtin, got)
		}
	}
}

func TestWriteDynamicMCPConfig_OnlyNonValarisTools_DenyAllSentinel(t *testing.T) {
	template := writeStaticTemplate(t)

	// A stage granting ZERO valaris tools must NOT collapse to an empty allowlist,
	// because empty == "no restriction" == full valaris access (escalation). The
	// __none__ sentinel passes the server's tool-name regex but matches no real
	// tool, yielding deny-all-valaris.
	path, cleanup, err := writeDynamicMCPConfig(template, []string{"Bash", "Skill", "Read"})
	if err != nil {
		t.Fatalf("writeDynamicMCPConfig: %v", err)
	}
	defer cleanup()

	env := readValarisEnv(t, path)
	got := env["VALARIS_MCP_ALLOWLIST"]
	if got != "__none__" {
		t.Errorf("VALARIS_MCP_ALLOWLIST = %q, want %q (deny-all sentinel)", got, "__none__")
	}
}

func TestWriteDynamicMCPConfig_TemplateEnvPreserved(t *testing.T) {
	template := writeStaticTemplate(t)

	path, cleanup, err := writeDynamicMCPConfig(template, []string{"mcp__valaris__get_card"})
	if err != nil {
		t.Fatalf("writeDynamicMCPConfig: %v", err)
	}
	defer cleanup()

	env := readValarisEnv(t, path)
	if env["VALARIS_API_KEY"] != "vlr_test_key" {
		t.Errorf("VALARIS_API_KEY preserved? got %q", env["VALARIS_API_KEY"])
	}
	if env["VALARIS_API_URL"] != "https://example.test" {
		t.Errorf("VALARIS_API_URL preserved? got %q", env["VALARIS_API_URL"])
	}
	if env["VALARIS_AGENT_EMAIL"] != "runner@example.test" {
		t.Errorf("VALARIS_AGENT_EMAIL preserved? got %q", env["VALARIS_AGENT_EMAIL"])
	}
	if env["VALARIS_MCP_ALLOWLIST"] != "get_card" {
		t.Errorf("VALARIS_MCP_ALLOWLIST = %q, want %q", env["VALARIS_MCP_ALLOWLIST"], "get_card")
	}
}

func TestWriteDynamicMCPConfig_CleanupIdempotent(t *testing.T) {
	template := writeStaticTemplate(t)
	path, cleanup, err := writeDynamicMCPConfig(template, []string{"mcp__valaris__get_card"})
	if err != nil {
		t.Fatalf("writeDynamicMCPConfig: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("dynamic file should exist before cleanup: %v", err)
	}
	cleanup()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("dynamic file should be removed after cleanup; stat err = %v", err)
	}
	// Second call must not panic or return error visibly.
	cleanup()
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Errorf("dynamic file should still be absent after second cleanup; stat err = %v", err)
	}
}

// Execute-level tests use a shell script as the fake claude binary so they
// can observe argv (written to a sidecar file). This proves the Execute path
// wires the dynamic helper correctly without launching real claude.

// fakeClaudeRecordingArgv writes the script's argv (one per line) to argvFile
// then exits 0. Output is empty (no stream-json) — we only care about argv.
func fakeClaudeRecordingArgv(t *testing.T, argvFile string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell fake binary is POSIX only")
	}
	dir := t.TempDir()
	fake := filepath.Join(dir, "fake-claude.sh")
	script := `#!/bin/sh
for a in "$@"; do
  printf '%s\n' "$a"
done > "` + argvFile + `"
exit 0
`
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake: %v", err)
	}
	return fake
}

// readArgv returns the recorded argv lines from the fake-claude run.
func readArgv(t *testing.T, argvFile string) []string {
	t.Helper()
	raw, err := os.ReadFile(argvFile)
	if err != nil {
		t.Fatalf("read argv: %v", err)
	}
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	return lines
}

// argvFlagValue returns the value passed for the given flag (the token
// immediately after it). Returns "" if the flag is not present.
func argvFlagValue(argv []string, flag string) string {
	for i, a := range argv {
		if a == flag && i+1 < len(argv) {
			return argv[i+1]
		}
	}
	return ""
}

func argvHas(argv []string, want string) bool {
	for _, a := range argv {
		if a == want {
			return true
		}
	}
	return false
}

func TestExecute_DynamicMCPConfig_EmbedsAllowlistEnv(t *testing.T) {
	template := writeStaticTemplate(t)
	argvFile := filepath.Join(t.TempDir(), "argv.txt")
	fake := fakeClaudeRecordingArgv(t, argvFile)

	cli := &ClaudeCLI{ClaudeBin: fake}
	_, err := cli.Execute(context.Background(), "p", Options{
		MCPConfigPath: template,
		AllowedTools:  []string{"mcp__valaris__get_card"},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	argv := readArgv(t, argvFile)
	mcpPath := argvFlagValue(argv, "--mcp-config")
	if mcpPath == "" {
		t.Fatalf("--mcp-config not present in argv: %v", argv)
	}
	if mcpPath == template {
		t.Fatalf("--mcp-config should point at dynamic temp file, not static template; got %q", mcpPath)
	}
	// The dynamic file is removed by deferred cleanup. We can't read it after
	// Execute returns — so this test asserts the argv path is non-static.
	// The file-content assertion happens in TestWriteDynamicMCPConfig_EmbedsAllowlistEnv.
}

func TestExecute_DynamicMCPConfig_StripsPrefixBeforeEmbed(t *testing.T) {
	// Pure-helper coverage lives in TestWriteDynamicMCPConfig_StripsPrefixBeforeEmbed.
	// At the Execute level, we just verify the dynamic path was taken (argv != template).
	template := writeStaticTemplate(t)
	argvFile := filepath.Join(t.TempDir(), "argv.txt")
	fake := fakeClaudeRecordingArgv(t, argvFile)

	cli := &ClaudeCLI{ClaudeBin: fake}
	_, err := cli.Execute(context.Background(), "p", Options{
		MCPConfigPath: template,
		AllowedTools:  []string{"mcp__valaris__create_note"},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	argv := readArgv(t, argvFile)
	mcpPath := argvFlagValue(argv, "--mcp-config")
	if mcpPath == template {
		t.Fatalf("expected dynamic temp file path, got static template")
	}
}

// fakeClaudeCapturingMCPConfig is fakeClaudeRecordingArgv plus a copy of the
// file passed to --mcp-config into configCopy. The copy has to happen INSIDE
// the fake binary: Execute's deferred cleanup removes the dynamic config the
// moment Execute returns, before the test could read it from the outside.
func fakeClaudeCapturingMCPConfig(t *testing.T, argvFile, configCopy string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell fake binary is POSIX only")
	}
	dir := t.TempDir()
	fake := filepath.Join(dir, "fake-claude.sh")
	script := `#!/bin/sh
prev=""
for a in "$@"; do
  printf '%s\n' "$a"
  if [ "$prev" = "--mcp-config" ]; then cp "$a" "` + configCopy + `"; fi
  prev="$a"
done > "` + argvFile + `"
exit 0
`
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake: %v", err)
	}
	return fake
}

// An EMPTY grant is the loop contract's "full platform surface" (tools: []),
// not a deny-all — but the launch must still pin toolsets to all, or a
// template without VALARIS_MCP_TOOLSETS hands the session the server's
// interactive default hand. So even an empty grant gets a dynamic config:
// toolsets pinned, and NO allowlist key (never the __none__ sentinel).
func TestExecute_DynamicMCPConfig_EmptyGrant_PinsToolsetsWithoutAllowlist(t *testing.T) {
	// nil and an empty slice must behave identically: the workloop hands the
	// drivers whichever the decoded config happens to carry.
	grants := []struct {
		name  string
		grant []string
	}{
		{name: "nil", grant: nil},
		{name: "empty slice", grant: []string{}},
	}
	for _, tt := range grants {
		t.Run(tt.name, func(t *testing.T) {
			grant := tt.grant
			template := writeStaticTemplate(t)
			argvFile := filepath.Join(t.TempDir(), "argv.txt")
			configCopy := filepath.Join(t.TempDir(), "mcp-config-copy.json")
			fake := fakeClaudeCapturingMCPConfig(t, argvFile, configCopy)

			cli := &ClaudeCLI{ClaudeBin: fake}
			_, err := cli.Execute(context.Background(), "p", Options{
				MCPConfigPath: template,
				AllowedTools:  grant,
			})
			if err != nil {
				t.Fatalf("Execute: %v", err)
			}

			argv := readArgv(t, argvFile)
			mcpPath := argvFlagValue(argv, "--mcp-config")
			if mcpPath == "" || mcpPath == template {
				t.Fatalf("--mcp-config = %q, want a dynamic config even for the empty grant (template %q)", mcpPath, template)
			}
			env := readValarisEnv(t, configCopy)
			if got := env[toolsetsEnvName]; got != "all" {
				t.Errorf("%s = %q, want %q — the empty grant is the full surface, and the launch must say so", toolsetsEnvName, got, "all")
			}
			if got, present := env["VALARIS_MCP_ALLOWLIST"]; present {
				t.Errorf("VALARIS_MCP_ALLOWLIST = %q, want the key absent: an empty grant is the full surface, not a deny-all", got)
			}
			if env["VALARIS_API_KEY"] != "vlr_test_key" {
				t.Errorf("VALARIS_API_KEY preserved? got %q", env["VALARIS_API_KEY"])
			}
		})
	}
}

func TestExecute_DynamicMCPConfig_AbsentMCPPath_NoFile(t *testing.T) {
	argvFile := filepath.Join(t.TempDir(), "argv.txt")
	fake := fakeClaudeRecordingArgv(t, argvFile)

	cli := &ClaudeCLI{ClaudeBin: fake}
	_, err := cli.Execute(context.Background(), "p", Options{
		MCPConfigPath: "",
		AllowedTools:  []string{"mcp__valaris__get_card"},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	argv := readArgv(t, argvFile)
	if argvHas(argv, "--mcp-config") {
		t.Errorf("--mcp-config should not be present when MCPConfigPath is empty; argv=%v", argv)
	}
}

// snapshotTempDir returns the set of files matching the dynamic config glob
// in os.TempDir(). Used to confirm cleanup happened.
func snapshotTempFiles(t *testing.T) map[string]struct{} {
	t.Helper()
	matches, err := filepath.Glob(filepath.Join(os.TempDir(), "valaris-mcp-config-*.json"))
	if err != nil {
		t.Fatalf("glob: %v", err)
	}
	out := make(map[string]struct{}, len(matches))
	for _, m := range matches {
		out[m] = struct{}{}
	}
	return out
}

func TestExecute_DynamicMCPConfig_CleanupOnSuccess(t *testing.T) {
	template := writeStaticTemplate(t)
	argvFile := filepath.Join(t.TempDir(), "argv.txt")
	fake := fakeClaudeRecordingArgv(t, argvFile)

	before := snapshotTempFiles(t)
	cli := &ClaudeCLI{ClaudeBin: fake}
	_, err := cli.Execute(context.Background(), "p", Options{
		MCPConfigPath: template,
		AllowedTools:  []string{"mcp__valaris__get_card"},
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	after := snapshotTempFiles(t)

	for path := range after {
		if _, existed := before[path]; !existed {
			t.Errorf("dynamic config file leaked after success: %s", path)
		}
	}
}

func TestExecute_DynamicMCPConfig_CleanupOnError(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fake binary is POSIX only")
	}

	template := writeStaticTemplate(t)
	dir := t.TempDir()
	fake := filepath.Join(dir, "fake-claude-fail.sh")
	script := `#!/bin/sh
exit 7
`
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake: %v", err)
	}

	before := snapshotTempFiles(t)
	cli := &ClaudeCLI{ClaudeBin: fake}
	_, err := cli.Execute(context.Background(), "p", Options{
		MCPConfigPath: template,
		AllowedTools:  []string{"mcp__valaris__get_card"},
	})
	if err == nil {
		t.Fatalf("expected error from non-zero exit")
	}
	after := snapshotTempFiles(t)

	for path := range after {
		if _, existed := before[path]; !existed {
			t.Errorf("dynamic config file leaked after error: %s", path)
		}
	}
}

// ------------------------------------------------------------- toolsets --
//
// VALARIS_MCP_TOOLSETS is the server's interactive scoping knob: unset, it
// serves the default hand (a subset of the surface that omits the
// autonomous-operations tools — enqueue_pr_for_merge, list_skills/get_skill,
// the approvals tools). A runner launch already narrows the surface with the
// stage's allowlist, so the dynamic config must pin toolsets to "all" —
// otherwise a default-hand template clips the grant a second time and a stage
// that was granted enqueue_pr_for_merge cannot see it.

const toolsetsEnvName = "VALARIS_MCP_TOOLSETS"

// The empty grant (the loop contract's full surface) gets the same pin and no
// allowlist key at all — an empty allowlist means no restriction server-side,
// and the deny-all sentinel is reserved for a NON-empty grant with no valaris
// tool in it.
func TestWriteDynamicMCPConfig_EmptyGrant_PinsToolsetsWithoutAllowlist(t *testing.T) {
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

			path, cleanup, err := writeDynamicMCPConfig(template, tt.grant)
			if err != nil {
				t.Fatalf("writeDynamicMCPConfig: %v", err)
			}
			defer cleanup()

			env := readValarisEnv(t, path)
			if got := env[toolsetsEnvName]; got != "all" {
				t.Errorf("%s = %q, want %q", toolsetsEnvName, got, "all")
			}
			if got, present := env["VALARIS_MCP_ALLOWLIST"]; present {
				t.Errorf("VALARIS_MCP_ALLOWLIST = %q, want the key absent for the empty grant", got)
			}
			if env["VALARIS_API_KEY"] != "vlr_test_key" {
				t.Errorf("VALARIS_API_KEY preserved? got %q", env["VALARIS_API_KEY"])
			}
		})
	}
}

// writeStaticTemplateWithToolsets is writeStaticTemplate with an explicit
// VALARIS_MCP_TOOLSETS already in the template env — the operator's
// interactive-use template being reused for a runner.
func writeStaticTemplateWithToolsets(t *testing.T, toolsets string) string {
	t.Helper()
	template := `{
  "mcpServers": {
    "valaris": {
      "command": "bash",
      "args": ["/opt/valaris/mcp-server/run.sh"],
      "env": {
        "VALARIS_API_URL": "https://example.test",
        "VALARIS_API_KEY": "vlr_test_key",
        "VALARIS_MCP_TOOLSETS": "` + toolsets + `"
      }
    }
  }
}`
	path := filepath.Join(t.TempDir(), "mcp-config-static.json")
	if err := os.WriteFile(path, []byte(template), 0o644); err != nil {
		t.Fatalf("write static template: %v", err)
	}
	return path
}

func TestWriteDynamicMCPConfig_PinsToolsetsToAll(t *testing.T) {
	template := writeStaticTemplate(t)

	path, cleanup, err := writeDynamicMCPConfig(template, []string{"mcp__valaris__get_card"})
	if err != nil {
		t.Fatalf("writeDynamicMCPConfig: %v", err)
	}
	defer cleanup()

	env := readValarisEnv(t, path)
	if got := env[toolsetsEnvName]; got != "all" {
		t.Errorf("%s = %q, want %q — the stage allowlist is the only narrowing a runner launch applies", toolsetsEnvName, got, "all")
	}
	// The allowlist still rides alongside: toolsets widen the pool the
	// allowlist selects from, they never replace it.
	if got := env["VALARIS_MCP_ALLOWLIST"]; got != "get_card" {
		t.Errorf("VALARIS_MCP_ALLOWLIST = %q, want %q", got, "get_card")
	}
}

func TestWriteDynamicMCPConfig_DenyAllSentinel_StillPinsToolsetsToAll(t *testing.T) {
	template := writeStaticTemplate(t)

	// Zero valaris tools granted: the sentinel denies everything on its own,
	// and toolsets stays "all" so the deny semantics come from exactly one
	// place (the allowlist), never from an accidental toolset/allowlist mix.
	path, cleanup, err := writeDynamicMCPConfig(template, []string{"Bash", "Read"})
	if err != nil {
		t.Fatalf("writeDynamicMCPConfig: %v", err)
	}
	defer cleanup()

	env := readValarisEnv(t, path)
	if got := env["VALARIS_MCP_ALLOWLIST"]; got != "__none__" {
		t.Fatalf("VALARIS_MCP_ALLOWLIST = %q, want deny-all sentinel", got)
	}
	if got := env[toolsetsEnvName]; got != "all" {
		t.Errorf("%s = %q, want %q even under the deny-all sentinel", toolsetsEnvName, got, "all")
	}
}

func TestWriteDynamicMCPConfig_OverridesTemplateToolsets(t *testing.T) {
	// An operator who reuses their interactive template (pinned to the
	// default hand) for runner launches must not have runner stages clipped
	// by it: the runner owns this key on every launch.
	for _, templateValue := range []string{"default", "cards,notes"} {
		t.Run(templateValue, func(t *testing.T) {
			template := writeStaticTemplateWithToolsets(t, templateValue)

			path, cleanup, err := writeDynamicMCPConfig(template, []string{"mcp__valaris__set_board_loop"})
			if err != nil {
				t.Fatalf("writeDynamicMCPConfig: %v", err)
			}
			defer cleanup()

			env := readValarisEnv(t, path)
			if got := env[toolsetsEnvName]; got != "all" {
				t.Errorf("template %s=%q leaked through: got %q, want %q", toolsetsEnvName, templateValue, got, "all")
			}
			// Overriding one key must not disturb the rest of the template env.
			if env["VALARIS_API_KEY"] != "vlr_test_key" {
				t.Errorf("VALARIS_API_KEY preserved? got %q", env["VALARIS_API_KEY"])
			}
		})
	}
}
