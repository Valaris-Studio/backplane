// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"
)

// A subagent header that states only session_id names the tree's root, the
// same claim a hook makes: it does not prove the immediate parent, which the
// server would keep for good, so usage, telemetry and contents name none.
func TestARootOnlySubagentHeaderNamesNoParent(t *testing.T) {
	const child = "01a12103-f912-7191-ac17-e29079b4869f"
	f := codexContentFixture(t, "rich")
	began := f.since(t, time.Second)
	path := f.codexRollout(child)
	writeLines(t, path, []string{
		rolloutLine(t, began, "session_meta", map[string]any{
			"id": child, "session_id": codexCLIThread, "timestamp": began.Format(time.RFC3339Nano),
			"cwd": f.repo, "originator": "codex_exec", "cli_version": "0.161.0",
		}),
		rolloutLine(t, began, "turn_context", map[string]any{"turn_id": "turn-1", "cwd": f.repo, "model": "gpt-5.4"}),
	})
	hook, _ := json.Marshal(map[string]any{"session_id": codexCLIThread, "agent_id": child, "transcript_path": path, "cwd": f.repo, "hook_event_name": "SubagentStart", "model": "gpt-5.4", "permission_mode": "default"})
	if err := f.shim.Handle("codex", bytes.NewReader(hook)); err != nil {
		t.Fatal(err)
	}
	appendTo(t, path, desktopReply(t, f.since(t, 2*time.Second), child, "root-only-reply", "Child text"))
	appendTo(t, path, rolloutRecord(t, f.since(t, 3*time.Second), child, "root-only-response", 9))
	f.since(t, 10*time.Minute)
	f.tickUntilSettled(t)
	seen := 0
	for _, record := range f.server.Records() {
		if record["native_session_id"] != child {
			continue
		}
		seen++
		if parent, named := record["parent_native_session_id"]; named {
			t.Errorf("%v record names parent %v from a root-only header, want unknown", record["collection_method"], parent)
		}
	}
	if seen == 0 {
		t.Fatal("the child uploaded nothing")
	}
}
