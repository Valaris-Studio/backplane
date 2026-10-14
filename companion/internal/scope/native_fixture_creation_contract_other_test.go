// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package scope

import (
	"os"
	"testing"
)

func observeExistingFixture(t *testing.T, path string) func() {
	t.Helper()
	before, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	return func() {
		t.Helper()
		after, err := os.Lstat(path)
		if err != nil || !os.SameFile(before, after) || before.Mode() != after.Mode() {
			t.Errorf("refusal changed existing path identity or permissions: %v", err)
		}
	}
}
