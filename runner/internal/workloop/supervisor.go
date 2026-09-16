// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"fmt"
	"log/slog"
	"runtime/debug"
	"time"
)

// supervisorClock abstracts time so tests can drive backoff deterministically
// without real sleeps. Production uses realClock.
type supervisorClock interface {
	Now() time.Time
	Sleep(ctx context.Context, d time.Duration) error
}

type realClock struct{}

func (realClock) Now() time.Time { return time.Now() }

func (realClock) Sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// SupervisorConfig configures Supervise. Zero-valued fields fall back to
// production defaults: 1s initial, 60s cap, 5m reset.
type SupervisorConfig struct {
	DisableRecover bool          // bypass panic recovery; debug only
	InitialDelay   time.Duration // first restart delay; doubles up to MaxDelay
	MaxDelay       time.Duration // cap on exponential backoff
	ResetAfter     time.Duration // run length that resets backoff to InitialDelay
}

// supervisorOpts is the test-internal entry point with hookable clock + onBackoff.
type supervisorOpts struct {
	clock          supervisorClock
	initialDelay   time.Duration
	maxDelay       time.Duration
	resetAfter     time.Duration
	disableRecover bool
	onBackoff      func(time.Duration)
}

func (o *supervisorOpts) applyDefaults() {
	if o.clock == nil {
		o.clock = realClock{}
	}
	if o.initialDelay <= 0 {
		o.initialDelay = time.Second
	}
	if o.maxDelay <= 0 {
		o.maxDelay = 60 * time.Second
	}
	if o.resetAfter <= 0 {
		o.resetAfter = 5 * time.Minute
	}
}

// Supervise invokes run repeatedly, recovering from panics and re-running
// after capped exponential backoff. Returns nil when run completes
// gracefully, run's error when run returns one, or context.Canceled when
// ctx is cancelled mid-backoff.
//
// DisableRecover bypasses the recover/restart loop and lets panics propagate;
// useful for development debugging via VALARIS_NO_SUPERVISOR=1.
func Supervise(ctx context.Context, run func(context.Context) error, cfg SupervisorConfig) error {
	return superviseInternal(ctx, run, supervisorOpts{
		initialDelay:   cfg.InitialDelay,
		maxDelay:       cfg.MaxDelay,
		resetAfter:     cfg.ResetAfter,
		disableRecover: cfg.DisableRecover,
	})
}

func superviseInternal(ctx context.Context, run func(context.Context) error, opts supervisorOpts) error {
	opts.applyDefaults()

	if opts.disableRecover {
		return run(ctx)
	}

	delay := opts.initialDelay
	for {
		if err := ctx.Err(); err != nil {
			return err
		}

		startedAt := opts.clock.Now()
		err, panicked := runWithRecover(ctx, run)

		if !panicked {
			return err
		}

		// Reset the backoff after a stable run that survived past resetAfter
		// before crashing — avoids penalising rare crashes with stale backoff.
		if opts.clock.Now().Sub(startedAt) >= opts.resetAfter {
			delay = opts.initialDelay
		}

		if opts.onBackoff != nil {
			opts.onBackoff(delay)
		}
		slog.Warn("supervisor restarting after panic", "delay", delay)
		if err := opts.clock.Sleep(ctx, delay); err != nil {
			return err
		}

		next := delay * 2
		if next > opts.maxDelay {
			next = opts.maxDelay
		}
		delay = next
	}
}

func runWithRecover(ctx context.Context, run func(context.Context) error) (err error, panicked bool) {
	defer func() {
		if r := recover(); r != nil {
			panicked = true
			slog.Error("workloop panic recovered",
				"panic", fmt.Sprintf("%v", r),
				"stack", string(debug.Stack()),
			)
		}
	}()
	return run(ctx), false
}
