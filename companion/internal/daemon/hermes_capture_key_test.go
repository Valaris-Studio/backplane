// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
)

func capturedIDs(records []map[string]any) []string {
	ids := []string{}
	for _, record := range records {
		ids = append(ids, record["capture_id"].(string))
	}
	sort.Strings(ids)
	return ids
}

func TestHermesRedeliveryKeepsItsCaptureIDThroughTheDrain(t *testing.T) {
	f, project := newHermesFixture(t, "metadata")
	input := hermesInput(t, "post_tool_call", project)
	f.hermesHook(t, input)
	f.hermesHook(t, input)
	items := f.inboxItems(t)
	if len(items) != 2 {
		t.Fatalf("setup: %d inbox items for two deliveries", len(items))
	}
	keys := map[string]bool{}
	for _, item := range items {
		keys[hermesCaptureKey(t, item)] = true
	}
	if len(keys) != 1 {
		t.Fatal("two identical deliveries were named apart")
	}
	var key string
	for named := range keys {
		key = named
	}
	f.tick(t)
	records := f.server.Records()
	if len(records) != 1 || f.normalizer.calls.Load() != 1 {
		t.Fatalf("a re-delivery was captured again: %d records, %d normalizations", len(records), f.normalizer.calls.Load())
	}
	if records[0]["capture_id"] != captureID(hermesAgent, key) {
		t.Fatalf("capture id %v is not derived from the capture key", records[0]["capture_id"])
	}
	for name := range items {
		if records[0]["capture_id"] == captureID(hermesAgent, name) {
			t.Fatal("capture id still derived from the inbox file name")
		}
	}
	if f.inboxCount(t) != 0 {
		t.Fatal("the skipped re-delivery stayed in the inbox")
	}
	uploaded, _ := json.Marshal(records)
	if strings.Contains(string(uploaded), key) {
		t.Fatal("the capture key was stored as a field")
	}
	f.hermesHook(t, input)
	f.tick(t)
	if records := f.server.Records(); len(records) != 1 || f.normalizer.calls.Load() != 1 {
		t.Fatalf("a re-delivery after the ack was captured again: %d records", len(records))
	}
}

func TestHermesAnotherToolCallIsANewCaptureButAnotherCwdIsNot(t *testing.T) {
	f, project := newHermesFixture(t, "metadata")
	sub := filepath.Join(project, "sub")
	if err := os.MkdirAll(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	f.hermesHook(t, hermesInput(t, "post_tool_call", project))
	f.hermesHook(t, hermesInput(t, "post_tool_call", sub))
	f.hermesHook(t, hermesVariant(t, "post_tool_call", project, func(payload, _ map[string]any) { payload["tool_call_id"] = "toolu_01ZzYyXx" }))
	keys := map[string]bool{}
	for _, item := range f.inboxItems(t) {
		keys[captureID(hermesAgent, hermesCaptureKey(t, item))] = true
	}
	if len(keys) != 2 {
		t.Fatalf("want one key for the cwd change and another for the other tool call, got %d", len(keys))
	}
	f.tick(t)
	records := f.server.Records()
	want := []string{}
	for id := range keys {
		want = append(want, id)
	}
	sort.Strings(want)
	if got := capturedIDs(records); strings.Join(got, ",") != strings.Join(want, ",") || f.normalizer.calls.Load() != 2 {
		t.Fatalf("captured %v, want %v (%d normalizations)", got, want, f.normalizer.calls.Load())
	}
}

// The same native identity re-sent with other content is the same capture:
// while the first copy waits in the queue the second is never normalized or
// queued, and the queued bytes stay the first copy's.
func TestHermesSameIdentityWithOtherContentIsNotQueuedTwice(t *testing.T) {
	f, project := newHermesFixture(t, "metadata")
	f.blockIngest(true)
	f.hermesHook(t, hermesInput(t, "post_tool_call", project))
	var firstID string
	for _, item := range f.inboxItems(t) {
		firstID = captureID(hermesAgent, hermesCaptureKey(t, item))
	}
	f.tick(t)
	queued := map[string][]byte{}
	if err := queue.Open(f.layout).Records(func(id string, record []byte) { queued[id] = bytes.Clone(record) }); err != nil {
		t.Fatal(err)
	}
	if len(queued) != 1 || queued[firstID] == nil || f.normalizer.calls.Load() != 1 {
		t.Fatalf("setup: the first copy is not the one queued record (%d queued, %d normalizations)", len(queued), f.normalizer.calls.Load())
	}

	f.hermesHook(t, hermesVariant(t, "post_tool_call", project, func(_, extra map[string]any) {
		extra["status"] = "error"
		extra["duration_ms"] = 43
		extra["observed_at"] = "2026-09-24T11:59:53.000001Z"
	}))
	for _, item := range f.inboxItems(t) {
		if id := captureID(hermesAgent, hermesCaptureKey(t, item)); id != firstID {
			t.Fatalf("other content under the same native identity was named %s, want %s", id, firstID)
		}
	}
	f.tick(t)
	if f.normalizer.calls.Load() != 1 || f.inboxCount(t) != 0 {
		t.Fatalf("the second copy was normalized (%d normalizations) or left in the inbox (%d)", f.normalizer.calls.Load(), f.inboxCount(t))
	}
	after := map[string][]byte{}
	if err := queue.Open(f.layout).Records(func(id string, record []byte) { after[id] = bytes.Clone(record) }); err != nil {
		t.Fatal(err)
	}
	if len(after) != 1 || !bytes.Equal(after[firstID], queued[firstID]) {
		t.Fatalf("the second copy was queued or replaced the first: %d queued", len(after))
	}

	f.blockIngest(false)
	*f.clock = f.clock.Add(time.Hour)
	f.tick(t)
	if records := f.server.Records(); len(records) != 1 || records[0]["capture_id"] != firstID {
		t.Fatalf("uplinked %d records, want only the first copy %s", len(records), firstID)
	}
}

func TestHermesProjectionFailureDropsTheItemAndCountsIt(t *testing.T) {
	f, project := newHermesFixture(t, "metadata")
	f.normalizer.normalized = []map[string]any{{
		"schema_version": "1.0",
		"timestamp":      "2026-09-24T11:59:50.123456Z",
		"event":          map[string]any{"action": "session.started"},
		"session":        map[string]any{"id": "20260924_000000_ffffff", "working_directory": project},
	}}
	f.hermesHook(t, hermesInput(t, "on_session_start", project))
	f.tick(t)
	health, _ := state.Load[state.Health](f.layout.Health())
	if f.inboxCount(t) != 0 || f.queueCount(t) != 0 || len(f.server.Records()) != 0 || health.DroppedItems != 1 || health.NormalizeFailures != 0 {
		t.Fatalf("an event of another session must be dropped and counted: inbox=%d queue=%d %+v", f.inboxCount(t), f.queueCount(t), health)
	}
}
