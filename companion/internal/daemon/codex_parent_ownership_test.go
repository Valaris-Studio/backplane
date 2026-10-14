// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
	"github.com/Valaris-Studio/backplane/companion/internal/collector"
)

// A hook can name an absolute transcript that belongs to another thread.
// Its cached fork parent must not become this child's immutable first parent.
func TestHookParentDoesNotBorrowAnotherThreadsRichCursor(t *testing.T) {
	const fork = "01a11e7a-685c-7440-88a7-e7ef8e4a962a"
	f := codexContentFixture(t, "rich")
	began := f.since(t, time.Second)
	path := f.codexRollout(fork)
	writeLines(t, path, []string{
		rolloutLine(t, began, "session_meta", map[string]any{
			"id": fork, "session_id": fork, "forked_from_id": codexCLIThread,
			"timestamp": began.Format(time.RFC3339Nano), "cwd": f.repo, "originator": "codex_exec",
		}),
		rolloutLine(t, began, "turn_context", map[string]any{"turn_id": "turn-1", "cwd": f.repo, "model": "gpt-5.4"}),
		desktopReply(t, f.since(t, 2*time.Second), fork, "fork-reply", "A separate fork"),
	})
	f.codexHook(t, fork, "SessionStart", "startup")
	f.tickUntilSettled(t)
	if len(declarationsByKey(f)[agent.ContentKey(codex.ID, fork, "fork-reply", "text:0")]) != 1 {
		t.Fatal("the separate fork was not captured")
	}
	if cursor, stored, err := contentCursors(f.layout).Load(sourceKey(path)); err != nil || !stored || cursor.ParentSessionID != codexCLIThread {
		t.Fatalf("the real fork's cursor was not established: %+v, %v", cursor, err)
	}

	parentProbeHook(t, f, path)
	parentProbeTelemetry(t, f)
	seen := 0
	for _, record := range f.server.Records() {
		if record["native_session_id"] != codexDesktopChild {
			continue
		}
		seen++
		if parent, named := record["parent_native_session_id"]; named {
			t.Errorf("another thread's header establishes no parent for this child: got %v, want unknown", parent)
		}
	}
	if seen == 0 {
		t.Fatal("the independently admitted child's telemetry was not uploaded")
	}
}

// A bounded directory scan is not evidence that a hook's tree root is the
// immediate parent. Sending that guess first permanently flattens the tree,
// even when the child's own header is discovered on a later tick.
func TestBoundedDiscoveryDoesNotPublishANestedDesktopRootAsItsParent(t *testing.T) {
	const spawner = "01a12dbf-98b2-77a1-af8e-f2b77c1d69ac"
	for _, omitted := range []string{"older than 24 hours", "behind 64 newer rollouts"} {
		t.Run(omitted, func(t *testing.T) {
			f := codexContentFixture(t, "rich")
			began := f.setupDone.Add(-26 * time.Hour)
			path := f.codexRollout(codexDesktopChild)
			writeLines(t, path, []string{rolloutLine(t, began, "session_meta", map[string]any{
				"id": codexDesktopChild, "session_id": codexDesktopThread, "parent_thread_id": spawner,
				"timestamp": began.Format(time.RFC3339Nano), "cwd": f.repo, "originator": "Codex Desktop",
			})})
			modified := time.Now().Add(-25 * time.Hour)
			if omitted == "behind 64 newer rollouts" {
				modified = time.Now().Add(-time.Hour)
				for index := range 64 {
					id := fmt.Sprintf("01a12000-0000-7000-8000-%012d", index)
					writeLines(t, f.codexRollout(id), []string{rolloutLine(t, began, "session_meta", map[string]any{
						"id": id, "timestamp": began.Format(time.RFC3339Nano), "cwd": f.repo, "originator": "Codex Desktop",
					})})
				}
			}
			if err := os.Chtimes(path, modified, modified); err != nil {
				t.Fatal(err)
			}
			for _, found := range codex.New().DiscoverContent(f.daemon.config.AgentEnv, 64) {
				if found.NativeSessionID == codexDesktopChild {
					t.Fatal("the fixture did not omit the child's header from bounded discovery")
				}
			}
			parentProbeHook(t, f, path)
			parentProbeTelemetry(t, f)
			var parents []any
			for _, record := range f.server.Records() {
				if record["native_session_id"] == codexDesktopChild {
					parents = append(parents, record["parent_native_session_id"])
				}
			}
			if len(parents) == 0 {
				t.Fatal("no first child telemetry envelope was uploaded")
			}
			for _, parent := range parents {
				if parent != nil && parent != spawner {
					t.Errorf("first parent %v, want immediate spawner %s or unknown; a later envelope cannot correct server parentage", parent, spawner)
				}
			}

			before := len(f.server.Records())
			appendTo(t, path, desktopReply(t, f.stamp(), codexDesktopChild, "resumed-child", "A resumed child"))
			f.tickUntilSettled(t)
			later := 0
			for _, record := range f.server.Records()[before:] {
				if record["native_session_id"] == codexDesktopChild {
					later++
					if record["parent_native_session_id"] != spawner {
						t.Errorf("resumed child did not acquire its known spawner: %v", record["parent_native_session_id"])
					}
				}
			}
			if later == 0 {
				t.Fatal("the child did not upload after its own rollout became discoverable")
			}
		})
	}
}

func parentProbeHook(t *testing.T, f *fixture, transcript string) {
	t.Helper()
	hook, _ := json.Marshal(map[string]any{
		"session_id": codexDesktopThread, "agent_id": codexDesktopChild,
		"transcript_path": transcript, "cwd": f.repo, "hook_event_name": "SubagentStart",
		"model": "gpt-5.4", "permission_mode": "default",
	})
	if err := f.shim.Handle("codex", bytes.NewReader(hook)); err != nil {
		t.Fatal(err)
	}
}

func parentProbeTelemetry(t *testing.T, f *fixture) {
	t.Helper()
	if err := os.MkdirAll(f.layout.OTelDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(collector.RuntimePath(f.layout.OTelDir()), []byte(runtimeEvent(codexDesktopChild, codex.DesktopID, "prompt.submitted")+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		*f.clock = f.clock.Add(time.Second)
		f.tick(t)
	}
}
