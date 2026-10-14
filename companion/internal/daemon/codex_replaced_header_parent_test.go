// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
	"github.com/Valaris-Studio/backplane/companion/internal/collector"
)

// Reading a named file for one hook must not freeze that path's relation
// before its actual owner is admitted. The server keeps the first parent.
func TestFirstParentUsesTheCurrentOwnHeaderAfterRolloutReplacement(t *testing.T) {
	const spawner = "01a12dbf-98b2-77a1-af8e-f2b77c1d69ac"
	for _, change := range []string{"new inode", "same inode rewritten", "different thread at same path"} {
		t.Run(change, func(t *testing.T) {
			f := codexContentFixture(t, "metadata")
			path := f.codexRollout(codexDesktopChild)
			began := f.since(t, time.Second)
			priorID := codexDesktopChild
			if change == "different thread at same path" {
				priorID = codexCLIThread
			}
			header := func(id, parent string) string {
				return rolloutLine(t, began, "session_meta", map[string]any{
					"id": id, "session_id": codexDesktopThread, "parent_thread_id": parent,
					"timestamp": began.Format(time.RFC3339Nano), "cwd": f.repo, "originator": "codex_exec",
				})
			}
			writeLines(t, path, []string{header(priorID, codexDesktopThread)})
			beforeFile, err := os.Open(path)
			if err != nil {
				t.Fatal(err)
			}
			// File.Stat snapshots Windows identity before replacement; os.Stat
			// may load it from the path only when SameFile is called later.
			beforeInfo, statErr := beforeFile.Stat()
			closeErr := beforeFile.Close()
			if statErr != nil || closeErr != nil {
				t.Fatalf("snapshot original file identity: stat %v, close %v", statErr, closeErr)
			}

			// A hook can name any absolute transcript. Admit only the root,
			// so reading this header has not yet published the child's parent.
			hook, _ := json.Marshal(map[string]any{
				"session_id": codexDesktopThread, "transcript_path": path,
				"cwd": f.repo, "hook_event_name": "SessionStart", "model": "gpt-5.4",
			})
			if err := f.shim.Handle("codex", bytes.NewReader(hook)); err != nil {
				t.Fatal(err)
			}
			writeLines(t, collector.RuntimePath(f.layout.OTelDir()), []string{runtimeEvent(codexDesktopThread, codex.DesktopID, "prompt.submitted") + "\n"})
			for range 3 {
				*f.clock = f.clock.Add(time.Second)
				f.tick(t)
			}
			rootUploaded := false
			for _, record := range f.server.Records() {
				rootUploaded = rootUploaded || record["native_session_id"] == codexDesktopThread
				if record["native_session_id"] == codexDesktopChild {
					t.Fatal("the child was admitted before its current header was written")
				}
			}
			if !rootUploaded {
				t.Fatal("the first hook's telemetry did not traverse the parent reader")
			}

			current := []byte(header(codexDesktopChild, spawner))
			if change == "same inode rewritten" {
				if err := os.WriteFile(path, current, 0o600); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.WriteFile(path+".replacement", current, 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(path+".replacement", path); err != nil {
					t.Fatal(err)
				}
			}
			afterInfo, err := os.Stat(path)
			if err != nil || os.SameFile(beforeInfo, afterInfo) != (change == "same inode rewritten") {
				t.Fatalf("replacement did not establish its inode contract: %v", err)
			}
			if relation, ok := codex.New().SessionRelation(f.daemon.config.AgentEnv, path); !ok || relation.SessionID != codexDesktopChild || relation.ParentSessionID != spawner {
				t.Fatalf("current confined header is not the child's known spawner: %+v, readable %v", relation, ok)
			}
			parentProbeHook(t, f, path)
			writeLines(t, collector.RuntimePath(f.layout.OTelDir()), []string{runtimeEvent(codexDesktopChild, codex.DesktopID, "prompt.submitted") + "\n"})
			for range 3 {
				*f.clock = f.clock.Add(time.Second)
				f.tick(t)
			}
			seen := 0
			for _, record := range f.server.Records() {
				if record["native_session_id"] == codexDesktopChild {
					seen++
					if record["parent_native_session_id"] != spawner {
						t.Errorf("first child envelope retained a stale relation: got %v, want current spawner %s", record["parent_native_session_id"], spawner)
					}
				}
			}
			if seen == 0 {
				t.Fatal("the child's first telemetry was not uploaded")
			}
		})
	}
}
