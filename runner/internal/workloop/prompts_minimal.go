// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

// minimalAgenticPromptTemplate mirrors backend's MINIMAL_AGENTIC_PROMPT_TEMPLATE
// (backend/app/services/agents/prompt_defaults.py). The two {{.Role}} and
// {{.Stage}} tokens are deliberately left as Go-template tokens so that role
// and stage are interpolated by the same engine as the rest of PromptContext —
// the render function receives them via minimalPromptData, which wraps
// PromptContext with two extra string fields.
//
// Keep in sync with the backend constant. The two templates describe the same
// generic agent behaviour: understand the stage name, read the card, act.
const minimalAgenticPromptTemplate = `You are an autonomous agent executing the "{{.Stage}}" stage for role "{{.Role}}".

WORKSPACE: {{.Workspace}}
AGENT_ID: {{.AgentID}}
BOARD_ID: {{.BoardID}}
CARD_ID: {{.CardID}}
EXECUTION_ID: {{.ExecutionID}}

{{if .ProjectDirectives}}PROJECT DIRECTIVES:
{{.ProjectDirectives}}

{{end}}Steps:
1. Call get_project_context(workspace_slug="{{.Workspace}}", board_id="{{.BoardID}}") to load the project briefing (definition, notes, recent activity).
2. Call get_card(workspace_slug="{{.Workspace}}", board_id="{{.BoardID}}", card_id="{{.CardID}}") to read the card you are working on.
3. Perform the work this stage is responsible for. The stage name ("{{.Stage}}") and the card description are your instructions. Use the tools available to you to investigate, reason, and act.
4. Call log_execution_update(agent_id="{{.AgentID}}", execution_id="{{.ExecutionID}}", status="running", output_summary="<one-line summary>") when you finish.

Respond with EXACTLY this JSON (no markdown, no extra text):

Success:
{"status":"done","summary":"<one-line verdict>"}

Cannot complete:
{"status":"blocked","summary":"<reason>"}
`

// minimalPromptData extends PromptContext with Role and Stage fields so the
// template can emit them as literal strings in the rendered output.
type minimalPromptData struct {
	PromptContext
	Role  string
	Stage string
}

// renderMinimalAgenticPrompt produces the platform-default minimal agentic
// prompt for a (role, stage) pair whose prompt has not been authored. Called
// from runLLMStage when LLMDef.UseMinimalPromptWhenUnauthored is set.
func renderMinimalAgenticPrompt(role, stage string, ctx PromptContext) string {
	return mustRenderExt(minimalAgenticPromptTemplate, minimalPromptData{
		PromptContext: ctx,
		Role:          role,
		Stage:         stage,
	})
}
