// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"encoding/json"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

func TestDefaultPipelineConfig_HasThreeStages(t *testing.T) {
	if len(DefaultPipelineConfig.Stages) != 3 {
		t.Fatalf("stages = %d, want 3", len(DefaultPipelineConfig.Stages))
	}
	roles := make(map[string]bool)
	for _, s := range DefaultPipelineConfig.Stages {
		roles[s.Role] = true
	}
	for _, expected := range []string{"orchestrator", "reviewer", "documentator"} {
		if !roles[expected] {
			t.Errorf("missing role %q in default pipeline", expected)
		}
	}
}

func TestDefaultPipelineConfig_OrchestratorTools(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "orchestrator")
	if stage == nil {
		t.Fatal("orchestrator stage not found")
	}
	want := []string{
		"mcp__valaris__get_card",
		"mcp__valaris__get_project_context",
		"mcp__valaris__log_execution_update",
		"mcp__valaris__request_approval",
	}
	if len(stage.LLM.Tools) != len(want) {
		t.Fatalf("orchestrator tools = %d, want %d", len(stage.LLM.Tools), len(want))
	}
	for i, tool := range want {
		if stage.LLM.Tools[i] != tool {
			t.Errorf("tool[%d] = %q, want %q", i, stage.LLM.Tools[i], tool)
		}
	}
}

func TestDefaultPipelineConfig_ReviewerConditional(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "reviewer")
	if stage == nil {
		t.Fatal("reviewer stage not found")
	}
	if !stage.OnSuccess.Conditional {
		t.Error("reviewer on_success should be conditional")
	}
	approve, ok := stage.OnSuccess.Branches["approve"]
	if !ok {
		t.Fatal("missing approve branch")
	}
	if approve.MoveToColumnType != "done" {
		t.Errorf("approve move = %q, want done", approve.MoveToColumnType)
	}
	if len(approve.WakeRoles) != 1 || approve.WakeRoles[0] != "documentator" {
		t.Errorf("approve wake = %v, want [documentator]", approve.WakeRoles)
	}

	reject, ok := stage.OnSuccess.Branches["request_changes"]
	if !ok {
		t.Fatal("missing request_changes branch")
	}
	if reject.MoveToColumnType != "active" {
		t.Errorf("reject move = %q, want active", reject.MoveToColumnType)
	}
	if reject.AppendLearning {
		t.Error("reject should NOT append learning by default (card 3c671415)")
	}
}

func TestDefaultPipelineConfig_DocumentatorFailure(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "documentator")
	if stage == nil {
		t.Fatal("documentator stage not found")
	}
	if !stage.OnFailure.StayInColumn {
		t.Error("documentator failure should stay in column (not move to backlog)")
	}
	if stage.OnSuccess.AddLabel != "documented" {
		t.Errorf("documentator success label = %q, want documented", stage.OnSuccess.AddLabel)
	}
}

func TestDefaultPipelineConfig_SchedulingOrder(t *testing.T) {
	want := []string{"reviewer", "orchestrator", "documentator"}
	got := DefaultPipelineConfig.Scheduling.PriorityOrder
	if len(got) != len(want) {
		t.Fatalf("priority order len = %d, want %d", len(got), len(want))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("priority[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestPipelineConfigForAgent_NilPanics(t *testing.T) {
	// Platform authority: Loop.New refuses to start without a platform
	// pipeline_config, so a nil reaching PipelineConfigForAgent at runtime
	// means an upstream invariant was violated. Panic surfaces the bug at
	// the boundary that broke it instead of papering it over with a default.
	defer func() {
		if r := recover(); r == nil {
			t.Fatal("expected panic when PipelineConfig is nil")
		}
	}()
	PipelineConfigForAgent(valaris.WorkspaceConfigData{MaxReworkAttempts: 3})
}

func TestPipelineConfigForAgent_CustomOverridesDefault(t *testing.T) {
	custom := &valaris.PipelineConfig{
		Version: 2,
		Stages:  []valaris.StageConfig{{Role: "custom-role"}},
	}
	cfg := valaris.WorkspaceConfigData{PipelineConfig: custom}
	result := PipelineConfigForAgent(cfg)
	if len(result.Stages) != 1 {
		t.Fatalf("custom pipeline should have 1 stage, got %d", len(result.Stages))
	}
	if result.Stages[0].Role != "custom-role" {
		t.Errorf("role = %q, want custom-role", result.Stages[0].Role)
	}
}

func TestStageForRole_Found(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "reviewer")
	if stage == nil {
		t.Fatal("reviewer should be found")
	}
	if stage.Role != "reviewer" {
		t.Errorf("role = %q, want reviewer", stage.Role)
	}
}

func TestStageForRole_NotFound(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "nonexistent")
	if stage != nil {
		t.Error("nonexistent role should return nil")
	}
}

func TestDefaultPipelineConfig_JSONRoundTrip(t *testing.T) {
	data, err := json.Marshal(DefaultPipelineConfig)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var parsed valaris.PipelineConfig
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(parsed.Stages) != 3 {
		t.Errorf("round-trip stages = %d, want 3", len(parsed.Stages))
	}
	if parsed.Scheduling.PriorityOrder[0] != "reviewer" {
		t.Errorf("round-trip priority[0] = %q, want reviewer", parsed.Scheduling.PriorityOrder[0])
	}
}
