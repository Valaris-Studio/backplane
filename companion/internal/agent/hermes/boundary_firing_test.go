// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package hermes

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"strings"
	"testing"
)

// Hermes fires on_session_start and on_session_finalize more
// than once per session id: a finalized session is reopened by its next real
// turn and finalized again (tui_gateway/methods_prompt.py _reopen_if_finalized),
// and the start re-fires after a model, provider or cwd switch
// (agent/conversation_loop.py). With no call id and no turn id, the record's
// own extra.observed_at names the firing.

const (
	firstFiring = "2026-09-24T11:59:58.456789Z"
	laterFiring = "2026-09-24T12:31:07.000001Z"
)

// hooksWithoutANativeID are the observations that carry neither a tool-call
// id nor a turn id.
var hooksWithoutANativeID = []struct {
	name, event string
	strip       func(payload, extra map[string]any)
}{
	{"session start", "on_session_start", nil},
	{"session finalize", "on_session_finalize", nil},
	{"approval with neither id", "post_approval_response", func(payload, extra map[string]any) {
		delete(payload, "tool_call_id")
		delete(extra, "turn_id")
	}},
}

func firedAt(t *testing.T, event, cwd string, strip func(payload, extra map[string]any), observedAt string) []byte {
	t.Helper()
	return variant(t, event, cwd, func(payload, extra map[string]any) {
		if strip != nil {
			strip(payload, extra)
		}
		extra["observed_at"] = observedAt
	})
}

func identityOnlyKey(event string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{"hermes", pluginSchema, event, fixtureSession, ""}, "\x00")))
	return hex.EncodeToString(sum[:])
}

func TestCaptureKeyNamesEachFiringOfAHookWithoutANativeIDApart(t *testing.T) {
	cwd := t.TempDir()
	for _, hook := range hooksWithoutANativeID {
		first := keyOf(t, firedAt(t, hook.event, cwd, hook.strip, firstFiring))
		later := keyOf(t, firedAt(t, hook.event, cwd, hook.strip, laterFiring))
		if first == later {
			t.Errorf("%s: two firings at %s and %s share capture key %s", hook.name, firstFiring, laterFiring, first)
		}
		if first == identityOnlyKey(hook.event) {
			t.Errorf("%s: the capture key is still the identity-only digest, which every firing of the hook shares", hook.name)
		}
	}
}

func TestCaptureKeyOfAHookWithoutANativeIDNamesARedeliveryAlike(t *testing.T) {
	cwd := t.TempDir()
	elsewhere := filepath.Join(t.TempDir(), "another-spelling")
	for _, hook := range hooksWithoutANativeID {
		raw := firedAt(t, hook.event, cwd, hook.strip, laterFiring)
		first := keyOf(t, raw)
		if again := keyOf(t, raw); again != first {
			t.Errorf("%s: an identical re-delivery was named apart", hook.name)
		}
		if moved := keyOf(t, firedAt(t, hook.event, elsewhere, hook.strip, laterFiring)); moved != first {
			t.Errorf("%s: the working directory changed the capture key", hook.name)
		}
		// What the firing says is still not identity: only when it fired is.
		recontent := variant(t, hook.event, cwd, func(payload, extra map[string]any) {
			if hook.strip != nil {
				hook.strip(payload, extra)
			}
			extra["observed_at"] = laterFiring
			extra["platform"] = "tui"
			extra["model"] = "gpt-5.1"
			extra["reason"] = "tui_close"
			extra["HERMES_SENTINEL_member"] = "HERMES_SENTINEL_value"
		})
		if changed := keyOf(t, recontent); changed != first {
			t.Errorf("%s: content of the firing changed its capture key", hook.name)
		}
	}
}

// Guard: the hooks that carry a tool-call id keep their identity-only key,
// whenever Hermes observed them. A turn-only denial is named by when it fired
// (turn_only_approval_test.go).
func TestCaptureKeyOfAHookWithACallIDIgnoresWhenItFired(t *testing.T) {
	cwd := t.TempDir()
	withCallID := []struct {
		name, event string
		strip       func(payload, extra map[string]any)
	}{
		{"tool call", "post_tool_call", nil},
		{"approval with a call id", "post_approval_response", nil},
	}
	for _, hook := range withCallID {
		if first, later := keyOf(t, firedAt(t, hook.event, cwd, hook.strip, firstFiring)), keyOf(t, firedAt(t, hook.event, cwd, hook.strip, laterFiring)); first != later {
			t.Errorf("%s: when Hermes observed it changed the capture key", hook.name)
		}
	}
}

func TestProjectEventsNamesEachFinalizeFiringApart(t *testing.T) {
	cwd := t.TempDir()
	beaconOutput := pinnedBeaconOutput(t, "on_session_finalize", cwd)
	idAt := func(observedAt string) string {
		observation, payload := parse(t, firedAt(t, "on_session_finalize", cwd, nil, observedAt))
		return eventID(mustProject(t, observation, payload, beaconOutput)[0])
	}
	first, later := idAt(firstFiring), idAt(laterFiring)
	if !uuidV5.MatchString(first) || !uuidV5.MatchString(later) {
		t.Fatalf("event ids %q, %q are not UUIDv5", first, later)
	}
	if first == later {
		t.Fatalf("a reopened session's second finalize reuses the first one's event id %s", first)
	}
	if again := idAt(laterFiring); again != later {
		t.Fatalf("a re-delivered finalize was renamed: %s, want %s", again, later)
	}
}
