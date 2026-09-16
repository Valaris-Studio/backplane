// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package harness

import "context"

// GuideInput provides context for guide application.
type GuideInput struct {
	// Role is the agent's current role (orchestrator, reviewer, documentator).
	Role string

	// Stage is the current pipeline stage (discover, claim, implement, ship, review, document).
	Stage string

	// CardID is the kanban card being worked on (empty during discover).
	CardID string

	// ExecutionID links this guidance to a specific execution.
	ExecutionID string

	// ProjectContext holds workspace/board metadata.
	ProjectContext map[string]any

	// PriorFindings from sensors in previous pipeline stages (e.g., lint results before implement).
	PriorFindings []Finding
}

// GuideOutput holds the guidance produced for the agent.
type GuideOutput struct {
	// SystemPromptAdditions are injected into the system prompt before the LLM call.
	SystemPromptAdditions string

	// ContextInjections are additional context blocks prepended to the user prompt.
	ContextInjections []string

	// ToolRestrictions override or narrow the allowed tools for this execution.
	ToolRestrictions []string

	// Constraints are natural-language rules injected into the prompt.
	Constraints []string
}

// Guide steers agent behavior BEFORE it acts.
//
// Architecture note (ref: Martin Fowler, "Harness Engineering", April 2026):
// Guides are the feedforward half of the harness. They shape behavior BEFORE the agent acts.
//
// Existing code that maps to this interface:
//   - Prompt templates (prompt_template.go, prompts.go) are guides: they inject
//     role-specific instructions, workspace context, and card details into prompts.
//   - Tool restrictions (AllowedTools in strategy_*.go) are guides: they constrain
//     which MCP tools each role can invoke.
//   - Platform-managed prompt configs (prompt cache) are guides: they override
//     default prompts with workspace/team-specific instructions.
//
// Future guides:
//   - Project-specific coding standards injected from workspace definition
//   - Dynamic tool restrictions based on card type or risk level
//   - Context injection from previous sensor results (e.g., "fix these lint findings")
type Guide interface {
	// Name returns a unique identifier for this guide (e.g., "prompt-template", "tool-restrictor").
	Name() string

	// Apply generates guidance for the agent based on the current context.
	Apply(ctx context.Context, input GuideInput) (*GuideOutput, error)
}
