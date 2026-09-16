// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// TestPollInterval_NoOverflow asserts PollInterval never returns a non-positive
// duration regardless of how many idle ticks accumulate. The original
// implementation computed `base << idleBackoff` directly: with base=2m
// (=120e9 ns) and idleBackoff>=26 the int64 overflows to a negative number,
// the cap check fails (negative < positive cap), and time.Ticker.Reset() then
// panics on the non-positive duration. Observed in a field smoke run
// 2026-04-27 after ~3h14m idle.
func TestPollInterval_NoOverflow(t *testing.T) {
	cfg := testConfig()
	cfg.WorkLoop.PollInterval = 2 * time.Minute
	cfg.WorkLoop.MaxIdleInterval = 16 * time.Minute
	client := testClientStubbed(t)
	mock := llm.NewMockProvider()
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	for backoff := uint(0); backoff <= 64; backoff++ {
		loop.idleBackoff = backoff
		got := loop.PollInterval()
		if got <= 0 {
			t.Fatalf("PollInterval at idleBackoff=%d returned non-positive duration %v (overflow)", backoff, got)
		}
		// 2m << 3 = 16m which already saturates the cap, so every shift >= 3
		// must clamp to MaxIdleInterval.
		if backoff >= 3 && got != cfg.WorkLoop.MaxIdleInterval {
			t.Errorf("PollInterval at idleBackoff=%d = %v, want %v (capped)", backoff, got, cfg.WorkLoop.MaxIdleInterval)
		}
	}
}

func TestPollInterval_ZeroBackoffReturnsBase(t *testing.T) {
	cfg := testConfig()
	cfg.WorkLoop.PollInterval = 2 * time.Minute
	cfg.WorkLoop.MaxIdleInterval = 16 * time.Minute
	client := testClientStubbed(t)
	mock := llm.NewMockProvider()
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	if got := loop.PollInterval(); got != cfg.WorkLoop.PollInterval {
		t.Errorf("PollInterval at idleBackoff=0 = %v, want %v", got, cfg.WorkLoop.PollInterval)
	}
}

// TestPollInterval_UncappedStillPositive covers the operational mode where the
// administrator set MaxIdleInterval=0 (uncapped). The shift-clamp must still
// keep the result positive across all backoff values; without it, a runner
// configured this way panics deterministically once idleBackoff hits the
// overflow boundary.
func TestPollInterval_UncappedStillPositive(t *testing.T) {
	cfg := testConfig()
	cfg.WorkLoop.PollInterval = 2 * time.Minute
	cfg.WorkLoop.MaxIdleInterval = 0
	client := testClientStubbed(t)
	mock := llm.NewMockProvider()
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin"}

	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	for backoff := uint(0); backoff <= 64; backoff++ {
		loop.idleBackoff = backoff
		got := loop.PollInterval()
		if got <= 0 {
			t.Fatalf("PollInterval(uncapped) at idleBackoff=%d returned non-positive %v", backoff, got)
		}
	}
}
