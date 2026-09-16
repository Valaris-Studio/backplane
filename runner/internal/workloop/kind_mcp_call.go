// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"fmt"
	"strings"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// lifecycleMCPCall dispatches a generic backend tool invocation. The Go runner
// doesn't speak the raw MCP protocol — every "tool" maps to a method on
// valaris.Client. The dispatcher below is the closed set the runner supports
// today; adding a new tool requires extending this map AND adding the client
// method. The walker errors out on unknown tools rather than silently
// no-op'ing — that's the "extensibility without hidden limits" rule.
//
// Tool args come from step.Params["args"] (a map). The dispatcher pulls the
// keys each tool needs and reports unknown / missing-arg errors fast.
//
// Most lifecycle authors will compose mcp_call only for tools that don't have
// a dedicated kind. Specialized kinds (move_card, apply_label, create_note,
// enqueue_for_merge) are preferred because they're better-typed and survive
// schema validation.
func lifecycleMCPCall(ctx context.Context, ws *lifecycle.WalkState, step *valaris.LifecycleStep) (string, string, error) {
	l := loopFromWalk(ws)
	tool := paramString(step, "tool", "")
	if tool == "" {
		return "", "", &configError{msg: "mcp_call requires param 'tool'"}
	}
	args := paramMap(step, "args")
	resolved, err := resolveMCPArgs(ws, args)
	if err != nil {
		return "", "", fmt.Errorf("mcp_call(%s): %w", tool, err)
	}

	handler, ok := mcpToolDispatch[tool]
	if !ok {
		return "", "", fmt.Errorf("mcp_call: unknown tool %q (supported: %v)", tool, mcpToolNames())
	}
	value, err := handler(ctx, l, ws, resolved)
	if err != nil {
		return "", "", fmt.Errorf("mcp_call(%s): %w", tool, err)
	}
	if value != nil {
		// Tool return values surface on the scratchpad under the tool name so
		// downstream branch steps can read them. Operators with multiple calls
		// to the same tool should set a per-step alias param (out of scope here).
		ws.Set(tool, value)
	}
	return "", "", nil
}

// mcpToolHandler is the per-tool dispatcher signature. Returns an opaque value
// the walker stores on WalkState.Variables[<tool>]; nil means "no result".
type mcpToolHandler func(ctx context.Context, l *Loop, ws *lifecycle.WalkState, args map[string]any) (any, error)

// mcpToolDispatch is the closed set of backend tools mcp_call can invoke. Keys
// must be real mcp-server tool names (TestMCPToolDispatch_NoPhantomTools in
// mcp_tool_catalog_test.go fails the build otherwise) even though the runner
// never speaks MCP wire protocol to reach them — it's a straight REST call via
// valaris.Client. Keep alphabetized by tool name; document the args contract
// on each entry.
var mcpToolDispatch = map[string]mcpToolHandler{
	"add_card_participant": func(ctx context.Context, l *Loop, ws *lifecycle.WalkState, args map[string]any) (any, error) {
		card, err := requireCard(ws, "mcp_call", "add_card_participant")
		if err != nil {
			return nil, err
		}
		userID, _ := args["user_id"].(string)
		role, _ := args["role"].(string)
		if userID == "" || role == "" {
			return nil, fmt.Errorf("missing required args user_id, role")
		}
		agentID, _ := args["agent_id"].(string)
		pipelineRole, _ := args["pipeline_role"].(string)
		return nil, l.client.AddCardParticipant(ctx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID, userID, role, agentID, pipelineRole)
	},
	// remove_card_participant takes exactly one selector: user_id (one
	// person) or pipeline_role (every holder of a stage role) — the MCP #4
	// fold of remove_card_participants_by_role, which stays below as an
	// alias while stored pipeline configs still name it.
	"remove_card_participant": func(ctx context.Context, l *Loop, ws *lifecycle.WalkState, args map[string]any) (any, error) {
		card, err := requireCard(ws, "mcp_call", "remove_card_participant")
		if err != nil {
			return nil, err
		}
		userID, _ := args["user_id"].(string)
		pipelineRole, _ := args["pipeline_role"].(string)
		switch {
		case userID == "" && pipelineRole == "":
			return nil, fmt.Errorf("remove_card_participant: pass exactly one of user_id or pipeline_role")
		case userID != "" && pipelineRole != "":
			return nil, fmt.Errorf("remove_card_participant: user_id and pipeline_role are mutually exclusive")
		case pipelineRole != "":
			return nil, l.client.RemoveCardParticipantsByRole(ctx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID, pipelineRole)
		}
		return nil, l.client.RemoveCardParticipant(ctx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID, userID)
	},
	// Deprecated alias of remove_card_participant(pipeline_role=...); the
	// server drops it in backplane-mcp 0.8.0 and the doctor warns on it.
	"remove_card_participants_by_role": func(ctx context.Context, l *Loop, ws *lifecycle.WalkState, args map[string]any) (any, error) {
		card, err := requireCard(ws, "mcp_call", "remove_card_participants_by_role")
		if err != nil {
			return nil, err
		}
		pipelineRole, _ := args["pipeline_role"].(string)
		if pipelineRole == "" {
			return nil, fmt.Errorf("missing required arg pipeline_role")
		}
		return nil, l.client.RemoveCardParticipantsByRole(ctx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID, pipelineRole)
	},
	"update_card": func(ctx context.Context, l *Loop, ws *lifecycle.WalkState, args map[string]any) (any, error) {
		card, err := requireCard(ws, "mcp_call", "update_card")
		if err != nil {
			return nil, err
		}
		fields, _ := args["fields"].(map[string]any)
		if fields == nil {
			return nil, fmt.Errorf("missing required arg fields (object)")
		}
		return nil, l.client.UpdateCard(ctx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID, fields)
	},
	"get_card_verdict": func(ctx context.Context, l *Loop, ws *lifecycle.WalkState, args map[string]any) (any, error) {
		card, err := requireCard(ws, "mcp_call", "get_card_verdict")
		if err != nil {
			return nil, err
		}
		return l.client.GetCardVerdict(ctx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID)
	},
	// create_note via mcp_call lets lifecycle authors compose arbitrary notes
	// with $-refs in the body field (e.g. $llm_output for the verbatim
	// LLM stdout). For purely-static notes prefer the create_note kind, which
	// validates body_from at config time. kind + non-empty body are required;
	// body is checked after $-ref resolution so a missing $llm_output is a
	// hard error rather than a silent empty POST.
	"create_note": func(ctx context.Context, l *Loop, ws *lifecycle.WalkState, args map[string]any) (any, error) {
		card, err := requireCard(ws, "mcp_call", "create_note")
		if err != nil {
			return nil, err
		}
		kind, _ := args["kind"].(string)
		kind = strings.TrimSpace(kind)
		if kind == "" {
			return nil, fmt.Errorf("create_note: missing required arg kind")
		}
		body, _ := args["body"].(string)
		if body == "" {
			return nil, fmt.Errorf("create_note: missing required arg body (after $-ref resolution)")
		}
		title, _ := args["title"].(string)
		if title == "" {
			title = fmt.Sprintf("Note: %s", card.CardID)
		}
		failureClass, _ := args["failure_class"].(string)
		pinned, _ := args["pinned"].(bool)
		return nil, l.client.CreateNote(ctx, l.cfg.Valaris.WorkspaceSlug,
			card.BoardID, card.CardID, kind, title, body, failureClass, pinned)
	},
}

// mcpToolNames is a stable, sorted-ish list of supported tools for error
// messages. The map iteration order is fine — operators read this once to
// fix their config.
func mcpToolNames() []string {
	names := make([]string, 0, len(mcpToolDispatch))
	for k := range mcpToolDispatch {
		names = append(names, k)
	}
	return names
}

// resolveMCPArgs substitutes $-prefixed runtime refs in top-level args.
// Leaf-string-only — nested objects/arrays pass through untouched.
func resolveMCPArgs(ws *lifecycle.WalkState, args map[string]any) (map[string]any, error) {
	if args == nil {
		return nil, nil
	}
	out := make(map[string]any, len(args))
	for k, v := range args {
		s, ok := v.(string)
		if !ok || len(s) == 0 || s[0] != '$' {
			out[k] = v
			continue
		}
		resolved, err := resolveMCPRef(ws, s)
		if err != nil {
			return nil, err
		}
		out[k] = resolved
	}
	return out, nil
}

// mcpRefNames lists the supported $-refs for error messages. Keep alphabetized.
var mcpRefNames = []string{
	"$agent_id", "$card_id", "$last_decision", "$learning",
	"$llm_decision", "$llm_findings", "$llm_output", "$llm_summary",
	"$pr_url", "$self",
}

func resolveMCPRef(ws *lifecycle.WalkState, ref string) (string, error) {
	l := loopFromWalk(ws)
	switch ref {
	case "$self":
		return l.client.UserID, nil
	case "$agent_id":
		if l.client.Agent == nil {
			return "", nil
		}
		return l.client.Agent.ID, nil
	case "$learning":
		card := cardFromWalk(ws)
		if card == nil {
			return "", nil
		}
		return learningFromSources(card, llmResultFromWalk(ws), sensorResultFromWalk(ws)), nil
	case "$last_decision":
		return ws.LastDecision, nil
	case "$card_id":
		card, err := requireCard(ws, "mcp_call", "$card_id")
		if err != nil {
			return "", err
		}
		return card.CardID, nil
	case "$pr_url":
		card, err := requireCard(ws, "mcp_call", "$pr_url")
		if err != nil {
			return "", err
		}
		return card.PRURL, nil
	case "$llm_output":
		// Verbatim LLM stdout of the latest llm step. "" when no LLM has run yet;
		// downstream handlers (e.g. create_note via mcp_call) decide whether empty
		// is acceptable.
		return ws.LLMRawOutput, nil
	case "$llm_findings":
		if r := llmResultFromWalk(ws); r != nil && r.reviewResult != nil {
			return string(r.reviewResult.Findings), nil
		}
		return "", nil
	case "$llm_summary":
		if r := llmResultFromWalk(ws); r != nil && r.reviewResult != nil {
			return r.reviewResult.Summary, nil
		}
		return "", nil
	case "$llm_decision":
		if r := llmResultFromWalk(ws); r != nil && r.reviewResult != nil {
			return r.reviewResult.Decision, nil
		}
		return "", nil
	default:
		return "", fmt.Errorf("unknown runtime ref %q (available: %v)", ref, mcpRefNames)
	}
}
