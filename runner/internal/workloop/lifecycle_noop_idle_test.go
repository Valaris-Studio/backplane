// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// A lifecycle that completes WITHOUT engaging a card (no discover, or discover
// found nothing) is an IDLE tick, not productive work. The disabled-documentator
// shape — a bare `end` terminator with llm.enabled=false — is the canonical case:
// it touches no card yet the walker returns nil (clean exit).
//
// REGRESSION: tickViaLifecycle's clean-exit path unconditionally set
// lastTickHadWork=true, so this no-op reported "work". In the multi-role
// scheduler that is catastrophic: scheduledTick returns the moment a role
// reports work, so a no-op role sitting mid-priority_order (documentator, 5th of
// 6) terminated every fast-forward walk one slot early and the tail role
// (ui_validator, 6th) was NEVER reached. selfTriggerIfProductive then re-armed on
// the phantom "work", spinning the same stalled walk. Proven live 2026-06-03:
// scheduler.Len()==6, walk reached documentator at attempt 4, documentator
// reported work, ui_validator never ticked.
//
// The fix: a clean walk that engaged no card (ws.Card == nil) is idle —
// IncrementIdleBackoff + lastTickHadWork=false — exactly like ErrNoWork.
func TestLifecycle_NoCardEngaged_IsIdleNotWork(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		// No next-assignment is reached: the lifecycle is a bare end with no
		// discover step, so the walk engages no card. Any stray call → empty.
		w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	// Mirror the live disabled-documentator stage: llm off, lifecycle is just end.
	stage := valaris.StageConfig{
		Role: "documentator",
		LLM:  valaris.LLMDef{Enabled: false, Stage: "document"},
		Lifecycle: []valaris.LifecycleStep{
			{Name: "documentator_disabled_end", Kind: "end"},
		},
	}

	// scheduledTick pre-clears lastTickHadWork before every Tick (loop.go) and
	// reads it after to decide work-vs-idle. Mirror that contract: a no-op tick
	// must leave it false so the scheduler fast-forwards past this role.
	loop.lastTickHadWork = false
	s := NewDataDrivenStrategy(stage, nil)
	if err := s.Tick(context.Background(), loop); err != nil {
		t.Fatalf("Tick: unexpected error %v", err)
	}

	if loop.lastTickHadWork {
		t.Errorf("a no-op lifecycle (bare end, no card engaged) must report IDLE, " +
			"not work — else it short-circuits the multi-role scheduler walk before " +
			"the tail role (e.g. ui_validator) is reached")
	}
}
