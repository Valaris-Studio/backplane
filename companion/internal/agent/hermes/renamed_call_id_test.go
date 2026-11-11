// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package hermes

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
)

// On the Responses path Hermes v0.22.4 synthesizes a missing call id while it
// normalizes the response (agent/codex_responses_adapter.py _response_tool_call
// -> _resolve_call_id -> deterministic_call_id). validate_tool_calls then
// renames an id the session already holds to `<id>_d<n>`
// (agent/message_sanitization.py uniquify_tool_call_ids), so the same command
// at the same position in a later turn reaches the hooks as `call_<12 hex>_d2`,
// still carrying the content fingerprint. Responses bridges also spell one
// call `<call id>|<item id>` (_expand_tool_id_variants). Whenever the call half
// is one of Hermes' synthesized shapes, ParseHook replaces the whole value.

// hermesUniquify mirrors uniquify_tool_call_ids: a call whose call half is
// already taken, in the session or earlier in the batch, gets the first free
// `<call half>_d<n>` from n = 2, and a composite id keeps its item half.
func hermesUniquify(ids []string, taken ...string) []string {
	seen := map[string]bool{}
	for _, id := range taken {
		callHalf, _, _ := strings.Cut(id, "|")
		seen[callHalf] = true
	}
	renamed := make([]string, len(ids))
	for index, id := range ids {
		callHalf, itemHalf, composite := strings.Cut(id, "|")
		free := callHalf
		for n := 2; seen[free]; n++ {
			free = fmt.Sprintf("%s_d%d", callHalf, n)
		}
		seen[free] = true
		if composite {
			free += "|" + itemHalf
		}
		renamed[index] = free
	}
	return renamed
}

// hermesResponsesItemID mirrors _derive_responses_function_call_id for a call
// that came without a provider item id: `fc_` + the call id after `call_`.
func hermesResponsesItemID(callID string) string {
	return "fc_" + strings.TrimPrefix(callID, "call_")
}

// fingerprint is what hashing a guessed command confirms: the 12 hex of the
// synthesized id.
func fingerprint() string { return strings.TrimPrefix(synthesizedCallID(), "call_") }

type callIDForm struct{ name, id string }

// hermesSynthesizedForms are the ids Hermes hands its hooks for the
// synthesized id of one command, built by Hermes' own rules at run time.
func hermesSynthesizedForms() []callIDForm {
	minted := synthesizedCallID()
	// The same command at the same position, turn after turn.
	var history []string
	for turn := 0; turn < 11; turn++ {
		history = append(history, hermesUniquify([]string{minted}, history...)[0])
	}
	composite := minted + "|" + hermesResponsesItemID(minted)
	return []callIDForm{
		{"renamed in the second turn", history[1]},
		{"renamed in the third turn", history[2]},
		{"renamed past the ninth turn", history[10]},
		{"composite Responses id", composite},
		{"composite with the provider's item id", minted + "|fc_68f0c2a1b3d4e5f60718293a"},
		{"renamed composite", hermesUniquify([]string{composite}, minted)[0]},
	}
}

func TestHermesUniquifyMirrorsTheRelease(t *testing.T) {
	// Hermes' own goldens (tests/agent/test_message_sanitization_policy.py).
	cases := []struct{ ids, taken, want []string }{
		{[]string{"x", "x", "x"}, nil, []string{"x", "x_d2", "x_d3"}},
		{[]string{"call_y|fc_1", "call_y|fc_2"}, nil, []string{"call_y|fc_1", "call_y_d2|fc_2"}},
		{[]string{"z", "z_d2", "z"}, nil, []string{"z", "z_d2", "z_d3"}},
		{[]string{"call_0", "call_fresh"}, []string{"call_0", "call_0_d2"}, []string{"call_0_d3", "call_fresh"}},
	}
	for _, c := range cases {
		if got := hermesUniquify(c.ids, c.taken...); strings.Join(got, ",") != strings.Join(c.want, ",") {
			t.Errorf("uniquify(%v, taken %v) = %v, want %v", c.ids, c.taken, got, c.want)
		}
	}
	minted := synthesizedCallID()
	forms := map[string]string{}
	for _, form := range hermesSynthesizedForms() {
		forms[form.name] = form.id
		if !strings.Contains(form.id, fingerprint()) {
			t.Errorf("setup: %s %q does not carry the fingerprint", form.name, form.id)
		}
	}
	for name, want := range map[string]string{
		"renamed in the second turn":  minted + "_d2",
		"renamed in the third turn":   minted + "_d3",
		"renamed past the ninth turn": minted + "_d11",
		"renamed composite":           minted + "_d2|fc_" + fingerprint(),
	} {
		if forms[name] != want {
			t.Errorf("setup: %s is %q, want %q", name, forms[name], want)
		}
	}
}

func TestParseHookReplacesEveryFormOfASynthesizedCallID(t *testing.T) {
	cwd := t.TempDir()
	for _, form := range hermesSynthesizedForms() {
		for _, event := range []string{"post_tool_call", "post_approval_response"} {
			golden := decodeJSON(t, input(t, event, cwd))["extra"].(map[string]any)
			want := opaqueCallID(fixtureSession, golden["turn_id"].(string), golden["observed_at"].(string))
			observation, payload := parse(t, withCallID(t, event, cwd, form.id, nil))
			if observation.NativeToolCallID != want || payload["tool_call_id"] != want {
				t.Errorf("%s, %s: call id %q / %v, want the opaque %s", form.name, event, observation.NativeToolCallID, payload["tool_call_id"], want)
			}
			if encoded := canonical(t, payload) + fmt.Sprintf("%+v", observation); strings.Contains(encoded, fingerprint()) {
				t.Errorf("%s, %s: the fingerprint survived ParseHook: %s", form.name, event, encoded)
			}
			if !New().IdentityPreserved(observation, payload) {
				t.Errorf("%s, %s: identity not preserved on the untouched projection", form.name, event)
			}
			expected := withoutMember(t, goldenPayload(t, event, cwd), "tool_call_id")
			if got := withoutMember(t, withoutNullToolMembers(event, payload), "tool_call_id"); canonical(t, got) != canonical(t, expected) {
				t.Errorf("%s, %s: replacing the call id changed the rest\n got %s\nwant %s", form.name, event, canonical(t, got), canonical(t, expected))
			}
		}
	}
}

// Turn after turn the same command reaches the hooks as call_<h>, call_<h>_d2,
// call_<h>_d3: each firing is named by its own identity, none by the content.
func TestRenamedSynthesizedCallsInLaterTurnsAreNamedByTheirFiring(t *testing.T) {
	cwd := t.TempDir()
	minted := synthesizedCallID()
	var history []string
	names, keys := map[string]int{}, map[string]int{}
	for turn := 0; turn < 3; turn++ {
		callID := hermesUniquify([]string{minted}, history...)[0]
		history = append(history, callID)
		turnID := fmt.Sprintf("%s:6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b:%08x", fixtureSession, turn+1)
		observedAt := fmt.Sprintf("2026-09-24T12:%02d:00.000001Z", turn+1)
		raw := withCallID(t, "post_tool_call", cwd, callID, func(extra map[string]any) {
			extra["turn_id"] = turnID
			extra["observed_at"] = observedAt
		})
		observation, payload := parse(t, raw)
		if want := opaqueCallID(fixtureSession, turnID, observedAt); observation.NativeToolCallID != want {
			t.Errorf("turn %d (%s): call id %q, want the opaque %s", turn+1, callID, observation.NativeToolCallID, want)
		}
		if strings.Contains(observation.NativeToolCallID, fingerprint()) {
			t.Errorf("turn %d: the call id %q carries the fingerprint", turn+1, observation.NativeToolCallID)
		}
		again, againPayload := parse(t, raw)
		if again.NativeToolCallID != observation.NativeToolCallID || captureKey(t, again, againPayload) != captureKey(t, observation, payload) {
			t.Errorf("turn %d: a re-delivery was named apart", turn+1)
		}
		names[observation.NativeToolCallID] = turn + 1
		keys[captureKey(t, observation, payload)] = turn + 1
	}
	if len(names) != 3 || len(keys) != 3 {
		t.Fatalf("three turns of one command share names: call ids %v, capture keys %v", names, keys)
	}
}

func TestCaptureKeyOfARenamedSynthesizedCallIsNamedByTheOpaqueID(t *testing.T) {
	cwd := t.TempDir()
	golden := decodeJSON(t, input(t, "post_tool_call", cwd))["extra"].(map[string]any)
	opaque := opaqueCallID(fixtureSession, golden["turn_id"].(string), golden["observed_at"].(string))
	sum := sha256.Sum256([]byte(strings.Join([]string{"hermes", pluginSchema, "post_tool_call", fixtureSession, opaque}, "\x00")))
	for _, form := range hermesSynthesizedForms() {
		observation, payload := parse(t, withCallID(t, "post_tool_call", cwd, form.id, nil))
		if got, want := captureKey(t, observation, payload), hex.EncodeToString(sum[:]); got != want {
			t.Errorf("%s: capture key %s, want the digest of the opaque identity %s", form.name, got, want)
		}
	}
}

// Guard: an id whose call half only resembles a synthesized shape is a
// provider's own id and is kept as sent.
func TestParseHookKeepsIDsWhoseCallHalfIsNotASynthesizedShape(t *testing.T) {
	cwd := t.TempDir()
	minted := synthesizedCallID()
	hex12 := fingerprint()
	for _, callID := range []string{
		minted + "_d",
		minted + "_dx",
		minted + "_D2",
		minted + "-d2",
		minted + "_d2x",
		minted + "__d2",
		"call_" + hex12[:11] + "_d2",
		"call_" + hex12 + "a_d2",
		"call_" + strings.ToUpper(hex12) + "_d2",
		fixtureCallID + "_d2",
		"call_b57d26af38ac4e67ae4e_d2",
		"call_b57d26af38ac4e67ae4e|fc_68f0c2a1b3d4e5f6",
	} {
		for _, event := range []string{"post_tool_call", "post_approval_response"} {
			observation, payload := parse(t, withCallID(t, event, cwd, callID, nil))
			if observation.NativeToolCallID != callID || payload["tool_call_id"] != callID {
				t.Errorf("%s: provider call id %q became %q", event, callID, observation.NativeToolCallID)
			}
		}
	}
}
