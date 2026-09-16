// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

func TestValidateConfig_NoRoles(t *testing.T) {
	l := &Loop{
		promptCache:  make(map[string]string),
		cardFailures: make(map[string]cardFailure),
	}
	// strategy and scheduler are both nil → no roles

	errs := l.validateConfig()
	found := false
	for _, e := range errs {
		if e.Code == ConfigErrNoRoles {
			found = true
		}
	}
	if !found {
		t.Errorf("expected %q error, got %v", ConfigErrNoRoles, errs)
	}
}

func TestValidateConfig_EmptyPromptCache(t *testing.T) {
	l := &Loop{
		strategy:     NewStrategyFromConfig(*StageForRole(DefaultPipelineConfig, "orchestrator"), nil),
		promptCache:  make(map[string]string),
		cardFailures: make(map[string]cardFailure),
	}

	errs := l.validateConfig()
	found := false
	for _, e := range errs {
		if e.Code == ConfigErrEmptyPromptCache {
			found = true
		}
	}
	if !found {
		t.Errorf("expected %q error, got %v", ConfigErrEmptyPromptCache, errs)
	}
}

func TestValidateConfig_MissingOwnedPromptOnly(t *testing.T) {
	// A runner that owns only "orchestrator" must not surface missing_prompts
	// for reviewer/documentator — those belong to other runners. See
	// audits/runner-launch-walkthrough-2026-04-18.md B6.
	pipelineCfg := DefaultPipelineConfig
	orchestratorStrategy := NewStrategyFromConfig(*StageForRole(DefaultPipelineConfig, "orchestrator"), nil)
	l := &Loop{
		strategy:        orchestratorStrategy,
		ownedStrategies: map[string]Strategy{"orchestrator": orchestratorStrategy},
		promptCache:     make(map[string]string),
		cardFailures:    make(map[string]cardFailure),
	}
	l.platformConfigMu = sync.RWMutex{}
	l.platformConfig = valaris.WorkspaceConfigData{PipelineConfig: &pipelineCfg}

	// Owned prompt missing; unowned roles' prompts also missing — only owned
	// gap should surface.
	l.promptCacheMu.Lock()
	l.promptCache["unrelated:dummy"] = "x" // ensures cacheSize > 0 so the empty-cache branch is skipped
	l.promptCacheMu.Unlock()

	errs := l.validateConfig()

	missingStages := make(map[string]bool)
	for _, e := range errs {
		if e.Code == ConfigErrMissingPrompts {
			missingStages[e.Stage] = true
		}
	}

	if !missingStages["orchestrator:implement"] {
		t.Errorf("expected missing_prompts for owned role orchestrator:implement, got %v", missingStages)
	}
	if missingStages["reviewer:review"] {
		t.Errorf("reviewer:review must NOT surface — runner does not own that role")
	}
	if missingStages["documentator:document"] {
		t.Errorf("documentator:document must NOT surface — runner does not own that role")
	}
}

func TestValidateConfig_AllGood(t *testing.T) {
	pipelineCfg := DefaultPipelineConfig
	l := &Loop{
		strategy:     NewStrategyFromConfig(*StageForRole(DefaultPipelineConfig, "orchestrator"), nil),
		promptCache:  make(map[string]string),
		cardFailures: make(map[string]cardFailure),
	}

	l.platformConfig = valaris.WorkspaceConfigData{
		PipelineConfig: &pipelineCfg,
	}

	// Populate all required prompts from default pipeline
	l.promptCacheMu.Lock()
	l.promptCache["orchestrator:implement"] = "prompt"
	l.promptCache["reviewer:review"] = "prompt"
	l.promptCache["documentator:document"] = "prompt"
	l.promptCacheMu.Unlock()

	errs := l.validateConfig()
	if len(errs) != 0 {
		t.Errorf("expected no config errors, got %v", errs)
	}
}

// ---------------------------------------------------------------------------
// Pipeline-config referential-integrity validation (Phase I.1.b).
//
// These tests focus on validatePipelineConfig directly; it runs on the raw
// config structure and returns ConfigErrors for each violation. The outer
// validateConfig() wraps it so the errors surface via HealthReport.ConfigErrors.
// ---------------------------------------------------------------------------

func containsCode(errs []valaris.ConfigError, code string) bool {
	for _, e := range errs {
		if e.Code == code {
			return true
		}
	}
	return false
}

func TestConfigValidation_DefaultIsClean(t *testing.T) {
	errs := validatePipelineConfig(DefaultPipelineConfig, nil)
	if len(errs) != 0 {
		t.Errorf("DefaultPipelineConfig must produce no errors, got %v", errs)
	}
}

func TestConfigValidation_InvalidWakeRole(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].OnSuccess.WakeRoles = []string{"ghost"}

	errs := validatePipelineConfig(cfg, nil)
	if !containsCode(errs, ConfigErrInvalidWakeRole) {
		t.Errorf("expected %q, got %v", ConfigErrInvalidWakeRole, errs)
	}
}

func TestConfigValidation_InvalidWakeRoleInBranch(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	approve := cfg.Stages[1].OnSuccess.Branches["approve"]
	approve.WakeRoles = []string{"nobody"}
	cfg.Stages[1].OnSuccess.Branches["approve"] = approve

	errs := validatePipelineConfig(cfg, nil)
	if !containsCode(errs, ConfigErrInvalidWakeRole) {
		t.Errorf("expected %q in branch, got %v", ConfigErrInvalidWakeRole, errs)
	}
}

func TestConfigValidation_InvalidMoveToColumnType(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].OnSuccess.MoveToColumnType = "nirvana"

	errs := validatePipelineConfig(cfg, nil)
	if !containsCode(errs, ConfigErrInvalidMoveToColumnType) {
		t.Errorf("expected %q, got %v", ConfigErrInvalidMoveToColumnType, errs)
	}
}

func TestConfigValidation_UnknownDiscoverStrategy(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].Discover.Strategy = "label_scan"

	errs := validatePipelineConfig(cfg, nil)
	if !containsCode(errs, ConfigErrUnknownDiscoverStrategy) {
		t.Errorf("expected %q, got %v", ConfigErrUnknownDiscoverStrategy, errs)
	}
}

func TestConfigValidation_UnknownClaimRole(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].Claim.ParticipantRole = "villain"

	errs := validatePipelineConfig(cfg, nil)
	if !containsCode(errs, ConfigErrUnknownClaimRole) {
		t.Errorf("expected %q, got %v", ConfigErrUnknownClaimRole, errs)
	}
}

func TestConfigValidation_UnknownGitAction(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].Git.Action = "magic_merge"

	errs := validatePipelineConfig(cfg, nil)
	if !containsCode(errs, ConfigErrUnknownGitAction) {
		t.Errorf("expected %q, got %v", ConfigErrUnknownGitAction, errs)
	}
}

func TestConfigValidation_GitActionEmptyIsAllowed(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].Git.Action = ""

	errs := validatePipelineConfig(cfg, nil)
	if containsCode(errs, ConfigErrUnknownGitAction) {
		t.Errorf("empty git.action must be allowed, got %v", errs)
	}
}

func TestConfigValidation_UnknownLLMStage(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].LLM.Enabled = true
	cfg.Stages[0].LLM.Stage = "ponder"

	errs := validatePipelineConfig(cfg, nil)
	if !containsCode(errs, ConfigErrUnknownLLMStage) {
		t.Errorf("expected %q, got %v", ConfigErrUnknownLLMStage, errs)
	}
}

func TestConfigValidation_LLMDisabledAllowsEmptyStage(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].LLM.Enabled = false
	cfg.Stages[0].LLM.Stage = ""

	errs := validatePipelineConfig(cfg, nil)
	if containsCode(errs, ConfigErrUnknownLLMStage) {
		t.Errorf("llm.stage empty must be allowed when disabled, got %v", errs)
	}
}

func TestConfigValidation_LLMEnabledEmptyStageRejected(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].LLM.Enabled = true
	cfg.Stages[0].LLM.Stage = ""

	errs := validatePipelineConfig(cfg, nil)
	if !containsCode(errs, ConfigErrUnknownLLMStage) {
		t.Errorf("expected %q for empty stage with enabled LLM, got %v",
			ConfigErrUnknownLLMStage, errs)
	}
}

func TestConfigValidation_DuplicateStageRole(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[1].Role = "orchestrator" // collide with stage 0

	errs := validatePipelineConfig(cfg, nil)
	if !containsCode(errs, ConfigErrDuplicateStageRole) {
		t.Errorf("expected %q, got %v", ConfigErrDuplicateStageRole, errs)
	}
}

func TestConfigValidation_PriorityOrderUnknownRole(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Scheduling.PriorityOrder = []string{"reviewer", "gremlin"}

	errs := validatePipelineConfig(cfg, nil)
	if !containsCode(errs, ConfigErrPriorityOrderUnknownRole) {
		t.Errorf("expected %q, got %v", ConfigErrPriorityOrderUnknownRole, errs)
	}
}

// stubCatalog is a deterministic SensorCatalog for tests — lists only the
// sensor names it should recognize.
type stubCatalog struct {
	known map[string]struct{}
}

func newStubCatalog(names ...string) *stubCatalog {
	c := &stubCatalog{known: make(map[string]struct{}, len(names))}
	for _, n := range names {
		c.known[n] = struct{}{}
	}
	return c
}

func (c *stubCatalog) Has(name string) bool {
	_, ok := c.known[name]
	return ok
}

func TestConfigValidation_UnknownSensorName(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].Sensors = []valaris.SensorDef{
		{Name: "phantom-linter"},
	}

	catalog := newStubCatalog("go-test")
	errs := validatePipelineConfig(cfg, catalog)
	if !containsCode(errs, ConfigErrUnknownSensorName) {
		t.Errorf("expected %q, got %v", ConfigErrUnknownSensorName, errs)
	}
}

func TestConfigValidation_KnownSensorName(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].Sensors = []valaris.SensorDef{
		{Name: "go-test"},
	}

	catalog := newStubCatalog("go-test")
	errs := validatePipelineConfig(cfg, catalog)
	if containsCode(errs, ConfigErrUnknownSensorName) {
		t.Errorf("known sensor must not produce %q: %v", ConfigErrUnknownSensorName, errs)
	}
}

func TestConfigValidation_NilCatalogSkipsSensorNameCheck(t *testing.T) {
	// When the agent has no registry yet (nil catalog), sensor-name validation
	// is deliberately skipped — the seam must stay permissive so legacy
	// configs keep working through rollout.
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].Sensors = []valaris.SensorDef{
		{Name: "phantom-linter"},
	}

	errs := validatePipelineConfig(cfg, nil)
	if containsCode(errs, ConfigErrUnknownSensorName) {
		t.Errorf("nil catalog must not produce %q: %v", ConfigErrUnknownSensorName, errs)
	}
}

func TestConfigValidation_ReportsFieldPath(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].Discover.Strategy = "bogus"

	errs := validatePipelineConfig(cfg, nil)
	found := false
	for _, e := range errs {
		if e.Code == ConfigErrUnknownDiscoverStrategy {
			found = true
			if e.Stage != "orchestrator" {
				t.Errorf("expected Stage=orchestrator, got %q", e.Stage)
			}
			if e.Message == "" {
				t.Errorf("expected non-empty message, got %+v", e)
			}
		}
	}
	if !found {
		t.Errorf("expected %q, got %v", ConfigErrUnknownDiscoverStrategy, errs)
	}
}

// ---------------------------------------------------------------------------
// Phase I.1.g — PostProcessKind discriminator.
//
// `LLMDef.PostProcessKind` opens the LLM stage enum to arbitrary stage names
// while keeping the engine honest: the kind decides how the LLM output is
// routed (git commit / decision / note / backlog mutation), and the stage name
// becomes a pure prompt-template key.
// ---------------------------------------------------------------------------

// Each of the four valid PostProcessKind values passes validation.
func TestValidatePostProcessKind_Known(t *testing.T) {
	kinds := []string{"writes_code", "produces_decision", "produces_note", "mutates_backlog"}
	for _, kind := range kinds {
		cfg := copyPipelineConfig(DefaultPipelineConfig)
		cfg.Stages[0].LLM.Enabled = true
		cfg.Stages[0].LLM.Stage = "any_custom_stage"
		cfg.Stages[0].LLM.PostProcessKind = kind

		errs := validatePipelineConfig(cfg, nil)
		if containsCode(errs, ConfigErrUnknownPostProcessKind) {
			t.Errorf("kind=%q produced %s: %v", kind, ConfigErrUnknownPostProcessKind, errs)
		}
	}
}

// An unrecognized PostProcessKind yields the unknown_post_process_kind error.
func TestValidatePostProcessKind_Unknown(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].LLM.Enabled = true
	cfg.Stages[0].LLM.Stage = "research"
	cfg.Stages[0].LLM.PostProcessKind = "garbage"

	errs := validatePipelineConfig(cfg, nil)
	if !containsCode(errs, ConfigErrUnknownPostProcessKind) {
		t.Errorf("expected %q, got %v", ConfigErrUnknownPostProcessKind, errs)
	}
}

// With a known PostProcessKind, a custom stage name no longer triggers unknown_llm_stage.
func TestValidateLLMStage_CustomStageWithKind(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].LLM.Enabled = true
	cfg.Stages[0].LLM.Stage = "research"
	cfg.Stages[0].LLM.PostProcessKind = "produces_note"

	errs := validatePipelineConfig(cfg, nil)
	if containsCode(errs, ConfigErrUnknownLLMStage) {
		t.Errorf("custom stage with kind should not trigger unknown_llm_stage, got %v", errs)
	}
}

// Without a PostProcessKind, the legacy stage-name allow-list still applies
// (back-compat: empty kind = fall through to unknown_llm_stage).
func TestValidateLLMStage_CustomStageWithoutKind(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].LLM.Enabled = true
	cfg.Stages[0].LLM.Stage = "research"
	cfg.Stages[0].LLM.PostProcessKind = ""

	errs := validatePipelineConfig(cfg, nil)
	if !containsCode(errs, ConfigErrUnknownLLMStage) {
		t.Errorf("custom stage without kind should still trigger %q, got %v",
			ConfigErrUnknownLLMStage, errs)
	}
}

// ---------------------------------------------------------------------------
// Fix 2 — approval_enabled must only land on legacy "implement" stages.
//
// Custom LLM stages go through runLLMStage, which has no approval plumbing
// wired in. Accepting approval_enabled=true on any non-implement stage is a
// silent footgun: the LLM emits status="needs_approval" and the engine
// happily proceeds to gitCommitAndPush.
// ---------------------------------------------------------------------------

func TestValidateApproval_LegacyImplement_Accepted(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	// Default orchestrator already has stage="implement" + approval_enabled=true.
	errs := validatePipelineConfig(cfg, nil)
	if containsCode(errs, ConfigErrApprovalNotSupportedForCustomStage) {
		t.Errorf("legacy implement stage with approval_enabled=true must be accepted, got %v", errs)
	}
}

func TestValidateApproval_CustomStage_Rejected(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].LLM.Stage = "research"
	cfg.Stages[0].LLM.PostProcessKind = "produces_note"
	cfg.Stages[0].LLM.ApprovalEnabled = true

	errs := validatePipelineConfig(cfg, nil)
	if !containsCode(errs, ConfigErrApprovalNotSupportedForCustomStage) {
		t.Errorf("custom stage with approval_enabled=true must be rejected, got %v", errs)
	}
}

// Reviewer / documentator stages also don't have approval wired in.
func TestValidateApproval_LegacyReviewerWithApproval_Rejected(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[1].LLM.ApprovalEnabled = true // reviewer

	errs := validatePipelineConfig(cfg, nil)
	if !containsCode(errs, ConfigErrApprovalNotSupportedForCustomStage) {
		t.Errorf("reviewer with approval_enabled=true must be rejected, got %v", errs)
	}
}

func TestValidateApproval_CustomStageDisabled_Accepted(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].LLM.Stage = "research"
	cfg.Stages[0].LLM.PostProcessKind = "produces_note"
	cfg.Stages[0].LLM.ApprovalEnabled = false

	errs := validatePipelineConfig(cfg, nil)
	if containsCode(errs, ConfigErrApprovalNotSupportedForCustomStage) {
		t.Errorf("custom stage with approval_enabled=false must be accepted, got %v", errs)
	}
}

// ---------------------------------------------------------------------------
// Fix 3 — mismatched post_process_kind on legacy stage names.
//
// `stage="implement", post_process_kind="produces_note"` is a silent footgun:
// executeLLM routes to l.implement (writes files), then the post-LLM gate sees
// EffectivePostProcessKind()=="produces_note" and skips gitCommitAndPush. Files
// are written but never committed — silent data loss.
//
// Rule: when stage is in {"implement","review","document"} AND post_process_kind
// is non-empty AND differs from LegacyPostProcessKind(stage), reject.
// ---------------------------------------------------------------------------

func TestValidateLegacyStage_ExplicitMatchingKind_Accepted(t *testing.T) {
	tests := []struct {
		stage string
		kind  string
	}{
		{"implement", "writes_code"},
		{"review", "produces_decision"},
		{"document", "writes_code"},
	}
	for _, tt := range tests {
		cfg := copyPipelineConfig(DefaultPipelineConfig)
		cfg.Stages[0].LLM.Enabled = true
		cfg.Stages[0].LLM.Stage = tt.stage
		cfg.Stages[0].LLM.PostProcessKind = tt.kind
		// approval only wired for implement — keep true only when stage=implement.
		cfg.Stages[0].LLM.ApprovalEnabled = tt.stage == "implement"

		errs := validatePipelineConfig(cfg, nil)
		if containsCode(errs, ConfigErrMismatchedPostProcessKind) {
			t.Errorf("stage=%q kind=%q (matches legacy) must be accepted, got %v",
				tt.stage, tt.kind, errs)
		}
	}
}

func TestValidateLegacyStage_MismatchedKind_Rejected(t *testing.T) {
	tests := []struct {
		stage string
		kind  string
	}{
		{"implement", "produces_note"},
		{"implement", "produces_decision"},
		{"review", "writes_code"},
		{"document", "produces_decision"},
	}
	for _, tt := range tests {
		cfg := copyPipelineConfig(DefaultPipelineConfig)
		cfg.Stages[0].LLM.Enabled = true
		cfg.Stages[0].LLM.Stage = tt.stage
		cfg.Stages[0].LLM.PostProcessKind = tt.kind
		// Drop approval_enabled on non-implement stages so we don't double-report.
		cfg.Stages[0].LLM.ApprovalEnabled = false

		errs := validatePipelineConfig(cfg, nil)
		if !containsCode(errs, ConfigErrMismatchedPostProcessKind) {
			t.Errorf("stage=%q kind=%q (mismatch) must be rejected, got %v",
				tt.stage, tt.kind, errs)
		}
	}
}

// Empty PostProcessKind on legacy stage keeps back-compat.
func TestValidateLegacyStage_EmptyKind_Accepted(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].LLM.Enabled = true
	cfg.Stages[0].LLM.Stage = "implement"
	cfg.Stages[0].LLM.PostProcessKind = ""

	errs := validatePipelineConfig(cfg, nil)
	if containsCode(errs, ConfigErrMismatchedPostProcessKind) {
		t.Errorf("legacy stage with empty kind must be accepted, got %v", errs)
	}
}

// Fully-custom stage (not in legacy allow-list) is not subject to the
// mismatch check; the PostProcessKind enum check already validates it.
func TestValidateLegacyStage_CustomStage_NotSubjectToMismatch(t *testing.T) {
	cfg := copyPipelineConfig(DefaultPipelineConfig)
	cfg.Stages[0].LLM.Enabled = true
	cfg.Stages[0].LLM.Stage = "research"
	cfg.Stages[0].LLM.PostProcessKind = "writes_code"

	errs := validatePipelineConfig(cfg, nil)
	if containsCode(errs, ConfigErrMismatchedPostProcessKind) {
		t.Errorf("custom stage should not trigger mismatched_post_process_kind, got %v", errs)
	}
}

// copyPipelineConfig deep-clones DefaultPipelineConfig so tests can mutate it
// without leaking state across test cases.
func copyPipelineConfig(src valaris.PipelineConfig) valaris.PipelineConfig {
	out := src
	out.Stages = make([]valaris.StageConfig, len(src.Stages))
	for i, s := range src.Stages {
		out.Stages[i] = s
		if s.Discover.Filters != nil {
			out.Stages[i].Discover.Filters = make(map[string]any, len(s.Discover.Filters))
			for k, v := range s.Discover.Filters {
				out.Stages[i].Discover.Filters[k] = v
			}
		}
		if s.LLM.Tools != nil {
			out.Stages[i].LLM.Tools = append([]string(nil), s.LLM.Tools...)
		}
		if s.OnSuccess.WakeRoles != nil {
			out.Stages[i].OnSuccess.WakeRoles = append([]string(nil), s.OnSuccess.WakeRoles...)
		}
		if s.OnFailure.WakeRoles != nil {
			out.Stages[i].OnFailure.WakeRoles = append([]string(nil), s.OnFailure.WakeRoles...)
		}
		if s.OnSuccess.Branches != nil {
			out.Stages[i].OnSuccess.Branches = make(map[string]valaris.ActionDef, len(s.OnSuccess.Branches))
			for k, v := range s.OnSuccess.Branches {
				copied := v
				if v.WakeRoles != nil {
					copied.WakeRoles = append([]string(nil), v.WakeRoles...)
				}
				out.Stages[i].OnSuccess.Branches[k] = copied
			}
		}
	}
	out.Scheduling.PriorityOrder = append([]string(nil), src.Scheduling.PriorityOrder...)
	return out
}
