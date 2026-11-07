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

// Through the daemon: Hermes mints a missing tool-call id from the call's
// content (agent/message_sanitization.py deterministic_call_id), and the
// adapter replaces it before the first durable write. This file covers the
// bare minted id; hermes_renamed_call_id_test.go covers the renamed `_d<n>` and
// composite `<call id>|<item id>` forms that carry the same fingerprint.

func hermesDeterministicCallID(toolName, arguments string, index int) string {
	sum := sha256.Sum256([]byte(fmt.Sprintf("%s:%s:%d", toolName, arguments, index)))
	return "call_" + hex.EncodeToString(sum[:])[:12]
}

// hermesSynthesizedCallID is built at run time, never spelled in the tree.
func hermesSynthesizedCallID() string {
	return hermesDeterministicCallID("terminal", `{"command":"make deploy HERMES_SENTINEL"}`, 0)
}

func hermesOpaqueCallID(sessionID, turnID, observedAt string) string {
	sum := sha256.Sum256([]byte("hermes-synthesized-call\x00" + sessionID + "\x00" + turnID + "\x00" + observedAt))
	return "hermes-" + hex.EncodeToString(sum[:])[:24]
}

// hermesFixtureOpaqueCallID is the opaque id of event's fixture firing.
func hermesFixtureOpaqueCallID(t *testing.T, event, project string) string {
	t.Helper()
	extra := decodeHermesJSON(t, hermesInput(t, event, project))["extra"].(map[string]any)
	return hermesOpaqueCallID(hermesSession, extra["turn_id"].(string), extra["observed_at"].(string))
}

func hermesWithSynthesizedCallID(t *testing.T, event, project string) []byte {
	t.Helper()
	return hermesVariant(t, event, project, func(payload, _ map[string]any) { payload["tool_call_id"] = hermesSynthesizedCallID() })
}

func (f *fixture) assertNoDurableFileHolds(t *testing.T, needle string) {
	t.Helper()
	for path, data := range f.durableFiles(t) {
		if bytes.Contains(data, []byte(needle)) {
			t.Fatalf("%s holds the synthesized call id: %.400s", path, data)
		}
	}
}

func TestHermesSynthesizedCallIDNeverReachesTheInbox(t *testing.T) {
	f, project := newHermesFixture(t, "metadata")
	synthesized := hermesSynthesizedCallID()
	events := []string{"post_tool_call", "post_approval_response"}
	for _, event := range events {
		f.hermesHook(t, hermesWithSynthesizedCallID(t, event, project))
	}
	items := f.inboxItems(t)
	if len(items) != len(events) {
		t.Fatalf("%d inbox items for %d hooks", len(items), len(events))
	}
	for name, raw := range f.inboxFiles(t) {
		if bytes.Contains(raw, []byte(synthesized)) {
			t.Fatalf("inbox item %s holds the synthesized call id: %.400s", name, raw)
		}
	}
	for _, item := range items {
		want := hermesFixtureOpaqueCallID(t, item.Observation.Event, project)
		if item.Observation.NativeToolCallID != want || item.Payload["tool_call_id"] != want {
			t.Fatalf("%s: call id %q / %v, want the opaque %s", item.Observation.Event, item.Observation.NativeToolCallID, item.Payload["tool_call_id"], want)
		}
	}
	f.assertNoDurableFileHolds(t, synthesized)
}

func TestHermesSynthesizedCallRedeliveryIsOneCaptureNamedByTheOpaqueID(t *testing.T) {
	f, project := newHermesFixture(t, "metadata")
	input := hermesWithSynthesizedCallID(t, "post_tool_call", project)
	f.hermesHook(t, input)
	f.hermesHook(t, input)
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
		if strings.Contains(hermesCanonical(t, payload), hermesSynthesizedCallID()) {
			t.Fatalf("Beacon was handed the synthesized call id: %s", hermesCanonical(t, payload))
		}
	}
	f.assertNoDurableFileHolds(t, hermesSynthesizedCallID())
}

func TestHermesSynthesizedCallIDNeverLeavesTheDeviceThroughPinnedBeacon(t *testing.T) {
	f, project, recorder := newPinnedHermesFixture(t)
	synthesized := hermesSynthesizedCallID()
	events := []string{"post_tool_call", "post_approval_response"}
	for _, event := range events {
		f.hermesHook(t, hermesWithSynthesizedCallID(t, event, project))
	}
	f.blockIngest(true)
	f.tick(t)
	queued := map[string][]byte{}
	if err := queue.Open(f.layout).Records(func(id string, record []byte) { queued[id] = bytes.Clone(record) }); err != nil {
		t.Fatal(err)
	}
	if len(queued) != len(events) || recorder.calls() != len(events) {
		t.Fatalf("setup: %d queued, %d normalizations for %d hooks", len(queued), recorder.calls(), len(events))
	}
	for id, raw := range queued {
		if bytes.Contains(raw, []byte(synthesized)) {
			t.Fatalf("queued record %s holds the synthesized call id: %s", id, raw)
		}
	}
	recorder.mu.Lock()
	for _, request := range recorder.requests {
		if strings.Contains(hermesCanonical(t, request.Payload), synthesized) {
			recorder.mu.Unlock()
			t.Fatalf("the pinned Beacon was handed the synthesized call id for %s", request.Event)
		}
	}
	recorder.mu.Unlock()

	f.blockIngest(false)
	*f.clock = f.clock.Add(time.Hour)
	f.tick(t)
	uplinked := f.uplinkedByCaptureID()
	if len(uplinked) != len(events) || f.queueCount(t) != 0 {
		t.Fatalf("uplinked %d captures, %d still queued", len(uplinked), f.queueCount(t))
	}
	for id, copies := range uplinked {
		for _, raw := range copies {
			if bytes.Contains(raw, []byte(synthesized)) {
				t.Fatalf("uplinked record %s holds the synthesized call id: %s", id, raw)
			}
		}
	}
	// The uploaded tool call is still named by a call id: the opaque one.
	opaque := hermesFixtureOpaqueCallID(t, "post_tool_call", project)
	var linked bool
	for _, record := range f.server.Records() {
		event := hermesRecordEvent(t, record)
		genAI, _ := event["gen_ai"].(map[string]any)
		tool, _ := genAI["tool"].(map[string]any)
		if call, _ := tool["call"].(map[string]any); call["id"] == opaque {
			linked = true
		}
	}
	if !linked {
		t.Fatalf("no uplinked tool call carries the opaque call id %s: %v", opaque, f.server.Records())
	}
	f.assertNoDurableFileHolds(t, synthesized)
}
