// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/queue"
)

// Hermes renames a synthesized call id that a later turn repeats to
// `<id>_d<n>` (agent/message_sanitization.py uniquify_tool_call_ids), and
// Responses bridges spell one call `<call id>|<item id>`. Both forms keep the
// content fingerprint, so neither may reach the inbox, the queue or the
// server. agent/hermes renamed_call_id_test.go checks these forms against
// Hermes' own rules.

func hermesFingerprint() string { return strings.TrimPrefix(hermesSynthesizedCallID(), "call_") }

type hermesCallIDForm struct{ name, id string }

func hermesSynthesizedCallIDForms() []hermesCallIDForm {
	minted := hermesSynthesizedCallID()
	// _derive_responses_function_call_id of a call without a provider item id.
	item := "fc_" + hermesFingerprint()
	return []hermesCallIDForm{
		{"renamed in the second turn", minted + "_d2"},
		{"renamed in the third turn", minted + "_d3"},
		{"renamed past the ninth turn", minted + "_d11"},
		{"composite Responses id", minted + "|" + item},
		{"renamed composite", minted + "_d2|" + item},
	}
}

type hermesFiring struct{ event, callID, turnID, observedAt string }

// hermesFiringsOfEveryForm fires a tool call and its denial for each form,
// each in a turn of its own and at its own instant.
func hermesFiringsOfEveryForm() []hermesFiring {
	var firings []hermesFiring
	for index, form := range hermesSynthesizedCallIDForms() {
		turnID := fmt.Sprintf("%s:6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b:%08x", hermesSession, index+1)
		for offset, event := range []string{"post_tool_call", "post_approval_response"} {
			observedAt := fmt.Sprintf("2026-09-24T12:%02d:%02d.000001Z", index+1, offset+1)
			firings = append(firings, hermesFiring{event, form.id, turnID, observedAt})
		}
	}
	return firings
}

func (firing hermesFiring) input(t *testing.T, project string) []byte {
	t.Helper()
	return hermesVariant(t, firing.event, project, func(payload, extra map[string]any) {
		payload["tool_call_id"] = firing.callID
		extra["turn_id"] = firing.turnID
		extra["observed_at"] = firing.observedAt
	})
}

func (firing hermesFiring) opaqueCallID() string {
	return hermesOpaqueCallID(hermesSession, firing.turnID, firing.observedAt)
}

func TestHermesRenamedOrCompositeSynthesizedCallIDNeverReachesTheInbox(t *testing.T) {
	f, project := newHermesFixture(t, "metadata")
	firings := hermesFiringsOfEveryForm()
	want := map[string]string{}
	for _, firing := range firings {
		f.hermesHook(t, firing.input(t, project))
		want[firing.event+" "+firing.observedAt] = firing.opaqueCallID()
	}
	items := f.inboxItems(t)
	if len(items) != len(firings) {
		t.Fatalf("%d inbox items for %d hooks", len(items), len(firings))
	}
	for name, raw := range f.inboxFiles(t) {
		if bytes.Contains(raw, []byte(hermesFingerprint())) {
			t.Errorf("inbox item %s holds the fingerprint: %.400s", name, raw)
		}
	}
	for _, item := range items {
		extra, _ := item.Payload["extra"].(map[string]any)
		observedAt, _ := extra["observed_at"].(string)
		opaque := want[item.Observation.Event+" "+observedAt]
		if opaque == "" || item.Observation.NativeToolCallID != opaque || item.Payload["tool_call_id"] != opaque {
			t.Errorf("%s at %s: call id %q / %v, want the opaque %q", item.Observation.Event, observedAt, item.Observation.NativeToolCallID, item.Payload["tool_call_id"], opaque)
		}
	}
	f.assertNoDurableFileHolds(t, hermesFingerprint())
}

func TestHermesRenamedSynthesizedCallRedeliveryIsOneCaptureNamedByTheOpaqueID(t *testing.T) {
	f, project := newHermesFixture(t, "metadata")
	renamed := hermesVariant(t, "post_tool_call", project, func(payload, _ map[string]any) {
		payload["tool_call_id"] = hermesSynthesizedCallID() + "_d2"
	})
	f.hermesHook(t, renamed)
	f.hermesHook(t, renamed)
	f.tick(t)
	records := f.server.Records()
	if len(records) != 1 || f.normalizer.calls.Load() != 1 {
		t.Fatalf("a re-delivery was captured again: %d records, %d normalizations", len(records), f.normalizer.calls.Load())
	}
	opaque := hermesFixtureOpaqueCallID(t, "post_tool_call", project)
	key := sha256.Sum256([]byte(strings.Join([]string{"hermes", "backplane.hermes.v1", "post_tool_call", hermesSession, opaque}, "\x00")))
	if want := captureID(hermesAgent, hex.EncodeToString(key[:])); records[0]["capture_id"] != want {
		t.Fatalf("capture id %v, want the one named by the opaque call id %s", records[0]["capture_id"], want)
	}
	for _, payload := range f.normalizer.payloads {
		if strings.Contains(hermesCanonical(t, payload), hermesFingerprint()) {
			t.Fatalf("Beacon was handed the fingerprint: %s", hermesCanonical(t, payload))
		}
	}
	f.assertNoDurableFileHolds(t, hermesFingerprint())
}

func TestHermesRenamedOrCompositeSynthesizedCallIDNeverLeavesTheDeviceThroughPinnedBeacon(t *testing.T) {
	f, project, recorder := newPinnedHermesFixture(t)
	firings := hermesFiringsOfEveryForm()
	for _, firing := range firings {
		f.hermesHook(t, firing.input(t, project))
	}
	f.blockIngest(true)
	f.tick(t)
	queued := map[string][]byte{}
	if err := queue.Open(f.layout).Records(func(id string, record []byte) { queued[id] = bytes.Clone(record) }); err != nil {
		t.Fatal(err)
	}
	if len(queued) != len(firings) || recorder.calls() != len(firings) {
		t.Fatalf("setup: %d queued, %d normalizations for %d hooks", len(queued), recorder.calls(), len(firings))
	}
	for id, raw := range queued {
		if bytes.Contains(raw, []byte(hermesFingerprint())) {
			t.Fatalf("queued record %s holds the fingerprint: %s", id, raw)
		}
	}
	recorder.mu.Lock()
	for _, request := range recorder.requests {
		if strings.Contains(hermesCanonical(t, request.Payload), hermesFingerprint()) {
			recorder.mu.Unlock()
			t.Fatalf("the pinned Beacon was handed the fingerprint for %s", request.Event)
		}
	}
	recorder.mu.Unlock()

	f.blockIngest(false)
	*f.clock = f.clock.Add(time.Hour)
	f.tick(t)
	uplinked := f.uplinkedByCaptureID()
	if len(uplinked) != len(firings) || f.queueCount(t) != 0 {
		t.Fatalf("uplinked %d captures, %d still queued", len(uplinked), f.queueCount(t))
	}
	for id, copies := range uplinked {
		for _, raw := range copies {
			if bytes.Contains(raw, []byte(hermesFingerprint())) {
				t.Fatalf("uplinked record %s holds the fingerprint: %s", id, raw)
			}
		}
	}
	// Each uploaded tool call is named by the opaque id of its own firing.
	uploadedCallIDs := map[any]bool{}
	for _, record := range f.server.Records() {
		genAI, _ := hermesRecordEvent(t, record)["gen_ai"].(map[string]any)
		tool, _ := genAI["tool"].(map[string]any)
		if call, _ := tool["call"].(map[string]any); call["id"] != nil {
			uploadedCallIDs[call["id"]] = true
		}
	}
	for _, firing := range firings {
		if firing.event == "post_tool_call" && !uploadedCallIDs[firing.opaqueCallID()] {
			t.Errorf("no uploaded tool call carries the opaque id %s of the %q firing", firing.opaqueCallID(), firing.callID)
		}
	}
	f.assertNoDurableFileHolds(t, hermesFingerprint())
}
