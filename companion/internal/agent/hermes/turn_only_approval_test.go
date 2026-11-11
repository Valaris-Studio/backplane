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

// Hermes fires post_approval_response with no tool-call id when the approval
// context holds none (tools/approval_context.py binds an empty
// _approval_tool_call_id), so the denial carries only its turn id. A turn can
// deny more than once: the record's own extra.observed_at names each denial,
// while an identical re-delivery keeps its key.

const (
	firstDenialAt  = "2026-09-24T11:59:54.345678Z"
	secondDenialAt = "2026-09-24T11:59:56.000001Z"
)

func turnOnlyDenial(t *testing.T, cwd, turnID, observedAt string, edit func(extra map[string]any)) []byte {
	t.Helper()
	return variant(t, "post_approval_response", cwd, func(payload, extra map[string]any) {
		delete(payload, "tool_call_id")
		extra["turn_id"] = turnID
		extra["observed_at"] = observedAt
		if edit != nil {
			edit(extra)
		}
	})
}

// turnIdentityKey is the digest every denial of the turn would share if the
// turn id alone named it.
func turnIdentityKey(turnID string) string {
	sum := sha256.Sum256([]byte(strings.Join([]string{"hermes", pluginSchema, "post_approval_response", fixtureSession, turnID}, "\x00")))
	return hex.EncodeToString(sum[:])
}

func TestCaptureKeyNamesTwoTurnOnlyDenialsInOneTurnApart(t *testing.T) {
	cwd := t.TempDir()
	first := keyOf(t, turnOnlyDenial(t, cwd, fixtureTurn, firstDenialAt, nil))
	second := keyOf(t, turnOnlyDenial(t, cwd, fixtureTurn, secondDenialAt, nil))
	if first == second {
		t.Fatalf("two denials of turn %s at %s and %s share capture key %s", fixtureTurn, firstDenialAt, secondDenialAt, first)
	}
	if first == turnIdentityKey(fixtureTurn) || second == turnIdentityKey(fixtureTurn) {
		t.Fatal("a turn-only denial is still named by the turn alone, which every denial of the turn shares")
	}
}

func TestCaptureKeyOfATurnOnlyDenialNamesARedeliveryAlike(t *testing.T) {
	cwd := t.TempDir()
	raw := turnOnlyDenial(t, cwd, fixtureTurn, secondDenialAt, nil)
	first := keyOf(t, raw)
	if again := keyOf(t, raw); again != first {
		t.Fatal("an identical re-delivery was named apart")
	}
	elsewhere := filepath.Join(t.TempDir(), "another-spelling")
	if moved := keyOf(t, turnOnlyDenial(t, elsewhere, fixtureTurn, secondDenialAt, nil)); moved != first {
		t.Fatal("the working directory changed the capture key")
	}
	recontent := turnOnlyDenial(t, cwd, fixtureTurn, secondDenialAt, func(extra map[string]any) {
		extra["platform"] = "desktop"
		extra["choice"] = "timeout"
		extra["HERMES_SENTINEL_member"] = "HERMES_SENTINEL_value"
	})
	if changed := keyOf(t, recontent); changed != first {
		t.Fatal("content of the denial changed its capture key")
	}
}

// Guard: the turn still names a turn-only denial.
func TestCaptureKeyOfATurnOnlyDenialStillNamesItsTurn(t *testing.T) {
	cwd := t.TempDir()
	otherTurn := "20260924_115958_a1b2c3:0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b:1f2e3d4c"
	if keyOf(t, turnOnlyDenial(t, cwd, fixtureTurn, firstDenialAt, nil)) == keyOf(t, turnOnlyDenial(t, cwd, otherTurn, firstDenialAt, nil)) {
		t.Fatal("denials of two turns at one instant share a capture key")
	}
}

func TestProjectEventsNamesTwoTurnOnlyDenialsInOneTurnApart(t *testing.T) {
	cwd := t.TempDir()
	beaconOutput := pinnedBeaconOutput(t, "post_approval_response", cwd)
	idAt := func(observedAt string) string {
		observation, payload := parse(t, turnOnlyDenial(t, cwd, fixtureTurn, observedAt, nil))
		return eventID(mustProject(t, observation, payload, beaconOutput)[0])
	}
	first, second := idAt(firstDenialAt), idAt(secondDenialAt)
	if !uuidV5.MatchString(first) || !uuidV5.MatchString(second) {
		t.Fatalf("event ids %q, %q are not UUIDv5", first, second)
	}
	if first == second {
		t.Fatalf("the second denial of the turn reuses the first one's event id %s", first)
	}
	if again := idAt(secondDenialAt); again != second {
		t.Fatalf("a re-delivered denial was renamed: %s, want %s", again, second)
	}
}
