// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/policy"
)

func (f *fixture) delegatedCodexSession(t *testing.T, cwd, prompt string) string {
	t.Helper()
	path := f.rolloutPath(desktopThread)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	created := *f.clock
	output := "<codex_delegation>\n<source_thread_id>019a8f2e-7c1d-7b3a-9e41-5d2c8a6f0b22</source_thread_id>\n<input>" + prompt + "</input>\n</codex_delegation>"
	content := rolloutLine(t, created, "session_meta", map[string]any{"id": desktopThread, "cwd": cwd, "originator": "Codex Desktop"}) +
		rolloutLine(t, created, "response_item", map[string]any{"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": "SECRET_AGENT_INSTRUCTIONS"}}}) +
		rolloutLine(t, created.Add(time.Millisecond), "response_item", map[string]any{"type": "function_call_output", "name": "create_thread", "output": output})
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	*f.clock = created.Add(3 * time.Second)
	payload, _ := json.Marshal(map[string]any{"session_id": desktopThread, "cwd": cwd, "transcript_path": path, "hook_event_name": "SessionStart", "source": "startup"})
	if err := f.shim.Handle("codex", strings.NewReader(string(payload))); err != nil {
		t.Fatal(err)
	}
	return path
}

func promptRecords(records []map[string]any) []map[string]any {
	var found []map[string]any
	for _, record := range records {
		for _, raw := range record["events"].([]any) {
			event := raw.(map[string]any)
			if event["event"].(map[string]any)["action"] == "prompt.submitted" {
				found = append(found, record)
				break
			}
		}
	}
	return found
}

func TestCodexDelegatedInitialPromptIsCapturedOnceBeforeAnyTool(t *testing.T) {
	f := desktopFixture(t)
	f.since(t, 10*time.Second)
	prompt := "Initialize this mapped project. Preserve <input>literal markup</input>."
	rollout := f.delegatedCodexSession(t, f.repo, prompt)
	f.tick(t)
	records := promptRecords(f.server.Records())
	if len(records) != 1 {
		t.Fatalf("want one initial prompt before any tool, got %d", len(records))
	}
	record := records[0]
	if record["harness"] != "codex_desktop" || record["mapping_id"] != "m1" || record["native_session_id"] != desktopThread {
		t.Fatalf("wrong attribution: %v", record)
	}
	event := record["events"].([]any)[0].(map[string]any)
	if got := event["prompt"].(map[string]any)["text"]; got != prompt {
		t.Fatalf("prompt changed: %v", got)
	}
	if event["timestamp"] != f.setupDone.Add(10*time.Second+time.Millisecond).Format(time.RFC3339Nano) {
		t.Fatalf("lost source timestamp: %v", event)
	}
	encoded, _ := json.Marshal(record)
	for _, forbidden := range []string{"SECRET_AGENT_INSTRUCTIONS", "codex_delegation", "source_thread_id", f.repo} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("unrelated context uploaded: %q", forbidden)
		}
	}
	f.daemon = New(f.daemon.config)
	f.since(t, 20*time.Second)
	appendTo(t, rollout, rolloutRecord(t, f.stamp(), desktopThread, "resp_bootstrap", 20))
	f.tick(t)
	if got := len(promptRecords(f.server.Records())); got != 1 {
		t.Fatalf("prompt replayed on restart: %d", got)
	}
	if got := len(usageRecords(f.server.Records())); got != 1 {
		t.Fatalf("usage lost: %d", got)
	}
}

func TestCodexDelegatedInitialPromptHonorsContentLevels(t *testing.T) {
	for _, level := range []string{"metadata", "standard", "full"} {
		t.Run(level, func(t *testing.T) {
			f := desktopFixture(t)
			f.setMappings(t, policy.Mapping{ID: "m1", WorkspaceID: "w", RootPath: f.repo, Enabled: true, ContentLevel: level})
			f.setupDone = *f.clock
			f.since(t, 10*time.Second)
			f.delegatedCodexSession(t, f.repo, "INITIAL_PROMPT_TEXT")
			f.tick(t)
			records := promptRecords(f.server.Records())
			if len(records) != 1 {
				t.Fatalf("want one prompt event, got %d", len(records))
			}
			encoded, _ := json.Marshal(records)
			if strings.Contains(string(encoded), "INITIAL_PROMPT_TEXT") != (level != "metadata") {
				t.Fatalf("content level violated: %s", encoded)
			}
		})
	}
}

func TestCodexDelegatedInitialPromptRespectsPauseAndScope(t *testing.T) {
	for _, excluded := range []string{"paused", "unmapped"} {
		t.Run(excluded, func(t *testing.T) {
			f := desktopFixture(t)
			cwd := f.repo
			if excluded == "paused" {
				f.setPaused(t, true)
				f.tick(t)
			} else {
				cwd = filepath.Join(f.home, "unmapped")
				os.MkdirAll(cwd, 0o700)
			}
			f.since(t, 10*time.Second)
			f.delegatedCodexSession(t, cwd, "DO_NOT_CAPTURE")
			f.tick(t)
			f.since(t, 20*time.Second)
			f.setPaused(t, false)
			f.tick(t)
			if got := len(promptRecords(f.server.Records())); got != 0 {
				t.Fatalf("excluded prompt captured: %d", got)
			}
		})
	}
}
