// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/shim"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
)

func TestHermesHookRetainsOnlyTheGoldenProjectionAtEveryLevel(t *testing.T) {
	for _, level := range []string{"metadata", "standard", "full"} {
		t.Run(level, func(t *testing.T) {
			f, project := newHermesFixture(t, level)
			sub := filepath.Join(project, "sub")
			if err := os.MkdirAll(sub, 0o700); err != nil {
				t.Fatal(err)
			}
			// Another spelling of the mapped root, so the stored cwd shows the rewrite.
			spelled := sub + string(filepath.Separator) + ".."
			for _, event := range hermesEvents {
				f.hermesHook(t, hermesInput(t, event, spelled))
			}
			for name, raw := range f.inboxFiles(t) {
				assertNoHermesContent(t, name, raw)
				assertNoHermesDigest(t, name, raw)
			}
			items := f.inboxItems(t)
			if len(items) != len(hermesEvents) {
				t.Fatalf("%d inbox items for %d hooks", len(items), len(hermesEvents))
			}
			seen := map[string]bool{}
			for _, item := range items {
				event := item.Observation.Event
				seen[event] = true
				if item.Agent != hermesAgent || item.MappingID != hermesMapping || string(item.ContentLevel) != level || item.Observation.NativeSessionID != hermesSession || item.Observation.Cwd != project {
					t.Fatalf("%s item %+v", event, item)
				}
				got := hermesCanonical(t, withoutNullHermesToolMembers(event, item.Payload))
				want := hermesCanonical(t, decodeHermesJSON(t, hermesTestdata(t, event+".payload.json", project)))
				if got != want {
					t.Fatalf("%s inbox payload\n got %s\nwant %s", event, got, want)
				}
			}
			if len(seen) != len(hermesEvents) {
				t.Fatalf("events retained %v", seen)
			}
		})
	}
}

func TestHermesUnusableInputLeavesOnlyAStableErrorCode(t *testing.T) {
	cases := []struct {
		name  string
		input func(project string) []byte
		code  string
	}{
		{"truncated", func(project string) []byte {
			golden := hermesInput(t, "post_tool_call", project)
			return golden[:bytes.Index(golden, []byte("HERMES_SENTINEL_RESULT"))+len("HERMES_SENTINEL_RESULT")]
		}, agent.ErrInvalidHook.Error()},
		{"oversized", func(project string) []byte {
			return hermesVariant(t, "post_tool_call", project, func(payload, _ map[string]any) {
				payload["result"] = strings.Repeat("HERMES_SENTINEL_", 70000)
			})
		}, shim.ErrHookTooLarge.Error()},
		{"two values", func(project string) []byte {
			return append(hermesInput(t, "on_session_start", project), hermesInput(t, "post_tool_call", project)...)
		}, agent.ErrInvalidHook.Error()},
		{"not an object", func(string) []byte { return []byte(`["HERMES_SENTINEL_PROMPT"]`) }, agent.ErrInvalidHook.Error()},
		{"relative cwd", func(string) []byte {
			return hermesVariant(t, "post_tool_call", "", func(payload, _ map[string]any) { payload["cwd"] = filepath.Join("code", "project") })
		}, agent.ErrMissingIdentity.Error()},
		{"unsubscribed blocking hook", func(project string) []byte {
			return hermesVariant(t, "post_tool_call", project, func(payload, _ map[string]any) { payload["hook_event_name"] = "pre_tool_call" })
		}, agent.ErrUnsupportedEvent.Error()},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f, project := newHermesFixture(t, "metadata")
			before := f.durableFiles(t)
			f.shim.HandleAndRecord("hermes", bytes.NewReader(c.input(project)))
			after := f.durableFiles(t)
			if names, _ := inbox.List(f.layout.InboxDir()); len(names) != 0 {
				t.Fatalf("unusable input was retained: %v", names)
			}
			health, err := state.Load[state.Health](f.layout.Health())
			if err != nil || health.HookErrors != 1 || health.HookLastError != c.code {
				t.Fatalf("health %+v (%v), want one %s", health, err, c.code)
			}
			healthFile, _ := filepath.Rel(f.layout.Root, f.layout.Health())
			for path, data := range after {
				assertNoHermesContent(t, path, data)
				if previous, existed := before[path]; path != healthFile && (!existed || !bytes.Equal(previous, data)) {
					t.Fatalf("%s written for unusable input", path)
				}
			}
		})
	}
}

func TestHermesIgnoredEventsAreNeitherRetainedNorCounted(t *testing.T) {
	f, project := newHermesFixture(t, "metadata")
	before := f.durableFiles(t)
	for _, raw := range [][]byte{
		hermesVariant(t, "on_session_start", project, func(_, extra map[string]any) { extra["platform"] = "telegram" }),
		hermesVariant(t, "post_tool_call", project, func(_, extra map[string]any) { extra["platform"] = "discord" }),
		hermesVariant(t, "post_approval_response", project, func(_, extra map[string]any) { extra["choice"] = "always" }),
		hermesVariant(t, "post_approval_response", project, func(_, extra map[string]any) { extra["choice"] = "notify_failed" }),
	} {
		f.shim.HandleAndRecord("hermes", bytes.NewReader(raw))
	}
	after := f.durableFiles(t)
	if len(after) != len(before) {
		t.Fatalf("ignored events wrote files: %d before, %d after", len(before), len(after))
	}
	for path, data := range after {
		if !bytes.Equal(before[path], data) {
			t.Fatalf("ignored events changed %s", path)
		}
	}
}
