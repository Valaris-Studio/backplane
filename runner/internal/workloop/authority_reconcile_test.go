// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/harness"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// uiValidatorStage mirrors the live workspace v20 ui_validator stage shape:
// an LLM stage 'validate_ui' that discovers done-column needs-ui-validation
// cards. The exact discover filters aren't exercised here — the bug under
// test is upstream of discovery: the role's strategy never existed in the
// scheduler at all.
func uiValidatorStage() valaris.StageConfig {
	return valaris.StageConfig{
		Role:  "ui_validator",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		LLM:   valaris.LLMDef{Enabled: true, Stage: "validate_ui"},
	}
}

// newLoopWithFrozenStrategies builds a Loop in the post-launch state the bug
// describes: ownedStrategies was pinned at New() WITHOUT ui_validator (the role
// was installed into pipeline_config later), and a live scheduler holds only the
// original roles. The live pipeline (platformConfig) now DOES carry ui_validator.
func newLoopWithFrozenStrategies(t *testing.T, scope map[string]struct{}) *Loop {
	t.Helper()
	registry := harness.DefaultRegistry()

	reviewerStage := valaris.StageConfig{
		Role:  "reviewer",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		LLM:   valaris.LLMDef{Enabled: true, Stage: "review"},
	}

	// Strategies as frozen at New(): reviewer only.
	owned := map[string]Strategy{
		"reviewer": NewStrategyFromConfig(reviewerStage, registry),
	}

	// Live pipeline now includes ui_validator (added after launch).
	livePipeline := &valaris.PipelineConfig{
		Version: 20,
		Stages:  []valaris.StageConfig{reviewerStage, uiValidatorStage()},
		Scheduling: valaris.SchedulingDef{
			PriorityOrder:  []string{"reviewer", "ui_validator"},
			MaxConsecutive: 3,
		},
	}

	l := &Loop{
		sensors:               registry,
		ownedStrategies:       owned,
		platformPriorityOrder: []string{"reviewer"},
		scopedTeamRoles:       scope,
		promptCache:           make(map[string]string),
		cardFailures:          make(map[string]cardFailure),
	}
	l.platformConfig = valaris.WorkspaceConfigData{PipelineConfig: livePipeline}
	l.scheduler = NewScheduler(
		map[string]Strategy{"reviewer": owned["reviewer"]},
		[]string{"reviewer"},
		"priority",
	)
	// Both roles' prompts are authored (so the missing-prompt drop doesn't mask
	// the reconciliation we're testing).
	l.promptCache["reviewer:review"] = "review the thing"
	l.promptCache["ui_validator:validate_ui"] = "validate the ui"
	return l
}

// TestApplyPlatformAuthority_BuildsRoleAddedAfterLaunch is the regression for the
// frozen-strategy-set bug: a ui_validator role installed into pipeline_config
// AFTER the runner started must become schedulable on the next authority pass,
// not stay permanently absent (the cause of zero ui_validator candidacy on the
// two DONE/needs-ui-validation cards).
func TestApplyPlatformAuthority_BuildsRoleAddedAfterLaunch(t *testing.T) {
	l := newLoopWithFrozenStrategies(t, nil) // role-agnostic scope

	if _, present := l.scheduler.Strategies()["ui_validator"]; present {
		t.Fatal("precondition: ui_validator must be absent before the authority pass")
	}

	l.applyPlatformAuthority(context.Background())

	if _, present := l.scheduler.Strategies()["ui_validator"]; !present {
		t.Fatalf("ui_validator added after launch must become schedulable; scheduler has %v",
			l.scheduler.PriorityOrder())
	}
	if _, owned := l.ownedStrategies["ui_validator"]; !owned {
		t.Error("ui_validator must be added to ownedStrategies so subsequent passes keep it")
	}
	foundInOrder := false
	for _, r := range l.scheduler.PriorityOrder() {
		if r == "ui_validator" {
			foundInOrder = true
		}
	}
	if !foundInOrder {
		t.Errorf("ui_validator must appear in scheduler priority order; got %v", l.scheduler.PriorityOrder())
	}
}

// TestApplyPlatformAuthority_RespectsTeamRoleScopeForNewcomers proves lazy
// reconciliation honors the sharding contract: a runner scoped to a team-role
// set that EXCLUDES ui_validator must NOT build it even when pipeline_config
// adds it (otherwise multi-runner sharding would silently double-claim).
func TestApplyPlatformAuthority_RespectsTeamRoleScopeForNewcomers(t *testing.T) {
	scope := map[string]struct{}{"reviewer": {}} // ui_validator NOT in shard
	l := newLoopWithFrozenStrategies(t, scope)

	l.applyPlatformAuthority(context.Background())

	if _, present := l.scheduler.Strategies()["ui_validator"]; present {
		t.Error("ui_validator is outside this runner's team-role scope and must not be built")
	}
	if _, present := l.scheduler.Strategies()["reviewer"]; !present {
		t.Error("reviewer remains schedulable")
	}
}
