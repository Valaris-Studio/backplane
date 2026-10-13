// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package queue

import (
	"os"
	"testing"
)

// makeUnreadable leaves a record the queue refuses to read: readable by
// others, so no longer private.
func makeUnreadable(t *testing.T, path string) {
	t.Helper()
	// store.ReadPrivateFile refuses it: "readable by others".
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
}
