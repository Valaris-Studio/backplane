// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package scope

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCanonical_LinuxResolvesSymlinkedComponent(t *testing.T) {
	f := newFixture(t)
	project := filepath.Join(f.home, "real", "Project")
	mkdir(t, project)
	if err := os.Symlink(filepath.Join(f.home, "real"), filepath.Join(f.home, "link")); err != nil {
		t.Fatal(err)
	}
	if got, ok := CanonicalDir(filepath.Join(f.home, "link", "Project")); !ok || got != project {
		t.Fatalf("CanonicalDir(through symlink) = %q, %v; want %q", got, ok, project)
	}
	if !canonicalizationQualified {
		t.Fatal("linux canonicalization is not qualified")
	}
}

func TestCanonical_LinuxKeepsCaseDistinctFoldersDistinct(t *testing.T) {
	f := newFixture(t)
	upper, lower := filepath.Join(f.home, "Repo"), filepath.Join(f.home, "repo")
	mkdir(t, upper)
	mkdir(t, lower)
	gotUpper, okUpper := CanonicalDir(upper)
	gotLower, okLower := CanonicalDir(lower)
	if !okUpper || !okLower || gotUpper != upper || gotLower != lower {
		t.Fatalf("case-distinct folders merged: %q/%v %q/%v", gotUpper, okUpper, gotLower, okLower)
	}
}

// A kernel path lookup cannot stand in for listing the parent here, so a
// folding volume whose parent the user cannot list has no provable spelling.
func TestCanonical_LinuxUnreadableParentFailsClosed(t *testing.T) {
	f := newFixture(t)
	_, child := lockedParent(t, f.root)
	withVolumeCaseSensitivity(t, false)
	if got, ok := CanonicalDir(child); ok {
		t.Fatalf("CanonicalDir under an unlistable parent on a folding volume = %q, want refusal", got)
	}
}
