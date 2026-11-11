// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/queue"
)

// A denial with no tool-call id carries only its turn id, and one turn can
// deny twice: each denial is its own capture, and neither is skipped as the
// other's re-delivery.

const (
	hermesFirstDenialAt  = "2026-09-24T11:59:54.345678Z"
	hermesSecondDenialAt = "2026-09-24T11:59:56.000001Z"
)

func hermesTurnOnlyDenial(t *testing.T, project, observedAt string) []byte {
	t.Helper()
	return hermesVariant(t, "post_approval_response", project, func(payload, extra map[string]any) {
		delete(payload, "tool_call_id")
		extra["observed_at"] = observedAt
	})
}

func assertHermesDenialsApart(t *testing.T, records []map[string]any, wantTimes ...string) {
	t.Helper()
	if len(records) != len(wantTimes) {
		t.Fatalf("uplinked %d denials, want %d", len(records), len(wantTimes))
	}
	captures, eventIDs, times := map[any]bool{}, map[string]bool{}, map[any]bool{}
	for _, record := range records {
		captures[record["capture_id"]] = true
		eventIDs[uplinkedEventID(t, record)] = true
		times[hermesRecordEvent(t, record)["timestamp"]] = true
	}
	if len(captures) != len(wantTimes) || len(eventIDs) != len(wantTimes) {
		t.Fatalf("the denials share a capture id or event id: captures %v, event ids %v", captures, eventIDs)
	}
	for _, want := range wantTimes {
		if !times[want] {
			t.Fatalf("no denial timed %s: %v", want, times)
		}
	}
}

func TestHermesTwoTurnOnlyDenialsInOneTurnAreTwoCaptures(t *testing.T) {
	f, project := newHermesFixture(t, "metadata")
	f.hermesHook(t, hermesTurnOnlyDenial(t, project, hermesFirstDenialAt))
	f.hermesHook(t, hermesTurnOnlyDenial(t, project, hermesSecondDenialAt))
	f.tick(t)
	records := f.server.Records()
	if len(records) != 2 || f.normalizer.calls.Load() != 2 || f.inboxCount(t) != 0 {
		t.Fatalf("the second denial of the turn was dropped as the first one's capture: %d records, %d normalizations, %d left in the inbox",
			len(records), f.normalizer.calls.Load(), f.inboxCount(t))
	}
	if records[0]["capture_id"] == records[1]["capture_id"] || uplinkedEventID(t, records[0]) == uplinkedEventID(t, records[1]) {
		t.Fatalf("the two denials share a capture or event id: %v", records)
	}
}

func TestHermesSecondTurnOnlyDenialWhileTheFirstIsQueuedIsQueuedTooThroughPinnedBeacon(t *testing.T) {
	f, project, recorder := newPinnedHermesFixture(t)
	f.blockIngest(true)
	f.hermesHook(t, hermesTurnOnlyDenial(t, project, hermesFirstDenialAt))
	f.tick(t)
	if f.queueCount(t) != 1 || recorder.calls() != 1 {
		t.Fatalf("setup: the first denial is not queued (%d queued, %d normalizations)", f.queueCount(t), recorder.calls())
	}
	f.hermesHook(t, hermesTurnOnlyDenial(t, project, hermesSecondDenialAt))
	f.tick(t)
	if f.inboxCount(t) != 0 {
		t.Fatalf("%d items left in the inbox", f.inboxCount(t))
	}
	if recorder.calls() != 2 || f.queueCount(t) != 2 {
		t.Fatalf("the second denial was dropped as the first one's capture: %d normalizations, %d queued", recorder.calls(), f.queueCount(t))
	}
	queued := map[string][]byte{}
	if err := queue.Open(f.layout).Records(func(id string, record []byte) { queued[id] = bytes.Clone(record) }); err != nil {
		t.Fatal(err)
	}
	f.blockIngest(false)
	*f.clock = f.clock.Add(time.Hour)
	f.tick(t)
	assertHermesDenialsApart(t, f.server.Records(), hermesFirstDenialAt, hermesSecondDenialAt)
	for id, copies := range f.uplinkedByCaptureID() {
		if len(copies) != 1 || !bytes.Equal(copies[0], queued[id]) {
			t.Fatalf("%s: the uplinked bytes are not the queued record", id)
		}
	}
}

// Guard: the same turn-only denial delivered again is one capture, uplinked once.
func TestHermesRedeliveredTurnOnlyDenialIsOneCapture(t *testing.T) {
	f, project := newHermesFixture(t, "metadata")
	input := hermesTurnOnlyDenial(t, project, hermesSecondDenialAt)
	f.hermesHook(t, input)
	f.hermesHook(t, input)
	f.tick(t)
	f.hermesHook(t, input)
	f.tick(t)
	if records := f.server.Records(); len(records) != 1 || f.normalizer.calls.Load() != 1 || f.inboxCount(t) != 0 {
		t.Fatalf("re-deliveries: %d records, %d normalizations, %d left in the inbox", len(records), f.normalizer.calls.Load(), f.inboxCount(t))
	}
}
