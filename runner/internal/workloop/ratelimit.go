// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"sync"
	"time"
)

// rateLimiter implements a sliding window rate limiter.
// It tracks timestamps of recent requests and blocks when the
// per-minute limit is reached.
type rateLimiter struct {
	mu         sync.Mutex
	maxPerMin  int
	timestamps []time.Time
}

func newRateLimiter(maxPerMinute int) *rateLimiter {
	return &rateLimiter{
		maxPerMin:  maxPerMinute,
		timestamps: make([]time.Time, 0, maxPerMinute),
	}
}

// wait blocks until a request is allowed or the context is cancelled.
func (r *rateLimiter) wait(ctx context.Context) error {
	for {
		r.mu.Lock()
		now := time.Now()
		cutoff := now.Add(-time.Minute)

		// Prune timestamps older than 1 minute.
		valid := r.timestamps[:0]
		for _, ts := range r.timestamps {
			if ts.After(cutoff) {
				valid = append(valid, ts)
			}
		}
		r.timestamps = valid

		if len(r.timestamps) < r.maxPerMin {
			r.timestamps = append(r.timestamps, now)
			r.mu.Unlock()
			return nil
		}

		// Calculate how long until the oldest entry expires.
		oldest := r.timestamps[0]
		waitDuration := oldest.Add(time.Minute).Sub(now)
		r.mu.Unlock()

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(waitDuration):
			// Retry after the oldest entry expires.
		}
	}
}
