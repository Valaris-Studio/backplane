// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package scope

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNativeFixture_CreateDirectoryRefusesExistingPathsUnchanged(t *testing.T) {
	for _, kind := range []string{"directory", "file"} {
		t.Run(kind, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "existing Ω")
			sentinel := path
			if kind == "directory" {
				if err := os.Mkdir(path, 0o700); err != nil {
					t.Fatal(err)
				}
				sentinel = filepath.Join(path, "sentinel.txt")
			}
			const content = "existing fixture must not be adopted or rewritten"
			if err := os.WriteFile(sentinel, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
			verifyUnchanged := observeExistingFixture(t, path)
			if err := createPhysicalFixtureDirectory(path); err == nil {
				t.Errorf("existing %s must be refused, not adopted", kind)
			}
			verifyUnchanged()
			if got, err := os.ReadFile(sentinel); err != nil || string(got) != content {
				t.Errorf("refusal changed sentinel content: %v", err)
			}
			if kind == "directory" {
				if entries, err := os.ReadDir(path); err != nil || len(entries) != 1 || entries[0].Name() != "sentinel.txt" {
					t.Errorf("refusal changed existing directory entries: %v", err)
				}
			}
		})
	}
}
