// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package lifecycle

import (
	"context"
	"errors"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// withHandlers swaps the global Handlers map for the duration of a test.
// Tests register fake handlers per-kind without polluting other tests.
func withHandlers(t *testing.T, fakes map[string]Handler) {
	t.Helper()
	prev := Handlers
	t.Cleanup(func() { Handlers = prev })
	cp := make(map[string]Handler, len(fakes))
	for k, v := range fakes {
		cp[k] = v
	}
	Handlers = cp
}

// recordCalls returns a handler that records its invocations and produces the
// configured decision. Used by routing-shape tests below.
func recordCalls(recorder *[]string, name string, decision string) Handler {
	return func(_ context.Context, _ *WalkState, step *valaris.LifecycleStep) (string, string, error) {
		*recorder = append(*recorder, name+":"+step.Name)
		return decision, "", nil
	}
}

func TestWalker_LinearSequence(t *testing.T) {
	var calls []string
	withHandlers(t, map[string]Handler{
		"discover": recordCalls(&calls, "discover", ""),
		"claim":    recordCalls(&calls, "claim", ""),
		"move_card": recordCalls(&calls, "move_card", ""),
	})

	steps := []valaris.LifecycleStep{
		{Name: "d", Kind: "discover", Next: "c"},
		{Name: "c", Kind: "claim", Next: "m"},
		{Name: "m", Kind: "move_card"}, // terminal → walker stops cleanly
	}

	ws := &WalkState{}
	if err := (Walker{}).Walk(context.Background(), ws, steps); err != nil {
		t.Fatalf("Walk: %v", err)
	}
	if got, want := calls, []string{"discover:d", "claim:c", "move_card:m"}; !equalSlice(got, want) {
		t.Errorf("call order = %v, want %v", got, want)
	}
}

func TestWalker_BranchingOnDecision(t *testing.T) {
	var calls []string
	withHandlers(t, map[string]Handler{
		"llm":         recordCalls(&calls, "llm", "approve"),
		"move_card":   recordCalls(&calls, "move_card", ""),
		"apply_label": recordCalls(&calls, "apply_label", ""),
		"end": func(_ context.Context, _ *WalkState, _ *valaris.LifecycleStep) (string, string, error) {
			return "", "", nil
		},
	})

	steps := []valaris.LifecycleStep{
		{Name: "review", Kind: "llm", Branches: map[string]string{
			"approve":         "ship",
			"request_changes": "reject",
		}},
		{Name: "ship", Kind: "move_card"},
		{Name: "reject", Kind: "apply_label", Next: "stop"},
		{Name: "stop", Kind: "end"},
	}

	ws := &WalkState{}
	if err := (Walker{}).Walk(context.Background(), ws, steps); err != nil {
		t.Fatalf("Walk: %v", err)
	}
	if got, want := calls, []string{"llm:review", "move_card:ship"}; !equalSlice(got, want) {
		t.Errorf("approve branch took %v, want %v", got, want)
	}
	if ws.LastDecision != "approve" {
		t.Errorf("LastDecision = %q, want approve", ws.LastDecision)
	}
}

func TestWalker_UnknownKindErrors(t *testing.T) {
	withHandlers(t, map[string]Handler{})
	steps := []valaris.LifecycleStep{{Name: "bogus", Kind: "no_such_kind"}}
	err := (Walker{}).Walk(context.Background(), &WalkState{}, steps)
	if err == nil || !contains(err.Error(), "unknown kind") {
		t.Errorf("want unknown-kind error, got: %v", err)
	}
}

func TestWalker_MissingHandlerErrors(t *testing.T) {
	// "discover" is a known kind but no handler is registered.
	withHandlers(t, map[string]Handler{})
	steps := []valaris.LifecycleStep{{Name: "d", Kind: "discover", Next: ""}}
	err := (Walker{}).Walk(context.Background(), &WalkState{}, steps)
	if err == nil || !contains(err.Error(), "no handler registered") {
		t.Errorf("want missing-handler error, got: %v", err)
	}
}

func TestWalker_DecisionFromNonProducerErrors(t *testing.T) {
	withHandlers(t, map[string]Handler{
		"discover": func(_ context.Context, _ *WalkState, _ *valaris.LifecycleStep) (string, string, error) {
			return "rogue_decision", "", nil
		},
	})
	steps := []valaris.LifecycleStep{{Name: "d", Kind: "discover", Next: ""}}
	err := (Walker{}).Walk(context.Background(), &WalkState{}, steps)
	if err == nil || !contains(err.Error(), "produces_decision") {
		t.Errorf("want produces_decision contract error, got: %v", err)
	}
}

func TestWalker_TerminalKindEndsWalk(t *testing.T) {
	var calls []string
	withHandlers(t, map[string]Handler{
		"move_card": recordCalls(&calls, "move_card", ""),
	})
	steps := []valaris.LifecycleStep{{Name: "m", Kind: "move_card"}}
	if err := (Walker{}).Walk(context.Background(), &WalkState{}, steps); err != nil {
		t.Fatalf("Walk: %v", err)
	}
	if len(calls) != 1 {
		t.Errorf("want 1 call, got %d", len(calls))
	}
}

func TestWalker_NonTerminalWithoutNextErrors(t *testing.T) {
	withHandlers(t, map[string]Handler{
		"discover": recordCalls(new([]string), "discover", ""),
	})
	steps := []valaris.LifecycleStep{{Name: "d", Kind: "discover"}}
	err := (Walker{}).Walk(context.Background(), &WalkState{}, steps)
	if err == nil || !contains(err.Error(), "no next/branches") {
		t.Errorf("want missing-next error, got: %v", err)
	}
}

func TestWalker_HandlerErrorPropagates(t *testing.T) {
	withHandlers(t, map[string]Handler{
		"discover": func(_ context.Context, _ *WalkState, _ *valaris.LifecycleStep) (string, string, error) {
			return "", "", errors.New("boom")
		},
	})
	steps := []valaris.LifecycleStep{{Name: "d", Kind: "discover", Next: ""}}
	err := (Walker{}).Walk(context.Background(), &WalkState{}, steps)
	if err == nil || !contains(err.Error(), "boom") {
		t.Errorf("want wrapped handler error, got: %v", err)
	}
}

func TestWalker_DuplicateStepNamesError(t *testing.T) {
	withHandlers(t, map[string]Handler{})
	steps := []valaris.LifecycleStep{
		{Name: "a", Kind: "discover", Next: "a"},
		{Name: "a", Kind: "claim"},
	}
	err := (Walker{}).Walk(context.Background(), &WalkState{}, steps)
	if err == nil || !contains(err.Error(), "duplicate step name") {
		t.Errorf("want duplicate-name error, got: %v", err)
	}
}

func TestWalker_LoopGuardTrips(t *testing.T) {
	var n int
	withHandlers(t, map[string]Handler{
		"discover": func(_ context.Context, _ *WalkState, _ *valaris.LifecycleStep) (string, string, error) {
			n++
			return "", "", nil
		},
	})
	steps := []valaris.LifecycleStep{
		{Name: "a", Kind: "discover", Next: "b"},
		{Name: "b", Kind: "discover", Next: "a"},
	}
	err := (Walker{}).Walk(context.Background(), &WalkState{}, steps)
	if err == nil || !contains(err.Error(), "MaxSteps") {
		t.Errorf("want MaxSteps error, got: %v", err)
	}
}

func TestWalker_EmptyBranchTargetTerminates(t *testing.T) {
	var calls []string
	withHandlers(t, map[string]Handler{
		"sensor": recordCalls(&calls, "sensor", "fail"),
	})
	steps := []valaris.LifecycleStep{
		{Name: "s", Kind: "sensor", Branches: map[string]string{"fail": ""}},
	}
	if err := (Walker{}).Walk(context.Background(), &WalkState{}, steps); err != nil {
		t.Fatalf("Walk: %v", err)
	}
	if len(calls) != 1 {
		t.Errorf("want exactly 1 call before empty-branch terminate, got %d", len(calls))
	}
}

func TestWalker_VariablesScratchpad(t *testing.T) {
	withHandlers(t, map[string]Handler{
		"mcp_call": func(_ context.Context, ws *WalkState, _ *valaris.LifecycleStep) (string, string, error) {
			ws.Set("result", "ok")
			return "", "", nil
		},
		"move_card": func(_ context.Context, ws *WalkState, _ *valaris.LifecycleStep) (string, string, error) {
			if ws.GetString("result") != "ok" {
				return "", "", errors.New("variables didn't propagate")
			}
			return "", "", nil
		},
	})
	steps := []valaris.LifecycleStep{
		{Name: "a", Kind: "mcp_call", Next: "b"},
		{Name: "b", Kind: "move_card"},
	}
	if err := (Walker{}).Walk(context.Background(), &WalkState{}, steps); err != nil {
		t.Fatalf("Walk: %v", err)
	}
}

func TestWalker_OnFailureRoutesToHandler(t *testing.T) {
	var calls []string
	withHandlers(t, map[string]Handler{
		"llm": func(_ context.Context, ws *WalkState, step *valaris.LifecycleStep) (string, string, error) {
			calls = append(calls, "llm:"+step.Name)
			return "", "", errors.New("transport boom")
		},
		"mcp_call":    recordCalls(&calls, "mcp_call", ""),
		"apply_label": recordCalls(&calls, "apply_label", ""),
		"end": func(_ context.Context, _ *WalkState, _ *valaris.LifecycleStep) (string, string, error) {
			return "", "", nil
		},
	})

	steps := []valaris.LifecycleStep{
		{Name: "generate", Kind: "llm", Next: "label_ok", OnFailure: "cleanup"},
		{Name: "label_ok", Kind: "apply_label", Next: "ok_end"},
		{Name: "ok_end", Kind: "end"},
		{Name: "cleanup", Kind: "mcp_call", Next: "label_fail"},
		{Name: "label_fail", Kind: "apply_label", Next: "fail_end"},
		{Name: "fail_end", Kind: "end"},
	}

	ws := &WalkState{}
	if err := (Walker{}).Walk(context.Background(), ws, steps); err != nil {
		t.Fatalf("Walk: %v", err)
	}
	want := []string{"llm:generate", "mcp_call:cleanup", "apply_label:label_fail"}
	if !equalSlice(calls, want) {
		t.Errorf("on_failure routing = %v, want %v", calls, want)
	}
	if ws.GetString("last_error") != "transport boom" {
		t.Errorf("last_error = %q, want %q", ws.GetString("last_error"), "transport boom")
	}
}

func TestWalker_OnFailureHandlerFailurePropagates(t *testing.T) {
	withHandlers(t, map[string]Handler{
		"llm": func(_ context.Context, _ *WalkState, _ *valaris.LifecycleStep) (string, string, error) {
			return "", "", errors.New("first boom")
		},
		"mcp_call": func(_ context.Context, _ *WalkState, _ *valaris.LifecycleStep) (string, string, error) {
			return "", "", errors.New("second boom")
		},
		"apply_label": recordCalls(new([]string), "apply_label", ""),
	})

	// cleanup's OnFailure points back at itself; if recursion were allowed this
	// would loop. We assert the SECOND error propagates, not the first.
	steps := []valaris.LifecycleStep{
		{Name: "generate", Kind: "llm", Next: "done", OnFailure: "cleanup"},
		{Name: "done", Kind: "apply_label"},
		{Name: "cleanup", Kind: "mcp_call", Next: "done", OnFailure: "cleanup"},
	}

	err := (Walker{}).Walk(context.Background(), &WalkState{}, steps)
	if err == nil || !contains(err.Error(), "second boom") {
		t.Errorf("want propagated 'second boom' error, got: %v", err)
	}
}

func TestWalker_OnFailureToUnknownStepErrors(t *testing.T) {
	withHandlers(t, map[string]Handler{
		"llm": func(_ context.Context, _ *WalkState, _ *valaris.LifecycleStep) (string, string, error) {
			return "", "", errors.New("boom")
		},
		"apply_label": recordCalls(new([]string), "apply_label", ""),
	})

	steps := []valaris.LifecycleStep{
		{Name: "generate", Kind: "llm", Next: "done", OnFailure: "ghost"},
		{Name: "done", Kind: "apply_label"},
	}

	err := (Walker{}).Walk(context.Background(), &WalkState{}, steps)
	if err == nil || !contains(err.Error(), "on_failure") || !contains(err.Error(), "ghost") {
		t.Errorf("want clear on_failure-dangling error, got: %v", err)
	}
}

func TestWalker_EmptyDecisionFromProducerRoutesToOnFailure(t *testing.T) {
	var calls []string
	withHandlers(t, map[string]Handler{
		"llm":         recordCalls(&calls, "llm", ""), // produced no parseable decision → ("","",nil)
		"mcp_call":    recordCalls(&calls, "mcp_call", ""),
		"move_card":   recordCalls(&calls, "move_card", ""),
		"apply_label": recordCalls(&calls, "apply_label", ""),
		"end": func(_ context.Context, _ *WalkState, _ *valaris.LifecycleStep) (string, string, error) {
			return "", "", nil
		},
	})

	// Mirrors the live review_diff / drive_ui shape: branches + on_failure, NO next.
	steps := []valaris.LifecycleStep{
		{Name: "review_diff", Kind: "llm",
			Branches:  map[string]string{"approve": "approve_end", "request_changes": "reject_end"},
			OnFailure: "decide_failed"},
		{Name: "approve_end", Kind: "move_card"},
		{Name: "reject_end", Kind: "apply_label", Next: "stop"},
		{Name: "stop", Kind: "end"},
		{Name: "decide_failed", Kind: "mcp_call", Next: "fail_end"},
		{Name: "fail_end", Kind: "end"},
	}

	ws := &WalkState{}
	if err := (Walker{}).Walk(context.Background(), ws, steps); err != nil {
		t.Fatalf("Walk: %v", err)
	}
	want := []string{"llm:review_diff", "mcp_call:decide_failed"}
	if !equalSlice(calls, want) {
		t.Errorf("empty-decision routing = %v, want %v (must route to on_failure, not branches)", calls, want)
	}
	if le := ws.GetString("last_error"); !contains(le, "no decision") {
		t.Errorf("last_error = %q, want it to mention 'no decision'", le)
	}
}

func TestWalker_EmptyDecisionNoOnFailureStillErrors(t *testing.T) {
	withHandlers(t, map[string]Handler{
		"llm": recordCalls(new([]string), "llm", ""),
	})
	steps := []valaris.LifecycleStep{
		{Name: "review_diff", Kind: "llm",
			Branches: map[string]string{"approve": "approve_end", "request_changes": "reject_end"}},
		{Name: "approve_end", Kind: "move_card"},
		{Name: "reject_end", Kind: "apply_label", Next: "stop"},
		{Name: "stop", Kind: "end"},
	}
	err := (Walker{}).Walk(context.Background(), &WalkState{}, steps)
	if err == nil || !contains(err.Error(), "no next/branches") {
		t.Errorf("want hard no-next/branches error for misconfigured decision step, got: %v", err)
	}
}

func equalSlice(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func contains(s, sub string) bool {
	return len(sub) == 0 || (len(s) >= len(sub) && (indexOf(s, sub) >= 0))
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
