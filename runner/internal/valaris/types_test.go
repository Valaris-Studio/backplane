// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/harness"
)

func TestWorkspaceConfigData_WithPipelineConfig(t *testing.T) {
	data := `{
		"max_rework_attempts": 3,
		"pipeline_config": {
			"version": 1,
			"stages": [
				{
					"role": "orchestrator",
					"discover": {"strategy": "unassigned_or_rework", "column_type": "backlog"},
					"claim": {"participant_role": "hero", "execution_action": "implement_card"},
					"git": {"action": "create_branch", "create_pr": true},
					"llm": {"enabled": true, "stage": "implement", "tools": ["read_file", "write_file"]},
					"on_success": {"move_to_column_type": "review", "wake_roles": ["reviewer"]},
					"on_failure": {"stay_in_column": true, "unassign": true}
				}
			],
			"scheduling": {
				"priority_order": ["orchestrator", "reviewer"],
				"max_consecutive": 3,
				"starvation_prevention": true
			}
		}
	}`

	var cfg WorkspaceConfigData
	if err := json.Unmarshal([]byte(data), &cfg); err != nil {
		t.Fatalf("unmarshal with pipeline_config: %v", err)
	}
	if cfg.PipelineConfig == nil {
		t.Fatal("PipelineConfig should not be nil")
	}
	if cfg.PipelineConfig.Version != 1 {
		t.Errorf("pipeline version = %d, want 1", cfg.PipelineConfig.Version)
	}
	if len(cfg.PipelineConfig.Stages) != 1 {
		t.Errorf("stages = %d, want 1", len(cfg.PipelineConfig.Stages))
	}

	stage := cfg.PipelineConfig.Stages[0]
	if stage.Role != "orchestrator" {
		t.Errorf("role = %q, want orchestrator", stage.Role)
	}
	if stage.Discover.Strategy != "unassigned_or_rework" {
		t.Errorf("discover.strategy = %q, want unassigned_or_rework", stage.Discover.Strategy)
	}
	if stage.Discover.ColumnType != "backlog" {
		t.Errorf("discover.column_type = %q, want backlog", stage.Discover.ColumnType)
	}
	if stage.Claim.ParticipantRole != "hero" {
		t.Errorf("claim.participant_role = %q, want hero", stage.Claim.ParticipantRole)
	}
	if !stage.Git.CreatePR {
		t.Error("git.create_pr should be true")
	}
	if !stage.LLM.Enabled {
		t.Error("llm.enabled should be true")
	}
	if len(stage.LLM.Tools) != 2 {
		t.Errorf("llm.tools = %d, want 2", len(stage.LLM.Tools))
	}
	if stage.OnSuccess.MoveToColumnType != "review" {
		t.Errorf("on_success.move_to_column_type = %q, want review", stage.OnSuccess.MoveToColumnType)
	}
	if len(stage.OnSuccess.WakeRoles) != 1 || stage.OnSuccess.WakeRoles[0] != "reviewer" {
		t.Errorf("on_success.wake_roles = %v, want [reviewer]", stage.OnSuccess.WakeRoles)
	}
	if !stage.OnFailure.StayInColumn {
		t.Error("on_failure.stay_in_column should be true")
	}

	sched := cfg.PipelineConfig.Scheduling
	if len(sched.PriorityOrder) != 2 {
		t.Errorf("scheduling.priority_order = %d, want 2", len(sched.PriorityOrder))
	}
	if sched.MaxConsecutive != 3 {
		t.Errorf("scheduling.max_consecutive = %d, want 3", sched.MaxConsecutive)
	}
	if !sched.StarvationPrevention {
		t.Error("scheduling.starvation_prevention should be true")
	}
}

func TestWorkspaceConfigData_WithoutPipelineConfig(t *testing.T) {
	data := `{"max_rework_attempts": 3, "version": 1}`

	var cfg WorkspaceConfigData
	if err := json.Unmarshal([]byte(data), &cfg); err != nil {
		t.Fatalf("unmarshal without pipeline_config: %v", err)
	}
	if cfg.PipelineConfig != nil {
		t.Error("PipelineConfig should be nil when absent")
	}
	if cfg.MaxReworkAttempts != 3 {
		t.Errorf("max_rework_attempts = %d, want 3", cfg.MaxReworkAttempts)
	}
	if cfg.Version != 1 {
		t.Errorf("version = %d, want 1", cfg.Version)
	}
}

func TestWorkspaceConfigData_NullPipelineConfig(t *testing.T) {
	data := `{"max_rework_attempts": 2, "pipeline_config": null}`

	var cfg WorkspaceConfigData
	if err := json.Unmarshal([]byte(data), &cfg); err != nil {
		t.Fatalf("unmarshal with null pipeline_config: %v", err)
	}
	if cfg.PipelineConfig != nil {
		t.Error("PipelineConfig should be nil when explicitly null")
	}
	if cfg.MaxReworkAttempts != 2 {
		t.Errorf("max_rework_attempts = %d, want 2", cfg.MaxReworkAttempts)
	}
}

func TestActionDef_ConditionalBranches(t *testing.T) {
	data := `{
		"conditional": true,
		"branches": {
			"approve": {"move_to_column_type": "done", "add_label": "approved"},
			"request_changes": {"move_to_column_type": "backlog", "create_review_note": true}
		}
	}`

	var action ActionDef
	if err := json.Unmarshal([]byte(data), &action); err != nil {
		t.Fatalf("unmarshal conditional action: %v", err)
	}
	if !action.Conditional {
		t.Error("conditional should be true")
	}
	if len(action.Branches) != 2 {
		t.Fatalf("branches = %d, want 2", len(action.Branches))
	}
	approve, ok := action.Branches["approve"]
	if !ok {
		t.Fatal("missing 'approve' branch")
	}
	if approve.MoveToColumnType != "done" {
		t.Errorf("approve.move_to_column_type = %q, want done", approve.MoveToColumnType)
	}
	if approve.AddLabel != "approved" {
		t.Errorf("approve.add_label = %q, want approved", approve.AddLabel)
	}
	changes := action.Branches["request_changes"]
	if !changes.CreateReviewNote {
		t.Error("request_changes.create_review_note should be true")
	}
}

func TestPipelineConfig_RoundTrip(t *testing.T) {
	original := PipelineConfig{
		Version: 2,
		Stages: []StageConfig{
			{
				Role: "implementor",
				Discover: DiscoverDef{
					Strategy:   "unassigned_or_rework",
					ColumnType: "backlog",
					Filters:    map[string]any{"require_git_repo": true},
				},
				Claim: ClaimDef{ParticipantRole: "hero", ExecutionAction: "implement_card"},
				Git:   GitDef{Action: "create_branch", CreatePR: true},
				LLM:   LLMDef{Enabled: true, Stage: "implement"},
				Sensors: []SensorDef{
					{Name: "go-test", Config: map[string]any{"timeout": "30s"}},
				},
				OnSuccess: ActionDef{MoveToColumnType: "review"},
				OnFailure: ActionDef{StayInColumn: true},
			},
		},
		Scheduling: SchedulingDef{
			PriorityOrder:        []string{"implementor"},
			MaxConsecutive:       5,
			StarvationPrevention: false,
		},
	}

	encoded, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded PipelineConfig
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if decoded.Version != original.Version {
		t.Errorf("version = %d, want %d", decoded.Version, original.Version)
	}
	if len(decoded.Stages) != 1 {
		t.Fatalf("stages = %d, want 1", len(decoded.Stages))
	}
	if decoded.Stages[0].Sensors[0].Name != "go-test" {
		t.Errorf("sensor name = %q, want go-test", decoded.Stages[0].Sensors[0].Name)
	}
	if decoded.Scheduling.MaxConsecutive != 5 {
		t.Errorf("max_consecutive = %d, want 5", decoded.Scheduling.MaxConsecutive)
	}
}

// T0.4: previously this test asserted that empty SensorCatalog was OMITTED
// (via `omitempty`). That was wrong for the same reason it's wrong for
// ConfigErrors — once a non-empty value was reported, omitempty made the
// field vanish on subsequent heartbeats, and the backend's "missing field =
// don't update" logic meant stale values persisted forever. All three
// fields (ConfigErrors, BlockedCards, SensorCatalog) now always serialize,
// so an empty slice round-trips as "[]" and clears backend state.
//
// NewHealthReport is the factory that guarantees non-nil slices; production
// code paths (Collector.Report, Loop.pollCycle) use it.
func TestHealthReport_EmptyCollectionsSerializeAsJSONArrays(t *testing.T) {
	report := NewHealthReport()
	data, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	payload := string(data)
	for _, field := range []string{"config_errors", "blocked_cards", "sensor_catalog"} {
		if !strings.Contains(payload, `"`+field+`":[]`) {
			t.Errorf(
				"field %q must serialize as `[]` (not omitted) so backend can "+
					"clear stale state on clean heartbeats. Payload: %s",
				field, payload,
			)
		}
	}
}

func TestBoard_UnmarshalSlug(t *testing.T) {
	data := `{"id": "b-1", "workspace_id": "ws-1", "name": "My Board", "slug": "my-board"}`

	var board Board
	if err := json.Unmarshal([]byte(data), &board); err != nil {
		t.Fatalf("unmarshal board: %v", err)
	}
	if board.Slug != "my-board" {
		t.Errorf("slug = %q, want my-board", board.Slug)
	}
	if board.ID != "b-1" {
		t.Errorf("id = %q, want b-1", board.ID)
	}
	if board.Name != "My Board" {
		t.Errorf("name = %q, want My Board", board.Name)
	}
}

func TestGitRepo_UnmarshalSlug(t *testing.T) {
	data := `{"id": "r-1", "name": "repo", "url": "https://example/r", "default_branch": "main", "slug": "my-repo"}`

	var repo GitRepo
	if err := json.Unmarshal([]byte(data), &repo); err != nil {
		t.Fatalf("unmarshal git repo: %v", err)
	}
	if repo.Slug != "my-repo" {
		t.Errorf("slug = %q, want my-repo", repo.Slug)
	}
	if repo.ID != "r-1" {
		t.Errorf("id = %q, want r-1", repo.ID)
	}
	if repo.DefaultBranch != "main" {
		t.Errorf("default_branch = %q, want main", repo.DefaultBranch)
	}
}

func TestGitRepo_UnmarshalProviderAndProtection(t *testing.T) {
	data := `{
		"id": "r-2",
		"name": "repo",
		"url": "https://github.com/org/r",
		"default_branch": "main",
		"slug": "repo",
		"provider": "github",
		"require_branch_protection": true
	}`

	var repo GitRepo
	if err := json.Unmarshal([]byte(data), &repo); err != nil {
		t.Fatalf("unmarshal git repo: %v", err)
	}
	if repo.Provider != "github" {
		t.Errorf("provider = %q, want github", repo.Provider)
	}
	if !repo.RequireBranchProtection {
		t.Error("require_branch_protection = false, want true")
	}
}

func TestPlatformConfig_UnmarshalTeamRoles(t *testing.T) {
	data := `{
		"agent_id": "a-1",
		"name": "agent",
		"agent_type": "coding",
		"is_active": true,
		"max_requests_per_minute": 60,
		"spent_usd": 0.0,
		"budget_exceeded": false,
		"team_role": "researcher",
		"team_roles": ["researcher", "planner"]
	}`

	var cfg PlatformConfig
	if err := json.Unmarshal([]byte(data), &cfg); err != nil {
		t.Fatalf("unmarshal platform config: %v", err)
	}
	if cfg.TeamRole == nil || *cfg.TeamRole != "researcher" {
		t.Errorf("team_role = %v, want researcher", cfg.TeamRole)
	}
	if len(cfg.TeamRoles) != 2 {
		t.Fatalf("team_roles len = %d, want 2", len(cfg.TeamRoles))
	}
	if cfg.TeamRoles[0] != "researcher" || cfg.TeamRoles[1] != "planner" {
		t.Errorf("team_roles = %v, want [researcher planner]", cfg.TeamRoles)
	}
}

func TestHealthReport_SensorCatalogRoundTrip(t *testing.T) {
	report := &HealthReport{
		SensorCatalog: []harness.SensorManifestEntry{
			{
				Name:          "go-test",
				Kind:          harness.SensorKindComputational,
				DefaultConfig: map[string]any{"packages": "./..."},
				Description:   "Runs tests",
			},
		},
	}
	data, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(data), `"sensor_catalog"`) {
		t.Errorf("expected sensor_catalog field, got: %s", data)
	}

	var decoded HealthReport
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(decoded.SensorCatalog) != 1 {
		t.Fatalf("catalog len = %d, want 1", len(decoded.SensorCatalog))
	}
	if decoded.SensorCatalog[0].Name != "go-test" {
		t.Errorf("name = %q, want go-test", decoded.SensorCatalog[0].Name)
	}
	if decoded.SensorCatalog[0].Kind != "computational" {
		t.Errorf("kind = %q, want computational", decoded.SensorCatalog[0].Kind)
	}
}
