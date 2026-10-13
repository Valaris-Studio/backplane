// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package scope

import (
	"os"
	"path/filepath"
	"testing"
)

// Rust's fs::canonicalize spells paths verbatim; codex-cli 0.161 names a
// resumed session's rollout that way in its hooks.
func TestCanonical_WindowsVerbatimPathNamesTheSameDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "sessions", "2026", "10", "09")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	want, ok := CanonicalDir(dir)
	if !ok {
		t.Fatal("temp dir not canonical")
	}
	got, ok := CanonicalDir(`\\?\` + dir)
	if !ok || got != want {
		t.Fatalf("CanonicalDir(verbatim) = %q, %v; want %q", got, ok, want)
	}
}
