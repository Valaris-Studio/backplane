// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// TestResolveMCPArgs_SelfSubstitutes confirms $self -> l.client.UserID lands
// inside the dispatched mcp_call (remove_card_participant). The kindHandlersServer
// records every request path; a hit on /participants/<userID> proves the
// resolver fed the substituted value to the tool handler, not the literal "$self".
func TestResolveMCPArgs_SelfSubstitutes(t *testing.T) {
	srv, rec := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c1", BoardID: "b"})
	step := &valaris.LifecycleStep{
		Name: "uns", Kind: "mcp_call",
		Params: map[string]any{
			"tool": "remove_card_participant",
			"args": map[string]any{"user_id": "$self"},
		},
	}
	if _, _, err := lifecycleMCPCall(context.Background(), ws, step); err != nil {
		t.Fatalf("mcp_call: %v", err)
	}
	wantPath := "/participants/" + loop.client.UserID
	found := false
	for _, h := range rec.hits {
		if strings.Contains(h, wantPath) && strings.HasPrefix(h, "DELETE ") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected DELETE on %s, hits=%v", wantPath, rec.hits)
	}
}

// TestResolveMCPArgs_LiteralPassesThrough — non-$ strings reach the handler
// unchanged. Verifies the resolver doesn't mangle ordinary args.
func TestResolveMCPArgs_LiteralPassesThrough(t *testing.T) {
	ws := &lifecycle.WalkState{Loop: &Loop{client: &valaris.Client{UserID: "user-1"}}}
	out, err := resolveMCPArgs(ws, map[string]any{"user_id": "literal-uuid"})
	if err != nil {
		t.Fatalf("resolveMCPArgs: %v", err)
	}
	if got := out["user_id"]; got != "literal-uuid" {
		t.Errorf("user_id = %v, want literal-uuid", got)
	}
}

// TestResolveMCPArgs_NilArgs — args==nil is a no-op (no error, no panic).
func TestResolveMCPArgs_NilArgs(t *testing.T) {
	ws := &lifecycle.WalkState{Loop: &Loop{client: &valaris.Client{}}}
	out, err := resolveMCPArgs(ws, nil)
	if err != nil {
		t.Fatalf("resolveMCPArgs(nil): %v", err)
	}
	if out != nil {
		t.Errorf("want nil out, got %v", out)
	}
}

// TestResolveMCPArgs_UnknownRefErrors — typos and future refs error fast with
// a list of supported names so operators can fix their config without grepping.
func TestResolveMCPArgs_UnknownRefErrors(t *testing.T) {
	ws := &lifecycle.WalkState{Loop: &Loop{client: &valaris.Client{}}}
	_, err := resolveMCPArgs(ws, map[string]any{"x": "$nope"})
	if err == nil {
		t.Fatal("want error on unknown ref")
	}
	msg := err.Error()
	if !strings.Contains(msg, "$nope") || !strings.Contains(msg, "$self") {
		t.Errorf("error %q missing ref context", msg)
	}
}

// TestResolveMCPArgs_LastDecision pulls from ws.LastDecision. Used by lifecycles
// that want to forward the producing-step's decision into a tool call.
func TestResolveMCPArgs_LastDecision(t *testing.T) {
	ws := &lifecycle.WalkState{
		Loop:         &Loop{client: &valaris.Client{}},
		LastDecision: "approve",
	}
	out, err := resolveMCPArgs(ws, map[string]any{"verdict": "$last_decision"})
	if err != nil {
		t.Fatalf("resolveMCPArgs: %v", err)
	}
	if got := out["verdict"]; got != "approve" {
		t.Errorf("verdict = %v, want approve", got)
	}
}

// TestResolveMCPArgs_CardID needs a discover'd card on the walk state.
func TestResolveMCPArgs_CardID(t *testing.T) {
	ws := &lifecycle.WalkState{
		Loop: &Loop{client: &valaris.Client{}},
		Card: &discoverResult{CardID: "card-42", BoardID: "b"},
	}
	out, err := resolveMCPArgs(ws, map[string]any{"card_id": "$card_id"})
	if err != nil {
		t.Fatalf("resolveMCPArgs: %v", err)
	}
	if got := out["card_id"]; got != "card-42" {
		t.Errorf("card_id = %v, want card-42", got)
	}
}

// TestResolveMCPArgs_AgentIDNilSafe — pre-Init clients (or unlinked API keys)
// have Agent==nil. $agent_id resolves to "" without panicking; the tool handler
// decides whether empty is acceptable.
func TestResolveMCPArgs_AgentIDNilSafe(t *testing.T) {
	ws := &lifecycle.WalkState{Loop: &Loop{client: &valaris.Client{}}}
	out, err := resolveMCPArgs(ws, map[string]any{"agent_id": "$agent_id"})
	if err != nil {
		t.Fatalf("resolveMCPArgs: %v", err)
	}
	if got := out["agent_id"]; got != "" {
		t.Errorf("agent_id = %v, want empty string", got)
	}
}

// TestResolveMCPArgs_NestedNotRecursed — nested objects pass through verbatim.
// Documents the leaf-only contract so future authors know they need to flatten.
func TestResolveMCPArgs_NestedNotRecursed(t *testing.T) {
	ws := &lifecycle.WalkState{Loop: &Loop{client: &valaris.Client{UserID: "u"}}}
	nested := map[string]any{"inner": "$self"}
	out, err := resolveMCPArgs(ws, map[string]any{"fields": nested})
	if err != nil {
		t.Fatalf("resolveMCPArgs: %v", err)
	}
	got := out["fields"].(map[string]any)
	if got["inner"] != "$self" {
		t.Errorf("nested $self should NOT be resolved; got %v", got["inner"])
	}
}

// TestMCPCall_RemoveCardParticipant_PipelineRoleSelectsTheByRoleRoute pins
// the MCP #4 fold: pipeline_role on remove_card_participant clears every
// holder of the stage role, the shape the default rework step now uses.
func TestMCPCall_RemoveCardParticipant_PipelineRoleSelectsTheByRoleRoute(t *testing.T) {
	srv, rec := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c1", BoardID: "b"})
	step := &valaris.LifecycleStep{
		Name: "clear", Kind: "mcp_call",
		Params: map[string]any{
			"tool": "remove_card_participant",
			"args": map[string]any{"pipeline_role": "implementer"},
		},
	}
	if _, _, err := lifecycleMCPCall(context.Background(), ws, step); err != nil {
		t.Fatalf("mcp_call: %v", err)
	}
	found := false
	for _, h := range rec.hits {
		if strings.HasPrefix(h, "DELETE ") && strings.Contains(h, "/participants/by-pipeline-role/implementer") {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("expected DELETE on the by-pipeline-role route, hits=%v", rec.hits)
	}
}

// TestMCPCall_RemoveCardParticipant_RequiresExactlyOneSelector: neither or
// both selectors is a config error, surfaced before any request.
func TestMCPCall_RemoveCardParticipant_RequiresExactlyOneSelector(t *testing.T) {
	srv, rec := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c1", BoardID: "b"})
	for name, args := range map[string]map[string]any{
		"neither": {},
		"both":    {"user_id": "u1", "pipeline_role": "implementer"},
	} {
		step := &valaris.LifecycleStep{Name: name, Kind: "mcp_call", Params: map[string]any{"tool": "remove_card_participant", "args": args}}
		if _, _, err := lifecycleMCPCall(context.Background(), ws, step); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
	for _, h := range rec.hits {
		if strings.HasPrefix(h, "DELETE ") {
			t.Errorf("no DELETE must be issued on a selector error, hits=%v", rec.hits)
		}
	}
}

