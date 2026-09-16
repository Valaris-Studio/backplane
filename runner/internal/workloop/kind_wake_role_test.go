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

// Single-role runners have l.scheduler == nil, so WakeRole is a silent no-op.
// The handler must still complete cleanly: no panic, no error, decision empty.
func TestKindWakeRole_HappyPathSingleRole(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c", BoardID: "b"})
	step := &valaris.LifecycleStep{
		Name:   "wake",
		Kind:   "wake_role",
		Params: map[string]any{"roles": []any{"documentator", "orchestrator"}},
	}
	dec, next, err := lifecycleWakeRole(context.Background(), ws, step)
	if err != nil {
		t.Fatalf("wake_role: %v", err)
	}
	if dec != "" || next != "" {
		t.Errorf("dec=%q next=%q, want both empty", dec, next)
	}
}

func TestKindWakeRole_TypedSliceAccepted(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c", BoardID: "b"})
	step := &valaris.LifecycleStep{
		Name:   "wake",
		Kind:   "wake_role",
		Params: map[string]any{"roles": []string{"documentator"}},
	}
	if _, _, err := lifecycleWakeRole(context.Background(), ws, step); err != nil {
		t.Fatalf("wake_role with []string: %v", err)
	}
}

func TestKindWakeRole_EmptyRolesIsConfigError(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c", BoardID: "b"})
	step := &valaris.LifecycleStep{Name: "wake", Kind: "wake_role"}
	_, _, err := lifecycleWakeRole(context.Background(), ws, step)
	if err == nil || !strings.Contains(err.Error(), "roles") {
		t.Errorf("want missing-roles error, got: %v", err)
	}
}

func TestKindWakeRole_NonStringEntryRejected(t *testing.T) {
	srv, _ := kindHandlersServer(t, "b")
	loop := newLoopForKindTest(t, srv.URL)
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "c", BoardID: "b"})
	step := &valaris.LifecycleStep{
		Name:   "wake",
		Kind:   "wake_role",
		Params: map[string]any{"roles": []any{"documentator", 42}},
	}
	_, _, err := lifecycleWakeRole(context.Background(), ws, step)
	if err == nil || !strings.Contains(err.Error(), "strings") {
		t.Errorf("want only-strings error, got: %v", err)
	}
}

// The bridge init() must register wake_role; this is a belt-and-suspenders
// check on top of TestKindHandlers_AllKindsRegistered.
func TestKindWakeRole_RegisteredInBridge(t *testing.T) {
	if _, ok := lifecycle.Handlers["wake_role"]; !ok {
		t.Fatal("wake_role handler missing from lifecycle.Handlers")
	}
}
