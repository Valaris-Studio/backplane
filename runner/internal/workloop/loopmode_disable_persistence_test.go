// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// railScenario drives Run into one specific safety rail. Each scenario owns
// the config knob and provider script that trip its rail on the first cycle,
// plus the fragment the disable reason must carry.
type railScenario struct {
	name           string
	configure      func(*loopModeServer) *LoopMode
	reasonFragment string
}

func railScenarios(t *testing.T) []railScenario {
	t.Helper()
	return []railScenario{
		{
			name: "max_iterations",
			configure: func(srv *loopModeServer) *LoopMode {
				return newLoopModeForServer(t, srv, llm.NewMockProvider("only response"))
			},
			reasonFragment: "max_iterations",
		},
		{
			name: "budget",
			configure: func(srv *loopModeServer) *LoopMode {
				provider := llm.NewMockProvider("expensive output")
				provider.InputTokens = 100_000
				provider.OutputTokens = 100_000
				return newLoopModeForServer(t, srv, provider)
			},
			reasonFragment: "budget_usd exhausted",
		},
		{
			name: "consecutive_failures",
			configure: func(srv *loopModeServer) *LoopMode {
				return newLoopModeForServer(t, srv, &scriptedProvider{results: []scriptedResult{
					{result: &llm.Result{ExitCode: 1}, err: errors.New("boom 1")},
					{result: &llm.Result{ExitCode: 1}, err: errors.New("boom 2")},
				}})
			},
			reasonFragment: "consecutive failed iterations",
		},
	}
}

// railServer builds the scripted server for one rail scenario. The config
// knobs mirror the single-rail tests above (TestLoopMode_MaxIterationsRail
// and friends) so each scenario trips exactly its own rail.
func railServer(t *testing.T, scenario string, failPatch bool) *loopModeServer {
	t.Helper()
	cfg := baseLoopConfig()
	switch scenario {
	case "max_iterations":
		cfg.MaxIterations = 1
	case "budget":
		cfg.BudgetUSD = 0.0001
	case "consecutive_failures":
		cfg.MaxConsecutiveFailures = 2
	default:
		t.Fatalf("unknown rail scenario %q", scenario)
	}
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	srv.failPatch = failPatch
	return srv
}

// TestLoopMode_RailExit_DisablePatchFailure_IsFatal proves the runner does
// NOT exit 0 when the stop it decided on never reached the board. A rail
// trips, the disable PATCH 500s, the board stays ENABLED — so the next
// launch would resume iterating and spending against a rail that already
// fired. Run must surface that as an error naming the un-persisted stop and
// the reason it tried to record, so the operator sees a failed exit rather
// than a silent, spend-resuming success.
func TestLoopMode_RailExit_DisablePatchFailure_IsFatal(t *testing.T) {
	for _, tc := range railScenarios(t) {
		t.Run(tc.name, func(t *testing.T) {
			srv := railServer(t, tc.name, true)
			m := tc.configure(srv)

			err := m.Run(context.Background())
			if err == nil {
				t.Fatal("Run returned nil after a failed disable PATCH — the board is still enabled and the process exited clean")
			}
			if !strings.Contains(err.Error(), tc.reasonFragment) {
				t.Errorf("error = %q, want it to name the disable reason %q", err, tc.reasonFragment)
			}
			if srv.patchCount() != 1 {
				t.Errorf("PATCH .../loop/state called %d times, want exactly 1 — the disable must never retry-loop", srv.patchCount())
			}
		})
	}
}

// TestLoopMode_RailExit_DisablePatchSuccess_StaysClean is the control: the
// same three rails with a healthy PATCH still return nil. Without this, the
// test above would pass on an implementation that simply errors on every
// rail exit.
func TestLoopMode_RailExit_DisablePatchSuccess_StaysClean(t *testing.T) {
	for _, tc := range railScenarios(t) {
		t.Run(tc.name, func(t *testing.T) {
			srv := railServer(t, tc.name, false)
			m := tc.configure(srv)

			if err := m.Run(context.Background()); err != nil {
				t.Fatalf("Run: %v — a rail exit whose disable persisted is a normal, successful stop", err)
			}
			if srv.patchCount() != 1 {
				t.Errorf("PATCH .../loop/state called %d times, want 1", srv.patchCount())
			}
			reason, _ := srv.lastPatch()["reason"].(string)
			if !strings.Contains(reason, tc.reasonFragment) {
				t.Errorf("reason = %q, want it to mention %q", reason, tc.reasonFragment)
			}
		})
	}
}

// TestLoopMode_DisabledAtFetch_UnaffectedByPatchHealth pins the exit path the
// card puts out of scope: a loop already off in config never PATCHes at all,
// so a broken PATCH endpoint cannot turn that clean observation into an error.
func TestLoopMode_DisabledAtFetch_UnaffectedByPatchHealth(t *testing.T) {
	disabled := baseLoopConfig()
	disabled.Enabled = false
	srv := newLoopModeServer(t, loopConfigJSON(t, disabled))
	srv.failPatch = true
	m := newLoopModeForServer(t, srv, llm.NewMockProvider())

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v — a disabled-at-fetch exit stays clean regardless of PATCH health", err)
	}
	if srv.patchCount() != 0 {
		t.Errorf("PATCH .../loop/state called %d times, want 0", srv.patchCount())
	}
}
