// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/daemon"
	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

func (h *harness) queueOneRecord(t *testing.T) store.Layout {
	t.Helper()
	layout, err := h.app.layout()
	if err != nil {
		t.Fatal(err)
	}
	if err := queue.Open(layout).Enqueue("0123456789abcdef0123456789abcdef", []byte(`{}`)); err != nil {
		t.Fatal(err)
	}
	return layout
}

func flushRequested(signal *daemon.FlushSignal) bool {
	select {
	case <-signal.Wake():
		return true
	default:
		return false
	}
}

func TestAPIQueueFlush_SchedulesTheRunningDaemon(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.queueOneRecord(t)
	h.app.uploadFlush = daemon.NewFlushSignal()
	defer h.app.uploadFlush.Attach()()
	status, body := h.api(t).call(t, "POST", "/v1/queue/flush", "")
	if status != 200 || string(bytes.TrimSpace(body)) != `{"scheduled":true}` || !flushRequested(h.app.uploadFlush) {
		t.Fatalf("flush: %d %s", status, body)
	}
}

func assertFlushNoOp(t *testing.T, h *harness, reason string) {
	t.Helper()
	status, body := h.api(t).call(t, "POST", "/v1/queue/flush", "")
	if status != 200 || string(bytes.TrimSpace(body)) != `{"scheduled":false,"reason":"`+reason+`"}` {
		t.Fatalf("want a %s no-op, got %d %s", reason, status, body)
	}
	if h.app.uploadFlush != nil && flushRequested(h.app.uploadFlush) {
		t.Fatalf("a %s no-op must not wake the uploader", reason)
	}
}

func TestAPIQueueFlush_EmptyQueueIsANoOp(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.app.uploadFlush = daemon.NewFlushSignal()
	assertFlushNoOp(t, h, "queue_empty")
}

func TestAPIQueueFlush_DisconnectedIsANoOp(t *testing.T) {
	h := newHarness(t)
	h.queueOneRecord(t)
	h.app.uploadFlush = daemon.NewFlushSignal()
	assertFlushNoOp(t, h, "not_connected")
}

func TestAPIQueueFlush_RevokedIsANoOp(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	layout := h.queueOneRecord(t)
	installation, err := state.Load[state.Installation](layout.Installation())
	if err != nil {
		t.Fatal(err)
	}
	store.WriteJSON(layout.Admission(), state.Admission{Unauthorized: true, InstallationID: installation.ID})
	h.app.uploadFlush = daemon.NewFlushSignal()
	assertFlushNoOp(t, h, "device_revoked")
}

func TestAPIQueueFlush_WithoutARunningDaemonIsANoOp(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.queueOneRecord(t)
	assertFlushNoOp(t, h, "daemon_not_running")
}

func TestAPIQueueFlush_NoRunningCaptureSessionIsANoOp(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.queueOneRecord(t)
	// The supervisor holds a signal while it waits for a connection or an
	// artifact; no session is attached to it then.
	h.app.uploadFlush = daemon.NewFlushSignal()
	assertFlushNoOp(t, h, "daemon_not_running")
}
