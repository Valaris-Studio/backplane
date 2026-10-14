// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"testing"
	"time"
)

// Telemetry can reach the daemon before the subagent's rollout holds its
// header. Until the header says who spawned it, the hook's root is a guess
// the server would keep, so the parent is left unknown; once it is
// written, the spawner is named.
func TestASubagentWhoseHeaderIsNotYetWrittenNamesNoParentUntilItIs(t *testing.T) {
	const spawner = "01a12dbf-98b2-77a1-af8e-f2b77c1d69ac"
	f := codexContentFixture(t, "rich")
	path := f.codexRollout(codexDesktopChild)
	parentProbeHook(t, f, path)
	parentProbeTelemetry(t, f)
	early := 0
	for _, record := range f.server.Records() {
		if record["native_session_id"] == codexDesktopChild {
			early++
			if parent, named := record["parent_native_session_id"]; named {
				t.Errorf("telemetry before the header names parent %v, want none", parent)
			}
		}
	}
	if early == 0 {
		t.Fatal("the child's telemetry was not uploaded")
	}

	began := f.stamp()
	writeLines(t, path, []string{
		rolloutLine(t, began, "session_meta", map[string]any{
			"id": codexDesktopChild, "session_id": codexDesktopThread, "parent_thread_id": spawner,
			"timestamp": began.Format(time.RFC3339Nano), "cwd": f.repo, "originator": "Codex Desktop",
		}),
		desktopReply(t, began.Add(time.Second), codexDesktopChild, "late-reply", "Written after the header"),
		rolloutRecord(t, began.Add(2*time.Second), codexDesktopChild, "late-response", 5),
	})
	before := len(f.server.Records())
	f.since(t, 10*time.Minute)
	f.tickUntilSettled(t)
	later := 0
	for _, record := range f.server.Records()[before:] {
		if record["native_session_id"] == codexDesktopChild {
			later++
			if record["parent_native_session_id"] != spawner {
				t.Errorf("record after the header names parent %v, want %s", record["parent_native_session_id"], spawner)
			}
		}
	}
	if later == 0 {
		t.Fatal("nothing of the child was uploaded after its header was written")
	}
}
