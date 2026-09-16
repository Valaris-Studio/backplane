// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"fmt"
	"sort"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

const (
	ConfigErrNoRoles          = "no_roles"
	ConfigErrMissingPrompts   = "missing_prompts"
	ConfigErrEmptyPromptCache = "empty_prompt_cache"

	// Referential-integrity error codes (Phase I.1.b). These mirror the codes
	// reported by the backend validator in app/services/pipeline_config_validation.py.
	ConfigErrInvalidWakeRole          = "invalid_wake_role"
	ConfigErrInvalidMoveToColumnType  = "invalid_move_to_column_type"
	ConfigErrUnknownDiscoverStrategy  = "unknown_discover_strategy"
	ConfigErrUnknownClaimRole         = "unknown_claim_role"
	ConfigErrUnknownGitAction         = "unknown_git_action"
	ConfigErrUnknownLLMStage          = "unknown_llm_stage"
	ConfigErrUnknownPostProcessKind   = "unknown_post_process_kind"
	ConfigErrDuplicateStageRole       = "duplicate_stage_role"
	ConfigErrPriorityOrderUnknownRole = "priority_order_unknown_role"
	ConfigErrUnknownSensorName        = "unknown_sensor_name"

	// I.1.k follow-ups: guard against silent footguns that the engine would
	// otherwise accept at runtime.
	//
	// approval_not_supported_for_custom_stage — approval_enabled=true is only
	// honored by the legacy "implement" switch branch. Any other stage (review,
	// document, or a custom stage with PostProcessKind) would silently ignore
	// approval and proceed as if it were approved.
	ConfigErrApprovalNotSupportedForCustomStage = "approval_not_supported_for_custom_stage"

	// mismatched_post_process_kind — when stage is a legacy name
	// ("implement", "review", "document") but PostProcessKind disagrees with
	// LegacyPostProcessKind(stage), the engine's specialized path writes
	// files/findings that the post-LLM gate then silently discards.
	ConfigErrMismatchedPostProcessKind = "mismatched_post_process_kind"
)

// legacyLLMStages tracks the stage names that route through a specialized
// engine path (l.implement / l.reviewCode / l.generateDocs). The mismatched-
// kind check runs only for these; custom stages have no legacy mapping to
// conflict with.
var legacyLLMStages = map[string]struct{}{
	"implement": {},
	"review":    {},
	"document":  {},
}

// SensorCatalog is the lookup interface used to validate SensorDef.Name values
// against the agent's registered sensors. I.1.b leaves this seam open; I.1.c
// will supply a real implementation that delegates to harness.Registry.
type SensorCatalog interface {
	Has(name string) bool
}

// Enum allow-lists. Kept in sync with the backend pipeline_config_validation.py
// and the runtime behavior of strategy_generic.go.
var (
	validDiscoverStrategies = map[string]struct{}{
		"unassigned_or_rework": {},
		"column_scan":          {},
	}
	validClaimRoles = map[string]struct{}{
		"hero":   {},
		"helper": {},
	}
	validGitActions = map[string]struct{}{
		"create_branch":             {},
		"checkout_pr_branch":        {},
		"checkout_integration_head": {},
		"none":                      {},
		"":                          {},
	}
	validLLMStages = map[string]struct{}{
		"implement": {},
		"review":    {},
		"document":  {},
	}
	// Phase I.1.g: when LLMDef.PostProcessKind is set, the stage name is free-form
	// and the kind decides the engine's output handling. Known kinds:
	validPostProcessKinds = map[string]struct{}{
		"":                  {}, // empty = derive from legacy stage name
		"writes_code":       {},
		"produces_decision": {},
		"produces_note":     {},
		"mutates_backlog":   {},
	}
	validColumnTypes = map[string]struct{}{
		"backlog": {},
		"active":  {},
		"review":  {},
		"done":    {},
		"":        {},
	}
)

// validateConfig checks the agent's configuration and returns any issues found.
//
// Prompt-existence checks are scoped to roles this runner owns (l.ownedStrategies
// in multi-role mode, l.strategy in single-role). Other roles in the platform
// pipeline belong to other runners — their prompt gaps are not this runner's
// responsibility to surface and would otherwise drown the operator in noise
// (B6 in audits/runner-launch-walkthrough-2026-04-18.md).
func (l *Loop) validateConfig() []valaris.ConfigError {
	var errs []valaris.ConfigError

	if l.strategy == nil && l.scheduler == nil {
		errs = append(errs, valaris.ConfigError{
			Code:    ConfigErrNoRoles,
			Message: "No roles assigned — agent cannot process cards",
		})
	}

	wsCfg := l.WorkspaceConfig()
	owned := l.ownedRoleSet()

	l.promptCacheMu.RLock()
	cacheSize := len(l.promptCache)
	l.promptCacheMu.RUnlock()

	if cacheSize == 0 && len(owned) > 0 {
		errs = append(errs, valaris.ConfigError{
			Code:    ConfigErrEmptyPromptCache,
			Message: "No prompt templates loaded from platform for roles owned by this runner",
		})
	} else if cacheSize > 0 && wsCfg.PipelineConfig != nil {
		pipelineCfg := PipelineConfigForAgent(wsCfg)
		for _, stage := range pipelineCfg.Stages {
			if !stage.LLM.Enabled {
				continue
			}
			if _, isOwned := owned[stage.Role]; !isOwned {
				continue
			}
			key := stage.Role + ":" + stage.LLM.Stage
			l.promptCacheMu.RLock()
			_, found := l.promptCache[key]
			l.promptCacheMu.RUnlock()
			if !found {
				errs = append(errs, valaris.ConfigError{
					Code:    ConfigErrMissingPrompts,
					Message: "Missing prompt template — role is unschedulable until the platform supplies one",
					Stage:   key,
				})
			}
		}
	}

	// Referential-integrity checks on the pipeline config itself. Skipped
	// when the platform has not (yet) supplied one — Loop.New refuses to
	// start in that case, so reaching here with nil means we are being
	// called from a health-check path before config arrived. Nothing to
	// validate yet; return whatever prompt errors we accumulated above.
	if wsCfg.PipelineConfig != nil {
		pipelineCfg := PipelineConfigForAgent(wsCfg)
		// The sensor registry doubles as the SensorCatalog seam — its
		// Has(name) method backs sensor-name validation. Nil means "skip
		// sensor checks" (keeps legacy Loops without harness support
		// permissive).
		var catalog SensorCatalog
		if l.sensors != nil {
			catalog = l.sensors
		}
		errs = append(errs, validatePipelineConfig(pipelineCfg, catalog)...)
	}

	return errs
}

// ownedRoleSet returns the roles this runner owns — the canonical set built
// from the platform pipeline at New(), not the live scheduler set (which may
// be temporarily reduced by applyPlatformAuthority). Used to scope prompt
// validation so a runner only reports gaps in roles it can do something
// about.
func (l *Loop) ownedRoleSet() map[string]struct{} {
	out := make(map[string]struct{}, len(l.ownedStrategies))
	for role := range l.ownedStrategies {
		out[role] = struct{}{}
	}
	if len(out) == 0 && l.strategy != nil {
		out[l.strategy.Name()] = struct{}{}
	}
	return out
}

// validatePipelineConfig runs referential-integrity checks over a pipeline
// config and returns one ConfigError per violation. Nil catalog skips
// sensor-name validation (I.1.c seam).
func validatePipelineConfig(cfg valaris.PipelineConfig, catalog SensorCatalog) []valaris.ConfigError {
	var errs []valaris.ConfigError

	knownRoles := make(map[string]struct{}, len(cfg.Stages))
	seen := make(map[string]struct{}, len(cfg.Stages))
	for _, stage := range cfg.Stages {
		if stage.Role == "" {
			continue
		}
		if _, dup := seen[stage.Role]; dup {
			errs = append(errs, valaris.ConfigError{
				Code:    ConfigErrDuplicateStageRole,
				Stage:   stage.Role,
				Message: fmt.Sprintf("duplicate stage role %q", stage.Role),
			})
			continue
		}
		seen[stage.Role] = struct{}{}
		knownRoles[stage.Role] = struct{}{}
	}

	for _, stage := range cfg.Stages {
		errs = append(errs, validateStage(stage, knownRoles, catalog)...)
	}

	for _, role := range cfg.Scheduling.PriorityOrder {
		if role == "" {
			continue
		}
		if _, ok := knownRoles[role]; !ok {
			errs = append(errs, valaris.ConfigError{
				Code:  ConfigErrPriorityOrderUnknownRole,
				Stage: role,
				Message: fmt.Sprintf(
					"scheduling.priority_order references unknown role %q (known: %s)",
					role, sortedKeys(knownRoles),
				),
			})
		}
	}

	return errs
}

func validateStage(stage valaris.StageConfig, knownRoles map[string]struct{}, catalog SensorCatalog) []valaris.ConfigError {
	var errs []valaris.ConfigError

	if _, ok := validDiscoverStrategies[stage.Discover.Strategy]; !ok {
		errs = append(errs, valaris.ConfigError{
			Code:  ConfigErrUnknownDiscoverStrategy,
			Stage: stage.Role,
			Message: fmt.Sprintf(
				"stage %q: unknown discover.strategy %q (expected one of %s)",
				stage.Role, stage.Discover.Strategy, sortedKeys(validDiscoverStrategies),
			),
		})
	}

	if _, ok := validClaimRoles[stage.Claim.ParticipantRole]; !ok {
		errs = append(errs, valaris.ConfigError{
			Code:  ConfigErrUnknownClaimRole,
			Stage: stage.Role,
			Message: fmt.Sprintf(
				"stage %q: unknown claim.participant_role %q (expected one of %s)",
				stage.Role, stage.Claim.ParticipantRole, sortedKeys(validClaimRoles),
			),
		})
	}

	if _, ok := validGitActions[stage.Git.Action]; !ok {
		errs = append(errs, valaris.ConfigError{
			Code:  ConfigErrUnknownGitAction,
			Stage: stage.Role,
			Message: fmt.Sprintf(
				"stage %q: unknown git.action %q (expected one of %s or empty)",
				stage.Role, stage.Git.Action, sortedNonEmpty(validGitActions),
			),
		})
	}

	// LLM stage + PostProcessKind validation. Two modes:
	//   1. PostProcessKind set → stage name is free-form; kind must be a known value.
	//   2. PostProcessKind empty → legacy closed enum on stage names still applies.
	if _, ok := validPostProcessKinds[stage.LLM.PostProcessKind]; !ok {
		errs = append(errs, valaris.ConfigError{
			Code:  ConfigErrUnknownPostProcessKind,
			Stage: stage.Role,
			Message: fmt.Sprintf(
				"stage %q: llm.post_process_kind %q is not a known kind (expected one of %s or empty)",
				stage.Role, stage.LLM.PostProcessKind, sortedNonEmpty(validPostProcessKinds),
			),
		})
	}

	hasKind := stage.LLM.PostProcessKind != ""
	if stage.LLM.Enabled {
		if hasKind {
			// Kind present — stage name is free-form. Only require non-empty.
			if stage.LLM.Stage == "" {
				errs = append(errs, valaris.ConfigError{
					Code:  ConfigErrUnknownLLMStage,
					Stage: stage.Role,
					Message: fmt.Sprintf(
						"stage %q: llm.stage must be non-empty when llm.enabled=true",
						stage.Role,
					),
				})
			}
		} else if _, ok := validLLMStages[stage.LLM.Stage]; !ok {
			errs = append(errs, valaris.ConfigError{
				Code:  ConfigErrUnknownLLMStage,
				Stage: stage.Role,
				Message: fmt.Sprintf(
					"stage %q: llm.stage %q is invalid when llm.enabled=true (expected one of %s, or set llm.post_process_kind for a custom stage)",
					stage.Role, stage.LLM.Stage, sortedKeys(validLLMStages),
				),
			})
		}
	} else if stage.LLM.Stage != "" && !hasKind {
		if _, ok := validLLMStages[stage.LLM.Stage]; !ok {
			errs = append(errs, valaris.ConfigError{
				Code:  ConfigErrUnknownLLMStage,
				Stage: stage.Role,
				Message: fmt.Sprintf(
					"stage %q: llm.stage %q is not a known stage (expected one of %s or empty)",
					stage.Role, stage.LLM.Stage, sortedKeys(validLLMStages),
				),
			})
		}
	}

	// ApprovalEnabled is only plumbed into the legacy "implement" path. Reject
	// it on every other stage (review, document, custom) — the engine would
	// otherwise silently ignore approval and ship as if approved.
	if stage.LLM.ApprovalEnabled && stage.LLM.Stage != "implement" {
		errs = append(errs, valaris.ConfigError{
			Code:  ConfigErrApprovalNotSupportedForCustomStage,
			Stage: stage.Role,
			Message: fmt.Sprintf(
				"stage %q: llm.approval_enabled=true is only wired for stage %q (got %q). Approval flow is not plumbed into custom stages; remove approval_enabled or set stage to \"implement\".",
				stage.Role, "implement", stage.LLM.Stage,
			),
		})
	}

	// Legacy stage names route through specialized engine paths that imply a
	// post-process kind. If the config sets a different explicit kind, the
	// specialized path writes files/findings that the post-LLM gate then
	// silently discards (stage=implement + kind=produces_note → files never
	// committed; stage=review + kind=writes_code → review output lost in a
	// no-op commit step). Reject the mismatch.
	if _, legacy := legacyLLMStages[stage.LLM.Stage]; legacy && stage.LLM.PostProcessKind != "" {
		expected := valaris.LegacyPostProcessKind(stage.LLM.Stage)
		if stage.LLM.PostProcessKind != expected {
			errs = append(errs, valaris.ConfigError{
				Code:  ConfigErrMismatchedPostProcessKind,
				Stage: stage.Role,
				Message: fmt.Sprintf(
					"stage %q: llm.post_process_kind %q disagrees with legacy stage %q (expected %q). The specialized %q path would run and its output silently discarded — rename the stage or align the kind.",
					stage.Role, stage.LLM.PostProcessKind, stage.LLM.Stage, expected, stage.LLM.Stage,
				),
			})
		}
	}

	errs = append(errs, validateAction(stage.Role, "on_success", stage.OnSuccess, knownRoles)...)
	errs = append(errs, validateAction(stage.Role, "on_failure", stage.OnFailure, knownRoles)...)

	// Sensor-name validation (Phase I.1.c). A nil catalog skips the check —
	// the seam stays permissive when the harness registry is unavailable (e.g.
	// older builds or tests that don't wire one in).
	if catalog != nil {
		for _, sensor := range stage.Sensors {
			if sensor.Name == "" {
				continue
			}
			if !catalog.Has(sensor.Name) {
				errs = append(errs, valaris.ConfigError{
					Code:  ConfigErrUnknownSensorName,
					Stage: stage.Role,
					Message: fmt.Sprintf(
						"stage %q: sensor %q is not in the registered catalog",
						stage.Role, sensor.Name,
					),
				})
			}
		}
	}

	return errs
}

func validateAction(role, fieldName string, action valaris.ActionDef, knownRoles map[string]struct{}) []valaris.ConfigError {
	var errs []valaris.ConfigError

	if _, ok := validColumnTypes[action.MoveToColumnType]; !ok {
		errs = append(errs, valaris.ConfigError{
			Code:  ConfigErrInvalidMoveToColumnType,
			Stage: role,
			Message: fmt.Sprintf(
				"stage %q: %s.move_to_column_type %q is not a known column type (expected one of %s or empty)",
				role, fieldName, action.MoveToColumnType, sortedNonEmpty(validColumnTypes),
			),
		})
	}

	for _, wakeRole := range action.WakeRoles {
		if wakeRole == "" {
			continue
		}
		if _, ok := knownRoles[wakeRole]; !ok {
			errs = append(errs, valaris.ConfigError{
				Code:  ConfigErrInvalidWakeRole,
				Stage: role,
				Message: fmt.Sprintf(
					"stage %q: %s.wake_roles references unknown role %q (known: %s)",
					role, fieldName, wakeRole, sortedKeys(knownRoles),
				),
			})
		}
	}

	for branchName, branchAction := range action.Branches {
		errs = append(errs, validateAction(
			role,
			fmt.Sprintf("%s.branches.%s", fieldName, branchName),
			branchAction,
			knownRoles,
		)...)
	}

	return errs
}

func sortedKeys(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func sortedNonEmpty(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		if k != "" {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}
