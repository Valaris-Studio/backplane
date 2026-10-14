// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package store

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// A reparse point (a symlink or junction) is never followed into.
func TestAnOwnedFileThatIsAReparsePointIsRefused(t *testing.T) {
	within := t.TempDir()
	target := filepath.Join(t.TempDir(), "secret.txt")
	os.WriteFile(target, []byte("not the harness's"), 0o600)
	plain := filepath.Join(within, "plain.txt")
	os.WriteFile(plain, []byte("body"), 0o600)
	if body, err := ReadOwnedFile(plain, within, 1<<20); err != nil || string(body) != "body" {
		t.Fatalf("control: %q %v", body, err)
	}
	link := filepath.Join(within, "link.txt")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("no symlink privilege: %v", err)
	}
	if _, err := ReadOwnedFile(link, within, 1<<20); !errors.Is(err, ErrNotOwnedFile) {
		t.Fatalf("read through a reparse point: %v", err)
	}
}
