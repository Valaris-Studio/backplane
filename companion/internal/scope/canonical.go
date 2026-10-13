// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package scope

import (
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/text/unicode/norm"
)

// volumeIsCaseSensitive is probed per path, never assumed per OS: APFS and
// NTFS may be either, and ext4 may casefold single directories. A volume the
// probe cannot classify is treated as folding, which only ever widens what an
// exclusion matches.
var volumeIsCaseSensitive = func(dir string) bool {
	sensitive, known := platformCaseSensitivity(dir)
	if !known {
		sensitive, known = caseSensitiveByLookup(dir)
	}
	return known && sensitive
}

// CanonicalDir is the one spelling of a directory that every scope
// comparison uses: symlinks resolved and, on a volume that folds case (and,
// with it, Unicode normalization), every component spelled as it is on disk.
// Otherwise /Volumes/Work/Repo and /volumes/work/repo are two strings for one folder,
// and an ignored or never-capture folder is captured under the other one.
func CanonicalDir(path string) (string, bool) {
	path, spelled := withoutVerbatimPrefix(path)
	if !spelled || !canonicalizationQualified || path == "" || !filepath.IsAbs(path) {
		return "", false
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return "", false
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.IsDir() {
		return "", false
	}
	return onDiskSpelling(filepath.Clean(resolved))
}

// CanonicalOrClean canonicalizes a stored path on read, so an entry written
// in another case or by an older version still names its directory; a path
// that no longer exists keeps its cleaned spelling.
func CanonicalOrClean(path string) string {
	spelled, ok := withoutVerbatimPrefix(path)
	if !ok {
		return filepath.Clean(path)
	}
	path = spelled
	if canonical, ok := CanonicalDir(path); ok {
		return canonical
	}
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return filepath.Clean(resolved)
	}
	return filepath.Clean(path)
}

func onDiskSpelling(dir string) (string, bool) {
	if volumeIsCaseSensitive(dir) {
		return dir, true
	}
	// The kernel's path may also expand firmlinks or pick another hard link;
	// only a respelling of the same components is taken from it.
	if spelled, ok := directorySpelling(dir); ok && foldName(spelled) == foldName(dir) {
		return spelled, true
	}
	return spellingFromEntries(dir)
}

// spellingFromEntries matches each component against its parent's entries,
// for platforms without a kernel path lookup. A parent the user cannot list
// leaves the spelling unproven, and an unproven spelling fails closed: an
// ignored folder must never be captured under another spelling of itself.
func spellingFromEntries(dir string) (string, bool) {
	volume := filepath.VolumeName(dir)
	spelled := volume + string(filepath.Separator)
	for _, name := range strings.Split(dir[len(volume):], string(filepath.Separator)) {
		if name == "" {
			continue
		}
		entry, ok := entryNamed(spelled, name)
		if !ok {
			return "", false
		}
		spelled = filepath.Join(spelled, entry)
	}
	return spelled, true
}

func entryNamed(parent, name string) (string, bool) {
	directory, err := os.Open(parent)
	if err != nil {
		return "", false
	}
	defer directory.Close()
	names, err := directory.Readdirnames(-1)
	if err != nil {
		return "", false
	}
	folded, match := foldName(name), name
	for _, entry := range names {
		if entry == name {
			return name, true
		}
		if foldName(entry) == folded {
			match = entry
		}
	}
	return match, true
}

func foldName(name string) string { return strings.ToLower(norm.NFC.String(name)) }

// caseSensitiveByLookup looks up the nearest component that has letters
// under its case-swapped name: the same file means the volume folds case.
func caseSensitiveByLookup(dir string) (sensitive, known bool) {
	for current := filepath.Clean(dir); ; {
		name := filepath.Base(current)
		if swapped := swapCase(name); swapped != name {
			original, err := os.Lstat(current)
			if err != nil {
				return false, false
			}
			other, err := os.Lstat(filepath.Join(filepath.Dir(current), swapped))
			return err != nil || !os.SameFile(original, other), true
		}
		parent := filepath.Dir(current)
		if parent == current {
			return false, false
		}
		current = parent
	}
}

func swapCase(name string) string {
	return strings.Map(func(r rune) rune {
		if upper := []rune(strings.ToUpper(string(r))); len(upper) == 1 && upper[0] != r {
			return upper[0]
		}
		if lower := []rune(strings.ToLower(string(r))); len(lower) == 1 {
			return lower[0]
		}
		return r
	}, name)
}
