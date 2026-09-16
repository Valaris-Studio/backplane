// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// The MCP server retires tools behind deprecated aliases for one minor
// version (backplane-mcp 0.7.0 → 0.8.0). A stored grant — loop_config.tools or
// a pipeline stage's llm.tools — that still names an alias keeps working until
// the alias goes, and the only place that can see the alias coming is the
// served catalog: every alias carries `_meta.deprecated` on tools/list.

const deprecatedClaimCardEntry = `{"name":"claim_card","description":"DEPRECATED, removed in backplane-mcp 0.8.0: call next_assignment instead of claim_card.","inputSchema":{"type":"object"},"_meta":{"deprecated":{"replacement":"next_assignment","removed_in":"0.8.0"}}}`
const liveGetCardEntry = `{"name":"get_card","description":"x","inputSchema":{"type":"object"}}`
const liveSetBoardLoopEntry = `{"name":"set_board_loop","description":"x","inputSchema":{"type":"object"}}`

func TestReadToolsListResult_ParsesDeprecationMeta(t *testing.T) {
	reply := `{"jsonrpc":"2.0","id":2,"result":{"tools":[` + liveGetCardEntry + `,` + deprecatedClaimCardEntry + `]}}` + "\n"
	served, err := readToolsListResult(strings.NewReader(reply))
	if err != nil {
		t.Fatalf("readToolsListResult: %v", err)
	}
	if len(served) != 2 {
		t.Fatalf("served = %v, want 2 tools", served)
	}
	if served[0].Name != "get_card" || served[0].Deprecated != nil {
		t.Errorf("get_card must be live: %+v", served[0])
	}
	if served[1].Name != "claim_card" || served[1].Deprecated == nil {
		t.Fatalf("claim_card must carry the deprecation: %+v", served[1])
	}
	if served[1].Deprecated.Replacement != "next_assignment" || served[1].Deprecated.RemovedIn != "0.8.0" {
		t.Errorf("deprecation = %+v", served[1].Deprecated)
	}
}

func TestDeprecatedGrants_MatchesEitherSpellingAndSkipsLiveTools(t *testing.T) {
	served := []ServedMCPTool{
		{Name: "get_card"},
		{Name: "claim_card", Deprecated: &MCPDeprecation{Replacement: "next_assignment", RemovedIn: "0.8.0"}},
		{Name: "append_note", Deprecated: &MCPDeprecation{Replacement: "update_note(mode='append')", RemovedIn: "0.8.0"}},
	}
	granted := []string{"Bash", "mcp__valaris__get_card", "mcp__valaris__claim_card", "append_note", "mcp__valaris__claim_card"}

	got := DeprecatedGrants(granted, served)

	want := []DeprecatedGrant{
		{Tool: "mcp__valaris__claim_card", Replacement: "next_assignment", RemovedIn: "0.8.0"},
		{Tool: "append_note", Replacement: "update_note(mode='append')", RemovedIn: "0.8.0"},
	}
	if len(got) != len(want) {
		t.Fatalf("DeprecatedGrants = %+v, want %+v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("[%d] = %+v, want %+v", i, got[i], want[i])
		}
	}
	if DeprecatedGrants(nil, served) != nil {
		t.Error("no grant, no findings")
	}
	if DeprecatedGrants(granted, nil) != nil {
		t.Error("no catalog, no findings")
	}
}

// TestLoopMode_DeprecatedGrantPreflight_WarnsOncePerRun: the board grants a
// deprecated alias the server still serves — the loop runs (the alias works),
// and one warning names the tool, its replacement and the removal version.
func TestLoopMode_DeprecatedGrantPreflight_WarnsOncePerRun(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.Tools = []string{"mcp__valaris__claim_card", "mcp__valaris__get_card", offSwitchTool}
	cfg.MaxIterations = 3
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))

	template := writeMCPTemplateEntries(t, liveGetCardEntry, liveSetBoardLoopEntry, deprecatedClaimCardEntry)

	provider := llm.NewMockProvider("ok", "ok", "ok")
	m := newLoopModeWithMCPTemplate(t, srv, provider, template)
	logs := captureLogs(t)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 3 {
		t.Errorf("provider called %d times, want 3 — a deprecated grant is a warning, never a gate", provider.CallCount())
	}
	if got := strings.Count(logs(), deprecatedGrantsWarning); got != 1 {
		t.Errorf("deprecated-grant warning appeared %d times across 3 iterations, want exactly 1; log: %s", got, logs())
	}
	for _, want := range []string{"level=WARN", "mcp__valaris__claim_card", "next_assignment", "0.8.0"} {
		if !strings.Contains(logs(), want) {
			t.Errorf("warning must carry %q; log: %s", want, logs())
		}
	}
	if strings.Contains(logs(), offSwitchUnservedWarning) {
		t.Errorf("the off-switch IS served — its warning must stay silent; log: %s", logs())
	}
}

func TestLoopMode_DeprecatedGrantPreflight_SilentWhenEveryGrantIsLive(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.Tools = []string{"mcp__valaris__get_card", offSwitchTool}
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))

	// The alias is served but NOT granted: nothing to warn about.
	template := writeMCPTemplateEntries(t, liveGetCardEntry, liveSetBoardLoopEntry, deprecatedClaimCardEntry)

	provider := llm.NewMockProvider("ok")
	m := newLoopModeWithMCPTemplate(t, srv, provider, template)
	logs := captureLogs(t)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if strings.Contains(logs(), deprecatedGrantsWarning) {
		t.Errorf("no deprecated tool is granted; log: %s", logs())
	}
}

func TestLoopMode_DeprecatedGrantPreflight_SilentWhenUnprobeable(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.Tools = []string{"mcp__valaris__claim_card"}
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))

	provider := llm.NewMockProvider("ok")
	m := newLoopModeForServer(t, srv, provider) // no MCP template: nothing to ask
	logs := captureLogs(t)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if strings.Contains(logs(), deprecatedGrantsWarning) {
		t.Errorf("an inconclusive probe must not warn; log: %s", logs())
	}
}
