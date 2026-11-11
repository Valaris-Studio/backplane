// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package hermes

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"regexp"
	"strings"
	"testing"
)

// When a provider returns a tool call without an id, Hermes mints one from the
// call's content (agent/message_sanitization.py deterministic_call_id): a
// fingerprint anyone can confirm by hashing a guessed command. ParseHook
// replaces it with an id derived only from the record's identity metadata.
// This file covers the bare minted id; renamed_call_id_test.go covers the
// renamed `_d<n>` and composite `<call id>|<item id>` forms that carry it too.

// hermesDeterministicCallID is Hermes v0.22.4's deterministic_call_id.
func hermesDeterministicCallID(toolName, arguments string, index int) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%s:%d", toolName, arguments, index)))
	return "call_" + hex.EncodeToString(sum[:])[:12]
}

// synthesizedCallID is the content fingerprint the tests feed in, built at run time.
func synthesizedCallID() string {
	return hermesDeterministicCallID("terminal", `{"command":"make deploy HERMES_SENTINEL"}`, 0)
}

func opaqueCallID(sessionID, turnID, observedAt string) string {
	sum := sha256.Sum256([]byte("hermes-synthesized-call\x00" + sessionID + "\x00" + turnID + "\x00" + observedAt))
	return "hermes-" + hex.EncodeToString(sum[:])[:24]
}

var opaqueCallIDShape = regexp.MustCompile(`^hermes-[0-9a-f]{24}$`)

func withCallID(t *testing.T, event, cwd, callID string, edit func(extra map[string]any)) []byte {
	t.Helper()
	return variant(t, event, cwd, func(payload, extra map[string]any) {
		payload["tool_call_id"] = callID
		if edit != nil {
			edit(extra)
		}
	})
}

func TestHermesDeterministicCallIDMirrorsTheRelease(t *testing.T) {
	// Hermes' own golden (tests/agent/test_message_sanitization_policy.py).
	if got := hermesDeterministicCallID("terminal", `{"command":"ls"}`, 0); got != "call_40ccaef54d02" {
		t.Fatalf("setup: deterministic_call_id is %s", got)
	}
}

func TestParseHookReplacesASynthesizedCallIDWithTheOpaqueID(t *testing.T) {
	cwd := t.TempDir()
	synthesized := synthesizedCallID()
	for _, event := range []string{"post_tool_call", "post_approval_response"} {
		raw := withCallID(t, event, cwd, synthesized, nil)
		golden := decodeJSON(t, input(t, event, cwd))["extra"].(map[string]any)
		want := opaqueCallID(fixtureSession, golden["turn_id"].(string), golden["observed_at"].(string))
		if !opaqueCallIDShape.MatchString(want) {
			t.Fatalf("setup: opaque id %q", want)
		}
		observation, payload := parse(t, raw)
		if observation.NativeToolCallID != want || payload["tool_call_id"] != want {
			t.Errorf("%s: call id %q / %q, want the opaque %s", event, observation.NativeToolCallID, payload["tool_call_id"], want)
		}
		if encoded := canonical(t, payload) + fmt.Sprintf("%+v", observation); strings.Contains(encoded, synthesized) {
			t.Errorf("%s: the synthesized call id survived ParseHook: %s", event, encoded)
		}
		if !New().IdentityPreserved(observation, payload) {
			t.Errorf("%s: identity not preserved on the untouched projection", event)
		}
		expected := withoutMember(t, goldenPayload(t, event, cwd), "tool_call_id")
		if got := withoutMember(t, withoutNullToolMembers(event, payload), "tool_call_id"); canonical(t, got) != canonical(t, expected) {
			t.Errorf("%s: replacing the call id changed the rest\n got %s\nwant %s", event, canonical(t, got), canonical(t, expected))
		}
	}
}

// The opaque id is the record's identity, never its content: another
// synthesized value (another command) in the same firing gives the same id.
func TestOpaqueCallIDIsDerivedFromIdentityMetadataOnly(t *testing.T) {
	cwd := t.TempDir()
	first, _ := parse(t, withCallID(t, "post_tool_call", cwd, synthesizedCallID(), nil))
	other := hermesDeterministicCallID("terminal", `{"command":"cat HERMES_SENTINEL_other"}`, 3)
	second, _ := parse(t, withCallID(t, "post_tool_call", cwd, other, nil))
	if first.NativeToolCallID != second.NativeToolCallID {
		t.Fatalf("the opaque id depends on the synthesized value: %s vs %s", first.NativeToolCallID, second.NativeToolCallID)
	}
	if strings.Contains(first.NativeToolCallID, strings.TrimPrefix(synthesizedCallID(), "call_")) {
		t.Fatalf("the opaque id %s carries the fingerprint", first.NativeToolCallID)
	}
}

func TestOpaqueCallIDIsStableAcrossRedeliveryAndNamesEachFiring(t *testing.T) {
	cwd := t.TempDir()
	synthesized := synthesizedCallID()
	raw := withCallID(t, "post_tool_call", cwd, synthesized, nil)
	first, firstPayload := parse(t, raw)
	again, againPayload := parse(t, raw)
	if first.NativeToolCallID != again.NativeToolCallID || captureKey(t, first, firstPayload) != captureKey(t, again, againPayload) {
		t.Fatal("a re-delivered tool call with a synthesized id was named apart")
	}
	// On the Chat Completions path Hermes synthesizes the id after its
	// uniquifier ran (it skips blank ids), so the same command at the same
	// position in a later turn gets the same synthesized id: it is another
	// call. The Responses path renames that repeat `_d<n>` instead
	// (renamed_call_id_test.go).
	laterTurn := "20260924_115958_a1b2c3:0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b:1f2e3d4c"
	repeated, repeatedPayload := parse(t, withCallID(t, "post_tool_call", cwd, synthesized, func(extra map[string]any) {
		extra["turn_id"] = laterTurn
		extra["observed_at"] = "2026-09-24T12:04:01.000001Z"
	}))
	if repeated.NativeToolCallID != opaqueCallID(fixtureSession, laterTurn, "2026-09-24T12:04:01.000001Z") {
		t.Fatalf("repeated call id %q", repeated.NativeToolCallID)
	}
	if repeated.NativeToolCallID == first.NativeToolCallID || captureKey(t, repeated, repeatedPayload) == captureKey(t, first, firstPayload) {
		t.Fatal("the same command in a later turn collapsed into the first call")
	}
	sameTurnLater, _ := parse(t, withCallID(t, "post_tool_call", cwd, synthesized, func(extra map[string]any) {
		extra["observed_at"] = "2026-09-24T11:59:53.000001Z"
	}))
	if sameTurnLater.NativeToolCallID == first.NativeToolCallID {
		t.Fatal("another firing in the same turn kept the opaque id")
	}
	otherSession, _ := parse(t, variant(t, "post_tool_call", cwd, func(payload, _ map[string]any) {
		payload["tool_call_id"] = synthesized
		payload["session_id"] = "20260924_115958_d4e5f6"
	}))
	if otherSession.NativeToolCallID == first.NativeToolCallID {
		t.Fatal("another session kept the opaque id")
	}
}

func TestCaptureKeyOfASynthesizedCallIsNamedByTheOpaqueID(t *testing.T) {
	cwd := t.TempDir()
	observation, payload := parse(t, withCallID(t, "post_tool_call", cwd, synthesizedCallID(), nil))
	golden := decodeJSON(t, input(t, "post_tool_call", cwd))["extra"].(map[string]any)
	opaque := opaqueCallID(fixtureSession, golden["turn_id"].(string), golden["observed_at"].(string))
	sum := sha256.Sum256([]byte(strings.Join([]string{"hermes", pluginSchema, "post_tool_call", fixtureSession, opaque}, "\x00")))
	if got, want := captureKey(t, observation, payload), hex.EncodeToString(sum[:]); got != want {
		t.Fatalf("capture key %s, want the digest of the opaque identity %s", got, want)
	}
}

// Guard: a provider's own id, and anything whose call half is not one of
// Hermes' synthesized shapes, is kept as sent.
func TestParseHookKeepsRealProviderCallIDs(t *testing.T) {
	cwd := t.TempDir()
	hex12 := strings.TrimPrefix(synthesizedCallID(), "call_")
	for _, callID := range []string{
		fixtureCallID,
		"call_b57d26af38ac4e67ae4e",
		"call_" + hex12[:11],
		"call_" + hex12 + "a",
		"call_" + strings.ToUpper(hex12),
		"call_" + hex12[:11] + "g",
		"Call_" + hex12,
		"xcall_" + hex12,
		"call_x|fc_ab+/cd==",
	} {
		for _, event := range []string{"post_tool_call", "post_approval_response"} {
			observation, payload := parse(t, withCallID(t, event, cwd, callID, nil))
			if observation.NativeToolCallID != callID || payload["tool_call_id"] != callID {
				t.Errorf("%s: provider call id %q became %q", event, callID, observation.NativeToolCallID)
			}
		}
	}
}
