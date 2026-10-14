// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package richcapture

import (
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// A FIFO in a session file's place, however it got there, never blocks the
// open, and with it the daemon's tick, until a writer comes along.
func TestOpeningAFIFOInASessionFilesPlaceDoesNotBlock(t *testing.T) {
	fifo := filepath.Join(t.TempDir(), "s.jsonl")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Fatal(err)
	}
	opened := make(chan error, 1)
	go func() {
		_, _, err := OpenSource(fifo, Cursor{}, false)
		opened <- err
	}()
	select {
	case err := <-opened:
		if err == nil {
			t.Fatal("a FIFO opened as a session file")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("opening a FIFO blocked")
	}
}
