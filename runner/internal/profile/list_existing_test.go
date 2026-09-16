// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package profile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListExistingNeverMigratesLegacyFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "runner.yaml"), []byte("llm: {}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	profiles, err := NewStore(root).ListExisting()
	if err != nil || len(profiles) != 0 {
		t.Fatalf("existing profiles = %v, %v", profiles, err)
	}
	if _, err := os.Stat(filepath.Join(root, "profiles")); !os.IsNotExist(err) {
		t.Fatalf("read-only discovery created profiles: %v", err)
	}
}
