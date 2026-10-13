// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !darwin && !linux && !windows

package scope

// canonicalizationQualified is false where no one has checked how the
// platform spells paths, so every CanonicalDir refuses and nothing is
// captured there until it is.
var canonicalizationQualified = false

func platformCaseSensitivity(string) (sensitive, known bool) { return false, false }

func directorySpelling(string) (string, bool) { return "", false }
