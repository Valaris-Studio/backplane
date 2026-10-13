// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package agent

import (
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

// Vectors from backend app/core/harness.py native_call_key, run on the
// RC-04 branch: verbatim up to 200 characters (Python's len counts code
// points, not bytes), "sha256:" + hex of the UTF-8 bytes beyond.
func TestNativeCallIDParityWithTheBackend(t *testing.T) {
	piOpenAI := "call_fdf50d27d2de1bfc0807e4665e04685e|fc_" + strings.Repeat("bc18b8e149513aecfb933937a74f71eb305a8bd92cdd2f2f37", 8)
	for _, vector := range []struct {
		id, want string
		// fits: the result is also an id the server keeps.
		fits bool
	}{
		{piOpenAI, "sha256:ac25a039cad478537021079eb0e4d2f5284decd9b8e59c7a0b000995650e4e66", true},
		{strings.Repeat("c", 200), strings.Repeat("c", 200), true},
		{strings.Repeat("c", 201), "sha256:36f8c1faac4be1a33844ae8d4c953eb1950787864300f3da920a3e9094907f8e", true},
		// 300 bytes but 150 characters: not hashed, as the backend keeps it.
		{strings.Repeat("é", 150), strings.Repeat("é", 150), false},
		{strings.Repeat("é", 201), "sha256:3821f1b32e730d3a6b5bd3720b9df60d5cb1b9f5731fff576d7f3cc81aae5579", true},
		{"call_1|fc_2", "call_1|fc_2", true},
	} {
		got := NativeCallID(vector.id)
		if got != vector.want {
			t.Errorf("%d-character id keyed %q, want %q", len([]rune(vector.id)), got, vector.want)
		}
		if vector.fits && !uplink.NativeIDPattern.MatchString(got) {
			t.Errorf("%q does not fit the server's native id shape", got)
		}
	}
	if NativeCallID("") != "" {
		t.Error("an absent id became one")
	}
}
