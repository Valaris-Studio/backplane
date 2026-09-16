// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"fmt"
	"log/slog"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

type CompletionWorkflowReport struct {
	Assignments []string
	Unverified  []string
}

// PreflightCompletionWorkflow checks locally decidable prerequisites without
// running a model, cloning source, executing validation or mutating the platform.
func PreflightCompletionWorkflow(ctx context.Context, client *valaris.Client, workspace, board string, cfg *valaris.BoardLoopConfig, providers map[string]llm.Provider, fallback llm.Provider, lookPath func(string) (string, error)) (CompletionWorkflowReport, error) {
	return preflightCompletionWorkflow(ctx, client, workspace, board, cfg, providers, fallback, lookPath, nil)
}

func preflightCompletionWorkflow(ctx context.Context, client *valaris.Client, workspace, board string, cfg *valaris.BoardLoopConfig, providers map[string]llm.Provider, fallback llm.Provider, lookPath func(string) (string, error), claim *valaris.CompletionWork) (CompletionWorkflowReport, error) {
	report := CompletionWorkflowReport{}
	checked := map[string]bool{}
	checkRuntime := func(provider llm.Provider) error {
		if provider == nil || checked[provider.Name()] {
			return nil
		}
		checked[provider.Name()] = true
		runtime, err := llm.CheckRuntimeHealth(ctx, provider, lookPath)
		if err != nil {
			return err
		}
		if len(runtime.Verified) > 0 {
			report.Assignments = append(report.Assignments, runtime.String())
		} else {
			report.Unverified = append(report.Unverified, runtime.String())
		}
		return nil
	}
	source := fallback
	if cfg.Provider != "" {
		source = providers[cfg.Provider]
		if source == nil && fallback != nil && fallback.Name() == cfg.Provider {
			source = fallback
		}
		if source == nil {
			return report, fmt.Errorf("source provider %q is unavailable; configure it before launching", cfg.Provider)
		}
	}
	if err := checkRuntime(source); err != nil {
		return report, err
	}
	if cfg.CompletionPolicy == nil {
		return report, nil
	}
	if err := cfg.ValidateCompletionContract(); err != nil {
		return report, err
	}
	requirements, err := client.GetCompletionRequirements(ctx, workspace, board)
	if err != nil {
		return report, err
	}
	if requirements.PolicyHash == "" || requirements.PolicyHash != cfg.CompletionPolicyHash {
		return report, fmt.Errorf("completion policy changed while checking requirements; refresh the board configuration before launching")
	}
	if err := validateRequirementCoverage(cfg.CompletionPolicy, requirements.Requirements); err != nil {
		return report, err
	}
	if claim != nil && !requirementsMatchClaim(requirements.Requirements, claim) {
		return report, fmt.Errorf("completion role %q assignment changed after claim; retry against the current provider/model and check contract", claim.Role)
	}
	if lookPath == nil {
		lookPath = exec.LookPath
	}
	if _, err := lookPath("git"); err != nil {
		return report, fmt.Errorf("completion exact checkout requires git on PATH; install git before launching")
	}
	for _, requirement := range requirements.Requirements {
		if strings.TrimSpace(requirement.Role) == "" {
			return report, fmt.Errorf("completion requirements omit a role; correct the backend completion configuration")
		}
		label := fmt.Sprintf("completion %s role %q", requirement.Kind, requirement.Role)
		switch requirement.Kind {
		case "review", "evidence_review":
			provider := providers[requirement.Provider]
			if provider == nil && fallback != nil && fallback.Name() == requirement.Provider {
				provider = fallback
			}
			if requirement.Provider == "" || provider == nil || provider.Name() != requirement.Provider {
				return report, fmt.Errorf("%s requires provider %q; configure it in llm.extra_providers before launching (source overrides do not replace reviewers)", label, requirement.Provider)
			}
			capabilities, ok := provider.(llm.CapabilityProvider)
			if !ok || !capabilities.Capabilities().StructuredOutput {
				return report, fmt.Errorf("%s requires structured output from provider %q; configure a compatible provider before launching", label, requirement.Provider)
			}
			if strings.TrimSpace(requirement.Model) == "" || isTierAlias(requirement.Model) {
				return report, fmt.Errorf("%s requires a concrete model for provider %q; configure the role model before launching", label, requirement.Provider)
			}
			if executable, ok := provider.(llm.ExecutableProvider); ok {
				if _, err := lookPath(executable.Executable()); err != nil {
					return report, fmt.Errorf("%s requires provider %q executable %q; install it or correct PATH before launching", label, requirement.Provider, executable.Executable())
				}
			}
			if err := checkRuntime(provider); err != nil {
				return report, fmt.Errorf("%s: %w", label, err)
			}
			if reporter, ok := provider.(llm.ShellDenyReporter); ok && len(reporter.UnenforceableDeny(requirement.ToolPolicy.Deny)) > 0 {
				return report, fmt.Errorf("%s provider %q cannot enforce the configured tool restrictions; configure a compatible provider before launching", label, requirement.Provider)
			}
			report.Assignments = append(report.Assignments, fmt.Sprintf("%s: %s / %s", label, requirement.Provider, requirement.Model))
		case "validation":
			if len(requirement.Checks) == 0 {
				return report, fmt.Errorf("%s has no direct checks; configure validation argv before launching", label)
			}
			seen := map[string]bool{}
			for _, check := range requirement.Checks {
				if check.ID == "" || seen[check.ID] || len(check.Argv) == 0 || strings.TrimSpace(check.Argv[0]) == "" || check.TimeoutSeconds <= 0 || check.TimeoutSeconds > 86400 {
					return report, fmt.Errorf("%s has an invalid check contract; configure unique check IDs, executable argv and valid timeouts", label)
				}
				seen[check.ID] = true
				executable := check.Argv[0]
				if !filepath.IsAbs(executable) && strings.ContainsAny(executable, "/\\") {
					report.Unverified = append(report.Unverified, fmt.Sprintf("%s check %q: repository executable is verified only after exact checkout", label, check.ID))
				} else if _, err := lookPath(executable); err != nil {
					return report, fmt.Errorf("%s check %q requires executable %q; install it or correct the check argv before launching", label, check.ID, executable)
				}
				report.Assignments = append(report.Assignments, fmt.Sprintf("%s: direct check %q", label, check.ID))
			}
		default:
			return report, fmt.Errorf("%s has an unsupported requirement kind; upgrade the runner before launching", label)
		}
	}
	report.Unverified = append(report.Unverified, "Provider account/model access and local checkout access require operational verification; executable discovery does not verify them.")
	return report, nil
}

func (m *LoopMode) preflightCompletionWorkflow(ctx context.Context, cfg *valaris.BoardLoopConfig, claims ...*valaris.CompletionWork) error {
	var claim *valaris.CompletionWork
	if len(claims) > 0 {
		claim = claims[0]
	}
	effective := *cfg
	if m.cfg.LLM.RunOverride != nil {
		effective.Provider = m.cfg.LLM.RunOverride.Provider
	} else if effective.Provider == "" || effective.CompletionPolicy == nil {
		dispatch := valaris.AssignmentLLM{Provider: cfg.Provider, Model: cfg.Model}
		if isTierAlias(cfg.Model) {
			dispatch.Tier = cfg.Model
		}
		if selected := resolveProvider(m.cfg, m.providers, m.defaultProvider, dispatch, "loop"); selected != nil {
			effective.Provider = selected.Name()
		}
	}
	report, err := preflightCompletionWorkflow(ctx, m.client, m.workspaceSlug, m.boardID, &effective, m.providers, m.defaultProvider, nil, claim)
	if err != nil {
		return fmt.Errorf("%s", m.completionOutput(err.Error(), ""))
	}
	if !m.completionNoticeChanged("prerequisites", report) {
		return nil
	}
	for _, assignment := range report.Assignments {
		slog.Info("Completion workflow prerequisite verified", "assignment", m.completionOutput(assignment, ""))
	}
	for _, unverified := range report.Unverified {
		slog.Info("Completion workflow prerequisite unverified", "detail", m.completionOutput(unverified, ""))
	}
	return nil
}

func validateRequirementCoverage(policy *valaris.CompletionPolicy, requirements []valaris.CompletionRequirement) error {
	require := func(kind, role string, checks []valaris.CompletionCheck) error {
		for _, requirement := range requirements {
			if requirement.Kind == kind && requirement.Role == role && (checks == nil || reflect.DeepEqual(requirement.Checks, checks)) {
				return nil
			}
		}
		return fmt.Errorf("completion requirements omit the current %s contract for role %q; refresh the board and deploy a compatible backend before launching", kind, role)
	}
	if policy.SourceReview == "independent" {
		if policy.ReviewRole == nil {
			return fmt.Errorf("completion policy has no independent review role; configure it before launching")
		}
		if err := require("review", *policy.ReviewRole, nil); err != nil {
			return err
		}
	}
	if policy.EvidenceOnly.Enabled && policy.EvidenceOnly.Approval == "independent" {
		if policy.EvidenceOnly.ReviewRole == nil {
			return fmt.Errorf("completion policy has no independent evidence review role; configure it before launching")
		}
		if err := require("evidence_review", *policy.EvidenceOnly.ReviewRole, nil); err != nil {
			return err
		}
	}
	if policy.PostmergeValidation != nil {
		return require("validation", policy.PostmergeValidation.Role, policy.PostmergeValidation.Checks)
	}
	return nil
}

func requirementsMatchClaim(requirements []valaris.CompletionRequirement, claim *valaris.CompletionWork) bool {
	for _, requirement := range requirements {
		if requirement.Kind != claim.Kind || requirement.Role != claim.Role {
			continue
		}
		if claim.Kind == "validation" {
			if reflect.DeepEqual(requirement.Checks, claim.Checks) {
				return true
			}
			continue
		}
		if requirement.Provider == claim.Provider && requirement.Model == claim.Model && slices.Equal(requirement.ToolPolicy.Deny, claim.ToolPolicy.Deny) {
			return true
		}
	}
	return false
}
