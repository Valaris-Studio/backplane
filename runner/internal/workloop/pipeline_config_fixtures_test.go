// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import "github.com/Valaris-Studio/backplane/runner/internal/valaris"

// DefaultPipelineConfig is a test fixture mirroring the legacy three-role
// pipeline (orchestrator, reviewer, documentator). Production code must never
// depend on it — platform-supplied pipeline_config is authoritative at runtime
// (see feedback_backend_authoritative_config.md and Loop.New's refusal to
// start without one). This fixture exists so tests can construct realistic
// multi-role pipelines without re-declaring every StageConfig field inline.
var DefaultPipelineConfig = valaris.PipelineConfig{
	Version: 1,
	Stages: []valaris.StageConfig{
		defaultOrchestratorStage,
		defaultReviewerStage,
		defaultDocumentatorStage,
	},
	Scheduling: valaris.SchedulingDef{
		PriorityOrder: []string{"reviewer", "orchestrator", "documentator"},
		Mode:          "priority",
	},
}

var defaultOrchestratorStage = valaris.StageConfig{
	Role: "orchestrator",
	Discover: valaris.DiscoverDef{
		Strategy:          "unassigned_or_rework",
		ColumnTypeExclude: "done",
		Filters: map[string]any{
			"require_git_repo": true,
		},
	},
	Claim: valaris.ClaimDef{
		ParticipantRole: "hero",
		ExecutionAction: "implement_card",
	},
	Git: valaris.GitDef{
		Action:            "create_branch",
		CreatePR:          true,
		ForcePushOnRework: true,
	},
	LLM: valaris.LLMDef{
		Enabled:          true,
		Stage:            "implement",
		InjectDirectives: true,
		ApprovalEnabled:  true,
		Tools: []string{
			"mcp__valaris__get_card",
			"mcp__valaris__get_project_context",
			"mcp__valaris__log_execution_update",
			"mcp__valaris__request_approval",
		},
	},
	OnSuccess: valaris.ActionDef{
		MoveToColumnType: "review",
		WakeRoles:        []string{"reviewer"},
	},
	OnFailure: valaris.ActionDef{
		MoveToColumnType: "backlog",
		Unassign:         true,
	},
}

var defaultReviewerStage = valaris.StageConfig{
	Role: "reviewer",
	Discover: valaris.DiscoverDef{
		Strategy:   "column_scan",
		ColumnType: "review",
		Filters: map[string]any{
			"require_pr_url":           true,
			"skip_if_participant_role": "reviewer",
			"require_git_repo":         true,
		},
	},
	Claim: valaris.ClaimDef{
		ParticipantRole: "helper",
		ExecutionAction: "review_card",
	},
	Git: valaris.GitDef{
		Action: "checkout_pr_branch",
	},
	LLM: valaris.LLMDef{
		Enabled: true,
		Stage:   "review",
		Tools: []string{
			"mcp__valaris__get_card",
			"mcp__valaris__get_project_context",
		},
	},
	OnSuccess: valaris.ActionDef{
		Conditional: true,
		Branches: map[string]valaris.ActionDef{
			"approve": {
				MoveToColumnType:   "done",
				WakeRoles:          []string{"documentator"},
				CleanupReviewNotes: true,
			},
			"request_changes": {
				MoveToColumnType: "active",
				WakeRoles:        []string{"orchestrator"},
				CreateReviewNote: true,
				// Mirrors backend default; see card 3c671415.
				AppendLearning:   false,
				UnassignSelf:     true,
			},
		},
	},
	OnFailure: valaris.ActionDef{
		MoveToColumnType: "backlog",
		Unassign:         true,
	},
}

var defaultDocumentatorStage = valaris.StageConfig{
	Role: "documentator",
	Discover: valaris.DiscoverDef{
		Strategy:   "column_scan",
		ColumnType: "done",
		Filters: map[string]any{
			"exclude_label":    "documented",
			"require_git_repo": true,
		},
	},
	Claim: valaris.ClaimDef{
		ParticipantRole: "helper",
		ExecutionAction: "document_card",
	},
	Git: valaris.GitDef{
		Action:       "create_branch",
		BranchPrefix: "docs-",
	},
	LLM: valaris.LLMDef{
		Enabled: true,
		Stage:   "document",
		Tools: []string{
			"mcp__valaris__create_note",
			"mcp__valaris__get_card",
			"mcp__valaris__get_project_context",
			"mcp__valaris__list_notes",
			"mcp__valaris__log_execution_update",
		},
	},
	OnSuccess: valaris.ActionDef{
		AddLabel: "documented",
	},
	OnFailure: valaris.ActionDef{
		StayInColumn: true,
		Unassign:     true,
	},
}
