// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package agent

import (
	"crypto/sha256"
	"encoding/hex"
	"unicode/utf8"
)

// maxNativeCallIDChars is the server's NATIVE_ID_MAX, counted in characters
// as Python's len counts them.
const maxNativeCallIDChars = 200

// NativeCallID is a tool call id as the server stores and matches it:
// verbatim when it fits, otherwise the stable digest backend
// app/core/harness.py native_call_key takes (Pi's OpenAI ids run to 400+
// characters), so content and events still join on the call.
func NativeCallID(id string) string {
	if utf8.RuneCountInString(id) <= maxNativeCallIDChars {
		return id
	}
	sum := sha256.Sum256([]byte(id))
	return "sha256:" + hex.EncodeToString(sum[:])
}
