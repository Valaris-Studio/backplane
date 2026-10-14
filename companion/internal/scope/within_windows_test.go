// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package scope

import "testing"

func TestWithin_WindowsCanonicalStringsKeepDistinctCaseSiblingsSeparate(t *testing.T) {
	// These inputs represent already-canonical, distinct identities. This
	// lexical seam test does not claim Windows created sensitive directories.
	root := `C:\qa\Sensitive\Repo`
	cases := []struct {
		name, path string
		want       bool
	}{
		{"exact root", root, true},
		{"exact descendant", root + `\src\child`, true},
		{"ancestor", `C:\qa\Sensitive`, false},
		{"prefix sibling", root + `-other`, false},
		{"different drive", `D:\qa\Sensitive\Repo`, false},
		{"distinct case sibling", `C:\qa\Sensitive\repo`, false},
		{"distinct case sibling descendant", `C:\qa\Sensitive\repo\src`, false},
		{"distinct case parent", `C:\qa\sensitive\Repo`, false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := within(root, test.path); got != test.want {
				t.Fatalf("within canonical root %q and path %q = %v; want %v", root, test.path, got, test.want)
			}
		})
	}
}

func TestCanonical_WindowsRejectsADriveRelativeRoot(t *testing.T) {
	if got, ok := CanonicalDir(`\`); ok {
		t.Fatalf("drive-relative root accepted as canonical: %q", got)
	}
}
