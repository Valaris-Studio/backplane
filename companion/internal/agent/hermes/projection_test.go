// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package hermes

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

var uuidV5 = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

// pinnedBeaconOutput is what the pinned beacon-hooks --platform hermes made of
// the event's golden payload, device identity already stripped.
func pinnedBeaconOutput(t *testing.T, event, cwd string) []json.RawMessage {
	t.Helper()
	var events []json.RawMessage
	for _, line := range bytes.Split(bytes.TrimSpace(readFixture(t, event+".beacon.jsonl", cwd)), []byte("\n")) {
		events = append(events, json.RawMessage(line))
	}
	return events
}

func projectEvents(t *testing.T, observation agent.Observation, payload map[string]any, events []json.RawMessage) ([]json.RawMessage, error) {
	t.Helper()
	var adapter agent.Agent = New()
	projector, ok := adapter.(agent.EventProjector)
	if !ok {
		t.Fatal("hermes is not an EventProjector")
	}
	return projector.ProjectEvents(observation, payload, events)
}

func mustProject(t *testing.T, observation agent.Observation, payload map[string]any, events []json.RawMessage) []map[string]any {
	t.Helper()
	projected, err := projectEvents(t, observation, payload, events)
	if err != nil {
		t.Fatalf("ProjectEvents: %v", err)
	}
	if len(projected) != len(events) {
		t.Fatalf("%d Beacon events projected to %d", len(events), len(projected))
	}
	decoded := make([]map[string]any, len(projected))
	for index, line := range projected {
		decoded[index] = decodeJSON(t, line)
	}
	return decoded
}

func eventID(event map[string]any) string {
	id, _ := event["event"].(map[string]any)["id"].(string)
	return id
}

func goldenEvent(t *testing.T, event, cwd, id string) map[string]any {
	t.Helper()
	return decodeJSON(t, bytes.ReplaceAll(readFixture(t, event+".event.json", cwd), []byte("__EVENT_ID__"), []byte(id)))
}

// edited re-encodes each Beacon event after edit.
func edited(t *testing.T, events []json.RawMessage, edit func(map[string]any)) []json.RawMessage {
	t.Helper()
	out := make([]json.RawMessage, len(events))
	for index, line := range events {
		event := decodeJSON(t, line)
		edit(event)
		out[index] = json.RawMessage(canonical(t, event))
	}
	return out
}

func TestProjectEventsKeepsOnlyTheAllowlistedMembersOfPinnedBeaconOutput(t *testing.T) {
	cwd := t.TempDir()
	ids := map[string]string{}
	for _, event := range subscribedEvents {
		observation, payload := parse(t, input(t, event, cwd))
		beaconOutput := pinnedBeaconOutput(t, event, cwd)
		projected := mustProject(t, observation, payload, beaconOutput)
		if len(projected) != 1 {
			t.Fatalf("%s: %d events", event, len(projected))
		}
		id := eventID(projected[0])
		if !uuidV5.MatchString(id) || id == eventID(decodeJSON(t, beaconOutput[0])) {
			t.Fatalf("%s: event id %q is not a fresh UUIDv5", event, id)
		}
		if got, want := canonical(t, projected[0]), canonical(t, goldenEvent(t, event, cwd, id)); got != want {
			t.Fatalf("%s projection\n got %s\nwant %s", event, got, want)
		}
		if again := mustProject(t, observation, payload, beaconOutput); eventID(again[0]) != id {
			t.Fatalf("%s: event id changed between projections", event)
		}
		if other, taken := ids[id]; taken {
			t.Fatalf("%s and %s share event id %s", event, other, id)
		}
		ids[id] = event
	}
}

func TestProjectEventsDropsWhateverElseBeaconAdds(t *testing.T) {
	cwd := t.TempDir()
	for _, event := range subscribedEvents {
		observation, payload := parse(t, input(t, event, cwd))
		hostile := edited(t, pinnedBeaconOutput(t, event, cwd), func(line map[string]any) {
			if event == "post_tool_call" {
				line["status"] = "succeeded"
			}
			line["error"] = "HERMES_SENTINEL_ERROR"
			line["command"] = map[string]any{"line": "HERMES_SENTINEL_COMMAND"}
			line["file"] = map[string]any{"path": cwd + "/HERMES_SENTINEL.go"}
			line["event"].(map[string]any)["reason"] = "HERMES_SENTINEL_REASON"
			line["session"].(map[string]any)["title"] = "HERMES_SENTINEL_TITLE"
			line["harness"].(map[string]any)["version"] = "HERMES_SENTINEL_VERSION"
			if approval, ok := line["approval"].(map[string]any); ok {
				approval["reason"] = "HERMES_SENTINEL_APPROVAL_REASON"
			}
			if tool, ok := line["tool"].(map[string]any); ok {
				tool["input"] = map[string]any{"card_id": "HERMES_SENTINEL_ARGS"}
			}
			if mcp, ok := line["mcp"].(map[string]any); ok {
				mcp["arguments"] = "HERMES_SENTINEL_ARGS"
			}
			if genAI, ok := line["gen_ai"].(map[string]any); ok {
				genAI["prompt"] = "HERMES_SENTINEL_PROMPT"
				genAI["usage"] = map[string]any{"input_tokens": 12}
			}
		})
		projected := mustProject(t, observation, payload, hostile)
		want := goldenEvent(t, event, cwd, eventID(projected[0]))
		if got := canonical(t, projected[0]); got != canonical(t, want) {
			t.Fatalf("%s kept more than its allowlist\n got %s\nwant %s", event, got, canonical(t, want))
		}
		if strings.Contains(canonical(t, projected), sentinelMark) {
			t.Fatalf("%s: content survived projection", event)
		}
	}
}

func TestProjectEventsNamesEachEventByCaptureKeyAndPosition(t *testing.T) {
	cwd := t.TempDir()
	observation, payload := parse(t, input(t, "post_tool_call", cwd))
	single := pinnedBeaconOutput(t, "post_tool_call", cwd)
	only := eventID(mustProject(t, observation, payload, single)[0])
	pair := mustProject(t, observation, payload, append(append([]json.RawMessage{}, single...), single...))
	if len(pair) != 2 || eventID(pair[0]) != only || eventID(pair[1]) == only || !uuidV5.MatchString(eventID(pair[1])) {
		t.Fatalf("events of one observation must be named by position: %s then %s (alone %s)", eventID(pair[0]), eventID(pair[1]), only)
	}
	moved := t.TempDir()
	movedObservation, movedPayload := parse(t, input(t, "post_tool_call", moved))
	if eventID(mustProject(t, movedObservation, movedPayload, pinnedBeaconOutput(t, "post_tool_call", moved))[0]) != only {
		t.Fatal("the working directory changed the event id")
	}
	otherCallObservation, otherCallPayload := parse(t, variant(t, "post_tool_call", cwd, func(payload, _ map[string]any) { payload["tool_call_id"] = "toolu_01ZzYyXx" }))
	if eventID(mustProject(t, otherCallObservation, otherCallPayload, single)[0]) == only {
		t.Fatal("another tool call kept the event id")
	}
	// Same native identity, other content: the same event id, so the server
	// keeps the first copy instead of storing a second event.
	recontentObservation, recontentPayload := parse(t, variant(t, "post_tool_call", cwd, func(_, extra map[string]any) {
		extra["duration_ms"] = 43
		extra["status"] = "error"
		extra["observed_at"] = "2026-09-24T11:59:53.000001Z"
	}))
	if id := eventID(mustProject(t, recontentObservation, recontentPayload, single)[0]); id != only {
		t.Fatalf("other content under the same native identity renamed the event: %s, want %s", id, only)
	}
}

// Beacon labels every Hermes event hook-collected; the companion reached it
// through the observer plugin, as the record says.
func TestProjectEventsRecordsThePluginAsTheCollectionMethod(t *testing.T) {
	cwd := t.TempDir()
	for _, event := range subscribedEvents {
		observation, payload := parse(t, input(t, event, cwd))
		for _, beaconSays := range []any{"hook", "otlp", nil} {
			beaconOutput := edited(t, pinnedBeaconOutput(t, event, cwd), func(line map[string]any) {
				harness := line["harness"].(map[string]any)
				if beaconSays == nil {
					delete(harness, "collection_method")
					return
				}
				harness["collection_method"] = beaconSays
			})
			harness, _ := mustProject(t, observation, payload, beaconOutput)[0]["harness"].(map[string]any)
			if harness["collection_method"] != "plugin" || harness["name"] != "hermes" {
				t.Errorf("%s (Beacon said %v): harness %v, want hermes collected by plugin", event, beaconSays, harness)
			}
		}
	}
}

func TestProjectEventsRefusesAnotherSessionsEvent(t *testing.T) {
	cwd := t.TempDir()
	observation, payload := parse(t, input(t, "post_tool_call", cwd))
	foreign := edited(t, pinnedBeaconOutput(t, "post_tool_call", cwd), func(line map[string]any) {
		line["session"].(map[string]any)["id"] = "20260924_000000_ffffff"
	})
	if projected, err := projectEvents(t, observation, payload, foreign); err == nil {
		t.Fatalf("an event of another session was projected: %s", projected)
	}
}
