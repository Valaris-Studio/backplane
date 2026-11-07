// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
	"github.com/Valaris-Studio/backplane/companion/internal/queue"
)

var hermesEventID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// beaconRecorder keeps what the pinned Beacon made of each request, before
// the daemon touched it.
type beaconRecorder struct {
	next     Normalizer
	mu       sync.Mutex
	requests []beacon.Request
	results  []beacon.Result
}

func (r *beaconRecorder) Normalize(ctx context.Context, request beacon.Request) (beacon.Result, error) {
	result, err := r.next.Normalize(ctx, request)
	r.mu.Lock()
	defer r.mu.Unlock()
	kept := result
	kept.Events = append([]json.RawMessage(nil), result.Events...)
	r.requests, r.results = append(r.requests, request), append(r.results, kept)
	return result, err
}

func (r *beaconRecorder) calls() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.requests)
}

func (r *beaconRecorder) made(t *testing.T, event string) []map[string]any {
	t.Helper()
	r.mu.Lock()
	defer r.mu.Unlock()
	for index, request := range r.requests {
		if request.Event == event {
			var events []map[string]any
			for _, line := range r.results[index].Events {
				events = append(events, decodeHermesJSON(t, line))
			}
			return events
		}
	}
	t.Fatalf("Beacon never normalized %s", event)
	return nil
}

// newPinnedHermesFixture is newHermesFixture at the metadata level with the
// real beacon-hooks the companion is pinned to.
func newPinnedHermesFixture(t *testing.T) (*fixture, string, *beaconRecorder) {
	t.Helper()
	manifest := os.Getenv("BACKPLANE_BEACON_ARTIFACT")
	if manifest == "" || runtime.GOOS == "windows" {
		t.Skip("set BACKPLANE_BEACON_ARTIFACT to replay through the pinned beacon-hooks executable")
	}
	f, project := newHermesFixture(t, "metadata")
	runner, err := beacon.Load(manifest, f.layout.WorkDir())
	if err != nil {
		t.Fatal(err)
	}
	recorder := &beaconRecorder{next: runner}
	f.daemon.config.Normalizer = recorder
	return f, project, recorder
}

func (f *fixture) blockIngest(blocked bool) {
	f.server.Lock()
	defer f.server.Unlock()
	if blocked {
		f.server.Status["/api/companion/ingest"] = 503
		return
	}
	delete(f.server.Status, "/api/companion/ingest")
}

func (f *fixture) uplinkedByCaptureID() map[string][][]byte {
	f.server.Lock()
	defer f.server.Unlock()
	uplinked := map[string][][]byte{}
	for _, batch := range f.server.Batches {
		for _, raw := range batch {
			var record struct {
				CaptureID string `json:"capture_id"`
			}
			json.Unmarshal(raw, &record)
			uplinked[record.CaptureID] = append(uplinked[record.CaptureID], raw)
		}
	}
	return uplinked
}

// localPathLeaves are the member names and strings that spell a local path.
func localPathLeaves(value any) []string {
	var found []string
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if filepath.IsAbs(key) {
				found = append(found, key)
			}
			found = append(found, localPathLeaves(child)...)
		}
	case []any:
		for _, child := range typed {
			found = append(found, localPathLeaves(child)...)
		}
	case string:
		if filepath.IsAbs(typed) || strings.HasPrefix(typed, "~") {
			found = append(found, typed)
		}
	}
	return found
}

func uplinkedEventID(t *testing.T, record map[string]any) string {
	t.Helper()
	events, _ := record["events"].([]any)
	if len(events) != 1 {
		t.Fatalf("record carries %d events: %v", len(events), record)
	}
	id, _ := events[0].(map[string]any)["event"].(map[string]any)["id"].(string)
	return id
}

func TestHermesThroughPinnedBeaconQueuesAndUplinksTheGoldenRecords(t *testing.T) {
	f, project, recorder := newPinnedHermesFixture(t)
	capturedAt := f.clock.UTC().Format(time.RFC3339Nano)
	for _, event := range hermesEvents {
		f.hermesHook(t, hermesInput(t, event, project))
	}
	captureIDs := map[string]string{}
	for _, item := range f.inboxItems(t) {
		captureIDs[item.Observation.Event] = captureID(hermesAgent, hermesCaptureKey(t, item))
	}
	f.blockIngest(true)
	f.tick(t)
	queued := map[string][]byte{}
	if err := queue.Open(f.layout).Records(func(id string, record []byte) { queued[id] = bytes.Clone(record) }); err != nil {
		t.Fatal(err)
	}
	if len(queued) != len(hermesEvents) {
		t.Fatalf("queued %d records for %d events", len(queued), len(hermesEvents))
	}
	f.blockIngest(false)
	*f.clock = f.clock.Add(time.Hour)
	f.tick(t)
	uplinked := f.uplinkedByCaptureID()
	if f.queueCount(t) != 0 || len(uplinked) != len(hermesEvents) {
		t.Fatalf("queue %d, uplinked %d", f.queueCount(t), len(uplinked))
	}
	root := filepath.Dir(f.home)
	for _, event := range hermesEvents {
		id := captureIDs[event]
		if len(uplinked[id]) != 1 || !bytes.Equal(uplinked[id][0], queued[id]) {
			t.Fatalf("%s: the uplinked bytes are not the queued record", event)
		}
		raw := queued[id]
		assertNoHermesContent(t, event, raw)
		assertNoHermesDigest(t, event, raw)
		if bytes.Contains(raw, []byte(root)) {
			t.Fatalf("%s: a local path left the device: %s", event, raw)
		}
		record := decodeHermesJSON(t, raw)
		if leaves := localPathLeaves(record); len(leaves) != 0 {
			t.Fatalf("%s: local paths %v in %s", event, leaves, raw)
		}
		beaconMade := recorder.made(t, event)
		if len(beaconMade) != 1 || beaconMade[0]["raw"] == nil || beaconMade[0]["message"] == nil || beaconMade[0]["repository"] != project {
			t.Fatalf("%s: setup: the pinned Beacon no longer emits raw, message and repository: %v", event, beaconMade)
		}
		eventID := uplinkedEventID(t, record)
		beaconID, _ := beaconMade[0]["event"].(map[string]any)["id"].(string)
		if !hermesEventID.MatchString(eventID) || eventID == beaconID {
			t.Fatalf("%s: event id %q is not the capture's own UUIDv5 (Beacon's was %q)", event, eventID, beaconID)
		}
		wantEvent := decodeHermesJSON(t, bytes.ReplaceAll(hermesTestdata(t, event+".event.json", "project"), []byte("__EVENT_ID__"), []byte(eventID)))
		want := map[string]any{
			"capture_id":        id,
			"mapping_id":        hermesMapping,
			"harness":           hermesAgent,
			"harness_version":   nil,
			"collection_method": "plugin",
			"native_session_id": hermesSession,
			"captured_at":       capturedAt,
			"beacon":            map[string]any{"commit": beacon.Commit, "schema_version": "1.0"},
			"events":            []any{wantEvent},
		}
		if got, want := hermesCanonical(t, record), hermesCanonical(t, want); got != want {
			t.Fatalf("%s uplink record\n got %s\nwant %s", event, got, want)
		}
	}
	f.assertNoHermesContentAnywhere(t)
}

func TestHermesThroughPinnedBeaconNamesAnObservationAlikeOnEveryRun(t *testing.T) {
	run := func() map[string]string {
		f, project, _ := newPinnedHermesFixture(t)
		for _, event := range hermesEvents {
			f.hermesHook(t, hermesInput(t, event, project))
		}
		f.tick(t)
		ids := map[string]string{}
		for _, record := range f.server.Records() {
			ids[record["capture_id"].(string)] = uplinkedEventID(t, record)
		}
		return ids
	}
	first, second := run(), run()
	if len(first) != len(hermesEvents) {
		t.Fatalf("captured %d records for %d events", len(first), len(hermesEvents))
	}
	if hermesCanonical(t, first) != hermesCanonical(t, second) {
		t.Fatalf("the same observations were named apart from another folder\nfirst  %v\nsecond %v", first, second)
	}
}

func TestHermesRedeliveryThroughPinnedBeaconIsSkippedByTheQueue(t *testing.T) {
	f, project, recorder := newPinnedHermesFixture(t)
	input := hermesInput(t, "post_approval_response", project)
	f.hermesHook(t, input)
	f.hermesHook(t, input)
	f.tick(t)
	f.hermesHook(t, input)
	f.tick(t)
	if records := f.server.Records(); len(records) != 1 || recorder.calls() != 1 || f.inboxCount(t) != 0 {
		t.Fatalf("re-deliveries: %d records, %d normalizations, %d left in the inbox", len(records), recorder.calls(), f.inboxCount(t))
	}
}

func TestHermesCrashReplayThroughPinnedBeaconKeepsItsCaptureID(t *testing.T) {
	f, project, recorder := newPinnedHermesFixture(t)
	f.hermesHook(t, hermesInput(t, "post_tool_call", project))
	saved := f.inboxFiles(t)
	var key string
	for _, item := range f.inboxItems(t) {
		key = hermesCaptureKey(t, item)
	}
	f.blockIngest(true)
	f.tick(t)
	if f.queueCount(t) != 1 || recorder.calls() != 1 {
		t.Fatal("setup: record not queued")
	}
	// A crash between enqueue and inbox removal leaves both copies.
	f.restoreInbox(t, saved)
	f.tick(t)
	if recorder.calls() != 1 || f.queueCount(t) != 1 || f.inboxCount(t) != 0 {
		t.Fatalf("replayed item re-normalized or duplicated: calls=%d queue=%d", recorder.calls(), f.queueCount(t))
	}
	f.blockIngest(false)
	*f.clock = f.clock.Add(time.Hour)
	f.tick(t)
	f.restoreInbox(t, saved)
	f.tick(t)
	records := f.server.Records()
	if len(records) != 1 || recorder.calls() != 1 {
		t.Fatalf("replay after ack uploaded again: records=%d calls=%d", len(records), recorder.calls())
	}
	if records[0]["capture_id"] != captureID(hermesAgent, key) {
		t.Fatalf("capture id %v is not derived from the capture key", records[0]["capture_id"])
	}
	for name := range saved {
		if records[0]["capture_id"] == captureID(hermesAgent, name) {
			t.Fatal("capture id still derived from the inbox file name")
		}
	}
}

func TestHermesUncertainAckRetransmitsTheQueuedBytesUnchanged(t *testing.T) {
	f, project, _ := newPinnedHermesFixture(t)
	f.failUploads()
	for _, event := range hermesEvents {
		f.hermesHook(t, hermesInput(t, event, project))
	}
	f.tick(t)
	if f.batchCount() != 1 || f.queueCount(t) != len(hermesEvents) {
		t.Fatalf("setup: %d batches, %d queued", f.batchCount(), f.queueCount(t))
	}
	f.server.Lock()
	f.server.Respond = nil
	f.server.Unlock()
	*f.clock = f.clock.Add(time.Hour)
	f.tick(t)
	f.server.Lock()
	rejections := len(f.server.Rejections)
	f.server.Unlock()
	if f.batchCount() != 2 || rejections != 0 || f.queueCount(t) != 0 {
		t.Fatalf("retransmission: %d batches, %d rejections, %d still queued", f.batchCount(), rejections, f.queueCount(t))
	}
	for id, copies := range f.uplinkedByCaptureID() {
		if len(copies) != 2 || !bytes.Equal(copies[0], copies[1]) {
			t.Fatalf("%s was retransmitted with other bytes", id)
		}
	}
}
