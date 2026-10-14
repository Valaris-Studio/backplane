// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package scope

import "testing"

func TestDOSPathFromFinal_StripsTheWin32Prefix(t *testing.T) {
	cases := map[string]string{
		`\\?\C:\Users\Jane\Repo`:    `C:\Users\Jane\Repo`,
		`\\?\C:\`:                   `C:\`,
		`\\?\UNC\server\share\Repo`: `\\server\share\Repo`,
		`\\?\unc\server\share\Repo`: `\\server\share\Repo`,
		`C:\Users\Jane\Repo`:        `C:\Users\Jane\Repo`,
	}
	for final, want := range cases {
		if got, ok := dosPathFromFinal(final); !ok || got != want {
			t.Errorf("dosPathFromFinal(%s) = %s, %v; want %s", final, got, ok, want)
		}
	}
}

func TestDOSPathFromFinal_RefusesPathsWithoutADriveOrShare(t *testing.T) {
	for _, final := range []string{
		``,
		`\\?\Volume{0b7ff6b2-0000-0000-0000-100000000000}\Repo`,
		`\\?\GLOBALROOT\Device\HarddiskVolume3\Repo`,
		`\Device\HarddiskVolume3\Repo`,
		`\\?\UNC\`,
		`\\?\UNC\server`,
		`relative\Repo`,
		`\\?\C:`,
	} {
		if got, ok := dosPathFromFinal(final); ok {
			t.Errorf("dosPathFromFinal(%q) accepted as %q", final, got)
		}
	}
}

// A verbatim path names the folder its drive or share spelling does; any
// other path is already in that spelling.
func TestWithoutVerbatimPrefix(t *testing.T) {
	for path, want := range map[string]string{
		`\\?\C:\Users\Jane\.codex\sessions`: `C:\Users\Jane\.codex\sessions`,
		`\\?\UNC\server\share\sessions`:     `\\server\share\sessions`,
		`C:\Users\Jane\.codex\sessions`:     `C:\Users\Jane\.codex\sessions`,
		`\\server\share\sessions`:           `\\server\share\sessions`,
		"/" + "home/jane/.codex/sessions":   "/" + "home/jane/.codex/sessions",
	} {
		if got, ok := withoutVerbatimPrefix(path); !ok || got != want {
			t.Errorf("withoutVerbatimPrefix(%s) = %s, %v; want %s", path, got, ok, want)
		}
	}
	for _, path := range []string{`\\?\Volume{0b7ff6b2-0000-0000-0000-100000000000}\Repo`, `\\?\GLOBALROOT\Device\HarddiskVolume3\Repo`, `\\.\C:\Users\Jane\.codex\sessions`} {
		if got, ok := withoutVerbatimPrefix(path); ok {
			t.Errorf("withoutVerbatimPrefix(%s) = %s, want refused", path, got)
		}
	}
}
