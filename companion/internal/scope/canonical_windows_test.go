// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package scope

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Qualified natively in DK-W1; compiled everywhere through GOOS=windows vet.
func TestCanonical_WindowsCaseInsensitive(t *testing.T) {
	root := t.TempDir()
	onDisk := filepath.Join(root, "MixedCase", "Repo")
	if err := os.MkdirAll(onDisk, 0o700); err != nil {
		t.Fatal(err)
	}
	canonicalRoot, ok := CanonicalDir(root)
	if !ok {
		t.Fatal("temp dir not canonical")
	}
	got, ok := CanonicalDir(strings.ToLower(filepath.Join(root, "MixedCase", "Repo")))
	if !ok || got != filepath.Join(canonicalRoot, "MixedCase", "Repo") {
		t.Fatalf("CanonicalDir = %s, %v", got, ok)
	}
	if strings.HasPrefix(got, `\\?\`) {
		t.Fatalf("Win32 prefix leaked into %s", got)
	}
}

func TestCanonical_WindowsDirectorySpellingRefusesAMissingDirectory(t *testing.T) {
	if spelled, ok := directorySpelling(filepath.Join(t.TempDir(), "missing")); ok {
		t.Fatalf("missing directory spelled %s", spelled)
	}
}
