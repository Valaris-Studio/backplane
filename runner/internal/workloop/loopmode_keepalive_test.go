// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// Keep-alive (card 5ffe97cf). A loop-off used to kill the process, so an
// operator who paused a board had to relaunch the runner by hand. With
// keep_alive the runner idles instead — heartbeating so it stays `alive`,
// spending nothing, and resuming when the loop is switched back on.
//
// The load-bearing distinction these tests defend: an operator turning the
// loop OFF is a pause; a RAIL turning it off (budget, max_iterations,
// completion_query) is the job ending. Keep-alive must survive the first and
// never the second — a keep-alive runner that resurrects a budget-exhausted
// run is a money leak.

// fakeAfter is the injected pacing seam. LoopMode's real backoff sleeps
// 30s/60s, which no unit test can afford; the fake records every requested
// delay and fires immediately, so the deltas are assertable in milliseconds.
type fakeAfter struct {
	delays []time.Duration
}

func (f *fakeAfter) after(d time.Duration) <-chan time.Time {
	f.delays = append(f.delays, d)
	ch := make(chan time.Time, 1)
	ch <- time.Now()
	return ch
}

// stopAfter returns a timer seam that fires instantly for the first n waits and
// then NEVER fires, cancelling ctx instead. A fake that keeps firing races the
// cancel: the idle select could take the ready timer, loop round, and issue its
// next config fetch on the already-cancelled context — surfacing as a transport
// error rather than the clean stop these tests are not about. Withholding the
// tick makes ctx.Done the only ready case, which is deterministic.
func (f *fakeAfter) stopAfter(n int, cancel context.CancelFunc) func(time.Duration) <-chan time.Time {
	return func(d time.Duration) <-chan time.Time {
		f.delays = append(f.delays, d)
		if len(f.delays) >= n {
			cancel()
			return make(chan time.Time) // never fires
		}
		ch := make(chan time.Time, 1)
		ch <- time.Now()
		return ch
	}
}

// setHistoryBody swaps the scripted GET .../loop/history payload mid-run, so a
// test can model the fresh budget_epoch the platform reports after an operator
// re-enables a loop.
func (s *loopModeServer) setHistoryBody(body string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.historyBody = body
}

func (s *loopModeServer) historyCallCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.historyCalls
}

// heartbeatLoopStates projects every recorded heartbeat down to its loop_state,
// which is the only field the latching-fallback tests care about.
func (s *loopModeServer) heartbeatLoopStates() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.heartbeatBodies))
	for _, hb := range s.heartbeatBodies {
		state, _ := hb["loop_state"].(string)
		out = append(out, state)
	}
	return out
}

// TestLoopMode_KeepAliveOff_DisabledStillExits is the regression fence for
// every existing invocation: with keep_alive unset the disabled branch must
// behave exactly as it did before this card — one config fetch, no session,
// return.
func TestLoopMode_KeepAliveOff_DisabledStillExits(t *testing.T) {
	disabled := baseLoopConfig()
	disabled.Enabled = false
	srv := newLoopModeServer(t, loopConfigJSON(t, disabled))
	provider := llm.NewMockProvider()
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := srv.getLoopCallCount(); got != 1 {
		t.Errorf("GetBoardLoop called %d times, want exactly 1 — keep_alive=false must not idle", got)
	}
	if provider.CallCount() != 0 {
		t.Errorf("provider called %d times, want 0", provider.CallCount())
	}
}

// TestLoopMode_SetKeepAliveFalse_StillExits closes the gap the fence above
// leaves open: it never CALLS SetKeepAlive, so a setter that ignored its
// argument and always latched on would satisfy it. An operator explicitly
// turning keep-alive off (`-keep-alive=false` over a profile that enables it)
// must still exit.
func TestLoopMode_SetKeepAliveFalse_StillExits(t *testing.T) {
	disabled := baseLoopConfig()
	disabled.Enabled = false
	srv := newLoopModeServer(t, loopConfigJSON(t, disabled))
	m := newLoopModeForServer(t, srv, llm.NewMockProvider())
	m.SetKeepAlive(true)
	m.SetKeepAlive(false) // the explicit opt-out wins
	fake := &fakeAfter{}
	m.SetAfter(fake.after)

	done := make(chan error, 1)
	go func() { done <- m.Run(context.Background()) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return — SetKeepAlive(false) did not turn keep-alive off")
	}
	if len(fake.delays) != 0 {
		t.Errorf("runner idled %d times with keep-alive explicitly off", len(fake.delays))
	}
	if got := srv.getLoopCallCount(); got != 1 {
		t.Errorf("GetBoardLoop called %d times, want exactly 1", got)
	}
}

// TestLoopMode_KeepAlive_IdlesInsteadOfExiting proves the core behaviour: a
// disabled board no longer ends the process. The runner keeps asking, keeps
// heartbeating as idle_waiting, and pays for nothing while it waits.
func TestLoopMode_KeepAlive_IdlesInsteadOfExiting(t *testing.T) {
	disabled := baseLoopConfig()
	disabled.Enabled = false
	enabled := baseLoopConfig()
	enabled.MaxIterations = 1
	srv := newLoopModeServer(t,
		loopConfigJSON(t, disabled),
		loopConfigJSON(t, disabled),
		loopConfigJSON(t, enabled),
	)
	provider := llm.NewMockProvider("worked once the loop came back")
	m := newLoopModeForServer(t, srv, provider)
	m.SetKeepAlive(true)
	fake := &fakeAfter{}
	m.SetAfter(fake.after)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if got := srv.getLoopCallCount(); got < 3 {
		t.Fatalf("GetBoardLoop called %d times, want >= 3 — the runner exited on the disabled fetch instead of idling", got)
	}
	if provider.CallCount() != 1 {
		t.Errorf("provider called %d times, want 1 (only after the loop was re-enabled)", provider.CallCount())
	}

	idle := srv.heartbeatBodyAt(0)
	if idle == nil {
		t.Fatal("idle tick sent no heartbeat body — the platform cannot tell a waiting runner from a dead one")
	}
	if got := idle["loop_state"]; got != "idle_waiting" {
		t.Errorf("loop_state = %v, want idle_waiting", got)
	}
	if got := idle["loop_board_id"]; got != "board-1" {
		t.Errorf("loop_board_id = %v, want board-1", got)
	}
	if got, _ := idle["loop_parked_since"].(string); got == "" {
		t.Error("loop_parked_since empty on an idle heartbeat — the operator cannot tell a 30s wait from a 3h one")
	}
	if got, _ := idle["loop_park_reason"].(string); got == "" {
		t.Error("loop_park_reason empty — an idle runner with no stated reason is the opaque silence this card removes")
	}
}

// TestLoopMode_KeepAlive_NoReadinessProbeWhileIdle proves the idle branch sits
// ABOVE the readiness pre-flight: probing a board whose loop is off is a
// pointless request against a disabled run.
func TestLoopMode_KeepAlive_NoReadinessProbeWhileIdle(t *testing.T) {
	disabled := baseLoopConfig()
	disabled.Enabled = false
	srv := newLoopModeServer(t,
		loopConfigJSON(t, disabled),
		loopConfigJSON(t, disabled),
		loopConfigJSON(t, disabled),
	)
	// Readiness would report NOT actionable if it were ever consulted, so a
	// probe that leaks into the idle path shows up as a park, not as noise.
	srv.readinessBodies = []string{readinessJSON(false, 0, 3, 3, 3)}
	m := newLoopModeForServer(t, srv, llm.NewMockProvider())
	m.SetKeepAlive(true)
	fake := &fakeAfter{}
	// Ending the run from inside the timer seam avoids cancelling ctx while an
	// HTTP fetch is in flight, which would surface as a fetch error rather than
	// the clean stop this test is not about.
	ctx, cancel := context.WithCancel(context.Background())
	m.SetAfter(fake.stopAfter(3, cancel))
	if err := m.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if got := srv.readinessCallCount(); got != 0 {
		t.Errorf("GetLoopReadiness called %d times while the loop was OFF, want 0", got)
	}
	if got := srv.executionStartCount(); got != 0 {
		t.Errorf("%d execution rows logged while idle, want 0 — idling must cost nothing", got)
	}
	if got := srv.patchCount(); got != 0 {
		t.Errorf("PATCH .../loop/state called %d times while idling, want 0 — waiting is not a rail trip", got)
	}
}

// TestLoopMode_KeepAlive_BackoffDeltasStayUnderLiveness pins the pacing. The
// backend marks an agent offline after ALIVE_THRESHOLD_SECONDS = 90s without a
// heartbeat, so an idle runner that backs off past that window flickers
// offline in the UI while it is perfectly healthy.
func TestLoopMode_KeepAlive_BackoffDeltasStayUnderLiveness(t *testing.T) {
	disabled := baseLoopConfig()
	disabled.Enabled = false
	srv := newLoopModeServer(t, loopConfigJSON(t, disabled))
	m := newLoopModeForServer(t, srv, llm.NewMockProvider())
	m.SetKeepAlive(true)
	fake := &fakeAfter{}
	ctx, cancel := context.WithCancel(context.Background())
	m.SetAfter(fake.stopAfter(5, cancel))
	if err := m.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if len(fake.delays) < 4 {
		t.Fatalf("observed %d idle delays, want >= 4", len(fake.delays))
	}
	want := []time.Duration{30 * time.Second, 60 * time.Second, 60 * time.Second, 60 * time.Second}
	for i, w := range want {
		if fake.delays[i] != w {
			t.Errorf("idle delay[%d] = %v, want %v", i, fake.delays[i], w)
		}
	}
	for i, d := range fake.delays {
		if d >= 90*time.Second {
			t.Errorf("idle delay[%d] = %v >= the backend's 90s liveness threshold — the runner would read offline while healthy", i, d)
		}
	}
}

// TestLoopMode_KeepAlive_WakeResetsContinuitySeed is the money test for the
// resume path. Re-enabling a loop resets budget_epoch server-side, so a runner
// that carries the previous epoch's `spent` across the wake disables itself on
// the first cycle for a budget it has not actually spent.
func TestLoopMode_KeepAlive_WakeResetsContinuitySeed(t *testing.T) {
	disabled := baseLoopConfig()
	disabled.Enabled = false
	enabled := baseLoopConfig()
	enabled.MaxIterations = 9 // wide: the BUDGET is what must stop this run, if anything does
	enabled.BudgetUSD = 20.0

	// The run must SEED before it idles, or the reset has nothing to undo and
	// the assertion below is vacuous: enabled (seed, spend the epoch) → the
	// operator switches it off → re-enabled on a fresh epoch.
	srv := newLoopModeServer(t,
		loopConfigJSON(t, enabled),
		loopConfigJSON(t, disabled),
		loopConfigJSON(t, enabled),
		loopConfigJSON(t, disabled), // second idle: the run ends here, not on a rail
	)
	// The CLOSED epoch spent almost the whole budget. When the operator
	// re-enables, the platform opens a FRESH epoch at $0 — and the runner can
	// only learn that by re-seeding. Carrying $19.90 across the wake trips the
	// budget rail on the first post-wake cycle, for money it never spent.
	srv.historyBody = `{"iteration_count":4,"spent_usd":19.9,"lifetime_spent_usd":19.9,"budget_epoch":"epoch-1"}`
	provider := llm.NewMockProvider("before the pause", "after the wake")
	m := newLoopModeForServer(t, srv, provider)
	m.SetKeepAlive(true)
	fake := &fakeAfter{}
	ctx, cancel := context.WithCancel(context.Background())
	m.SetAfter(fake.stopAfter(2, cancel))

	go func() {
		// Fresh epoch appears exactly when the operator's pause begins.
		for srv.getLoopCallCount() < 2 {
			time.Sleep(time.Millisecond)
		}
		srv.setHistoryBody(`{"iteration_count":5,"spent_usd":0,"lifetime_spent_usd":19.9,"budget_epoch":"epoch-2"}`)
	}()

	if err := m.Run(ctx); err != nil {
		t.Fatalf("Run: %v", err)
	}

	// Two seeds: once at startup, once on the wake. One means the wake reused
	// the closed epoch's numbers.
	if got := srv.historyCallCount(); got < 2 {
		t.Errorf("GetLoopHistory called %d times, want 2 — the wake did not re-seed, so the runner still carries epoch-1's $19.90", got)
	}
	// $19.90 of a $20 budget leaves no room: without the re-seed the budget
	// rail fires on the first post-wake cycle and this session never runs.
	if provider.CallCount() != 2 {
		t.Errorf("provider called %d times, want 2 — the post-wake iteration was suppressed by the CLOSED epoch's spend", provider.CallCount())
	}
	for _, p := range srv.statePatches() {
		if reason, _ := p["reason"].(string); strings.Contains(reason, "budget") {
			t.Errorf("runner disabled the board with %q — it charged the new epoch for the old one's money", reason)
		}
	}
}

// TestLoopMode_KeepAlive_RailTrippedDisableStillExits is the sharpest test on
// this card. A budget-exhausted run turns the loop off through the SAME flag a
// paused board uses; only the ordering of the checks keeps keep-alive from
// resurrecting a run that spent its money.
func TestLoopMode_KeepAlive_RailTrippedDisableStillExits(t *testing.T) {
	broke := baseLoopConfig()
	broke.BudgetUSD = 5.0
	srv := newLoopModeServer(t, loopConfigJSON(t, broke))
	srv.historyBody = `{"iteration_count":2,"spent_usd":9.99,"lifetime_spent_usd":9.99,"budget_epoch":"epoch-1"}`
	provider := llm.NewMockProvider()
	m := newLoopModeForServer(t, srv, provider)
	m.SetKeepAlive(true)
	fake := &fakeAfter{}
	m.SetAfter(fake.after)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if provider.CallCount() != 0 {
		t.Errorf("provider called %d times on an exhausted budget, want 0", provider.CallCount())
	}
	if len(fake.delays) != 0 {
		t.Fatalf("the runner idled (%d delays) after a BUDGET rail tripped — keep-alive must never outlive the money", len(fake.delays))
	}
	patches := srv.statePatches()
	if len(patches) == 0 {
		t.Fatal("no PATCH .../loop/state — the budget rail did not disable the board")
	}
	if reason, _ := patches[0]["reason"].(string); reason == "" {
		t.Error("rail disable carried no reason")
	}
}

// TestLoopMode_KeepAlive_ContextCancelWhileIdle proves SIGINT still works while
// waiting: a clean nil return and, critically, no PATCH — a runner shutting
// down must not flip the operator's board flag on its way out.
func TestLoopMode_KeepAlive_ContextCancelWhileIdle(t *testing.T) {
	disabled := baseLoopConfig()
	disabled.Enabled = false
	srv := newLoopModeServer(t, loopConfigJSON(t, disabled))
	m := newLoopModeForServer(t, srv, llm.NewMockProvider())
	m.SetKeepAlive(true)
	// Deliberately NOT stubbing `after`: a real 30s sleep would hang the test
	// unless ctx.Done() genuinely races the timer, which is the contract.
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		for srv.heartbeatCount() < 1 {
			time.Sleep(time.Millisecond)
		}
		cancel()
	}()

	done := make(chan error, 1)
	go func() { done <- m.Run(ctx) }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return within 5s of ctx cancel — the idle wait ignores cancellation")
	}
	if got := srv.patchCount(); got != 0 {
		t.Errorf("PATCH .../loop/state called %d times on shutdown, want 0", got)
	}
}

// TestLoopMode_KeepAlive_HeartbeatRejectionLatchesToParked covers the deploy
// window where the runner ships before the backend literal. An old backend
// 422s the unknown loop_state; without the latch the heartbeat fails on every
// idle tick, last_seen_at stalls, and the runner reads offline. The latch must
// also re-send immediately — waiting out the next backoff would gap ~120s,
// past the 90s liveness threshold.
func TestLoopMode_KeepAlive_HeartbeatRejectionLatchesToParked(t *testing.T) {
	disabled := baseLoopConfig()
	disabled.Enabled = false
	enabled := baseLoopConfig()
	enabled.MaxIterations = 1
	// Three idle cycles, then the loop comes back and the run ends on the
	// max_iterations rail — a natural stop, so no cancellation can race the
	// in-flight config fetch and mask the heartbeat sequence under test.
	srv := newLoopModeServer(t,
		loopConfigJSON(t, disabled),
		loopConfigJSON(t, disabled),
		loopConfigJSON(t, disabled),
		loopConfigJSON(t, enabled),
	)
	srv.rejectLoopState = "idle_waiting" // pre-rollout backend
	m := newLoopModeForServer(t, srv, llm.NewMockProvider("worked"))
	m.SetKeepAlive(true)
	fake := &fakeAfter{}
	m.SetAfter(fake.after)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	states := srv.heartbeatLoopStates()
	if len(states) < 3 {
		t.Fatalf("observed %d heartbeats, want >= 3", len(states))
	}
	if states[0] != "idle_waiting" {
		t.Errorf("heartbeat[0] loop_state = %q, want idle_waiting (the runner must try the real state first)", states[0])
	}
	if states[1] != valaris.LoopStateParked {
		t.Errorf("heartbeat[1] loop_state = %q, want %q — the 422 did not trigger a parked re-send", states[1], valaris.LoopStateParked)
	}
	for i, s := range states[1:] {
		if s == "idle_waiting" {
			t.Errorf("heartbeat[%d] loop_state = idle_waiting after the latch — the fallback did not latch for the process lifetime", i+1)
		}
	}

	// IMMEDIACY, not just eventual correctness. Counting states alone cannot
	// tell "retried in the same tick" from "gave up and sent parked on the
	// NEXT tick" — both produce [idle_waiting, parked, ...]. Three idle cycles
	// with a same-tick retry means 4 beats (idle+parked, parked, parked) before
	// the ticking one; deferring the retry means only 3. A gap of a whole
	// backoff (~120s total) exceeds ALIVE_THRESHOLD_SECONDS=90 and flickers the
	// agent offline exactly once.
	idleBeats := 0
	for _, s := range states {
		if s == "idle_waiting" || s == valaris.LoopStateParked {
			idleBeats++
		}
	}
	if idleBeats < 4 {
		t.Errorf("%d idle-cycle heartbeats across 3 idle cycles (states=%v) — the 422 retry was deferred to the next tick, gapping last_seen_at past the 90s liveness threshold", idleBeats, states)
	}
}
