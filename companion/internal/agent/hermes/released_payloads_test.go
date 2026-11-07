// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package hermes

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// testdata/hermes-v0.22.4 holds what the observer plugin sent when the pinned
// Hermes v0.22.4 gateway ran a synthetic session against a fake model: a
// session start, a tool call that succeeded and two that Hermes blocked.
func TestParseHook_KeepsEveryPayloadThePinnedReleaseSent(t *testing.T) {
	paths, err := filepath.Glob(filepath.Join("testdata", "hermes-v0.22.4", "*.json"))
	if err != nil || len(paths) == 0 {
		t.Fatalf("no released payloads: %v", err)
	}
	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			observation, projected, err := New().ParseHook(raw)
			if err != nil {
				t.Fatalf("ParseHook refused a payload the release sent: %v", err)
			}
			if !filepath.IsAbs(observation.Cwd) || observation.NativeSessionID == "" {
				t.Fatalf("observation lost its identity: %+v", observation)
			}
			var sent map[string]any
			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.UseNumber()
			if err := decoder.Decode(&sent); err != nil {
				t.Fatal(err)
			}
			// The plugin already projects to the allowlist, so the shim's own
			// projection must keep every member it sent and add none.
			if !reflect.DeepEqual(projected, sent) {
				t.Fatalf("projection changed a released payload:\n sent      %v\n projected %v", sent, projected)
			}
		})
	}
}
