// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"testing"
	"time"
)

// A nested Desktop subagent (guardian_review) names the subagent that
// spawned it, not the tree's root, on its usage and rich envelopes alike:
// the server keeps the first parent it is told.
func TestHooklessDesktopNestedSubagentEnvelopesNameItsSpawner(t *testing.T) {
	const spawner = "01a12dbf-98b2-77a1-af8e-f2b77c1d69ac"
	f := codexContentFixture(t, "rich")
	began := f.since(t, time.Second)
	path := f.codexRollout(codexDesktopChild)
	writeLines(t, path, []string{
		rolloutLine(t, began, "session_meta", map[string]any{
			"id": codexDesktopChild, "session_id": codexDesktopThread, "parent_thread_id": spawner,
			"timestamp": began.Format(time.RFC3339Nano), "cwd": f.repo, "originator": "Codex Desktop",
			"cli_version": "0.162.0-alpha.2", "thread_source": "guardian_review",
		}),
		rolloutLine(t, began, "turn_context", map[string]any{"turn_id": "turn-1", "cwd": f.repo, "model": "gpt-5.4"}),
	})
	appendTo(t, path, desktopReply(t, f.since(t, 2*time.Second), codexDesktopChild, "guardian-reply", "Guardian verdict"))
	appendTo(t, path, rolloutRecord(t, f.since(t, 3*time.Second), codexDesktopChild, "guardian-response", 33))
	discoverDesktop(t, f)
	var usage, contents int
	for _, record := range f.server.Records() {
		events, _ := record["events"].([]any)
		declared, _ := record["contents"].([]any)
		if len(events) == 0 && len(declared) == 0 {
			continue
		}
		usage += len(events)
		contents += len(declared)
		if record["native_session_id"] != codexDesktopChild || record["parent_native_session_id"] != spawner {
			t.Errorf("nested subagent envelope: session %v parent %v, want %s under %s", record["native_session_id"], record["parent_native_session_id"], codexDesktopChild, spawner)
		}
	}
	if usage != 1 || contents == 0 {
		t.Fatalf("nested subagent uploaded %d usage events and %d contents", usage, contents)
	}
}
