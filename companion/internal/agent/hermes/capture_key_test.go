// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package hermes

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

var sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)

func captureKey(t *testing.T, observation agent.Observation, payload map[string]any) string {
	t.Helper()
	var adapter agent.Agent = New()
	source, ok := adapter.(agent.CaptureKeySource)
	if !ok {
		t.Fatal("hermes is not a CaptureKeySource")
	}
	key, named := source.CaptureKey(observation, payload)
	if !named || !sha256Hex.MatchString(key) {
		t.Fatalf("capture key %q (named %v) for %+v", key, named, observation)
	}
	return key
}

func keyOf(t *testing.T, raw []byte) string {
	t.Helper()
	observation, payload := parse(t, raw)
	return captureKey(t, observation, payload)
}

// fixtureTurn is the turn id the tool call and approval fixtures carry.
const fixtureTurn = "20260924_115958_a1b2c3:6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b:8a1b2c3d"

// The capture key of an observation with a tool-call id is a digest of that
// identity alone: harness, plugin schema, hook event, session id and the call
// id. Nothing the observation carries besides is in its preimage. A hook with
// no call id is named by when it fired as well (boundary_firing_test.go,
// turn_only_approval_test.go).
func TestCaptureKeyIsTheContractDigestOfTheNativeIdentity(t *testing.T) {
	cases := []struct {
		name, event   string
		edit          func(payload, extra map[string]any)
		discriminator string
	}{
		{"tool call", "post_tool_call", nil, fixtureCallID},
		{"approval", "post_approval_response", nil, fixtureCallID},
	}
	cwd := t.TempDir()
	for _, c := range cases {
		raw := input(t, c.event, cwd)
		if c.edit != nil {
			raw = variant(t, c.event, cwd, c.edit)
		}
		preimage := strings.Join([]string{"hermes", "backplane.hermes.v1", c.event, fixtureSession, c.discriminator}, "\x00")
		sum := sha256.Sum256([]byte(preimage))
		if got, want := keyOf(t, raw), hex.EncodeToString(sum[:]); got != want {
			t.Errorf("%s: capture key %s, want sha256(%q) = %s", c.name, got, preimage, want)
		}
	}
}

func TestCaptureKeyNamesARedeliveryAlikeWhereverItRan(t *testing.T) {
	cwd := t.TempDir()
	observation, payload := parse(t, input(t, "post_tool_call", cwd))
	first := captureKey(t, observation, payload)
	if again := keyOf(t, input(t, "post_tool_call", cwd)); again != first {
		t.Fatal("an identical re-delivery was named apart")
	}
	elsewhere := filepath.Join(t.TempDir(), "another-spelling")
	if moved := keyOf(t, input(t, "post_tool_call", elsewhere)); moved != first {
		t.Fatal("the working directory changed the capture key")
	}
	New().RewriteCwd(payload, elsewhere)
	if rewritten := captureKey(t, observation, payload); rewritten != first {
		t.Fatal("rewriting the cwd for a mapping changed the capture key")
	}
	noisier := variant(t, "post_tool_call", cwd, func(payload, extra map[string]any) {
		payload["result"] = "HERMES_SENTINEL_OTHER_RESULT"
		delete(payload, "args")
		extra["error_type"] = "HERMES_SENTINEL_OTHER"
	})
	if dropped := keyOf(t, noisier); dropped != first {
		t.Fatal("members the projection drops changed the capture key")
	}
}

// Content is never identity: the same native observation re-sent with other
// values is the same capture, which the server refuses as a conflict.
func TestCaptureKeyIgnoresEverythingButTheNativeIdentity(t *testing.T) {
	cwd := t.TempDir()
	otherTurn := "20260924_115958_a1b2c3:0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b:1f2e3d4c"
	changes := map[string]map[string]func(payload, extra map[string]any){
		"post_tool_call": {
			"extra.status":      func(_, extra map[string]any) { extra["status"] = "error" },
			"extra.duration_ms": func(_, extra map[string]any) { extra["duration_ms"] = 43 },
			"extra.observed_at": func(_, extra map[string]any) { extra["observed_at"] = "2026-09-24T11:59:52.234568Z" },
			"extra.platform":    func(_, extra map[string]any) { extra["platform"] = "tui" },
			"tool_name":         func(payload, _ map[string]any) { payload["tool_name"] = "mcp__backplane__list_cards" },
			// The call id names the call; its turn is not identity beside it.
			"extra.turn_id": func(_, extra map[string]any) { extra["turn_id"] = otherTurn },
		},
		"post_approval_response": {
			"extra.observed_at": func(_, extra map[string]any) { extra["observed_at"] = "2026-09-24T11:59:54.345679Z" },
			"extra.platform":    func(_, extra map[string]any) { extra["platform"] = "desktop" },
			"extra.choice":      func(_, extra map[string]any) { extra["choice"] = "timeout" },
			"extra.turn_id":     func(_, extra map[string]any) { extra["turn_id"] = otherTurn },
		},
		// extra.observed_at names a firing of these two.
		"on_session_start": {
			"extra.model":    func(_, extra map[string]any) { extra["model"] = "gpt-5.1" },
			"extra.platform": func(_, extra map[string]any) { extra["platform"] = "acp" },
		},
		"on_session_finalize": {
			"extra.reason":   func(_, extra map[string]any) { extra["reason"] = "exit" },
			"extra.platform": func(_, extra map[string]any) { extra["platform"] = "tui" },
		},
	}
	for event, edits := range changes {
		base := keyOf(t, input(t, event, cwd))
		for field, change := range edits {
			if changed := keyOf(t, variant(t, event, cwd, change)); changed != base {
				t.Errorf("%s: changing %s changed the capture key", event, field)
			}
		}
	}
}

// Guard: what names the observation still names the capture apart.
func TestCaptureKeyChangesWithTheNativeIdentity(t *testing.T) {
	cwd := t.TempDir()
	identities := map[string]map[string]func(payload, extra map[string]any){
		"post_tool_call": {
			"session_id":   func(payload, _ map[string]any) { payload["session_id"] = "20260924_115958_d4e5f6" },
			"tool_call_id": func(payload, _ map[string]any) { payload["tool_call_id"] = "toolu_01ZzYyXx" },
			"plugin_schema": func(_, extra map[string]any) {
				delete(extra, "plugin_schema")
			},
		},
		"post_approval_response": {
			"tool_call_id": func(payload, _ map[string]any) { payload["tool_call_id"] = "toolu_01ZzYyXx" },
		},
		"on_session_start": {
			"session_id": func(payload, _ map[string]any) { payload["session_id"] = "local-" + strings.Repeat("ab", 32) },
		},
	}
	for event, edits := range identities {
		base := keyOf(t, input(t, event, cwd))
		for field, change := range edits {
			if changed := keyOf(t, variant(t, event, cwd, change)); changed == base {
				t.Errorf("%s: changing %s kept the capture key", event, field)
			}
		}
	}
	withoutCall := func(payload, _ map[string]any) { delete(payload, "tool_call_id") }
	turnOnly := keyOf(t, variant(t, "post_approval_response", cwd, withoutCall))
	otherTurn := keyOf(t, variant(t, "post_approval_response", cwd, func(payload, extra map[string]any) {
		withoutCall(payload, extra)
		extra["turn_id"] = "20260924_115958_a1b2c3:0e9d8c7b-6a5f-4e3d-8c2b-1a0f9e8d7c6b:1f2e3d4c"
	}))
	if otherTurn == turnOnly {
		t.Error("without a call id, another turn kept the capture key")
	}
	keys := map[string]string{}
	for _, event := range subscribedEvents {
		key := keyOf(t, input(t, event, cwd))
		if other, taken := keys[key]; taken {
			t.Fatalf("%s and %s share a capture key", event, other)
		}
		keys[key] = event
	}
}
