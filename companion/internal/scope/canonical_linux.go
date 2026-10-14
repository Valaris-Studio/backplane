// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package scope

var canonicalizationQualified = true

// Linux has no per-volume case flag to read (ext4 and f2fs casefold single
// directories; vfat, exfat and SMB mounts fold everything), so the lookup
// probe decides.
func platformCaseSensitivity(string) (sensitive, known bool) { return false, false }

// directorySpelling is not taken from readlink(/proc/self/fd/N): on a
// folding directory the dentry keeps the spelling of the first lookup, not
// the one on disk. Only listing each parent proves the spelling.
func directorySpelling(string) (string, bool) { return "", false }
