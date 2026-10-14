// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
	"github.com/Valaris-Studio/backplane/companion/internal/collector"
)

// Desktop also runs the companion's hooks for its subagents, naming the
// tree's root as session_id. A nested subagent's header names its spawner;
// usage, telemetry and rich records must all name that spawner, whichever
// reaches the queue first: the server keeps the first parent it is told.
func TestAHookNamedNestedDesktopSubagentNamesItsSpawnerEverywhere(t *testing.T) {
	const spawner = "01a12dbf-98b2-77a1-af8e-f2b77c1d69ac"
	for _, order := range []string{"usage first", "contents first"} {
		t.Run(order, func(t *testing.T) {
			f := codexContentFixture(t, "rich")
			began := f.since(t, time.Second)
			path := f.codexRollout(codexDesktopChild)
			writeLines(t, path, []string{
				rolloutLine(t, began, "session_meta", map[string]any{
					"id": codexDesktopChild, "session_id": codexDesktopThread, "parent_thread_id": spawner, "forked_from_id": spawner,
					"timestamp": began.Format(time.RFC3339Nano), "cwd": f.repo, "originator": "Codex Desktop", "cli_version": "0.162.0-alpha.2",
				}),
				rolloutLine(t, began, "turn_context", map[string]any{"turn_id": "turn-1", "cwd": f.repo, "model": "gpt-5.4"}),
			})
			hook, _ := json.Marshal(map[string]any{"session_id": codexDesktopThread, "agent_id": codexDesktopChild, "transcript_path": path, "cwd": f.repo, "hook_event_name": "SubagentStart", "model": "gpt-5.4", "permission_mode": "default"})
			if err := f.shim.Handle("codex", bytes.NewReader(hook)); err != nil {
				t.Fatal(err)
			}
			appendTo(t, path, desktopReply(t, f.since(t, 2*time.Second), codexDesktopChild, "nested-reply", "Nested verdict"))
			usage := rolloutRecord(t, f.since(t, 3*time.Second), codexDesktopChild, "nested-response", 21)
			if order == "usage first" {
				appendTo(t, path, usage)
			}
			os.MkdirAll(f.layout.OTelDir(), 0o700)
			os.WriteFile(collector.RuntimePath(f.layout.OTelDir()), []byte(runtimeEvent(codexDesktopChild, codex.DesktopID, "prompt.submitted")+"\n"), 0o600)
			settle := func() {
				for range 3 {
					*f.clock = f.clock.Add(time.Second)
					f.tick(t)
				}
			}
			settle()
			if order == "contents first" {
				if len(declarationsByKey(f)[agent.ContentKey(codex.DesktopID, codexDesktopChild, "nested-reply", "text:0")]) != 1 {
					t.Fatal("the reply was not captured before the usage was written")
				}
				appendTo(t, path, usage)
				settle()
			}
			kinds := map[string]int{}
			for _, record := range f.server.Records() {
				if record["native_session_id"] != codexDesktopChild {
					continue
				}
				events, _ := record["events"].([]any)
				contents, _ := record["contents"].([]any)
				kind := "telemetry"
				switch {
				case len(contents) > 0:
					kind = "rich"
				case record["collection_method"] == "poll":
					kind = "usage"
				}
				if len(events) == 0 && len(contents) == 0 {
					continue
				}
				kinds[kind]++
				if record["parent_native_session_id"] != spawner {
					t.Errorf("%s record names parent %v, want the spawner %s", kind, record["parent_native_session_id"], spawner)
				}
			}
			if kinds["usage"] == 0 || kinds["rich"] == 0 || kinds["telemetry"] == 0 {
				t.Fatalf("records by kind %v, want usage, rich and telemetry", kinds)
			}
		})
	}
}

// A hook-named Codex CLI fork is never discovered; once rich capture has
// read its header, its usage names the session it forked from, as its rich
// records do, not the hook's own session.
func TestAHookNamedCLIForkReadForContentNamesItsForkParentOnUsage(t *testing.T) {
	const fork = "01a11e7a-685c-7440-88a7-e7ef8e4a962a"
	f := codexContentFixture(t, "rich")
	began := f.since(t, time.Second)
	path := f.codexRollout(fork)
	writeLines(t, path, []string{
		rolloutLine(t, began, "session_meta", map[string]any{
			"id": fork, "session_id": fork, "forked_from_id": codexCLIThread,
			"timestamp": began.Format(time.RFC3339Nano), "cwd": f.repo, "originator": "codex_exec", "cli_version": "0.161.0",
		}),
		rolloutLine(t, began, "turn_context", map[string]any{"turn_id": "turn-1", "cwd": f.repo, "model": "gpt-5.4"}),
	})
	f.codexHook(t, fork, "SessionStart", "startup")
	appendTo(t, path, desktopReply(t, f.since(t, 2*time.Second), fork, "fork-reply", "Fork verdict"))
	f.tickUntilSettled(t)
	if len(declarationsByKey(f)[agent.ContentKey(codex.ID, fork, "fork-reply", "text:0")]) != 1 {
		t.Fatal("the fork's reply was not captured")
	}
	appendTo(t, path, rolloutRecord(t, f.stamp(), fork, "fork-response", 11))
	f.since(t, 10*time.Minute)
	f.tickUntilSettled(t)
	var usage int
	for _, record := range f.server.Records() {
		events, _ := record["events"].([]any)
		contents, _ := record["contents"].([]any)
		if record["native_session_id"] != fork || len(events) == 0 && len(contents) == 0 {
			continue
		}
		if record["collection_method"] == "poll" && len(contents) == 0 {
			usage++
		}
		if record["parent_native_session_id"] != codexCLIThread {
			t.Errorf("fork record (%v) names parent %v, want %s", record["collection_method"], record["parent_native_session_id"], codexCLIThread)
		}
	}
	if usage == 0 {
		t.Fatal("the fork's usage was not uploaded")
	}
}
