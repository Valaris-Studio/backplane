// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package store

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// storeFixture is a harness store directory with one body in it.
func storeFixture(t *testing.T) (within, path string) {
	t.Helper()
	within, _ = filepath.EvalSymlinks(t.TempDir())
	path = filepath.Join(within, "sess", "tool-results", "b1.txt")
	os.MkdirAll(filepath.Dir(path), 0o700)
	if err := os.WriteFile(path, []byte("the stored body\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return within, path
}

func readStore(path, within string) ([]byte, error) {
	return ReadOwnedFile(path, within, 1<<20)
}

func TestAHarnessStoreIsReadThroughItsCheckedDescriptor(t *testing.T) {
	within, path := storeFixture(t)
	body, err := readStore(path, within)
	if err != nil || string(body) != "the stored body\n" {
		t.Fatalf("read %q %v", body, err)
	}
}

// readable is the positive control a refusal case is measured against.
func readable(t *testing.T, path, within string) {
	t.Helper()
	if _, err := readStore(path, within); err != nil {
		t.Fatalf("control read failed: %v", err)
	}
}

func refused(t *testing.T, path, within string) {
	t.Helper()
	if body, err := readStore(path, within); !errors.Is(err, ErrNotOwnedFile) || body != nil {
		t.Fatalf("read %q, %v: want a refusal", body, err)
	}
}

func TestAStoreOutsideItsDirectoryIsRefused(t *testing.T) {
	_, path := storeFixture(t)
	readable(t, path, filepath.Dir(filepath.Dir(filepath.Dir(path))))
	other, _ := filepath.EvalSymlinks(t.TempDir())
	refused(t, path, other)
	refused(t, filepath.Join(filepath.Dir(path), "..", "..", "..", filepath.Base(other), "x"), filepath.Dir(path))
	refused(t, "relative/b1.txt", filepath.Dir(path))
}

func TestASymlinkedStoreIsRefused(t *testing.T) {
	within, path := storeFixture(t)
	readable(t, path, within)
	secret := filepath.Join(t.TempDir(), "secret.txt")
	os.WriteFile(secret, []byte("not the harness's"), 0o600)
	link := filepath.Join(filepath.Dir(path), "b2.txt")
	os.Symlink(secret, link)
	refused(t, link, within)
	// A symlinked directory on the way out of the store is an escape too.
	escape := filepath.Join(within, "sess", "linked")
	os.Symlink(filepath.Dir(secret), escape)
	refused(t, filepath.Join(escape, "secret.txt"), within)
}

// The file checked by path is not necessarily the file opened: a swap in
// between is caught by comparing the descriptor with the checked file.
func TestAStoreSwappedBetweenCheckAndOpenIsRefused(t *testing.T) {
	within, path := storeFixture(t)
	readable(t, path, within)
	impostor := filepath.Join(filepath.Dir(path), "impostor.txt")
	os.WriteFile(impostor, []byte("swapped in"), 0o600)
	afterOwnedLstat = func() { os.Rename(impostor, path) }
	defer func() { afterOwnedLstat = func() {} }()
	refused(t, path, within)
}

func TestAStoreOthersCanWriteOrThatIsLinkedTwiceIsRefused(t *testing.T) {
	within, path := storeFixture(t)
	readable(t, path, within)
	os.Chmod(path, 0o620)
	refused(t, path, within)
	os.Chmod(path, 0o600)
	os.Link(path, filepath.Join(within, "second-name"))
	refused(t, path, within)
}

func TestAStoreThatIsNotARegularFileIsRefusedWithoutBlocking(t *testing.T) {
	within, path := storeFixture(t)
	readable(t, path, within)
	fifo := filepath.Join(filepath.Dir(path), "pipe.txt")
	if err := syscall.Mkfifo(fifo, 0o600); err != nil {
		t.Skipf("no FIFO: %v", err)
	}
	done := make(chan struct{})
	go func() { refused(t, fifo, within); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("opening a FIFO blocked")
	}
	refused(t, filepath.Dir(path), within)
}

func TestAStoreOverItsLimitIsRefused(t *testing.T) {
	within, path := storeFixture(t)
	readable(t, path, within)
	if body, err := ReadOwnedFile(path, within, 4); !errors.Is(err, ErrNotOwnedFile) || body != nil {
		t.Fatalf("read %q %v", body, err)
	}
}

// The directory may be named through a symlink (macOS /var is
// /private/var): it is canonicalized before anything is compared.
func TestAStoreUnderASymlinkedSpellingOfItsDirectoryIsRead(t *testing.T) {
	within := t.TempDir()
	path := filepath.Join(within, "b1.txt")
	os.WriteFile(path, []byte("body"), 0o600)
	if body, err := readStore(path, within); err != nil || string(body) != "body" {
		t.Fatalf("read %q %v", body, err)
	}
}
