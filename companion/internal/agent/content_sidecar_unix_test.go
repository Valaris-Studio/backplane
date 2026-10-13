// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package agent

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func refusedSidecar(t *testing.T, path, dir string) {
	t.Helper()
	if data, ok := ReadSessionSidecar(path, dir); ok || data != nil {
		t.Fatalf("read %q from %s", data, path)
	}
}

// What only the guarded open refuses: a path check and a plain read would
// take every one of these.
func TestASessionSidecarOthersCanWriteIsRefused(t *testing.T) {
	dir, path := sidecarFixture(t)
	os.Chmod(path, 0o620)
	refusedSidecar(t, path, dir)
}

func TestASessionSidecarKnownByTwoNamesIsRefused(t *testing.T) {
	dir, path := sidecarFixture(t)
	if err := os.Link(path, filepath.Join(dir, "second-name.json")); err != nil {
		t.Fatal(err)
	}
	refusedSidecar(t, path, dir)
}

func TestASessionSidecarReachedThroughASymlinkedDirectoryIsRefused(t *testing.T) {
	dir, _ := sidecarFixture(t)
	outside, _ := filepath.EvalSymlinks(t.TempDir())
	os.WriteFile(filepath.Join(outside, "agent-a9.meta.json"), []byte(`{}`), 0o600)
	os.RemoveAll(filepath.Join(dir, "subagents"))
	if err := os.Symlink(outside, filepath.Join(dir, "subagents")); err != nil {
		t.Fatal(err)
	}
	refusedSidecar(t, filepath.Join(dir, "subagents", "agent-a9.meta.json"), dir)
}

func TestASessionSidecarPathClimbingOutIsRefused(t *testing.T) {
	root, _ := filepath.EvalSymlinks(t.TempDir())
	dir := filepath.Join(root, "session")
	os.MkdirAll(filepath.Join(dir, "subagents"), 0o700)
	os.WriteFile(filepath.Join(root, "x.json"), []byte(`{}`), 0o600)
	refusedSidecar(t, filepath.Join(dir, "subagents", "..", "..", "x.json"), dir)
}

func TestARelativeSessionSidecarPathIsRefused(t *testing.T) {
	dir, path := sidecarFixture(t)
	relative, _ := filepath.Rel(dir, path)
	refusedSidecar(t, relative, dir)
}

func TestASessionSidecarIsBoundedAtFourKibibytes(t *testing.T) {
	dir, path := sidecarFixture(t)
	os.WriteFile(path, []byte(strings.Repeat("x", 4096)), 0o600)
	if data, ok := ReadSessionSidecar(path, dir); !ok || len(data) != 4096 {
		t.Fatalf("4096 bytes: read %d, %v", len(data), ok)
	}
	os.WriteFile(path, []byte(strings.Repeat("x", 4097)), 0o600)
	refusedSidecar(t, path, dir)
}

func TestASessionSidecarThatIsAFIFOIsRefusedWithoutBlocking(t *testing.T) {
	dir, path := sidecarFixture(t)
	fifo := filepath.Join(filepath.Dir(path), "agent-a3.meta.json")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Skipf("no FIFO: %v", err)
	}
	done := make(chan struct{})
	go func() { refusedSidecar(t, fifo, dir); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("reading a FIFO sidecar blocked")
	}
}
