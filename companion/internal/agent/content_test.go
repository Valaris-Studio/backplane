// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// The key digests native identities, NUL-separated, never what was said.
func TestContentKeyDigestsNativeIdentitiesOnly(t *testing.T) {
	sum := sha256.Sum256([]byte("claude_code\x00sess-1\x00d1f0a9e2\x00text:0"))
	if got := ContentKey("claude_code", "sess-1", "d1f0a9e2", "text:0"); got != hex.EncodeToString(sum[:]) {
		t.Fatalf("ContentKey = %s", got)
	}
	if ContentKey("a", "bc", "d", "e") == ContentKey("ab", "c", "d", "e") {
		t.Fatal("fields must not run into each other")
	}
}
