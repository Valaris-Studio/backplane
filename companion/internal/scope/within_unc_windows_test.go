// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package scope

import "testing"

func TestOnDiskSpelling_WindowsSensitiveProbePreservesUNCVolumeCasing(t *testing.T) {
	withVolumeCaseSensitivity(t, true)
	// The sensitive branch returns these clean strings without filesystem or
	// network lookup. It does not establish a uniquely cased UNC volume.
	for _, path := range []string{`\\SERVER\SHARE\Repo`, `\\server\share\Repo`, `\\server\share\repo`} {
		if got, ok := onDiskSpelling(path); !ok || got != path {
			t.Fatalf("onDiskSpelling(%q) = %q, %v; want unchanged sensitive spelling", path, got, ok)
		}
	}
}

func TestWithin_WindowsUNCVolumeAliasesKeepDirectoryCaseDistinct(t *testing.T) {
	// Ordinary UNC server/share casing aliases the volume. Already-canonical
	// directory components after that volume retain their distinct case.
	root := `\\server\share\Repo`
	cases := []struct {
		name, root, path string
		want             bool
	}{
		{"exact root", root, root, true},
		{"exact descendant", root, root + `\child`, true},
		{"server case alias root", `\\SERVER\share\Repo`, root, true},
		{"share case alias root", `\\server\SHARE\Repo`, root, true},
		{"volume case alias descendant", `\\SERVER\SHARE\Repo`, root + `\child`, true},
		{"reverse volume case alias descendant", root, `\\SERVER\SHARE\Repo\child`, true},
		{"distinct directory case", root, `\\server\share\repo`, false},
		{"distinct directory case below volume alias", `\\SERVER\SHARE\Repo`, `\\server\share\repo\child`, false},
		{"distinct parent case below volume alias", `\\SERVER\SHARE\Sensitive\Repo`, `\\server\share\sensitive\Repo\child`, false},
		{"different server", root, `\\other\share\Repo`, false},
		{"different share", root, `\\server\other\Repo`, false},
		{"share prefix sibling", `\\server\share`, `\\server\share2\Repo`, false},
		{"directory prefix sibling", root, root + `-other`, false},
		{"ancestor", root, `\\server\share`, false},
		{"share root descendant", `\\server\share`, root + `\child`, true},
		{"share root alias descendant", `\\SERVER\SHARE`, root + `\child`, true},
		{"drive root descendant", `C:\`, `C:\Repo\child`, true},
		{"relative root", `Repo`, root, false},
		{"relative path", root, `Repo`, false},
		{"drive relative equality", `C:Repo`, `C:Repo`, false},
		{"empty equality", ``, ``, false},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			if got := within(test.root, test.path); got != test.want {
				t.Fatalf("within canonical root %q and path %q = %v; want %v", test.root, test.path, got, test.want)
			}
		})
	}
}
