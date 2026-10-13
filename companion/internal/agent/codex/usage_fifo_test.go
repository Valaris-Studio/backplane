// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package codex

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// readsPromptly fails the test when a read blocks: opening a FIFO without a
// writer would hang the daemon's tick.
func readsPromptly(t *testing.T, f *rolloutFixture, path string) []map[string]any {
	t.Helper()
	done := make(chan []map[string]any, 1)
	go func() { done <- f.readPath(t, path, time.Time{}) }()
	select {
	case events := <-done:
		return events
	case <-time.After(5 * time.Second):
		t.Fatal("reading the rollout blocked")
		return nil
	}
}

func TestRolloutUsage_RefusesAFIFOWithoutBlocking(t *testing.T) {
	f := newRollout(t, encodeRollout(t, sessionMeta("Codex Desktop"), usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(100, 0, 0, 1, 0))))
	fifo := filepath.Join(filepath.Dir(f.path), "rollout-2026-09-29T11-00-02-fifo.jsonl")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	if events := readsPromptly(t, f, fifo); len(events) != 0 {
		t.Fatalf("a FIFO was read: %v", events)
	}
}

func TestRolloutUsage_RefusesAFIFOSwappedInAfterTheChecks(t *testing.T) {
	f := newRollout(t, encodeRollout(t, sessionMeta("Codex Desktop"), usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(100, 0, 0, 1, 0))))
	previous := beforeOpenRollout
	defer func() { beforeOpenRollout = previous }()
	beforeOpenRollout = func(path string) {
		os.Remove(path)
		if err := syscall.Mkfifo(path, 0o600); err != nil {
			t.Error(err)
		}
	}
	if events := readsPromptly(t, f, f.path); len(events) != 0 {
		t.Fatalf("a FIFO swapped in was read: %v", events)
	}
}
