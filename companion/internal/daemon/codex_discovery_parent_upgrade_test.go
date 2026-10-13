// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// A daemon upgraded mid-session resumes a native Desktop subagent from the
// sources and cursors an earlier daemon persisted without the envelope
// relation: what it reads next names the parent, what was read stays read.
func TestHooklessDesktopSubagentReadBeforeAnUpgradeNamesItsParentAfter(t *testing.T) {
	f := codexContentFixture(t, "rich")
	lines := f.fixtureRolloutLines(t, "codex-desktop", "rollout-subagent.jsonl", f.since(t, 10*time.Second))
	path := f.codexRollout(codexDesktopChild)
	// Up to the first response's usage: prompts and a call, no usage yet.
	writeLines(t, path, lines[:14])
	f.since(t, 30*time.Second)
	discoverDesktop(t, f)
	upgradedFrom := len(f.server.Records())
	if upgradedFrom == 0 {
		t.Fatal("the subagent's first lines uploaded nothing")
	}
	forgetEnvelopeParents(t, f)
	f.daemon = New(f.daemon.config)

	writeLines(t, path, lines[14:])
	discoverDesktop(t, f)
	var outputs []float64
	for _, record := range f.server.Records()[upgradedFrom:] {
		events, _ := record["events"].([]any)
		contents, _ := record["contents"].([]any)
		if len(events) == 0 && len(contents) == 0 {
			continue
		}
		if record["native_session_id"] != codexDesktopChild || record["parent_native_session_id"] != codexDesktopThread {
			t.Errorf("record after the upgrade: session %v parent %v, want %s under %s", record["native_session_id"], record["parent_native_session_id"], codexDesktopChild, codexDesktopThread)
		}
		for _, raw := range events {
			outputs = append(outputs, raw.(map[string]any)["gen_ai"].(map[string]any)["usage"].(map[string]any)["output_tokens"].(float64))
		}
	}
	if !reflect.DeepEqual(outputs, []float64{62, 15}) {
		t.Errorf("usage after the upgrade = %v, want [62 15]", outputs)
	}
	for key, declared := range declarationsByKey(f) {
		if len(declared) != 1 {
			t.Errorf("%s declared %d times across the upgrade", key, len(declared))
		}
	}
	if key := agent.ContentKey(codex.DesktopID, codexDesktopChild, "msg_086d8e06a084ea5d016ac8501973208193b22171ff2bf68f90", "text:0"); len(declarationsByKey(f)[key]) != 1 {
		t.Error("the reply written after the upgrade was not captured")
	}
}

// forgetEnvelopeParents rewrites the persisted sources as a daemon from
// before the envelope relation saved them.
func forgetEnvelopeParents(t *testing.T, f *fixture) {
	t.Helper()
	data, err := os.ReadFile(f.daemon.contentSourcesPath())
	if err != nil {
		t.Fatal(err)
	}
	var persisted struct {
		Sources map[string]map[string]any `json:"sources"`
	}
	if err := json.Unmarshal(data, &persisted); err != nil || len(persisted.Sources) == 0 {
		t.Fatalf("persisted sources %s: %v", data, err)
	}
	for _, source := range persisted.Sources {
		delete(source, "envelope_parent_id")
	}
	if err := store.WriteJSON(f.daemon.contentSourcesPath(), persisted); err != nil {
		t.Fatal(err)
	}
}
