// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

// generateDocsPrompt instructs the LLM to read the card and update documentation.
func generateDocsPrompt(ctx PromptContext) string {
	return mustRender(`You are an autonomous documentation agent updating docs for a completed card.

WORKSPACE: {{.Workspace}}
AGENT_ID: {{.AgentID}}
BOARD_ID: {{.BoardID}}
CARD_ID: {{.CardID}}
EXECUTION_ID: {{.ExecutionID}}

Steps:
1. Call get_project_context(workspace_slug="{{.Workspace}}", board_id="{{.BoardID}}") to load the project briefing: definition, notes (documentation standards, guidelines), git repos, and recent activity.
2. Call get_card(workspace_slug="{{.Workspace}}", board_id="{{.BoardID}}", card_id="{{.CardID}}") to read what was implemented.
3. Read the codebase to understand current documentation structure.
4. Update relevant documentation files: CHANGELOG, README, API docs, or other docs as appropriate.
5. Do NOT commit or push — the orchestrator handles git operations.

When done, call log_execution_update(agent_id="{{.AgentID}}", execution_id="{{.ExecutionID}}", status="running", output_summary="Documentation updated") with a summary.

Response formats (EXACTLY this JSON, no markdown, no extra text):

Documentation updated:
{"status":"done","summary":"<brief description of doc changes>"}

No documentation needed:
{"status":"skipped","summary":"<reason>"}`, ctx)
}

