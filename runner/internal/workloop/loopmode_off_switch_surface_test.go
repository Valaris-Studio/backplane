// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// The two existing pre-flights answer "is the tool granted?" (allowlist) and
// "may this identity drive the endpoint?" (API probe). Card 30031fc6 named the
// third question neither can reach: does the session's MCP server actually
// SERVE the tool? Loops #1–#3 all failed here — the MCP template resolved a
// stale PyPI 0.1.0 wheel with no set_board_loop in it, so the allowlist check
// passed (config listed the tool), the API probe passed (the agent key could
// call the endpoint), and the session still had no off-switch. The surface
// check spawns the configured server and asks it, which is the only place that
// failure is visible.

// writeMCPTemplate writes an mcpServers.json whose valaris entry runs a fake
// stdio MCP server serving exactly the named tools. Returns the template path.
func writeMCPTemplate(t *testing.T, tools ...string) string {
	t.Helper()
	var entries []string
	for _, name := range tools {
		entries = append(entries, fmt.Sprintf(`{"name":"%s","description":"x","inputSchema":{"type":"object"}}`, name))
	}
	return writeMCPTemplateEntries(t, entries...)
}

// writeMCPTemplateEntries is writeMCPTemplate over raw tools/list entries, for
// catalogs that need more than a name (a `_meta.deprecated` block, say).
// Entries must not contain single quotes — the fake server echoes them inside
// a single-quoted shell literal.
func writeMCPTemplateEntries(t *testing.T, entries ...string) string {
	t.Helper()
	dir := t.TempDir()

	// A shell script standing in for the real server: reads JSON-RPC lines and
	// answers initialize + tools/list. Enough of the handshake to be honest
	// about the surface without depending on a Python install.
	script := filepath.Join(dir, "fake-mcp-server.sh")
	body := `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"initialize"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"fake","version":"0"}}}'
      ;;
    *'"tools/list"'*)
      printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"tools":[` + strings.Join(entries, ",") + `]}}'
      ;;
  esac
done
`
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatalf("write fake server: %v", err)
	}

	doc := map[string]any{
		"mcpServers": map[string]any{
			"valaris": map[string]any{
				"command": "sh",
				"args":    []any{script},
				"env":     map[string]any{},
			},
		},
	}
	encoded, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		t.Fatalf("encode template: %v", err)
	}
	path := filepath.Join(dir, "mcp-config.json")
	if err := os.WriteFile(path, encoded, 0o644); err != nil {
		t.Fatalf("write template: %v", err)
	}
	return path
}

// newLoopModeWithMCPTemplate builds a LoopMode whose runner config points at
// the given MCP template, so the surface pre-flight has something to spawn.
func newLoopModeWithMCPTemplate(t *testing.T, srv *loopModeServer, provider llm.Provider, templatePath string) *LoopMode {
	t.Helper()
	cfg := loopModeTestConfig(t)
	cfg.LLM.MCPConfigPath = templatePath
	client := testClientWithURL(srv.srv.URL)
	return NewLoopMode(client, cfg, nil, provider, "acme", "board-1", "agent-1")
}

// TestLoopMode_OffSwitchSurfacePreflight_WarnsWhenServerOmitsTool is the exact
// Loop #1–#3 failure: allowlist grants it, the API accepts it, and the MCP
// server serves a catalog without it. Both older pre-flights stay silent.
func TestLoopMode_OffSwitchSurfacePreflight_WarnsWhenServerOmitsTool(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.Tools = []string{"Bash", offSwitchTool}
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))

	// A stale-wheel server: real tools, but no set_board_loop.
	template := writeMCPTemplate(t, "get_card", "update_card", "move_card")

	provider := llm.NewMockProvider("ok")
	m := newLoopModeWithMCPTemplate(t, srv, provider, template)
	logs := captureLogs(t)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	// Diagnostic, never a gate — same contract as the other two pre-flights.
	if provider.CallCount() != 1 {
		t.Errorf("provider called %d times, want 1 — the pre-flight must not stop the loop", provider.CallCount())
	}
	if got := strings.Count(logs(), offSwitchUnservedWarning); got != 1 {
		t.Errorf("unserved warning appeared %d times, want 1; log: %s", got, logs())
	}
	if !strings.Contains(logs(), "level=WARN") {
		t.Errorf("pre-flight must be slog.Warn (level=WARN); log: %s", logs())
	}
	// The other two faults are absent, so their warnings must not fire: each
	// sends the operator somewhere different, and only one place is wrong.
	if strings.Contains(logs(), offSwitchPreflightWarning) {
		t.Errorf("allowlist warning must stay silent when the tool IS granted; log: %s", logs())
	}
	if strings.Contains(logs(), offSwitchUncallableWarning) {
		t.Errorf("callability warning must stay silent when the endpoint accepts; log: %s", logs())
	}
}

// TestLoopMode_OffSwitchSurfacePreflight_SilentWhenServed pins the happy path:
// a server that lists the tool warns about nothing.
func TestLoopMode_OffSwitchSurfacePreflight_SilentWhenServed(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.Tools = []string{"Bash", offSwitchTool}
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))

	template := writeMCPTemplate(t, "get_card", "set_board_loop", "update_card")

	provider := llm.NewMockProvider("ok")
	m := newLoopModeWithMCPTemplate(t, srv, provider, template)
	logs := captureLogs(t)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if strings.Contains(logs(), offSwitchUnservedWarning) {
		t.Errorf("a served off-switch must not warn; log: %s", logs())
	}
}

// TestLoopMode_OffSwitchSurfacePreflight_SkippedWhenNotGranted keeps the three
// diagnostics from stacking on one fault. A missing grant is already fully
// explained by the allowlist warning; spawning a server to confirm the tool is
// absent from a surface nobody asked for would add noise, not information.
func TestLoopMode_OffSwitchSurfacePreflight_SkippedWhenNotGranted(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.Tools = []string{"Bash"} // off-switch NOT granted
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))

	template := writeMCPTemplate(t, "get_card") // would fail the surface check

	provider := llm.NewMockProvider("ok")
	m := newLoopModeWithMCPTemplate(t, srv, provider, template)
	logs := captureLogs(t)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := strings.Count(logs(), offSwitchPreflightWarning); got != 1 {
		t.Errorf("allowlist warning appeared %d times, want 1; log: %s", got, logs())
	}
	if strings.Contains(logs(), offSwitchUnservedWarning) {
		t.Errorf("surface check must not run when the tool is not granted; log: %s", logs())
	}
}

// TestLoopMode_OffSwitchSurfacePreflight_FiresOncePerRun proves the check is
// run-scoped: spawning an MCP server per iteration would be a real cost, and
// the condition it reads (the configured template) cannot change mid-run.
func TestLoopMode_OffSwitchSurfacePreflight_FiresOncePerRun(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.Tools = []string{offSwitchTool}
	cfg.MaxIterations = 3
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))

	template := writeMCPTemplate(t, "get_card")

	provider := llm.NewMockProvider("ok", "ok", "ok")
	m := newLoopModeWithMCPTemplate(t, srv, provider, template)
	logs := captureLogs(t)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 3 {
		t.Fatalf("provider called %d times, want 3", provider.CallCount())
	}
	if got := strings.Count(logs(), offSwitchUnservedWarning); got != 1 {
		t.Errorf("unserved warning appeared %d times across 3 iterations, want exactly 1", got)
	}
}

// TestLoopMode_OffSwitchSurfacePreflight_SilentWhenUnprobeable is the
// fail-OPEN pin. A server that cannot be spawned or does not speak the
// handshake tells us nothing about the off-switch, and an inconclusive probe
// must not be reported as a fault: crying wolf on every misconfigured-but-
// unrelated template is how operators learn to ignore the warning that
// matters. The loop still runs, and the other two pre-flights still cover
// their own faults.
func TestLoopMode_OffSwitchSurfacePreflight_SilentWhenUnprobeable(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.Tools = []string{offSwitchTool}
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))

	provider := llm.NewMockProvider("ok")
	// No MCP template configured at all — nothing to spawn, nothing to claim.
	m := newLoopModeForServer(t, srv, provider)
	logs := captureLogs(t)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 1 {
		t.Errorf("provider called %d times, want 1 — an unprobeable surface must not stop the loop", provider.CallCount())
	}
	if strings.Contains(logs(), offSwitchUnservedWarning) {
		t.Errorf("an inconclusive probe must not warn; log: %s", logs())
	}
}

// TestOffSwitchServedByMCP_MatchesUnprefixedName pins the name translation the
// check depends on. The board allowlist and the loop prompt both speak the
// PREFIXED form (mcp__valaris__set_board_loop) that the coding agent surfaces,
// but the MCP server's own catalog lists tools UNPREFIXED (set_board_loop) —
// the prefix is added by the client, not the server. Comparing the two forms
// directly would report every healthy server as broken.
func TestOffSwitchServedByMCP_MatchesUnprefixedName(t *testing.T) {
	if got := strings.TrimPrefix(offSwitchTool, valarisMCPToolPrefix); got != "set_board_loop" {
		t.Fatalf("unprefixed off-switch name = %q, want set_board_loop", got)
	}

	served := []string{"get_card", "set_board_loop", "update_card"}
	if !offSwitchInCatalog(served) {
		t.Errorf("catalog %v serves the off-switch unprefixed; the check must recognize it", served)
	}
	if offSwitchInCatalog([]string{"get_card", "update_card"}) {
		t.Errorf("a catalog without the off-switch must not report it as served")
	}
	// A server that already prefixes must still be recognized — the check
	// answers "is it there", not "which spelling did the server choose".
	if !offSwitchInCatalog([]string{offSwitchTool}) {
		t.Errorf("a prefixed catalog entry must also count as served")
	}
}
