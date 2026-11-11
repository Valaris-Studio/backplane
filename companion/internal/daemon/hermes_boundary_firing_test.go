// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/queue"
)

// Through the daemon and the pinned Beacon: Hermes reopens a
// finalized session on its next real turn and finalizes it again at the next
// viewer close: each finalize is its own capture, so the session ends again.

const (
	hermesFixtureFinalizedAt = "2026-09-24T11:59:58.456789Z"
	hermesReopenedAt         = "2026-09-24T12:30:00.000001Z"
	hermesRefinalizedAt      = "2026-09-24T12:31:07.000001Z"
)

func hermesFinalizeAt(t *testing.T, project, observedAt string) []byte {
	t.Helper()
	return hermesVariant(t, "on_session_finalize", project, func(_, extra map[string]any) {
		extra["observed_at"] = observedAt
		extra["reason"] = "tui_close"
	})
}

func hermesRecordEvent(t *testing.T, record map[string]any) map[string]any {
	t.Helper()
	events, _ := record["events"].([]any)
	if len(events) != 1 {
		t.Fatalf("record carries %d events: %v", len(events), record)
	}
	return events[0].(map[string]any)
}

func hermesEndRecords(t *testing.T, records []map[string]any) []map[string]any {
	t.Helper()
	var ended []map[string]any
	for _, record := range records {
		if action, _ := hermesRecordEvent(t, record)["event"].(map[string]any)["action"].(string); action == "session.ended" {
			ended = append(ended, record)
		}
	}
	return ended
}

func assertHermesFinalizesApart(t *testing.T, ended []map[string]any, wantTimes ...string) {
	t.Helper()
	if len(ended) != len(wantTimes) {
		t.Fatalf("uplinked %d session ends, want %d", len(ended), len(wantTimes))
	}
	captures, eventIDs, times := map[any]bool{}, map[string]bool{}, map[any]bool{}
	for _, record := range ended {
		captures[record["capture_id"]] = true
		eventIDs[uplinkedEventID(t, record)] = true
		times[hermesRecordEvent(t, record)["timestamp"]] = true
	}
	if len(captures) != len(wantTimes) || len(eventIDs) != len(wantTimes) {
		t.Fatalf("the finalizes share a capture id or event id: captures %v, event ids %v", captures, eventIDs)
	}
	for _, want := range wantTimes {
		if !times[want] {
			t.Fatalf("no session end timed %s: %v", want, times)
		}
	}
}

func TestHermesSecondFinalizeWhileTheFirstIsQueuedIsQueuedTooThroughPinnedBeacon(t *testing.T) {
	f, project, recorder := newPinnedHermesFixture(t)
	f.blockIngest(true)
	f.hermesHook(t, hermesInput(t, "on_session_finalize", project))
	f.tick(t)
	if f.queueCount(t) != 1 || recorder.calls() != 1 {
		t.Fatalf("setup: the first finalize is not queued (%d queued, %d normalizations)", f.queueCount(t), recorder.calls())
	}
	f.hermesHook(t, hermesFinalizeAt(t, project, hermesRefinalizedAt))
	f.tick(t)
	if f.inboxCount(t) != 0 {
		t.Fatalf("%d items left in the inbox", f.inboxCount(t))
	}
	if recorder.calls() != 2 || f.queueCount(t) != 2 {
		t.Fatalf("the second finalize was dropped as the first one's capture: %d normalizations, %d queued", recorder.calls(), f.queueCount(t))
	}
	queued := map[string][]byte{}
	if err := queue.Open(f.layout).Records(func(id string, record []byte) { queued[id] = bytes.Clone(record) }); err != nil {
		t.Fatal(err)
	}
	f.blockIngest(false)
	*f.clock = f.clock.Add(time.Hour)
	f.tick(t)
	records := f.server.Records()
	assertHermesFinalizesApart(t, hermesEndRecords(t, records), hermesFixtureFinalizedAt, hermesRefinalizedAt)
	for id, copies := range f.uplinkedByCaptureID() {
		if len(copies) != 1 || !bytes.Equal(copies[0], queued[id]) {
			t.Fatalf("%s: the uplinked bytes are not the queued record", id)
		}
	}
}

func TestHermesReopenedSessionEndsAgainThroughPinnedBeacon(t *testing.T) {
	f, project, recorder := newPinnedHermesFixture(t)
	sessions := recordSessions(f)
	step := func(input []byte) {
		t.Helper()
		f.hermesHook(t, input)
		f.tick(t)
		*f.clock = f.clock.Add(3 * time.Second)
	}
	for _, event := range hermesEvents {
		step(hermesInput(t, event, project))
	}
	if last := sessions.last(); last.Kind != SessionEnded {
		t.Fatalf("setup: the first finalize did not end the session: %v", sessions.kinds())
	}
	// The next real turn reopens it; the next viewer close finalizes it again.
	step(hermesVariant(t, "post_tool_call", project, func(payload, extra map[string]any) {
		payload["tool_call_id"] = "toolu_01Reopened"
		extra["observed_at"] = hermesReopenedAt
	}))
	step(hermesFinalizeAt(t, project, hermesRefinalizedAt))
	records := f.server.Records()
	if want := len(hermesEvents) + 2; len(records) != want || recorder.calls() != want {
		t.Fatalf("uplinked %d records after %d normalizations, want %d: the second finalize was dropped as settled", len(records), recorder.calls(), want)
	}
	assertHermesFinalizesApart(t, hermesEndRecords(t, records), hermesFixtureFinalizedAt, hermesRefinalizedAt)
	last := sessions.last()
	if last.Kind != SessionEnded || last.Session.Harness != hermesAgent || last.Session.NativeSessionID != hermesSession {
		t.Fatalf("the reopened session never ended again: %+v (kinds %v)", last, sessions.kinds())
	}
}

// Guard: the same finalize delivered again is the
// same capture, queued once and never uplinked twice.
func TestHermesRedeliveredFinalizeIsOneCaptureThroughPinnedBeacon(t *testing.T) {
	f, project, recorder := newPinnedHermesFixture(t)
	input := hermesFinalizeAt(t, project, hermesRefinalizedAt)
	f.hermesHook(t, input)
	f.hermesHook(t, input)
	f.tick(t)
	f.hermesHook(t, input)
	f.tick(t)
	if records := f.server.Records(); len(records) != 1 || recorder.calls() != 1 || f.inboxCount(t) != 0 {
		t.Fatalf("re-deliveries: %d records, %d normalizations, %d left in the inbox", len(records), recorder.calls(), f.inboxCount(t))
	}
}
