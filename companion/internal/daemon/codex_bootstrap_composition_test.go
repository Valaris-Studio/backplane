// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

const delegationSpawner = "01a12dbf-98b2-77a1-af8e-f2b77c1d69ac"

// relationOverride is the real Codex adapter whose header reader reports a
// fixed relation, as an unreadable or foreign header would.
type relationOverride struct {
	codex.Codex
	relation agent.SessionRelation
	readable bool
}

func (r relationOverride) SessionRelation(agent.Env, string) (agent.SessionRelation, bool) {
	return r.relation, r.readable
}

// delegatedDesktopChild writes a synthetic child rollout in the recorded
// Desktop subagent lineage shape, its own header naming its immediate
// spawner, and admits it through a synthetic SubagentStart hook whose
// session_id names the tree's root rather than that spawner.
func (f *fixture) delegatedDesktopChild(t *testing.T, prompt string) string {
	t.Helper()
	path := f.rolloutPath(codexDesktopChild)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	created := *f.clock
	output := "<codex_delegation>\n<source_thread_id>" + delegationSpawner + "</source_thread_id>\n<input>" + prompt + "</input>\n</codex_delegation>"
	content := rolloutLine(t, created, "session_meta", map[string]any{
		"id": codexDesktopChild, "session_id": codexDesktopThread, "parent_thread_id": delegationSpawner,
		"timestamp": created.Format(time.RFC3339Nano), "cwd": f.repo, "originator": "Codex Desktop",
	}) + rolloutLine(t, created.Add(time.Millisecond), "response_item", map[string]any{"type": "function_call_output", "name": "create_thread", "output": output})
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	*f.clock = created.Add(3 * time.Second)
	hook, _ := json.Marshal(map[string]any{
		"session_id": codexDesktopThread, "agent_id": codexDesktopChild, "transcript_path": path,
		"cwd": f.repo, "hook_event_name": "SubagentStart", "model": "gpt-5.4", "permission_mode": "default",
	})
	if err := f.shim.Handle("codex", bytes.NewReader(hook)); err != nil {
		t.Fatal(err)
	}
	return path
}

// The hook's session_id is the tree's root, not the child's immediate parent;
// only the child's own current header may name a parent, and an unreadable or
// foreign header leaves it unknown. The server keeps the first parent it is told.
func TestDelegatedInitialPromptNamesOnlyTheVerifiedImmediateParent(t *testing.T) {
	for _, header := range []struct {
		name       string
		adapter    agent.Agent
		wantParent any
	}{
		{"own header", codex.New(), delegationSpawner},
		{"unreadable header", relationOverride{Codex: codex.New()}, nil},
		{"foreign header", relationOverride{Codex: codex.New(), readable: true, relation: agent.SessionRelation{SessionID: codexCLIThread, ParentSessionID: delegationSpawner}}, nil},
	} {
		t.Run(header.name, func(t *testing.T) {
			f := desktopFixture(t)
			f.daemon.config.Registry = registryWith(header.adapter)
			f.shim.Registry = registryWith(header.adapter)
			f.since(t, 10*time.Second)
			f.delegatedDesktopChild(t, "CHILD_INITIAL_PROMPT")
			f.tick(t)
			records := promptRecords(f.server.Records())
			if len(records) != 1 {
				t.Fatalf("want the child's one initial prompt, got %d", len(records))
			}
			record := records[0]
			if record["native_session_id"] != codexDesktopChild {
				t.Fatalf("prompt attributed to %v", record["native_session_id"])
			}
			if parent := record["parent_native_session_id"]; parent != header.wantParent {
				t.Fatalf("parent %v, want %v; the hook's root %s is not the immediate parent", parent, header.wantParent, codexDesktopThread)
			}
		})
	}
}

// initialPromptDoneField is what marking the prompt done adds to a legacy
// usage state that never recorded it.
const initialPromptDoneField = `,"initial_prompt_done":true`

// legacyUsageStateOfSize is a usage state saved before initial prompts were
// recorded, its cursor padded so that it encodes to exactly size bytes.
func legacyUsageStateOfSize(t *testing.T, firstSeen time.Time, size int) []byte {
	t.Helper()
	encode := func(padding int) []byte {
		cursor, _ := json.Marshal(map[string]any{"pad": strings.Repeat("a", padding)})
		encoded, err := json.Marshal(usageState{FirstSeen: firstSeen, Cursor: cursor, Source: usageFromTranscript})
		if err != nil {
			t.Fatal(err)
		}
		return encoded
	}
	encoded := encode(size - len(encode(0)))
	if len(encoded) != size || bytes.Contains(encoded, []byte("initial_prompt_done")) {
		t.Fatalf("legacy state is %d bytes, want %d", len(encoded), size)
	}
	return encoded
}

// Marking the initial prompt done must not make a loadable usage state
// unloadable: that would forget its cursor, first sighting and usage source.
// The prospective state is checked before the prompt is queued or anything is
// saved; a state that cannot hold the mark is kept as it was and counted as
// capacity, and the prompt waits.
func TestInitialPromptDoneMustFitTheUsageStateBeforeAnyEffect(t *testing.T) {
	for _, bound := range []struct {
		name        string
		legacyBytes int
		fits        bool
	}{
		{"marked state exactly at the limit", maxUsageCursorBytes - len(initialPromptDoneField), true},
		{"marked state one byte past the limit", maxUsageCursorBytes - len(initialPromptDoneField) + 1, false},
		{"legacy state exactly at the limit", maxUsageCursorBytes, false},
	} {
		t.Run(bound.name, func(t *testing.T) {
			f := desktopFixture(t)
			f.since(t, 10*time.Second)
			f.tick(t)
			f.delegatedCodexSession(t, f.repo, "BOUNDARY_PROMPT")
			adapter, err := f.daemon.config.Registry.Lookup(codex.ID)
			if err != nil {
				t.Fatal(err)
			}
			statePath := f.daemon.usageCursorPath(adapter.ID(), desktopThread)
			if err := store.EnsurePrivateDir(f.layout.UsageDir()); err != nil {
				t.Fatal(err)
			}
			legacy := legacyUsageStateOfSize(t, f.setupDone, bound.legacyBytes)
			if err := store.WriteFileAtomic(statePath, legacy); err != nil {
				t.Fatal(err)
			}
			if loaded := loadUsageState(statePath); loaded.Source != usageFromTranscript {
				t.Fatalf("the legacy state does not load: %+v", loaded.FirstSeen)
			}
			threads, err := state.Load[state.Threads](f.layout.Threads())
			if err != nil {
				t.Fatal(err)
			}
			thread, known := threads.Threads[desktopThread]
			if !known {
				t.Fatal("the hook did not record the thread")
			}
			promptCapture := captureID(adapter.ID(), "initial_prompt\x00"+desktopThread)

			poll := func() {
				t.Helper()
				if err := f.daemon.pollInitialPrompt(context.Background(), desktopThread, thread); err != nil {
					t.Fatal(err)
				}
			}
			poll()
			queued, err := f.daemon.queue.Has(promptCapture)
			if err != nil {
				t.Fatal(err)
			}
			saved, err := os.ReadFile(statePath)
			if err != nil {
				t.Fatal(err)
			}
			loaded := loadUsageState(statePath)
			health, _ := state.Load[state.Health](f.layout.Health())
			if bound.fits {
				if !queued || !loaded.InitialPromptDone || len(saved) != maxUsageCursorBytes {
					t.Fatalf("an in-bound mark was not applied: queued %v, done %v, %d bytes", queued, loaded.InitialPromptDone, len(saved))
				}
				var marked usageState
				if err := json.Unmarshal(legacy, &marked); err != nil {
					t.Fatal(err)
				}
				marked.InitialPromptDone = true
				want, _ := json.Marshal(marked)
				if !loaded.FirstSeen.Equal(f.setupDone) || loaded.Source != usageFromTranscript || !bytes.Equal(saved, want) {
					t.Fatal("marking the prompt done changed the cursor, first sighting or source")
				}
			} else {
				if queued {
					t.Fatal("the prompt was queued although its done mark cannot be saved")
				}
				if !bytes.Equal(saved, legacy) || loaded.Source != usageFromTranscript || !loaded.FirstSeen.Equal(f.setupDone) {
					t.Fatalf("the refused mark changed the usage state: %d bytes, loads %v", len(saved), loaded.Source)
				}
				if health.UsageCapacityLimitedFiles == 0 {
					t.Fatal("the refused mark was not counted as capacity")
				}
			}

			// A restarted daemon neither replays a recorded prompt nor turns a
			// refused one into an effect.
			f.daemon = New(f.daemon.config)
			poll()
			again, _ := os.ReadFile(statePath)
			queuedAgain, _ := f.daemon.queue.Has(promptCapture)
			if !bytes.Equal(again, saved) || queuedAgain != queued {
				t.Fatalf("restart replay changed the outcome: state equal %v, queued %v→%v", bytes.Equal(again, saved), queued, queuedAgain)
			}
		})
	}
}
