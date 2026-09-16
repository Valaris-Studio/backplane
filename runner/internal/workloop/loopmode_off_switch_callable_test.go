// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// The allowlist-only pre-flight (card abf18fa9) asks "is set_board_loop in
// cfg.Tools?". Card ba778abd proved that question is the wrong one: on this
// very board the allowlist GRANTED the tool and the session still could not
// call it, because the gate that hid it lives client-side, past the allowlist.
// A grant the session cannot exercise is indistinguishable from no grant at
// all — so the pre-flight has to probe the endpoint the off-switch actually
// drives, under the session's own identity, rather than trust the manifest.

// TestLoopMode_OffSwitchCallablePreflight_WarnsWhenGrantedButUncallable is the
// regression that the allowlist-only check cannot express: the off-switch IS
// allowlisted, so warnMissingOffSwitch stays silent, yet PATCH /loop/state is
// refused for this identity. Exactly the three-run failure shape.
func TestLoopMode_OffSwitchCallablePreflight_WarnsWhenGrantedButUncallable(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.Tools = []string{"Bash", offSwitchTool} // granted — the old check is happy
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	srv.denyOffSwitchProbe = true // ...but the endpoint refuses this identity

	provider := llm.NewMockProvider("ok")
	m := newLoopModeForServer(t, srv, provider)

	var buf strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&lockedWriter{mu: &sync.Mutex{}, b: &buf}, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	// Diagnostic, never a gate: an unreachable off-switch is exactly when the
	// operator most needs the run's work to still happen.
	if provider.CallCount() != 1 {
		t.Errorf("provider called %d times, want 1 — the pre-flight must not stop the loop", provider.CallCount())
	}
	if got := strings.Count(buf.String(), offSwitchUncallableWarning); got != 1 {
		t.Errorf("uncallable warning appeared %d times, want 1; log: %s", got, buf.String())
	}
	if !strings.Contains(buf.String(), "level=WARN") {
		t.Errorf("pre-flight must be slog.Warn (level=WARN); log: %s", buf.String())
	}
	// The allowlist warning must NOT fire: the grant is present. Emitting both
	// would send the operator to the board's tool list, which is already correct.
	if strings.Contains(buf.String(), offSwitchPreflightWarning) {
		t.Errorf("allowlist warning must stay silent when the tool IS granted; log: %s", buf.String())
	}
}

// TestLoopMode_OffSwitchCallablePreflight_SilentWhenCallable pins the happy
// path: a granted AND callable off-switch warns about nothing.
func TestLoopMode_OffSwitchCallablePreflight_SilentWhenCallable(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.Tools = []string{"Bash", offSwitchTool}
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))

	provider := llm.NewMockProvider("ok")
	m := newLoopModeForServer(t, srv, provider)

	var buf strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&lockedWriter{mu: &sync.Mutex{}, b: &buf}, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if strings.Contains(buf.String(), offSwitchUncallableWarning) {
		t.Errorf("callable off-switch must not warn; log: %s", buf.String())
	}
}

// TestLoopMode_OffSwitchCallablePreflight_SkippedWhenNotGranted keeps the two
// diagnostics from double-reporting one fault. When the allowlist omits the
// tool the existing warning already names the fix (grant it); probing the
// endpoint would add a second, misleading line about callability.
func TestLoopMode_OffSwitchCallablePreflight_SkippedWhenNotGranted(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.Tools = []string{"Bash"} // off-switch NOT granted
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	srv.denyOffSwitchProbe = true

	provider := llm.NewMockProvider("ok")
	m := newLoopModeForServer(t, srv, provider)

	var buf strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&lockedWriter{mu: &sync.Mutex{}, b: &buf}, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := strings.Count(buf.String(), offSwitchPreflightWarning); got != 1 {
		t.Errorf("allowlist warning appeared %d times, want 1; log: %s", got, buf.String())
	}
	if strings.Contains(buf.String(), offSwitchUncallableWarning) {
		t.Errorf("callability probe must not run when the tool is not granted; log: %s", buf.String())
	}
	if srv.offSwitchProbes() != 0 {
		t.Errorf("probe ran %d times, want 0 — no probe when the grant is already missing", srv.offSwitchProbes())
	}
}

// TestLoopMode_OffSwitchCallablePreflight_FiresOncePerRun proves the probe is a
// run-scoped diagnostic: one probe and one warning across many iterations, not
// a per-iteration write against the loop-state endpoint.
func TestLoopMode_OffSwitchCallablePreflight_FiresOncePerRun(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.Tools = []string{offSwitchTool}
	cfg.MaxIterations = 3
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))
	srv.denyOffSwitchProbe = true

	provider := llm.NewMockProvider("ok", "ok", "ok")
	m := newLoopModeForServer(t, srv, provider)

	var buf strings.Builder
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&lockedWriter{mu: &sync.Mutex{}, b: &buf}, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}
	if provider.CallCount() != 3 {
		t.Fatalf("provider called %d times, want 3", provider.CallCount())
	}
	if got := strings.Count(buf.String(), offSwitchUncallableWarning); got != 1 {
		t.Errorf("uncallable warning appeared %d times across 3 iterations, want exactly 1", got)
	}
	if got := srv.offSwitchProbes(); got != 1 {
		t.Errorf("probe ran %d times across 3 iterations, want exactly 1", got)
	}
}

// TestLoopMode_OffSwitchCallableProbe_IsANoOp is the safety pin on the probe
// itself: verifying the off-switch must never FLIP the off-switch. The probe
// asserts the loop's current state, so a runner that starts a run by disabling
// the very loop it is starting would be catastrophic — and silent.
//
// The run still ends on its max_iterations rail, so a disable at the END is
// expected and correct. What must never happen is a disable BEFORE the work:
// the provider ran, and the only enabled=false came after it.
func TestLoopMode_OffSwitchCallableProbe_IsANoOp(t *testing.T) {
	cfg := baseLoopConfig()
	cfg.Tools = []string{offSwitchTool}
	cfg.MaxIterations = 1
	srv := newLoopModeServer(t, loopConfigJSON(t, cfg))

	provider := llm.NewMockProvider("ok")
	m := newLoopModeForServer(t, srv, provider)

	if err := m.Run(context.Background()); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if provider.CallCount() != 1 {
		t.Fatalf("provider called %d times, want 1 — a probe that stopped the run", provider.CallCount())
	}
	patches := srv.statePatches()
	if len(patches) != 1 {
		t.Fatalf("got %d state patches, want exactly 1 (the max_iterations stop); the probe must not persist a state change: %v", len(patches), patches)
	}
	if enabled, ok := patches[0]["enabled"].(bool); !ok || enabled {
		t.Errorf("the only recorded patch should be the rail's disable, got %v", patches[0])
	}
}
