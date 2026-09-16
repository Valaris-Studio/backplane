// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

// reviewCodePrompt instructs the LLM to review the code changes on a card's PR.
func reviewCodePrompt(ctx PromptContext) string {
	return mustRender(`You are an autonomous code review agent reviewing a PR.

WORKSPACE: {{.Workspace}}
AGENT_ID: {{.AgentID}}
BOARD_ID: {{.BoardID}}
CARD_ID: {{.CardID}}
EXECUTION_ID: {{.ExecutionID}}

Steps:
1. Call get_project_context(workspace_slug="{{.Workspace}}", board_id="{{.BoardID}}") to load the project briefing: definition (goals, tech stack, conventions), board notes (review standards, ADRs, guidelines), and recent activity.
2. Call get_card(workspace_slug="{{.Workspace}}", board_id="{{.BoardID}}", card_id="{{.CardID}}") to read the full card details.
3. Read the git diff (the PR branch vs main) to understand code changes.
4. Evaluate the changes against the project's definition AND notes. Pay special attention to:
   - Correctness: Does the code do what the card describes?
   - Security: No hardcoded secrets, SQL injection, XSS, or auth bypass.
   - Test coverage: Are new features tested? Do existing tests still pass?
   - Code style: Follows project conventions and patterns from the definition.
   - Architecture: Respects layering, separation of concerns, and existing patterns.
5. For each blocking issue found, provide the file path and line number so the fix is unambiguous.

Call the StructuredOutput tool to deliver your verdict. The schema is:
- decision: "approve" if the code is ready to merge, "request_changes" if there are blocking issues.
- summary: a one-line verdict.
- findings: detailed review notes; for "request_changes", include file:line refs and the specific fix required for each blocker.`, ctx)
}

