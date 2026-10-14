// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"sync/atomic"
	"time"
)

// FlushFloor is the least time between two attempts that skip the backoff,
// so a client hammering flush cannot turn the backoff into a hot retry loop.
const FlushFloor = time.Second

// FlushSignal asks the uploader to retry now, skipping the current backoff
// once. It outlives capture sessions, so a request made between sessions
// reaches the next one. Requests coalesce: however many arrive before the
// tick loop looks, they buy a single attempt, and that attempt runs on the
// tick loop itself, so uploads never overlap.
type FlushSignal struct {
	requested atomic.Bool
	wake      chan struct{}
	// attached counts running tick loops: a request is only worth
	// answering "scheduled" while one will act on it.
	attached atomic.Int32
}

func NewFlushSignal() *FlushSignal {
	return &FlushSignal{wake: make(chan struct{}, 1)}
}

// Request never blocks. A nil signal ignores it.
func (f *FlushSignal) Request() {
	if f == nil {
		return
	}
	f.requested.Store(true)
	select {
	case f.wake <- struct{}{}:
	default:
	}
}

// Wake fires once after a Request, cutting the loop's poll wait short. A nil
// signal never fires.
func (f *FlushSignal) Wake() <-chan struct{} {
	if f == nil {
		return nil
	}
	return f.wake
}

// Attach marks a tick loop as consuming requests until the returned detach.
func (f *FlushSignal) Attach() (detach func()) {
	if f == nil {
		return func() {}
	}
	f.attached.Add(1)
	var once atomic.Bool
	return func() {
		if once.CompareAndSwap(false, true) {
			f.attached.Add(-1)
		}
	}
}

// Attached reports whether a tick loop is running to act on a request.
func (f *FlushSignal) Attached() bool {
	return f != nil && f.attached.Load() > 0
}

// take consumes a pending request.
func (f *FlushSignal) take() bool {
	return f != nil && f.requested.Swap(false)
}
