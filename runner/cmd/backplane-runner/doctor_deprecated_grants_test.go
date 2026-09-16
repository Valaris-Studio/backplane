// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/tui"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
	"github.com/Valaris-Studio/backplane/runner/internal/workloop"
)

// The doctor sees two things the launch pre-flight cannot pair on its own: the
// workspace pipeline config (every stage's llm.tools and mcp_call steps) and
// the catalog the configured MCP server actually serves. A stage grant that
// names a deprecated alias works today and breaks on the next minor of
// backplane-mcp, so the doctor says so before that upgrade, not after.

func servedWithDeprecatedClaimCard() []workloop.ServedMCPTool {
	return []workloop.ServedMCPTool{
		{Name: "get_card"},
		{Name: "claim_card", Deprecated: &workloop.MCPDeprecation{Replacement: "next_assignment", RemovedIn: "0.8.0"}},
		{Name: "remove_card_participants_by_role", Deprecated: &workloop.MCPDeprecation{Replacement: "remove_card_participant(pipeline_role=...)", RemovedIn: "0.8.0"}},
	}
}

func TestStageGrantsFrom_CollectsLLMToolsAndMCPCallSteps(t *testing.T) {
	platform := &valaris.PlatformConfig{
		WorkspaceConfig: valaris.WorkspaceConfigData{
			PipelineConfig: &valaris.PipelineConfig{Stages: []valaris.StageConfig{
				{Role: "implementer", LLM: valaris.LLMDef{Tools: []string{"Bash", "mcp__valaris__claim_card"}}},
				{Role: "rework_mediator", Lifecycle: []valaris.LifecycleStep{
					{Name: "clear", Kind: "mcp_call", Params: map[string]any{"tool": "remove_card_participants_by_role"}},
					{Name: "wake", Kind: "wake_role", Params: map[string]any{"roles": []any{"implementer"}}},
				}},
			}},
		},
	}
	grants := stageGrantsFrom(platform)
	if len(grants) != 2 {
		t.Fatalf("grants = %+v, want 2 stages", grants)
	}
	if grants[0].Role != "implementer" || strings.Join(grants[0].Tools, ",") != "Bash,mcp__valaris__claim_card" {
		t.Errorf("implementer grant = %+v", grants[0])
	}
	if grants[1].Role != "rework_mediator" || strings.Join(grants[1].Tools, ",") != "remove_card_participants_by_role" {
		t.Errorf("mediator grant = %+v", grants[1])
	}
	if got := stageGrantsFrom(nil); got != nil {
		t.Errorf("nil platform config → nil grants, got %+v", got)
	}
	if got := stageGrantsFrom(&valaris.PlatformConfig{}); got != nil {
		t.Errorf("no pipeline config → nil grants, got %+v", got)
	}
}

func TestCheckMCPDeprecatedGrants_WarnsNamingStageToolAndReplacement(t *testing.T) {
	deps := doctorDeps{
		StageGrants: []stageGrant{
			{Role: "implementer", Tools: []string{"Bash", "mcp__valaris__claim_card"}},
			{Role: "reviewer", Tools: []string{"mcp__valaris__get_card"}},
			{Role: "rework_mediator", Tools: []string{"remove_card_participants_by_role"}},
		},
		ServedMCP: servedWithDeprecatedClaimCard(),
	}
	row, found := checkMCPDeprecatedGrants(deps)
	if !found {
		t.Fatal("a probed catalog must always yield a row")
	}
	if row.State != tui.StateWarn {
		t.Fatalf("state = %v, want WARN (the grants still work today)", row.State)
	}
	for _, want := range []string{"implementer", "mcp__valaris__claim_card", "next_assignment", "rework_mediator", "remove_card_participants_by_role", "0.8.0"} {
		if !strings.Contains(row.Detail, want) {
			t.Errorf("detail must carry %q: %q", want, row.Detail)
		}
	}
	if strings.Contains(row.Detail, "reviewer") {
		t.Errorf("a stage with only live grants must not be named: %q", row.Detail)
	}
	if row.Fix == "" {
		t.Error("a warning row must carry a fix hint")
	}
}

func TestCheckMCPDeprecatedGrants_OKWhenNoGrantIsDeprecated(t *testing.T) {
	deps := doctorDeps{
		StageGrants: []stageGrant{{Role: "implementer", Tools: []string{"mcp__valaris__get_card"}}},
		ServedMCP:   servedWithDeprecatedClaimCard(),
	}
	row, found := checkMCPDeprecatedGrants(deps)
	if !found || row.State != tui.StateOK {
		t.Fatalf("row = %+v found=%v, want an OK row", row, found)
	}
}

func TestCheckMCPDeprecatedGrants_AbsentWhenTheServerWasNotProbed(t *testing.T) {
	deps := doctorDeps{
		StageGrants: []stageGrant{{Role: "implementer", Tools: []string{"mcp__valaris__claim_card"}}},
	}
	if _, found := checkMCPDeprecatedGrants(deps); found {
		t.Error("an unprobed server says nothing about deprecations — no row")
	}
}

func TestRunChecks_IncludesTheDeprecatedGrantsRowWhenProbed(t *testing.T) {
	deps := mcpProbeDeps(t, "")
	deps.StageGrants = []stageGrant{{Role: "implementer", Tools: []string{"mcp__valaris__claim_card"}}}
	deps.ServedMCP = servedWithDeprecatedClaimCard()

	row := detailFor(t, runChecks(deps), mcpDeprecatedGrantsLabel)
	if row.State != tui.StateWarn {
		t.Errorf("state = %v, want WARN", row.State)
	}
}
