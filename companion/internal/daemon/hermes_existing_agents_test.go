// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent/pi"
)

// beaconShapedEvent carries members a Hermes projection would drop, so an
// unprojected event is recognizable after the daemon.
func beaconShapedEvent(session string) map[string]any {
	return map[string]any{
		"schema_version": "1.0",
		"timestamp":      "2026-09-24T11:00:00.5Z",
		"event":          map[string]any{"id": "beacon-own-event-id", "action": "session.started", "category": "session"},
		"session":        map[string]any{"id": session},
		"message":        "Agent session started",
		"sequence":       7,
		"severity":       "info",
		"trace":          map[string]any{"id": "session:fixture:" + session},
		"raw":            map[string]any{"fixture": map[string]any{"source": "startup"}},
	}
}

func assertUnprojected(t *testing.T, harness string, record map[string]any) {
	t.Helper()
	events, _ := record["events"].([]any)
	if len(events) != 1 {
		t.Fatalf("%s record carries %d events", harness, len(events))
	}
	event := events[0].(map[string]any)
	for _, member := range []string{"message", "sequence", "severity", "trace", "raw"} {
		if event[member] == nil {
			t.Errorf("%s event lost %s: %v", harness, member, event)
		}
	}
	if event["event"].(map[string]any)["id"] != "beacon-own-event-id" || event["timestamp"] != "2026-09-24T11:00:00.5Z" {
		t.Errorf("%s event id or timestamp replaced: %v", harness, event)
	}
}

func TestClaudeCaptureIDsStillComeFromTheInboxItemAndEventsAreNotProjected(t *testing.T) {
	f := newFixture(t)
	f.normalizer.normalized = []map[string]any{beaconShapedEvent("sess-1")}
	f.hook(t, f.repo, "SessionStart", `,"source":"startup"`)
	f.hook(t, f.repo, "SessionStart", `,"source":"startup"`)
	names := f.inboxFiles(t)
	f.tick(t)
	records := f.server.Records()
	if len(records) != len(names) || f.normalizer.calls.Load() != int32(len(names)) {
		t.Fatalf("identical Claude deliveries are separate captures: %d records for %d items", len(records), len(names))
	}
	want := map[string]bool{}
	for name := range names {
		want[captureID("claude_code", name)] = true
	}
	for _, record := range records {
		if !want[record["capture_id"].(string)] {
			t.Fatalf("Claude capture id %v is not captureID(claude_code, inbox name)", record["capture_id"])
		}
		delete(want, record["capture_id"].(string))
		assertUnprojected(t, "claude_code", record)
	}
}

func TestPiCaptureIDsStillComeFromTheInboxItemAndEventsAreNotProjected(t *testing.T) {
	f := newFixture(t, pi.New())
	f.normalizer.normalized = []map[string]any{beaconShapedEvent("pi-sess-1")}
	f.server.Lock()
	f.server.Policy.Installation.EnabledAgents = append(f.server.Policy.Installation.EnabledAgents, pi.ID)
	f.server.Unlock()
	f.daemon.refreshPolicy(context.Background())
	start, _ := json.Marshal(map[string]string{"type": "session_start", "reason": "startup", "sessionId": "pi-sess-1", "cwd": f.repo})
	if err := f.shim.Handle("pi", strings.NewReader(string(start))); err != nil {
		t.Fatal(err)
	}
	names := f.inboxFiles(t)
	f.tick(t)
	records := f.server.Records()
	if len(records) != 1 || len(names) != 1 {
		t.Fatalf("%d records for %d items", len(records), len(names))
	}
	for name := range names {
		if records[0]["capture_id"] != captureID(pi.ID, name) {
			t.Fatalf("Pi capture id %v is not captureID(pi_cli, inbox name)", records[0]["capture_id"])
		}
	}
	assertUnprojected(t, pi.ID, records[0])
}
