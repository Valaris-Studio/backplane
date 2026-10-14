// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

func bootstrapFixture(t *testing.T) (*rolloutFixture, agent.InitialPromptRead, []rolloutEntry) {
	t.Helper()
	f := newRollout(t, "")
	created := rolloutNow.Add(-time.Hour)
	entries := []rolloutEntry{
		{"timestamp": created, "type": "session_meta", "payload": map[string]any{"id": rolloutThread, "cwd": f.env.Home, "originator": "Codex Desktop"}},
		userMessage(time.Millisecond, "PRIVATE_AGENT_INSTRUCTIONS"),
		{"timestamp": created.Add(time.Second), "type": "response_item", "payload": map[string]any{"type": "function_call_output", "name": "create_thread", "output": "<codex_delegation>\n<source_thread_id>source-thread</source_thread_id>\n<input>Initialize this project.</input>\n</codex_delegation>"}},
	}
	read := agent.InitialPromptRead{Transcript: f.path, SessionID: rolloutThread, Cwd: f.env.Home, FirstSeen: created.Add(3 * time.Second), Now: rolloutNow, Env: f.env.Env, Allowed: func(at time.Time) bool { return !at.Before(created) }}
	return f, read, entries
}

func writeBootstrap(t *testing.T, f *rolloutFixture, entries []rolloutEntry) {
	t.Helper()
	var text strings.Builder
	for _, entry := range entries {
		raw, err := json.Marshal(entry)
		if err != nil {
			t.Fatal(err)
		}
		text.Write(raw)
		text.WriteByte('\n')
	}
	write(t, f.path, text.String())
}

func TestInitialPromptReadsOnlyFreshDesktopDelegation(t *testing.T) {
	cases := map[string]func(*agent.InitialPromptRead, []rolloutEntry){
		"valid": func(*agent.InitialPromptRead, []rolloutEntry) {},
		"wrong thread": func(_ *agent.InitialPromptRead, e []rolloutEntry) {
			e[0]["payload"].(map[string]any)["id"] = "other-thread"
		},
		"wrong cwd": func(r *agent.InitialPromptRead, _ []rolloutEntry) { r.Cwd = filepath.Dir(r.Cwd) },
		"CLI": func(_ *agent.InitialPromptRead, e []rolloutEntry) {
			e[0]["payload"].(map[string]any)["originator"] = "codex_exec"
		},
		"resumed history": func(r *agent.InitialPromptRead, _ []rolloutEntry) { r.FirstSeen = r.Now },
		"excluded time":   func(r *agent.InitialPromptRead, _ []rolloutEntry) { r.Allowed = func(time.Time) bool { return false } },
		"ordinary tool": func(_ *agent.InitialPromptRead, e []rolloutEntry) {
			e[2]["payload"].(map[string]any)["name"] = "exec_command"
		},
		"malformed wrapper": func(_ *agent.InitialPromptRead, e []rolloutEntry) {
			e[2]["payload"].(map[string]any)["output"] = "<input>Not a delegation</input>"
		},
		"copied old output": func(_ *agent.InitialPromptRead, e []rolloutEntry) { e[2]["timestamp"] = rolloutNow.Add(-2 * time.Hour) },
		"future output":     func(_ *agent.InitialPromptRead, e []rolloutEntry) { e[2]["timestamp"] = rolloutNow.Add(time.Hour) },
		"after assistant began": func(_ *agent.InitialPromptRead, e []rolloutEntry) {
			e[1]["payload"].(map[string]any)["role"] = "assistant"
		},
	}
	for name, edit := range cases {
		t.Run(name, func(t *testing.T) {
			f, r, entries := bootstrapFixture(t)
			edit(&r, entries)
			writeBootstrap(t, f, entries)
			result, err := New().ReadInitialPrompt(r)
			if err != nil {
				t.Fatal(err)
			}
			if (len(result.Event) > 0) != (name == "valid") {
				t.Fatalf("unexpected initial prompt: %s", result.Event)
			}
			if strings.Contains(string(result.Event), "PRIVATE_AGENT_INSTRUCTIONS") {
				t.Fatal("agent instructions captured")
			}
		})
	}
}

func TestInitialPromptWaitsForCompleteLineAndRejectsOutsideTranscript(t *testing.T) {
	f, r, entries := bootstrapFixture(t)
	writeBootstrap(t, f, entries)
	content := read(t, f.path)
	write(t, f.path, strings.TrimSuffix(content, "\n"))
	result, err := New().ReadInitialPrompt(r)
	if err != nil || result.Done || len(result.Event) > 0 {
		t.Fatalf("partial line treated as complete: %+v %v", result, err)
	}
	f.appendText(t, "\n")
	result, err = New().ReadInitialPrompt(r)
	if err != nil || len(result.Event) == 0 {
		t.Fatalf("completed line not read: %+v %v", result, err)
	}
	outside := filepath.Join(f.env.Home, "rollout-outside.jsonl")
	write(t, outside, content)
	r.Transcript = outside
	result, err = New().ReadInitialPrompt(r)
	if err != nil || len(result.Event) > 0 {
		t.Fatal("outside transcript read")
	}
	link := filepath.Join(filepath.Dir(f.path), "rollout-link.jsonl")
	if err := os.Symlink(outside, link); err != nil {
		t.Fatal(err)
	}
	r.Transcript = link
	result, err = New().ReadInitialPrompt(r)
	if err != nil || len(result.Event) > 0 {
		t.Fatal("linked transcript read")
	}
}

// A hookless thread is first seen at its header's creation stamp, which the
// header line's own timestamp follows: by 22–48 ms in the recorded Desktop
// rollouts and 1.92 s in the CLI's. A header written well after the thread
// was first seen is a later or replaced file, not the startup a first hook
// saw within a minute of creation.
func TestInitialPromptAdmissionBoundsAHeaderAfterFirstSighting(t *testing.T) {
	for _, admission := range []struct {
		name     string
		lag      time.Duration
		admitted bool
	}{
		{"recorded Desktop header lag", 48 * time.Millisecond, true},
		{"recorded CLI header lag", 1920 * time.Millisecond, true},
		{"header written after the first sighting", 10 * time.Minute, false},
	} {
		t.Run(admission.name, func(t *testing.T) {
			f, r, entries := bootstrapFixture(t)
			r.FirstSeen = entries[0]["timestamp"].(time.Time).Add(-admission.lag)
			writeBootstrap(t, f, entries)
			result, err := New().ReadInitialPrompt(r)
			if err != nil || !result.Done {
				t.Fatalf("admission undecided: %+v %v", result, err)
			}
			if (len(result.Event) > 0) != admission.admitted {
				t.Fatalf("first seen %s before the header: admitted %v, want %v", admission.lag, len(result.Event) > 0, admission.admitted)
			}
		})
	}
}
