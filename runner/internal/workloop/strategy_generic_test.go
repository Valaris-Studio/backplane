// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/harness"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// fakeSensor is a configurable sensor for decision-routing tests.
type fakeSensor struct {
	name   string
	passed bool
	findings []harness.Finding
	summary  string
	evalErr  error
}

func (f *fakeSensor) Name() string              { return f.name }
func (f *fakeSensor) Kind() harness.SensorKind  { return harness.Computational }
func (f *fakeSensor) Evaluate(_ context.Context, _ harness.SensorInput) (*harness.SensorResult, error) {
	if f.evalErr != nil {
		return nil, f.evalErr
	}
	return &harness.SensorResult{
		Passed:   f.passed,
		Findings: f.findings,
		Summary:  f.summary,
	}, nil
}

// fakeRegistry returns a SensorRegistry pre-populated with the given sensors keyed by name.
func fakeRegistry(sensors ...*fakeSensor) *harness.SensorRegistry {
	r := harness.NewSensorRegistry()
	for _, s := range sensors {
		s := s
		r.Register(s.name, func(_ map[string]any) (harness.Sensor, error) { return s, nil })
	}
	return r
}

func TestNewDataDrivenStrategy_Name(t *testing.T) {
	tests := []struct {
		role string
	}{
		{"orchestrator"},
		{"reviewer"},
		{"documentator"},
		{"tester"},
		{"secretary"},
	}
	for _, tt := range tests {
		cfg := valaris.StageConfig{Role: tt.role}
		s := NewDataDrivenStrategy(cfg, nil)
		if s.Name() != tt.role {
			t.Errorf("Name() = %q, want %q", s.Name(), tt.role)
		}
	}
}

func TestNewDataDrivenStrategy_AllowedTools(t *testing.T) {
	tools := []string{"tool_a", "tool_b"}
	cfg := valaris.StageConfig{
		LLM: valaris.LLMDef{Tools: tools},
	}
	s := NewDataDrivenStrategy(cfg, nil)
	got := s.AllowedTools()
	if len(got) != len(tools) {
		t.Fatalf("AllowedTools() len = %d, want %d", len(got), len(tools))
	}
	for i, tool := range tools {
		if got[i] != tool {
			t.Errorf("AllowedTools()[%d] = %q, want %q", i, got[i], tool)
		}
	}
}

func TestNewDataDrivenStrategy_DefaultToolsNotEmpty(t *testing.T) {
	for _, role := range []string{"orchestrator", "reviewer", "documentator"} {
		stage := StageForRole(DefaultPipelineConfig, role)
		if stage == nil {
			t.Fatalf("no default stage for %s", role)
		}
		dds := NewDataDrivenStrategy(*stage, nil)
		if len(dds.AllowedTools()) == 0 {
			t.Errorf("%s: AllowedTools() should not be empty", role)
		}
	}
}

func TestBuildStrategies_DataDrivenForKnownRoles(t *testing.T) {
	roles := []string{"orchestrator", "reviewer", "documentator"}
	strategies := buildStrategies(roles, DefaultPipelineConfig, nil)

	if len(strategies) != 3 {
		t.Fatalf("strategies count = %d, want 3", len(strategies))
	}

	for _, role := range roles {
		s, ok := strategies[role]
		if !ok {
			t.Errorf("missing strategy for %s", role)
			continue
		}
		if _, isDDS := s.(*DataDrivenStrategy); !isDDS {
			t.Errorf("%s strategy is %T, want *DataDrivenStrategy", role, s)
		}
		if s.Name() != role {
			t.Errorf("%s strategy Name() = %q", role, s.Name())
		}
	}
}

func TestBuildStrategies_UnknownRole_CreatesMinimalStrategy(t *testing.T) {
	roles := []string{"unknown_role"}
	strategies := buildStrategies(roles, DefaultPipelineConfig, nil)

	s, ok := strategies["unknown_role"]
	if !ok {
		t.Fatal("missing strategy for unknown_role")
	}

	if _, isDDS := s.(*DataDrivenStrategy); !isDDS {
		t.Errorf("unknown_role strategy is %T, want *DataDrivenStrategy", s)
	}
	if s.Name() != "unknown_role" {
		t.Errorf("unknown_role Name() = %q", s.Name())
	}
}

func TestBuildStrategies_MixedKnownAndUnknown(t *testing.T) {
	roles := []string{"orchestrator", "my_custom_role"}
	strategies := buildStrategies(roles, DefaultPipelineConfig, nil)

	if _, isDDS := strategies["orchestrator"].(*DataDrivenStrategy); !isDDS {
		t.Error("orchestrator should be DataDrivenStrategy")
	}

	if _, isDDS := strategies["my_custom_role"].(*DataDrivenStrategy); !isDDS {
		t.Error("my_custom_role should be DataDrivenStrategy (minimal)")
	}
	if strategies["my_custom_role"].Name() != "my_custom_role" {
		t.Error("my_custom_role should preserve role name")
	}
}

func TestBuildStrategies_CustomPipelineConfig(t *testing.T) {
	customPipeline := valaris.PipelineConfig{
		Version: 2,
		Stages: []valaris.StageConfig{
			{
				Role: "tester",
				LLM:  valaris.LLMDef{Tools: []string{"run_tests"}},
			},
		},
	}
	strategies := buildStrategies([]string{"tester"}, customPipeline, nil)

	s, ok := strategies["tester"]
	if !ok {
		t.Fatal("missing strategy for tester")
	}
	if _, isDDS := s.(*DataDrivenStrategy); !isDDS {
		t.Errorf("tester is %T, want *DataDrivenStrategy", s)
	}
	tools := s.AllowedTools()
	if len(tools) != 1 || tools[0] != "run_tests" {
		t.Errorf("tester tools = %v, want [run_tests]", tools)
	}
}

func TestNewStrategyFromConfig_ImplementsInterface(t *testing.T) {
	cfg := valaris.StageConfig{Role: "test", LLM: valaris.LLMDef{Tools: []string{"t1"}}}
	var s Strategy = NewStrategyFromConfig(cfg, nil)
	if s.Name() != "test" {
		t.Errorf("Name() = %q, want test", s.Name())
	}
}

func TestDataDrivenStrategy_DiscoverStrategies(t *testing.T) {
	// Test that the strategy correctly identifies its discover strategy type.
	tests := []struct {
		role     string
		strategy string
	}{
		{"orchestrator", "unassigned_or_rework"},
		{"reviewer", "column_scan"},
		{"documentator", "column_scan"},
	}
	for _, tt := range tests {
		stage := StageForRole(DefaultPipelineConfig, tt.role)
		if stage == nil {
			t.Fatalf("no default stage for %s", tt.role)
		}
		if stage.Discover.Strategy != tt.strategy {
			t.Errorf("%s discover strategy = %q, want %q", tt.role, stage.Discover.Strategy, tt.strategy)
		}
	}
}

func TestDataDrivenStrategy_OrchestratorClaimIsHero(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "orchestrator")
	if stage == nil {
		t.Fatal("missing orchestrator stage")
	}
	if stage.Claim.ParticipantRole != "hero" {
		t.Errorf("orchestrator claim role = %q, want hero", stage.Claim.ParticipantRole)
	}
}

func TestDataDrivenStrategy_ReviewerClaimIsHelper(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "reviewer")
	if stage == nil {
		t.Fatal("missing reviewer stage")
	}
	if stage.Claim.ParticipantRole != "helper" {
		t.Errorf("reviewer claim role = %q, want helper", stage.Claim.ParticipantRole)
	}
}

func TestDataDrivenStrategy_DocumentatorClaimIsHelper(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "documentator")
	if stage == nil {
		t.Fatal("missing documentator stage")
	}
	if stage.Claim.ParticipantRole != "helper" {
		t.Errorf("documentator claim role = %q, want helper", stage.Claim.ParticipantRole)
	}
}

func TestDataDrivenStrategy_GitActions(t *testing.T) {
	tests := []struct {
		role   string
		action string
	}{
		{"orchestrator", "create_branch"},
		{"reviewer", "checkout_pr_branch"},
		{"documentator", "create_branch"},
	}
	for _, tt := range tests {
		stage := StageForRole(DefaultPipelineConfig, tt.role)
		if stage == nil {
			t.Fatalf("missing %s stage", tt.role)
		}
		if stage.Git.Action != tt.action {
			t.Errorf("%s git action = %q, want %q", tt.role, stage.Git.Action, tt.action)
		}
	}
}

func TestDataDrivenStrategy_OrchestratorGitCreatesPR(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "orchestrator")
	if !stage.Git.CreatePR {
		t.Error("orchestrator should create PRs")
	}
	if !stage.Git.ForcePushOnRework {
		t.Error("orchestrator should force-push on rework")
	}
}

func TestDataDrivenStrategy_DocumentatorBranchPrefix(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "documentator")
	if stage.Git.BranchPrefix != "docs-" {
		t.Errorf("documentator branch prefix = %q, want docs-", stage.Git.BranchPrefix)
	}
}

func TestDataDrivenStrategy_OrchestratorOnSuccessWakesReviewer(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "orchestrator")
	if len(stage.OnSuccess.WakeRoles) != 1 || stage.OnSuccess.WakeRoles[0] != "reviewer" {
		t.Errorf("orchestrator on_success wake = %v, want [reviewer]", stage.OnSuccess.WakeRoles)
	}
}

func TestDataDrivenStrategy_OrchestratorOnFailureMovesToBacklog(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "orchestrator")
	if stage.OnFailure.MoveToColumnType != "backlog" {
		t.Errorf("orchestrator on_failure move = %q, want backlog", stage.OnFailure.MoveToColumnType)
	}
	if !stage.OnFailure.Unassign {
		t.Error("orchestrator on_failure should unassign")
	}
}

func TestDataDrivenStrategy_ReviewerConditionalBranches(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "reviewer")
	if !stage.OnSuccess.Conditional {
		t.Fatal("reviewer on_success should be conditional")
	}

	approve := stage.OnSuccess.Branches["approve"]
	if approve.MoveToColumnType != "done" {
		t.Errorf("approve move = %q, want done", approve.MoveToColumnType)
	}
	if !approve.CleanupReviewNotes {
		t.Error("approve should cleanup review notes")
	}
	if len(approve.WakeRoles) != 1 || approve.WakeRoles[0] != "documentator" {
		t.Errorf("approve wake = %v, want [documentator]", approve.WakeRoles)
	}

	reject := stage.OnSuccess.Branches["request_changes"]
	if reject.MoveToColumnType != "active" {
		t.Errorf("reject move = %q, want active", reject.MoveToColumnType)
	}
	if !reject.CreateReviewNote {
		t.Error("reject should create review note")
	}
	if reject.AppendLearning {
		t.Error("reject should NOT append learning by default (card 3c671415)")
	}
	if !reject.UnassignSelf {
		t.Error("reject should unassign self")
	}
	if len(reject.WakeRoles) != 1 || reject.WakeRoles[0] != "orchestrator" {
		t.Errorf("reject wake = %v, want [orchestrator]", reject.WakeRoles)
	}
}

func TestDataDrivenStrategy_DocumentatorOnFailureStaysInColumn(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "documentator")
	if !stage.OnFailure.StayInColumn {
		t.Error("documentator on_failure should stay in column")
	}
	if !stage.OnFailure.Unassign {
		t.Error("documentator on_failure should unassign")
	}
}

func TestDataDrivenStrategy_LLMStages(t *testing.T) {
	tests := []struct {
		role  string
		stage string
	}{
		{"orchestrator", "implement"},
		{"reviewer", "review"},
		{"documentator", "document"},
	}
	for _, tt := range tests {
		stage := StageForRole(DefaultPipelineConfig, tt.role)
		if stage.LLM.Stage != tt.stage {
			t.Errorf("%s LLM stage = %q, want %q", tt.role, stage.LLM.Stage, tt.stage)
		}
		if !stage.LLM.Enabled {
			t.Errorf("%s LLM should be enabled", tt.role)
		}
	}
}

func TestDataDrivenStrategy_OrchestratorApprovalEnabled(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "orchestrator")
	if !stage.LLM.ApprovalEnabled {
		t.Error("orchestrator should have approval enabled")
	}
}

func TestDataDrivenStrategy_ReviewerApprovalDisabled(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "reviewer")
	if stage.LLM.ApprovalEnabled {
		t.Error("reviewer should not have approval enabled")
	}
}

func TestDataDrivenStrategy_OrchestratorDirectivesEnabled(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "orchestrator")
	if !stage.LLM.InjectDirectives {
		t.Error("orchestrator should inject directives")
	}
}

func TestDataDrivenStrategy_ReviewerDiscoverFilters(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "reviewer")
	filters := stage.Discover.Filters

	if v, _ := filters["require_pr_url"].(bool); !v {
		t.Error("reviewer discover should require PR URL")
	}
	if v, _ := filters["skip_if_participant_role"].(string); v != "reviewer" {
		t.Errorf("reviewer discover skip_if_participant_role = %q, want 'reviewer'", v)
	}
	if v, _ := filters["require_git_repo"].(bool); !v {
		t.Error("reviewer discover should require git repo")
	}
}

func TestDataDrivenStrategy_DocumentatorDiscoverFilters(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "documentator")
	filters := stage.Discover.Filters

	if v, _ := filters["exclude_label"].(string); v != "documented" {
		t.Errorf("documentator exclude_label = %q, want documented", v)
	}
	if v, _ := filters["require_git_repo"].(bool); !v {
		t.Error("documentator discover should require git repo")
	}
}

func TestDataDrivenStrategy_NoSensors_SkipsSensorStep(t *testing.T) {
	cfg := valaris.StageConfig{Role: "orchestrator", Sensors: nil}
	s := NewDataDrivenStrategy(cfg, nil)
	if len(s.config.Sensors) != 0 {
		t.Error("orchestrator default should have no sensors")
	}
	if s.sensors != nil {
		t.Error("nil registry should stay nil")
	}
}

func TestDataDrivenStrategy_WithSensors_HasRegistry(t *testing.T) {
	registry := harness.DefaultRegistry()
	cfg := valaris.StageConfig{
		Role:    "tester",
		Sensors: []valaris.SensorDef{{Name: "go-test"}},
	}
	s := NewDataDrivenStrategy(cfg, registry)
	if s.sensors == nil {
		t.Error("strategy should have sensor registry")
	}
	if !s.sensors.Has("go-test") {
		t.Error("registry should contain go-test sensor")
	}
}

func TestDataDrivenStrategy_RunSensors_NilWhenEmpty(t *testing.T) {
	cfg := valaris.StageConfig{Role: "orchestrator"}
	s := NewDataDrivenStrategy(cfg, nil)
	res, err := s.runSensors(nil, nil, &discoverResult{}, "", "")
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if res != nil {
		t.Error("expected nil result for no sensors")
	}
}

func TestDataDrivenStrategy_RunSensors_NilRegistryGraceful(t *testing.T) {
	cfg := valaris.StageConfig{
		Role:    "tester",
		Sensors: []valaris.SensorDef{{Name: "go-test"}},
	}
	s := NewDataDrivenStrategy(cfg, nil)
	res, err := s.runSensors(nil, nil, &discoverResult{}, "", "")
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if res != nil {
		t.Error("expected nil result when registry is nil")
	}
}

func TestDataDrivenStrategy_DefaultRolesHaveNoSensors(t *testing.T) {
	for _, role := range []string{"orchestrator", "reviewer", "documentator"} {
		stage := StageForRole(DefaultPipelineConfig, role)
		if stage == nil {
			t.Fatalf("missing default stage for %s", role)
		}
		if len(stage.Sensors) != 0 {
			t.Errorf("%s should have no sensors in DefaultPipelineConfig, got %d", role, len(stage.Sensors))
		}
	}
}

// --- I.1.d: Sensor decisions feed ActionDef.Branches ---

// Sensor pass with OnPass emits the decision string.
func TestDataDrivenStrategy_RunSensors_OnPass_ProducesDecision(t *testing.T) {
	registry := fakeRegistry(&fakeSensor{name: "pass-sensor", passed: true, summary: "ok"})
	cfg := valaris.StageConfig{
		Role: "tester",
		Sensors: []valaris.SensorDef{
			{Name: "pass-sensor", OnPass: "pass", OnFail: "fail"},
		},
	}
	s := NewDataDrivenStrategy(cfg, registry)

	res, err := s.runSensors(context.Background(), nil, &discoverResult{}, "exec", "/tmp")
	if err != nil {
		t.Fatalf("runSensors: %v", err)
	}
	if res == nil {
		t.Fatal("expected non-nil sensorResults")
	}
	if !res.allPassed {
		t.Error("expected allPassed=true")
	}
	if res.decision != "pass" {
		t.Errorf("decision = %q, want %q", res.decision, "pass")
	}
}

// Sensor fail with OnFail emits the fail decision.
func TestDataDrivenStrategy_RunSensors_OnFail_ProducesDecision(t *testing.T) {
	registry := fakeRegistry(&fakeSensor{
		name:    "fail-sensor",
		passed:  false,
		summary: "2 tests failed",
		findings: []harness.Finding{
			{Severity: "error", Message: "TestFoo failed", Rule: "go-test/fail"},
		},
	})
	cfg := valaris.StageConfig{
		Role: "tester",
		Sensors: []valaris.SensorDef{
			{Name: "fail-sensor", OnPass: "pass", OnFail: "fail"},
		},
	}
	s := NewDataDrivenStrategy(cfg, registry)

	res, err := s.runSensors(context.Background(), nil, &discoverResult{}, "exec", "/tmp")
	if err != nil {
		t.Fatalf("runSensors: %v", err)
	}
	if res == nil {
		t.Fatal("expected non-nil sensorResults")
	}
	if res.allPassed {
		t.Error("expected allPassed=false")
	}
	if res.decision != "fail" {
		t.Errorf("decision = %q, want %q", res.decision, "fail")
	}
}

// Multiple sensors: first failure's OnFail wins (later sensors don't overwrite the decision).
func TestDataDrivenStrategy_RunSensors_FirstFailureWins(t *testing.T) {
	registry := fakeRegistry(
		&fakeSensor{name: "a", passed: true, summary: "a ok"},
		&fakeSensor{name: "b", passed: false, summary: "b broke"},
		&fakeSensor{name: "c", passed: false, summary: "c broke too"},
	)
	cfg := valaris.StageConfig{
		Role: "tester",
		Sensors: []valaris.SensorDef{
			{Name: "a", OnPass: "pass", OnFail: "fail-a"},
			{Name: "b", OnPass: "pass", OnFail: "fail-b"},
			{Name: "c", OnPass: "pass", OnFail: "fail-c"},
		},
	}
	s := NewDataDrivenStrategy(cfg, registry)

	res, err := s.runSensors(context.Background(), nil, &discoverResult{}, "exec", "/tmp")
	if err != nil {
		t.Fatalf("runSensors: %v", err)
	}
	if res.allPassed {
		t.Error("expected allPassed=false")
	}
	if res.decision != "fail-b" {
		t.Errorf("decision = %q, want %q (first failing sensor)", res.decision, "fail-b")
	}
}

// All sensors pass: decision is the last sensor's OnPass.
func TestDataDrivenStrategy_RunSensors_AllPass_LastOnPassWins(t *testing.T) {
	registry := fakeRegistry(
		&fakeSensor{name: "a", passed: true, summary: "a"},
		&fakeSensor{name: "b", passed: true, summary: "b"},
	)
	cfg := valaris.StageConfig{
		Role: "tester",
		Sensors: []valaris.SensorDef{
			{Name: "a", OnPass: "pass-a", OnFail: "fail-a"},
			{Name: "b", OnPass: "pass-b", OnFail: "fail-b"},
		},
	}
	s := NewDataDrivenStrategy(cfg, registry)

	res, err := s.runSensors(context.Background(), nil, &discoverResult{}, "exec", "/tmp")
	if err != nil {
		t.Fatalf("runSensors: %v", err)
	}
	if !res.allPassed {
		t.Error("expected allPassed=true")
	}
	if res.decision != "pass-b" {
		t.Errorf("decision = %q, want %q (last OnPass)", res.decision, "pass-b")
	}
}

// Empty OnPass/OnFail: decision remains empty (back-compat: aggregated failure path owns routing).
func TestDataDrivenStrategy_RunSensors_EmptyOnPassOnFail_NoDecision(t *testing.T) {
	registry := fakeRegistry(&fakeSensor{name: "legacy", passed: false, summary: "fail"})
	cfg := valaris.StageConfig{
		Role:    "legacy-role",
		Sensors: []valaris.SensorDef{{Name: "legacy"}},
	}
	s := NewDataDrivenStrategy(cfg, registry)

	res, err := s.runSensors(context.Background(), nil, &discoverResult{}, "exec", "/tmp")
	if err != nil {
		t.Fatalf("runSensors: %v", err)
	}
	if res.decision != "" {
		t.Errorf("decision = %q, want empty", res.decision)
	}
	if res.hasFailureMapping {
		t.Error("hasFailureMapping should be false when OnFail is empty")
	}
}

// With OnFail set, sensorResults signals to skip the aggregated failure path (Option A).
func TestDataDrivenStrategy_RunSensors_OnFailSet_SignalsMappedFailure(t *testing.T) {
	registry := fakeRegistry(&fakeSensor{name: "s", passed: false, summary: "x"})
	cfg := valaris.StageConfig{
		Role:    "tester",
		Sensors: []valaris.SensorDef{{Name: "s", OnFail: "fail"}},
	}
	s := NewDataDrivenStrategy(cfg, registry)

	res, err := s.runSensors(context.Background(), nil, &discoverResult{}, "exec", "/tmp")
	if err != nil {
		t.Fatalf("runSensors: %v", err)
	}
	if !res.hasFailureMapping {
		t.Error("hasFailureMapping should be true when any sensor has OnFail")
	}
}

// resolveBranchAction: conditional + decision match -> branch; no match -> original.
func TestResolveBranchAction_ConditionalMatch(t *testing.T) {
	base := valaris.ActionDef{
		Conditional: true,
		Branches: map[string]valaris.ActionDef{
			"pass": {MoveToColumnType: "done", WakeRoles: []string{"reviewer"}},
			"fail": {MoveToColumnType: "active", CreateReviewNote: true},
		},
	}

	got := resolveBranchAction(base, "pass")
	if got.MoveToColumnType != "done" {
		t.Errorf("pass branch MoveToColumnType = %q, want done", got.MoveToColumnType)
	}
	if len(got.WakeRoles) != 1 || got.WakeRoles[0] != "reviewer" {
		t.Errorf("pass branch WakeRoles = %v, want [reviewer]", got.WakeRoles)
	}

	got = resolveBranchAction(base, "fail")
	if got.MoveToColumnType != "active" {
		t.Errorf("fail branch MoveToColumnType = %q, want active", got.MoveToColumnType)
	}
	if !got.CreateReviewNote {
		t.Error("fail branch should set CreateReviewNote")
	}
}

// resolveBranchAction: no decision or non-conditional -> original action.
func TestResolveBranchAction_NoDecisionOrNonConditional(t *testing.T) {
	base := valaris.ActionDef{
		Conditional: true,
		Branches:    map[string]valaris.ActionDef{"pass": {MoveToColumnType: "done"}},
	}

	// Empty decision returns base unchanged.
	got := resolveBranchAction(base, "")
	if got.MoveToColumnType != "" {
		t.Errorf("empty-decision MoveToColumnType = %q, want empty", got.MoveToColumnType)
	}

	// Unknown decision returns base unchanged.
	got = resolveBranchAction(base, "unknown")
	if got.MoveToColumnType != "" {
		t.Errorf("unknown-decision MoveToColumnType = %q, want empty", got.MoveToColumnType)
	}

	// Non-conditional returns base unchanged even with matching decision key.
	nonCond := valaris.ActionDef{
		MoveToColumnType: "review",
		Branches:         map[string]valaris.ActionDef{"pass": {MoveToColumnType: "done"}},
	}
	got = resolveBranchAction(nonCond, "pass")
	if got.MoveToColumnType != "review" {
		t.Errorf("non-conditional MoveToColumnType = %q, want review (unchanged)", got.MoveToColumnType)
	}
}

// deriveDecision: LLM result decision takes precedence over sensor decision.
func TestDeriveDecision_LLMPrecedesSensor(t *testing.T) {
	llm := &llmStageResult{decision: "approve"}
	sensors := &sensorResults{decision: "pass"}

	got := deriveDecision(llm, sensors)
	if got != "approve" {
		t.Errorf("decision = %q, want approve (LLM wins)", got)
	}
}

// deriveDecision: empty LLM decision falls through to sensor decision.
func TestDeriveDecision_SensorFallback(t *testing.T) {
	llm := &llmStageResult{decision: ""}
	sensors := &sensorResults{decision: "fail"}

	got := deriveDecision(llm, sensors)
	if got != "fail" {
		t.Errorf("decision = %q, want fail (sensor fallback)", got)
	}
}

// deriveDecision: nil LLM result (LLM disabled) uses sensor decision.
func TestDeriveDecision_LLMDisabled(t *testing.T) {
	sensors := &sensorResults{decision: "pass"}

	got := deriveDecision(nil, sensors)
	if got != "pass" {
		t.Errorf("decision = %q, want pass (no LLM, sensor only)", got)
	}
}

// deriveDecision: no sources returns empty.
func TestDeriveDecision_NoSources(t *testing.T) {
	got := deriveDecision(nil, nil)
	if got != "" {
		t.Errorf("decision = %q, want empty", got)
	}
}

// Default pipeline config produces no decisions (back-compat).
func TestDeriveDecision_DefaultPipelineNoSensors(t *testing.T) {
	stage := StageForRole(DefaultPipelineConfig, "orchestrator")
	if stage == nil {
		t.Fatal("missing orchestrator stage")
	}
	if len(stage.Sensors) != 0 {
		t.Errorf("orchestrator should have 0 sensors by default, got %d", len(stage.Sensors))
	}
	// LLM implement result has no decision field populated.
	llm := &llmStageResult{}
	got := deriveDecision(llm, nil)
	if got != "" {
		t.Errorf("default orchestrator decision = %q, want empty", got)
	}
}

// Tester-like stage: LLM disabled, sensor pass routes through Branches["pass"] → wake reviewer.
func TestTesterStage_SensorPass_BranchesToWakeReviewer(t *testing.T) {
	testerStage := valaris.StageConfig{
		Role: "tester",
		LLM:  valaris.LLMDef{Enabled: false},
		Sensors: []valaris.SensorDef{
			{Name: "go-test", OnPass: "pass", OnFail: "fail"},
		},
		OnSuccess: valaris.ActionDef{
			Conditional: true,
			Branches: map[string]valaris.ActionDef{
				"pass": {WakeRoles: []string{"reviewer"}},
				"fail": {MoveToColumnType: "active", CreateReviewNote: true},
			},
		},
	}

	sensors := &sensorResults{allPassed: true, decision: "pass"}
	decision := deriveDecision(nil, sensors)
	action := resolveBranchAction(testerStage.OnSuccess, decision)

	if len(action.WakeRoles) != 1 || action.WakeRoles[0] != "reviewer" {
		t.Errorf("WakeRoles = %v, want [reviewer]", action.WakeRoles)
	}
}

// Tester-like stage: LLM disabled, sensor fail routes to Branches["fail"] → move card + review note.
func TestTesterStage_SensorFail_BranchesToActive(t *testing.T) {
	testerStage := valaris.StageConfig{
		Role: "tester",
		LLM:  valaris.LLMDef{Enabled: false},
		Sensors: []valaris.SensorDef{
			{Name: "go-test", OnPass: "pass", OnFail: "fail"},
		},
		OnSuccess: valaris.ActionDef{
			Conditional: true,
			Branches: map[string]valaris.ActionDef{
				"pass": {WakeRoles: []string{"reviewer"}},
				"fail": {MoveToColumnType: "active", CreateReviewNote: true},
			},
		},
	}

	sensors := &sensorResults{allPassed: false, decision: "fail", hasFailureMapping: true}
	decision := deriveDecision(nil, sensors)
	action := resolveBranchAction(testerStage.OnSuccess, decision)

	if action.MoveToColumnType != "active" {
		t.Errorf("MoveToColumnType = %q, want active", action.MoveToColumnType)
	}
	if !action.CreateReviewNote {
		t.Error("fail branch should set CreateReviewNote")
	}
}

// roleCapturingExecutionServer starts an httptest.Server that captures the
// JSON body of POST /executions requests so tests can assert the "role" field
// propagated from the strategy configuration (not a hardcoded string).
func roleCapturingExecutionServer(t *testing.T) (*httptest.Server, func() string) {
	t.Helper()
	var mu sync.Mutex
	var lastExecBody string

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		if strings.Contains(r.URL.Path, "/executions") && r.Method == http.MethodPost {
			body, _ := io.ReadAll(r.Body)
			mu.Lock()
			lastExecBody = string(body)
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "exec-test-role"})
			return
		}
		// ClaimCard, AddCardParticipant, and any other REST calls default to 200.
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)

	return srv, func() string {
		mu.Lock()
		defer mu.Unlock()
		return lastExecBody
	}
}

// Claim propagates the strategy's configured role (not a hardcoded
// "orchestrator") into the executions.role column via LogExecutionStart.
// Exercises the hero path: strategy_generic.claimWithConfig → loop.claim.
func TestClaim_PropagatesStrategyRoleToExecutionStart(t *testing.T) {
	srv, getBody := roleCapturingExecutionServer(t)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	stage := valaris.StageConfig{
		Role: "researcher",
		Claim: valaris.ClaimDef{
			ParticipantRole: "hero",
			ExecutionAction: "research_card",
		},
	}
	s := NewDataDrivenStrategy(stage, nil)

	card := &discoverResult{CardID: "card-r1", BoardID: "board-1", Title: "Investigate login flow"}
	if _, err := s.claimWithConfig(context.Background(), loop, card); err != nil {
		t.Fatalf("claimWithConfig: %v", err)
	}

	body := getBody()
	if body == "" {
		t.Fatal("expected POST /executions to be captured, got empty body")
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatalf("decode executions body: %v (body=%s)", err, body)
	}

	gotRole, _ := payload["role"].(string)
	if gotRole != "researcher" {
		t.Errorf("executions.role = %q, want %q (body=%s)", gotRole, "researcher", body)
	}

	// The reserved card must ride along on execution-start so the backend binds
	// it to cards_affected and agent_presence flips to 'active' immediately —
	// the board no longer waits on the LLM to self-report cards_affected.
	gotCard, _ := payload["card_id"].(string)
	if gotCard != "card-r1" {
		t.Errorf("executions.card_id = %q, want %q (body=%s)", gotCard, "card-r1", body)
	}
}

// shipExecutionCapturingServer captures the JSON body of the PATCH to the
// execution-update endpoint so tests can inspect the payload the ship path
// ultimately sends to platform telemetry.
func shipExecutionCapturingServer(t *testing.T, boardID string) (*httptest.Server, func() string) {
	t.Helper()
	var mu sync.Mutex
	var patchBody string

	columns := []map[string]any{
		{"id": "col-backlog", "name": "To Do", "column_type": "backlog", "position": 1024.0},
		{"id": "col-active", "name": "Active", "column_type": "active", "position": 2048.0},
		{"id": "col-review", "name": "Review", "column_type": "review", "position": 3072.0},
		{"id": "col-done", "name": "Done", "column_type": "done", "position": 4096.0},
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		if strings.Contains(r.URL.Path, "/executions/") && r.Method == http.MethodPatch {
			body, _ := io.ReadAll(r.Body)
			mu.Lock()
			patchBody = string(body)
			mu.Unlock()
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
			return
		}
		if strings.Contains(r.URL.Path, "/boards/"+boardID) &&
			!strings.Contains(r.URL.Path, "/cards") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":      boardID,
				"name":    "Test Board",
				"columns": columns,
			})
			return
		}
		if strings.Contains(r.URL.Path, "/cards/") && r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":          "card-ship",
				"title":       "ShipMe",
				"description": "",
				"labels":      []string{},
			})
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)

	return srv, func() string {
		mu.Lock()
		defer mu.Unlock()
		return patchBody
	}
}

// B16: when the ship stage captures non-fatal warnings (e.g. auto-merge
// arming failed because branch protection is not configured), the warnings
// must be forwarded to the platform in the final execution-update PATCH
// so the frontend can render a "Ship warnings" chip on the execution row.
// Before this fix the warnings lived only in the runner's local slog and
// never travelled to platform telemetry — the ST#16 snake-orchestrator
// failure mode.
func TestShip_ForwardsShipWarningsToExecutionUpdate(t *testing.T) {
	boardID := "board-ship"
	srv, getPatchBody := shipExecutionCapturingServer(t, boardID)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	card := &discoverResult{
		CardID:        "card-ship",
		BoardID:       boardID,
		Title:         "ShipMe",
		DefaultBranch: "main",
	}
	warnings := []string{
		"auto-merge arming failed: Protected branch rules not configured for this branch",
	}

	if err := loop.ship(context.Background(), card, "exec-ship", "runner/card-ship", "https://github.com/org/repo/pull/42", "review", warnings); err != nil {
		t.Fatalf("ship: %v", err)
	}

	body := getPatchBody()
	if body == "" {
		t.Fatal("expected PATCH /executions/<id> to be captured, got empty body")
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatalf("decode PATCH body: %v (body=%s)", err, body)
	}

	got, ok := payload["ship_warnings"].([]any)
	if !ok {
		t.Fatalf("ship_warnings missing or wrong type in PATCH body: %s", body)
	}
	if len(got) != 1 {
		t.Fatalf("ship_warnings length = %d, want 1 (body=%s)", len(got), body)
	}
	if got[0] != warnings[0] {
		t.Errorf("ship_warnings[0] = %q, want %q", got[0], warnings[0])
	}
}

// B16: when there are no warnings, the ship path must NOT include a
// ship_warnings key in the PATCH body — old runners never set it, and
// omitted-equals-null at the storage layer. This keeps the backend's
// three-way distinction (null vs [] vs populated) clean.
func TestShip_OmitsShipWarningsWhenNone(t *testing.T) {
	boardID := "board-ship-clean"
	srv, getPatchBody := shipExecutionCapturingServer(t, boardID)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	card := &discoverResult{
		CardID:        "card-clean",
		BoardID:       boardID,
		Title:         "Clean ship",
		DefaultBranch: "main",
	}

	if err := loop.ship(context.Background(), card, "exec-clean", "runner/card-clean", "https://github.com/org/repo/pull/43", "review", nil); err != nil {
		t.Fatalf("ship: %v", err)
	}

	body := getPatchBody()
	if body == "" {
		t.Fatal("expected PATCH /executions/<id> to be captured, got empty body")
	}
	if strings.Contains(body, "ship_warnings") {
		t.Errorf("PATCH body must omit ship_warnings when none were captured; body=%s", body)
	}
}

// Cluster III: the legacy on-ship auto-merge arming path was removed (runner
// is git-provider-agnostic; merge happens only via the reviewer's merge_pr
// step). The former TestPostAction_CapturesAutoMergeArmingFailureAsShipWarning
// + captureAutoMergeWarning helper asserted that removed behavior and were
// deleted with it.

// ReworkClaim propagates the caller-supplied role into LogExecutionStart so
// rework executions record the pipeline stage's role instead of the hardcoded
// "orchestrator". The live caller (tickRework) passes s.config.Role.
func TestReworkClaim_PropagatesRoleToExecutionStart(t *testing.T) {
	srv, getBody := roleCapturingExecutionServer(t)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	card := &discoverResult{CardID: "card-p1", BoardID: "board-1", Title: "Rework plan"}
	if _, err := loop.reworkClaim(context.Background(), card, "planner"); err != nil {
		t.Fatalf("reworkClaim: %v", err)
	}

	body := getBody()
	if body == "" {
		t.Fatal("expected POST /executions to be captured, got empty body")
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(body), &payload); err != nil {
		t.Fatalf("decode executions body: %v (body=%s)", err, body)
	}

	gotRole, _ := payload["role"].(string)
	if gotRole != "planner" {
		t.Errorf("executions.role = %q, want %q (body=%s)", gotRole, "planner", body)
	}
}

// postActionServer is a recording server that returns 200 for every endpoint
// except the one whose path ends in failingSuffix + method, which returns the
// given HTTP status. Used to inject targeted backend failures into the
// post-action pipeline (e.g. 403 on CreateReviewNote after API-key rotation).
func postActionServer(t *testing.T, boardID, failingSuffix, failingMethod string, failingStatus int) *httptest.Server {
	t.Helper()

	columns := []map[string]any{
		{"id": "col-backlog", "name": "To Do", "column_type": "backlog", "position": 1024.0},
		{"id": "col-active", "name": "Active", "column_type": "active", "position": 2048.0},
		{"id": "col-review", "name": "Review", "column_type": "review", "position": 3072.0},
		{"id": "col-done", "name": "Done", "column_type": "done", "position": 4096.0},
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}

		// Inject failure on the target endpoint.
		if r.Method == failingMethod && strings.HasSuffix(r.URL.Path, failingSuffix) {
			w.WriteHeader(failingStatus)
			_, _ = w.Write([]byte(`{"detail":"forbidden"}`))
			return
		}

		// Board detail — needed by moveCardToColumnType for column_type lookup.
		if strings.Contains(r.URL.Path, "/boards/"+boardID) &&
			!strings.Contains(r.URL.Path, "/cards") &&
			!strings.Contains(r.URL.Path, "/git-repos") &&
			!strings.Contains(r.URL.Path, "/context") &&
			!strings.Contains(r.URL.Path, "/notes") &&
			!strings.Contains(r.URL.Path, "/definition") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":      boardID,
				"name":    "Test Board",
				"columns": columns,
			})
			return
		}

		if strings.Contains(r.URL.Path, "/cards/") && r.Method == http.MethodGet &&
			!strings.Contains(r.URL.Path, "/search") &&
			!strings.Contains(r.URL.Path, "/participants") &&
			!strings.Contains(r.URL.Path, "/review-notes") {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":           "card-1",
				"title":        "Test Card",
				"description":  "",
				"labels":       []string{},
				"participants": []any{},
			})
			return
		}

		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// B19: when a post-action REST call is rejected by the backend (e.g. 403 after
// the operator rotated the runner's API key mid-stage), applyActionFlags must
// surface the error. The tick must fail fast, recordFailure must increment the
// per-card circuit-breaker counter, and "stage completed" must NOT be logged —
// otherwise the next discover tick re-claims the same card and the runner
// loops on it forever (the card 177bfcc5 re-claim regression).
func TestPostAction_BackendRejects_EscalatesAndRecordsFailure(t *testing.T) {
	boardID := "board-b19"
	// Fail the CreateReviewNote POST (the first-wave backend call that would
	// swallow errors pre-B19). "/notes" suffix matches the CreateReviewNote URL.
	srv := postActionServer(t, boardID, "/notes", http.MethodPost, http.StatusForbidden)

	reviewerStage := StageForRole(DefaultPipelineConfig, "reviewer")
	if reviewerStage == nil {
		t.Fatal("missing reviewer stage in default pipeline")
	}
	strategy := NewDataDrivenStrategy(*reviewerStage, nil)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)
	loop.strategy = strategy

	card := &discoverResult{
		CardID:  "card-b19",
		BoardID: boardID,
		Title:   "PR with issues",
	}
	llmResult := &llmStageResult{
		reviewResult: &reviewResult{
			Decision: "request_changes",
			Summary:  "Missing tests",
			Findings: "Add tests for new endpoint.",
		},
		decision: "request_changes",
	}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-b19", t.TempDir(), "",
		llmResult, nil, func() {}, silentLogger(),
	)
	if err == nil {
		t.Fatal("expected postActionWithConfig to return an error when backend rejects CreateReviewNote")
	}
	if !strings.Contains(err.Error(), "post-actions") {
		t.Errorf("error should be wrapped with \"post-actions\" prefix, got: %v", err)
	}
	if !strings.Contains(err.Error(), "create_review_note") {
		t.Errorf("error should identify the failing action (create_review_note), got: %v", err)
	}

	if got := loop.CardFailureCount(card.CardID); got < 1 {
		t.Errorf("CardFailureCount = %d, want >= 1 (recordFailure must fire on post-action rejection)", got)
	}
}

// B19 companion: a happy-path post-action run still succeeds, returns nil, and
// does NOT record a per-card failure. Protects against over-zealous escalation
// (e.g. accidentally failing the tick when no post-actions were configured).
func TestPostAction_AllSucceed_NoFailureRecorded(t *testing.T) {
	boardID := "board-b19-ok"
	// No endpoint fails — every call 200s.
	srv := postActionServer(t, boardID, "/__never__", http.MethodPost, http.StatusForbidden)

	reviewerStage := StageForRole(DefaultPipelineConfig, "reviewer")
	strategy := NewDataDrivenStrategy(*reviewerStage, nil)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)
	loop.strategy = strategy

	card := &discoverResult{
		CardID:  "card-b19-ok",
		BoardID: boardID,
		Title:   "Clean PR",
	}
	llmResult := &llmStageResult{
		reviewResult: &reviewResult{
			Decision: "request_changes",
			Summary:  "Needs a tweak",
			Findings: "Rename FooBar to FooBaz.",
		},
		decision: "request_changes",
	}

	err := strategy.postActionWithConfig(
		context.Background(), context.Background(),
		loop, card, "exec-b19-ok", t.TempDir(), "",
		llmResult, nil, func() {}, silentLogger(),
	)
	if err != nil {
		t.Fatalf("postActionWithConfig: %v", err)
	}
	if got := loop.CardFailureCount(card.CardID); got != 0 {
		t.Errorf("CardFailureCount = %d, want 0 on happy path", got)
	}
}
