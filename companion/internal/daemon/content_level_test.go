// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/pi"
	"github.com/Valaris-Studio/backplane/companion/internal/collector"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
)

const (
	claudeReplySentinel  = "SENTINEL-CLAUDE-REPLY-7c1e"
	piReplySentinel      = "SENTINEL-PI-REPLY-7c1e"
	piReasoningSentinel  = "SENTINEL-PI-REASONING-7c1e"
	promptAlongsideReply = "SENTINEL-PROMPT-7c1e"
)

// replyFixture captures one Claude Stop and one Pi assistant message, both
// carrying the agent's reply, with mapping m1 at level.
func replyFixture(t *testing.T, level string) *fixture {
	t.Helper()
	f := newFixture(t, pi.New())
	f.normalizer.carryPayload = true
	f.server.Lock()
	f.server.Policy.Mappings[0].ContentLevel = level
	f.server.Policy.Installation.EnabledAgents = append(f.server.Policy.Installation.EnabledAgents, pi.ID)
	f.server.Unlock()
	f.daemon.refreshPolicy(context.Background())
	f.hook(t, f.repo, "UserPromptSubmit", `,"prompt":"`+promptAlongsideReply+`"`)
	f.hook(t, f.repo, "Stop", `,"last_assistant_message":"`+claudeReplySentinel+`"`)
	piMessage := `{"type":"message_end","sessionId":"pi-sess-1","cwd":"` + f.repo + `","message":{"role":"assistant","model":"claude-x","content":[{"type":"thinking","thinking":"` + piReasoningSentinel + `"},{"type":"text","text":"` + piReplySentinel + `"}],"usage":{"input":10,"output":5}}}`
	if err := f.shim.Handle("pi", strings.NewReader(piMessage)); err != nil {
		t.Fatal(err)
	}
	f.tick(t)
	if records := f.server.Records(); len(records) != 3 {
		t.Fatalf("uploaded %d records, want 3", len(records))
	}
	return f
}

func uploadedText(t *testing.T, f *fixture) string {
	t.Helper()
	encoded, _ := json.Marshal(f.server.Records())
	return string(encoded)
}

func TestEnqueue_StandardRecordCarriesNoAssistantReplyText(t *testing.T) {
	f := replyFixture(t, "standard")
	uploaded := uploadedText(t, f)
	for _, reply := range []string{claudeReplySentinel, piReplySentinel, piReasoningSentinel} {
		if strings.Contains(uploaded, reply) {
			t.Errorf("the agent's reply %s left the device at standard: %s", reply, uploaded)
		}
	}
	if !strings.Contains(uploaded, promptAlongsideReply) {
		t.Fatalf("standard still sends prompts: %s", uploaded)
	}
	if !strings.Contains(uploaded, `"role":"assistant"`) || !strings.Contains(uploaded, `"model":"claude-x"`) {
		t.Fatalf("withholding the reply must keep the message's shape for Beacon: %s", uploaded)
	}
}

func TestEnqueue_FullRecordKeepsAssistantReplyText(t *testing.T) {
	f := replyFixture(t, "full")
	uploaded := uploadedText(t, f)
	for _, reply := range []string{claudeReplySentinel, piReplySentinel, piReasoningSentinel} {
		if !strings.Contains(uploaded, reply) {
			t.Errorf("full sends the agent's reply, but %s is missing: %s", reply, uploaded)
		}
	}
}

// parentInProject names a folder between the project root and the working
// directory; at the metadata level no record may mention it.
const parentInProject = "packages-sentinel"

// folderFixture captures, at level, a Claude prompt and a Pi assistant
// message from a folder nested in the project, and a Codex event Beacon
// normalized with that folder as its working directory.
func folderFixture(t *testing.T, level string) (*fixture, string) {
	t.Helper()
	f := newFixture(t, pi.New(), codex.New())
	f.normalizer.carryPayload = true
	nested := filepath.Join(f.repo, parentInProject, "api")
	os.MkdirAll(nested, 0o700)
	f.server.Lock()
	f.server.Policy.Mappings[0].ContentLevel = level
	f.server.Policy.Installation.EnabledAgents = []string{"claude_code", pi.ID, codex.ID}
	f.server.Unlock()
	f.daemon.config.OTel = &OTelConfig{Harness: codex.HarnessForService}
	f.daemon.refreshPolicy(context.Background())
	f.hook(t, nested, "UserPromptSubmit", `,"prompt":"hello"`)
	piMessage, err := json.Marshal(map[string]any{
		"type": "message_end", "sessionId": "pi-sess-1", "cwd": nested,
		"message": map[string]any{
			"role": "assistant", "model": "claude-x", "content": []any{},
			"usage": map[string]int{"input": 10, "output": 5},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.shim.Handle("pi", strings.NewReader(string(piMessage))); err != nil {
		t.Fatal(err)
	}
	f.thread(t, "thread-root", nested)
	codexEvent, _ := json.Marshal(map[string]any{
		"schema_version": "1.0", "event": map[string]any{"action": "tool.invoked"},
		"harness": map[string]any{"name": "codex_cli"}, "session": map[string]any{"id": "thread-root", "working_directory": nested},
		"raw": map[string]any{"cwd": nested},
	})
	os.MkdirAll(f.layout.OTelDir(), 0o700)
	os.WriteFile(collector.RuntimePath(f.layout.OTelDir()), append(codexEvent, '\n'), 0o600)
	f.tick(t)
	if records := f.server.Records(); len(records) != 3 {
		t.Fatalf("uploaded %d records, want 3", len(records))
	}
	return f, nested
}

// uploadedWorkingDirectories collects every working directory member of
// every uploaded event.
func uploadedWorkingDirectories(f *fixture) []any {
	var found []any
	var walk func(any)
	walk = func(value any) {
		switch typed := value.(type) {
		case map[string]any:
			for key, child := range typed {
				if key == "cwd" || key == "working_directory" || key == "workdir" {
					found = append(found, child)
					continue
				}
				walk(child)
			}
		case []any:
			for _, child := range typed {
				walk(child)
			}
		}
	}
	for _, record := range f.server.Records() {
		walk(record["events"])
	}
	return found
}

func TestEnqueue_MetadataRecordCarriesNoParentPathSegment(t *testing.T) {
	f, _ := folderFixture(t, "metadata")
	directories := uploadedWorkingDirectories(f)
	if len(directories) < 4 {
		t.Fatalf("expected the session and raw working directories of every record, got %v", directories)
	}
	for _, directory := range directories {
		// Beacon's raw members are digested at the metadata level, so there
		// the folder's name arrives as its fingerprint.
		if directory != "api" && directory != privacy.Digest("api") {
			t.Fatalf("metadata sends only the folder's name, got %v", directories)
		}
	}
	uploaded := uploadedText(t, f)
	for _, parent := range []string{parentInProject, "/code", "code/", f.home} {
		if strings.Contains(uploaded, parent) {
			t.Fatalf("metadata record mentions %q: %s", parent, uploaded)
		}
	}
}

func TestEnqueue_StandardRecordKeepsRelativeWorkingDirectory(t *testing.T) {
	f, _ := folderFixture(t, "standard")
	for _, directory := range uploadedWorkingDirectories(f) {
		if directory != parentInProject+"/api" {
			t.Fatalf("standard sends the path inside the project, got %v", uploadedWorkingDirectories(f))
		}
	}
}

const (
	editDiffSentinel   = "SENTINEL-EDIT-DIFF-7c1e"
	editOutputSentinel = "SENTINEL-EDIT-OUTPUT-7c1e"
)

// editFixture captures a Claude Edit at level, which Beacon normalizes into
// a file.modified event carrying the diff it derives from the edit's
// arguments, as the pinned Beacon does.
func editFixture(t *testing.T, level string) string {
	t.Helper()
	f := newFixture(t)
	f.normalizer.normalized = []map[string]any{{
		"schema_version": "1.0", "event": map[string]any{"action": "file.modified"},
		"session": map[string]any{"id": "sess-1"},
		"file":    map[string]any{"diff": "-old\n+" + editDiffSentinel, "diff_bytes": 12, "operation": "modify", "language": "go"},
		"tool":    map[string]any{"name": "Edit", "output": editOutputSentinel},
		"gen_ai":  map[string]any{"output": map[string]any{"messages": []any{map[string]any{"role": "assistant", "parts": []any{map[string]any{"type": "text", "content": claudeReplySentinel}}}}}},
	}}
	f.server.Lock()
	f.server.Policy.Mappings[0].ContentLevel = level
	f.server.Unlock()
	f.daemon.refreshPolicy(context.Background())
	f.hook(t, f.repo, "PostToolUse", `,"tool_name":"Edit","tool_use_id":"toolu_1","tool_input":{"file_path":"main.go","old_string":"old","new_string":"new"},"tool_response":{}`)
	f.tick(t)
	if records := f.server.Records(); len(records) != 1 {
		t.Fatalf("uploaded %d records, want 1", len(records))
	}
	return uploadedText(t, f)
}

func TestProcess_StandardHookEventWithholdsDiffOutputAndReply(t *testing.T) {
	uploaded := editFixture(t, "standard")
	for _, withheld := range []string{editDiffSentinel, editOutputSentinel, claudeReplySentinel} {
		if strings.Contains(uploaded, withheld) {
			t.Errorf("standard sent %s from a normalized hook event: %s", withheld, uploaded)
		}
	}
	for _, kept := range []string{`"diff_bytes":12`, `"operation":"modify"`, `"name":"Edit"`} {
		if !strings.Contains(uploaded, kept) {
			t.Errorf("standard lost %s: %s", kept, uploaded)
		}
	}
}

func TestProcess_FullHookEventKeepsDiffOutputAndReply(t *testing.T) {
	uploaded := editFixture(t, "full")
	for _, kept := range []string{editDiffSentinel, editOutputSentinel, claudeReplySentinel} {
		if !strings.Contains(uploaded, kept) {
			t.Errorf("full dropped %s: %s", kept, uploaded)
		}
	}
}
