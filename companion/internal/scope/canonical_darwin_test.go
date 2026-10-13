// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package scope

import "testing"

func TestCanonical_DarwinIsQualified(t *testing.T) {
	if !canonicalizationQualified {
		t.Fatal("darwin canonicalization is not qualified")
	}
}
