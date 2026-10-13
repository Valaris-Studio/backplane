// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
)

// observedCancelContext is canceled once requested, but its Done channel
// closes only when a caller observes Err: in-flight HTTP is never aborted,
// so the cancellation is first seen by whoever checks after the exchange.
type observedCancelContext struct {
	context.Context
	requested atomic.Bool
	once      sync.Once
	done      chan struct{}
}

func newObservedCancelContext() *observedCancelContext {
	return &observedCancelContext{Context: context.Background(), done: make(chan struct{})}
}

func (c *observedCancelContext) Done() <-chan struct{} { return c.done }

func (c *observedCancelContext) Err() error {
	if !c.requested.Load() {
		return nil
	}
	c.once.Do(func() { close(c.done) })
	return context.Canceled
}

// A run canceled while its valid acknowledgement is on the wire never
// reaches a provider, even though the preparation itself succeeded.
func TestContextDispatchCancellationAfterValidAckStopsInference(t *testing.T) {
	f := newInvocationHTTP()
	c := newInvocationCase(t, f, "continue_project")
	ctx := newObservedCancelContext()
	f.beforeAck = func() { ctx.requested.Store(true) }
	if err := c.run(ctx); err == nil {
		t.Error("invocation continued after cancellation following a valid acknowledgement")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.payloads) != 1 || c.current.CallCount()+c.stale.CallCount() != 0 {
		t.Errorf("post-ack cancellation counts: prepare=%d current=%d stale=%d", len(f.payloads), c.current.CallCount(), c.stale.CallCount())
	}
}
