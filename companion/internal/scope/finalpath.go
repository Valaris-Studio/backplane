// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package scope

import "strings"

// dosPathFromFinal turns GetFinalPathNameByHandleW's VOLUME_NAME_DOS result
// (\\?\C:\x or \\?\UNC\server\share\x) into the drive or share spelling the
// rest of the companion compares. A volume GUID or device path has neither,
// so it is refused rather than compared as a different folder.
func dosPathFromFinal(final string) (string, bool) {
	const win32Prefix, uncPrefix = `\\?\`, `UNC\`
	path := strings.TrimPrefix(final, win32Prefix)
	if len(path) >= len(uncPrefix) && strings.EqualFold(path[:len(uncPrefix)], uncPrefix) {
		share := path[len(uncPrefix):]
		server, rest, found := strings.Cut(share, `\`)
		if !found || server == "" || strings.TrimRight(rest, `\`) == "" {
			return "", false
		}
		return `\\` + share, true
	}
	if len(path) < 3 || path[1] != ':' || path[2] != '\\' || !isDriveLetter(path[0]) {
		return "", false
	}
	return path, true
}

// withoutVerbatimPrefix spells a \\?\ path (Rust's fs::canonicalize) as the
// drive or share it names; a device-namespace path (\\.\) names neither.
// Any other path is already in that spelling.
func withoutVerbatimPrefix(path string) (string, bool) {
	if strings.HasPrefix(path, `\\.\`) {
		return "", false
	}
	if !strings.HasPrefix(path, `\\?\`) {
		return path, true
	}
	return dosPathFromFinal(path)
}

func isDriveLetter(b byte) bool { return b >= 'A' && b <= 'Z' || b >= 'a' && b <= 'z' }
