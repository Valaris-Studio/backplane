// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package hermes

import (
	"strings"
	"testing"
)

// A provider that echoes an id Hermes already renamed has it renamed again,
// so the hooks can see `call_<12 hex>_d2_d2`, still carrying the fingerprint.
// And the backend keeps a tool-call id only as a NativeId of at most 200
// bytes, so a longer provider id would be dropped there and its call lost
// from the session's counts. ParseHook stands the opaque id in for both.

func assertOpaqueCallID(t *testing.T, cwd, callID string) {
	t.Helper()
	for _, event := range []string{"post_tool_call", "post_approval_response"} {
		golden := decodeJSON(t, input(t, event, cwd))["extra"].(map[string]any)
		want := opaqueCallID(fixtureSession, golden["turn_id"].(string), golden["observed_at"].(string))
		observation, payload := parse(t, withCallID(t, event, cwd, callID, nil))
		if observation.NativeToolCallID != want || payload["tool_call_id"] != want {
			t.Errorf("%s: call id %q became %q / %v, want the opaque %s", event, callID, observation.NativeToolCallID, payload["tool_call_id"], want)
		}
	}
}

func TestParseHookReplacesAStackedRenameOfASynthesizedCallID(t *testing.T) {
	cwd := t.TempDir()
	minted := synthesizedCallID()
	for _, callID := range []string{
		minted + "_d2_d2",
		minted + "_d3_d2_d4",
		minted + "_d2_d2|fc_" + fingerprint(),
	} {
		assertOpaqueCallID(t, cwd, callID)
	}
}

func TestParseHookReplacesAProviderCallIDLongerThanTheBackendKeeps(t *testing.T) {
	cwd := t.TempDir()
	callHalf := "call_b57d26af38ac4e67ae4e"
	longest := callHalf + "|fc_" + strings.Repeat("a", 200-len(callHalf)-len("|fc_"))
	if len(longest) != 200 {
		t.Fatalf("setup: %d bytes, want 200", len(longest))
	}
	assertOpaqueCallID(t, cwd, longest+"b")
	assertOpaqueCallID(t, cwd, callHalf+"|fc_"+strings.Repeat("Zm9vYmFy+/=", 25))

	// Guard: an id the backend keeps is uploaded as sent.
	for _, event := range []string{"post_tool_call", "post_approval_response"} {
		observation, payload := parse(t, withCallID(t, event, cwd, longest, nil))
		if observation.NativeToolCallID != longest || payload["tool_call_id"] != longest {
			t.Errorf("%s: a 200-byte provider call id became %q", event, observation.NativeToolCallID)
		}
	}
}
