// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !darwin && !linux && !windows

package scope

import "testing"

func TestCanonical_UnqualifiedPlatformIsNotQualified(t *testing.T) {
	if canonicalizationQualified {
		t.Fatal("canonicalization claims qualification on an unqualified platform")
	}
}
