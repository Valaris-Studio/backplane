// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// TestEndToEndCaptureWithPinnedBeacon drives the real flow: connect, install
// user-level hooks, shim writes the inbox, the daemon normalizes with the
// real beacon-hooks, uploads to a fake server, and local state drains.
func TestEndToEndCaptureWithPinnedBeacon(t *testing.T) {
	manifest := os.Getenv(envBeaconArtifact)
	if manifest == "" || runtime.GOOS == "windows" {
		t.Skip("set BACKPLANE_BEACON_ARTIFACT to replay through the pinned beacon-hooks executable")
	}
	h := newHarness(t)
	h.env[envBeaconArtifact] = manifest
	t.Setenv("BEACON_CLOUD_DEVICE_KEY", "bcn_device_do_not_inherit")
	h.connect(t)
	if err := h.run(t, "agents", "install", "claude-code"); err != nil {
		t.Fatal(err)
	}
	fixtures := []struct{ event, content, action string }{
		{"SessionStart", `,"model":"claude-test-model"`, "session.started"},
		{"UserPromptSubmit", `,"prompt":"Fix synthetic fixture token=fixtureSecretValue"`, "prompt.submitted"},
		{"PreToolUse", `,"tool_name":"mcp__backplane__get_card","tool_use_id":"toolu_fixture_1","tool_input":{"card_id":"card-fixture","api_key":"structuredSecretValue"}`, "tool.invoked"},
		{"PostToolUse", `,"tool_name":"mcp__backplane__get_card","tool_use_id":"toolu_fixture_1","tool_input":{"card_id":"card-fixture"},"tool_response":{"result":"synthetic card"}`, "mcp.tool_invoked"},
		{"PostToolUseFailure", `,"tool_name":"Write","tool_use_id":"toolu_fixture_2","tool_input":{"file_path":"fixture.py","content":"print('must not be a successful edit')"},"error":"synthetic failure"`, "tool.failed"},
		{"Stop", `,"transcript_path":"/DO_NOT_OPEN_TRANSCRIPT"`, "tool.completed"},
		{"SessionEnd", ``, "session.ended"},
	}
	for _, fixture := range fixtures {
		if output := h.hook(t, hookPayload(h.repo, fixture.event, fixture.content)); output != "{}" {
			t.Fatalf("%s: hook answered %q", fixture.event, output)
		}
	}
	if names, _ := inbox.List(filepath.Join(h.data, "inbox")); len(names) != len(fixtures) {
		t.Fatalf("inbox has %d items", len(names))
	}

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.app.run(ctx, []string{"run"}) }()
	deadline := time.Now().Add(30 * time.Second)
	for len(h.server.Records()) < len(fixtures) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("daemon: %v", err)
	}

	records := h.server.Records()
	if len(records) != len(fixtures) {
		t.Fatalf("uploaded %d of %d records", len(records), len(fixtures))
	}
	for index, fixture := range fixtures {
		assertRecord(t, records[index], fixture.event, fixture.action)
	}
	assertEventContract(t, records)
	layout := store.Layout{Root: h.data}
	if names, _ := inbox.List(layout.InboxDir()); len(names) != 0 {
		t.Fatal("inbox not drained")
	}
	if stats, _ := queue.Open(layout).Stats(); stats.Records != 0 || stats.Acknowledged != uint64(len(fixtures)) {
		t.Fatalf("queue not drained after ack: %+v", stats)
	}
	assertNoSecrets(t, h, records)

	// An unmapped repository leaves nothing beyond its discovered entry.
	other := filepath.Join(h.home, "code", "unmapped")
	mustMkdir(t, filepath.Join(other, ".git"))
	mustWrite(t, filepath.Join(other, ".git", "config"), "[remote \"origin\"]\n\turl = git@github.com:acme/unmapped.git\n")
	before := h.files(t)
	h.hook(t, hookPayload(other, "UserPromptSubmit", `,"prompt":"UNSELECTED_MUST_NOT_PERSIST"`))
	after := h.files(t)
	if len(after) != len(before)+1 || !containsString(after, "/discovered.json") {
		t.Fatalf("out-of-scope hook wrote %v (before %v)", after, before)
	}
	assertNoSecrets(t, h, nil)
}

func assertRecord(t *testing.T, record map[string]any, event, action string) {
	t.Helper()
	if record["mapping_id"] != "m1" || record["harness"] != "claude_code" || record["native_session_id"] != "session_fixture_1" || record["collection_method"] != "hook" {
		t.Fatalf("%s: record envelope %v", event, record)
	}
	provenance, _ := record["beacon"].(map[string]any)
	if provenance["commit"] != "b17031414618cf86f7aad2b485935e548e8a8e63" || provenance["schema_version"] == "" {
		t.Fatalf("%s: provenance %v", event, provenance)
	}
	events, _ := record["events"].([]any)
	found := false
	for _, raw := range events {
		encoded, _ := json.Marshal(raw)
		var members map[string]any
		json.Unmarshal(encoded, &members)
		if _, leaked := members["user"]; leaked {
			t.Fatalf("%s: local user uploaded: %s", event, encoded)
		}
		if endpoint, _ := members["endpoint"].(map[string]any); endpoint["hostname"] != nil {
			t.Fatalf("%s: host name uploaded: %s", event, encoded)
		}
		var value struct {
			Event   struct{ Action, Fidelity string }
			Harness struct {
				CollectionMethod string `json:"collection_method"`
			}
			Session struct{ ID string }
		}
		json.Unmarshal(encoded, &value)
		if value.Event.Action == action {
			found = true
		}
		if value.Event.Action == "file.modified" && event == "PostToolUseFailure" {
			t.Fatalf("failed tool reported as a successful edit: %s", encoded)
		}
		if value.Event.Fidelity != "observed" || value.Harness.CollectionMethod != "hook" || value.Session.ID != "session_fixture_1" {
			t.Fatalf("%s: event provenance %s", event, encoded)
		}
	}
	if !found {
		t.Fatalf("%s: no %s event in %v", event, action, events)
	}
}

func assertNoSecrets(t *testing.T, h *harness, records []map[string]any) {
	t.Helper()
	secrets := []string{"fixtureSecretValue", "structuredSecretValue", "UNSELECTED_MUST_NOT_PERSIST", "bcn_device_do_not_inherit", "DO_NOT_OPEN_TRANSCRIPT"}
	uploaded, _ := json.Marshal(records)
	filepath.WalkDir(h.root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		data, _ := os.ReadFile(path)
		for _, secret := range secrets {
			if strings.Contains(string(data), secret) {
				t.Errorf("%s persisted in %s", secret, path)
			}
		}
		return nil
	})
	for _, secret := range secrets {
		if strings.Contains(string(uploaded), secret) {
			t.Errorf("%s uploaded", secret)
		}
	}
	if _, err := os.Stat(filepath.Join(h.home, ".beacon")); !os.IsNotExist(err) {
		t.Error("Beacon touched the user's HOME")
	}
}

func TestMetadataLevelThroughPinnedBeacon(t *testing.T) {
	manifest := os.Getenv(envBeaconArtifact)
	if manifest == "" || runtime.GOOS == "windows" {
		t.Skip("set BACKPLANE_BEACON_ARTIFACT to replay through the pinned beacon-hooks executable")
	}
	h := newHarness(t)
	h.env[envBeaconArtifact] = manifest
	h.server.Policy.Mappings[0].ContentLevel = "metadata"
	h.connect(t)
	fixtures := []struct{ event, content, action string }{
		{"UserPromptSubmit", `,"prompt":"draft the confidential acquisition memo"`, "prompt.submitted"},
		{"PreToolUse", `,"tool_name":"Bash","tool_use_id":"toolu_meta_1","tool_input":{"command":"cat acquisition-terms.txt"}`, "tool.invoked"},
		{"PostToolUse", `,"tool_name":"Bash","tool_use_id":"toolu_meta_1","tool_input":{"command":"cat acquisition-terms.txt"},"tool_response":{"stdout":"price is secret"}`, ""},
	}
	for _, fixture := range fixtures {
		h.hook(t, hookPayload(h.repo, fixture.event, fixture.content))
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.app.run(ctx, []string{"run"}) }()
	deadline := time.Now().Add(30 * time.Second)
	for len(h.server.Records()) < len(fixtures) && time.Now().Before(deadline) {
		time.Sleep(50 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	records := h.server.Records()
	if len(records) != len(fixtures) {
		t.Fatalf("uploaded %d of %d metadata records", len(records), len(fixtures))
	}
	uploaded, _ := json.Marshal(records)
	for _, content := range []string{"confidential", "acquisition", "price is secret"} {
		if strings.Contains(string(uploaded), content) {
			t.Fatalf("metadata level uploaded content %q", content)
		}
	}
	for index, fixture := range fixtures {
		if fixture.action != "" && !strings.Contains(string(mustJSON(records[index])), `"action":"`+fixture.action+`"`) {
			t.Fatalf("%s: metadata level lost the %s event", fixture.event, fixture.action)
		}
	}
}

func mustJSON(value any) []byte { data, _ := json.Marshal(value); return data }

// piImage stands in for base64 image bytes Pi attaches to a prompt.
var piImage = strings.Repeat("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk", 40)

func assertNoImageBytes(t *testing.T, records []map[string]any) {
	t.Helper()
	uploaded, _ := json.Marshal(records)
	if strings.Contains(string(uploaded), piImage[:64]) {
		t.Fatal("image bytes uploaded")
	}
}

type piFixture struct {
	event, payload string
	actions        []string
}

func piFixtures(cwd string) []piFixture {
	c := quoted(cwd)
	return []piFixture{
		{"session_start", `{"type":"session_start","reason":"startup","sessionId":"pi-sess-1","cwd":` + c + `,"model":"anthropic/claude-x"}`, []string{"session.started"}},
		{"input", `{"type":"input","text":"fix the build token=piSecretValue","source":"interactive","images":[{"type":"image","data":"` + piImage + `","mimeType":"image/png"}],"sessionId":"pi-sess-1","cwd":` + c + `}`, []string{"prompt.submitted"}},
		{"tool_call", `{"type":"tool_call","toolName":"bash","toolCallId":"call_1","input":{"command":"make test"},"sessionId":"pi-sess-1","cwd":` + c + `}`, []string{"tool.invoked"}},
		{"tool_result", `{"type":"tool_result","toolName":"bash","toolCallId":"call_1","input":{"command":"make test"},"content":[{"type":"text","text":"PI_TOOL_OUTPUT_MARK"}],"isError":false,"sessionId":"pi-sess-1","cwd":` + c + `}`, []string{"command.executed"}},
		{"user_bash", `{"type":"user_bash","command":"ls","excludeFromContext":false,"sessionId":"pi-sess-1","cwd":` + c + `}`, []string{"command.executed"}},
		{"message_end", `{"type":"message_end","message":{"role":"assistant","model":"claude-x","content":[{"type":"thinking","thinking":"plan it"},{"type":"text","text":"done"}],"usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.001}}},"sessionId":"pi-sess-1","cwd":` + c + `}`, []string{"agent.reasoning", "token.usage"}},
		{"session_shutdown", `{"type":"session_shutdown","reason":"quit","sessionId":"pi-sess-1","cwd":` + c + `}`, []string{"session.ended"}},
	}
}

func runPiThroughPinnedBeacon(t *testing.T, contentLevel string) (*harness, []map[string]any) {
	t.Helper()
	manifest := os.Getenv(envBeaconArtifact)
	if manifest == "" || runtime.GOOS == "windows" {
		t.Skip("set BACKPLANE_BEACON_ARTIFACT to replay through the pinned beacon-hooks executable")
	}
	h := newHarness(t)
	h.env[envBeaconArtifact] = manifest
	h.server.Policy.Installation.EnabledAgents = []string{"claude_code", "pi_cli"}
	h.server.Policy.Mappings[0].ContentLevel = contentLevel
	h.connect(t)
	fixtures := piFixtures(h.repo)
	for _, fixture := range fixtures {
		h.stdout.Reset()
		h.app.stdin = strings.NewReader(fixture.payload)
		h.app.runHook([]string{"pi"})
	}
	h.app.stdin = strings.NewReader(`{"type":"message_end","message":{"role":"user","content":"a user message"},"sessionId":"pi-sess-1","cwd":` + quoted(h.repo) + `}`)
	h.app.runHook([]string{"pi"})
	if names, _ := inbox.List(filepath.Join(h.data, "inbox")); len(names) != len(fixtures) {
		t.Fatalf("inbox has %d items for %d mapped events", len(names), len(fixtures))
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- h.app.run(ctx, []string{"run"}) }()
	for deadline := time.Now().Add(30 * time.Second); len(h.server.Records()) < len(fixtures) && time.Now().Before(deadline); {
		time.Sleep(50 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	records := h.server.Records()
	if len(records) != len(fixtures) {
		t.Fatalf("uploaded %d of %d Pi records", len(records), len(fixtures))
	}
	return h, records
}

func TestPiEventsThroughPinnedBeacon(t *testing.T) {
	h, records := runPiThroughPinnedBeacon(t, "standard")
	for index, fixture := range piFixtures(h.repo) {
		record := records[index]
		if record["harness"] != "pi_cli" || record["collection_method"] != "plugin" || record["native_session_id"] != "pi-sess-1" || record["mapping_id"] != "m1" {
			t.Fatalf("%s: record envelope %v", fixture.event, record)
		}
		events, _ := record["events"].([]any)
		var actions []string
		for _, raw := range events {
			encoded, _ := json.Marshal(raw)
			var value struct {
				Event   struct{ Action, Fidelity string }
				Harness struct {
					Name             string
					CollectionMethod string `json:"collection_method"`
				}
				Session struct{ ID string }
				GenAI   struct {
					Tool struct{ Call struct{ ID string } }
				} `json:"gen_ai"`
				User     any
				Endpoint map[string]any
			}
			json.Unmarshal(encoded, &value)
			actions = append(actions, value.Event.Action)
			if value.Harness.Name != "pi_cli" || value.Harness.CollectionMethod != "plugin" || value.Session.ID != "pi-sess-1" {
				t.Fatalf("%s: event provenance %s", fixture.event, encoded)
			}
			if value.User != nil || value.Endpoint["hostname"] != nil {
				t.Fatalf("%s: device identity uploaded: %s", fixture.event, encoded)
			}
			if (fixture.event == "tool_call" || fixture.event == "tool_result") && value.GenAI.Tool.Call.ID != "call_1" {
				t.Fatalf("%s: tool call id lost: %s", fixture.event, encoded)
			}
			if strings.Contains(string(encoded), "approval") {
				t.Fatalf("%s: approval data invented: %s", fixture.event, encoded)
			}
		}
		if strings.Join(actions, ",") != strings.Join(fixture.actions, ",") {
			t.Fatalf("%s: actions %v, want %v", fixture.event, actions, fixture.actions)
		}
	}
	uploaded, _ := json.Marshal(records)
	if strings.Contains(string(uploaded), "piSecretValue") || strings.Contains(string(uploaded), "a user message") {
		t.Fatalf("secret or ignored user message uploaded")
	}
	assertNoImageBytes(t, records)
	assertEventContract(t, records)
	if strings.Contains(string(uploaded), "PI_TOOL_OUTPUT_MARK") {
		t.Fatal("standard level uploaded Pi tool output")
	}
	for _, reply := range []string{"plan it", `"done"`} {
		if strings.Contains(string(uploaded), reply) {
			t.Fatalf("standard level uploaded the agent's reply %s", reply)
		}
	}
	if !strings.Contains(string(uploaded), `"mime":"image/png"`) {
		t.Fatal("image descriptor missing at standard level")
	}
}

func TestPiMetadataLevelThroughPinnedBeacon(t *testing.T) {
	_, records := runPiThroughPinnedBeacon(t, "metadata")
	assertNoImageBytes(t, records)
	uploaded, _ := json.Marshal(records)
	if strings.Contains(string(uploaded), "PI_TOOL_OUTPUT_MARK") {
		t.Fatal("metadata level uploaded Pi tool output")
	}
	for _, content := range []string{"fix the build", "make test", "plan it", `"done"`, `"ls"`} {
		if strings.Contains(string(uploaded), content) {
			t.Fatalf("metadata level uploaded %q", content)
		}
	}
	for _, kept := range []string{`"action":"token.usage"`, `"action":"agent.reasoning"`, `"action":"tool.invoked"`, "call_1"} {
		if !strings.Contains(string(uploaded), kept) {
			t.Fatalf("metadata level lost %s", kept)
		}
	}
}

// The backend correlates a Pi MCP call that carries no tool call id by the
// tool event's tool.name and raw.pi.input (backend app/core/call_correlation.py),
// comparing strings by their metadata-level digest. Both must reach the server
// at every content level: verbatim, or as exactly that digest.
func TestPiToolArgumentsReachTheServerForCallCorrelation(t *testing.T) {
	for level, want := range map[string]string{
		"metadata": privacy.Digest("make test"),
		"standard": "make test",
		"full":     "make test",
	} {
		t.Run(level, func(t *testing.T) {
			_, records := runPiThroughPinnedBeacon(t, level)
			events, _ := records[2]["events"].([]any)
			if len(events) != 1 {
				t.Fatalf("tool_call record has %d events", len(events))
			}
			encoded, _ := json.Marshal(events[0])
			var event struct {
				Tool struct{ Name string }
				Raw  struct {
					Pi struct {
						Input struct{ Command string }
					}
				}
			}
			json.Unmarshal(encoded, &event)
			if event.Tool.Name != "bash" || event.Raw.Pi.Input.Command != want {
				t.Fatalf("tool name %q, arguments %q; want bash, %q: %s", event.Tool.Name, event.Raw.Pi.Input.Command, want, encoded)
			}
		})
	}
}

const codexPatch = "*** Begin Patch\n*** Update File: src/app.py\n@@\n-old line\n+CODEX_PATCH_MARK\n*** End Patch\n"

// codexExecPatch is the exec tool's JavaScript as codex-cli 0.159.0 sends it
// when the model edits through the tools wrapper: the patch rides inside a
// JS string literal, newlines escaped.
const codexExecPatch = `text(await tools.apply_patch("*** Begin Patch\n*** Update File: cli/existing.txt\n@@\n+CODEX_EXEC_EDIT_MARK\n*** Add File: cli/new.txt\n+CODEX_EXEC_NEW_MARK\n*** End Patch"));`

var codexCommandContentMarks = []string{"CODEX_EXEC_EDIT_MARK", "CODEX_EXEC_NEW_MARK", "CODEX_SHELL_PATCH_MARK", "CODEX_HEREDOC_MARK"}

// codexHeredocWrite is a shell command that writes a file through a heredoc.
const codexHeredocWrite = "mkdir -p docs && cat > docs/notes.md <<'EOF'\n# CODEX_HEREDOC_MARK\nEOF"

// codexShellPatch is a shell command that pipes a patch to apply_patch.
const codexShellPatch = "cd cli && apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: existing.txt\n+CODEX_SHELL_PATCH_MARK\n*** End Patch\nPATCH"

func codexLogs(threads map[string]string) string {
	attribute := func(key, value string) string {
		return `{"key":` + quoted(key) + `,"value":{"stringValue":` + quoted(value) + `}}`
	}
	var records []string
	for _, entry := range []struct{ thread, event, extra string }{
		{"thread-root", "codex.conversation_starts", attribute("provider_name", "openai")},
		{"thread-root", "codex.user_prompt", attribute("prompt", "refactor the parser")},
		{"thread-root", "codex.tool_result", attribute("tool_name", "exec_command") + "," + attribute("call_id", "call_1") + "," + attribute("arguments", `{"cmd":"make test"}`) + "," + attribute("success", "true") + "," + attribute("output", "CODEX_TOOL_OUTPUT_MARK")},
		// apply_patch is a freeform tool: its arguments are the patch itself.
		{"thread-root", "codex.tool_result", attribute("tool_name", "apply_patch") + "," + attribute("call_id", "call_2") + "," + attribute("arguments", codexPatch) + "," + attribute("success", "true") + "," + attribute("output", "Success. Updated the following files:\nM src/app.py")},
		{"thread-root", "codex.tool_result", attribute("tool_name", "exec") + "," + attribute("tool_namespace", "functions") + "," + attribute("call_id", "call_3") + "," + attribute("arguments", codexExecPatch) + "," + attribute("success", "true") + "," + attribute("output", "Success.")},
		{"thread-root", "codex.tool_result", attribute("tool_name", "exec_command") + "," + attribute("call_id", "call_4") + "," + attribute("arguments", `{"cmd":`+quoted(codexShellPatch)+`}`) + "," + attribute("success", "true") + "," + attribute("output", "Success.")},
		{"thread-root", "codex.tool_result", attribute("tool_name", "exec_command") + "," + attribute("call_id", "call_5") + "," + attribute("arguments", `{"cmd":`+quoted(codexHeredocWrite)+`}`) + "," + attribute("success", "true") + "," + attribute("output", "")},
		{"thread-child", "codex.user_prompt", attribute("prompt", "subagent prompt")},
		{"thread-orphan", "codex.user_prompt", attribute("prompt", "orphan prompt")},
		{"thread-rootonly", "codex.user_prompt", attribute("prompt", "root-only prompt")},
		{"thread-malformed", "codex.user_prompt", attribute("prompt", "malformed prompt")},
		{"thread-foreign", "codex.user_prompt", attribute("prompt", "foreign prompt")},
		{"thread-out", "codex.user_prompt", attribute("prompt", "OTHER_REPO_PROMPT")},
		{"thread-late", "codex.user_prompt", attribute("prompt", "late hook prompt")},
	} {
		if threads != nil && threads[entry.thread] == "" {
			continue
		}
		records = append(records, `{"timeUnixNano":"1790000000000000000","body":{"stringValue":`+quoted(entry.event)+`},"attributes":[`+
			attribute("event.name", entry.event)+","+attribute("conversation.id", entry.thread)+","+attribute("user.email", "person@example.com")+","+
			attribute("app.version", "0.144.1")+","+attribute("model", "gpt-5")+","+entry.extra+`]}`)
	}
	return `{"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"codex_exec"}},{"key":"host.name","value":{"stringValue":"laptop.local"}}]},"scopeLogs":[{"scope":{"name":"codex_otel.log_only"},"logRecords":[` + strings.Join(records, ",") + `]}]}]}`
}

func postUntilAccepted(t *testing.T, url, body string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		response, err := http.Post(url, "application/json", strings.NewReader(body))
		if err == nil {
			response.Body.Close()
			if response.StatusCode == http.StatusOK {
				return
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("gate never accepted %s", url)
}

func TestCodexTelemetryThroughGateAndPinnedCollector(t *testing.T) {
	records := runCodexThroughCollector(t, "standard")
	actions := map[string]bool{}
	for _, record := range records {
		for _, raw := range record["events"].([]any) {
			event, _ := raw.(map[string]any)["event"].(map[string]any)
			actions[event["action"].(string)] = true
		}
	}
	for _, want := range []string{"session.started", "prompt.submitted", "command.executed", "token.usage"} {
		if !actions[want] {
			t.Errorf("no %s from the pinned collector: %v", want, actions)
		}
	}
	uploaded, _ := json.Marshal(records)
	if !strings.Contains(string(uploaded), "refactor the parser") {
		t.Fatal("standard level must keep the prompt")
	}
	if strings.Contains(string(uploaded), "CODEX_TOOL_OUTPUT_MARK") {
		t.Fatal("standard level uploaded Codex tool output")
	}
	if strings.Contains(string(uploaded), "CODEX_PATCH_MARK") || !strings.Contains(string(uploaded), "apply_patch") {
		t.Fatalf("standard level must describe a patch but keep its content on the device: %s", uploaded)
	}
	for _, patched := range codexCommandContentMarks {
		if strings.Contains(string(uploaded), patched) {
			t.Errorf("standard level uploaded %s, file content inside a command", patched)
		}
	}
	for _, command := range []string{"tools.apply_patch(", `cd cli \u0026\u0026 apply_patch`, "make test", "docs/notes.md"} {
		if !strings.Contains(string(uploaded), command) {
			t.Errorf("standard level must still send the command around a patch: %s missing", command)
		}
	}
	if !strings.Contains(string(uploaded), `"input_tokens":777`) {
		t.Fatalf("token usage of a child span resolved through its trace was lost: %s", uploaded)
	}
}

func TestCodexMetadataLevelThroughPinnedCollector(t *testing.T) {
	records := runCodexThroughCollector(t, "metadata")
	uploaded, _ := json.Marshal(records)
	for _, content := range append([]string{"refactor the parser", "make test", "late hook prompt", "CODEX_TOOL_OUTPUT_MARK", "CODEX_PATCH_MARK"}, codexCommandContentMarks...) {
		if strings.Contains(string(uploaded), content) {
			t.Fatalf("metadata level uploaded %q", content)
		}
	}
	if !strings.Contains(string(uploaded), `"action":"token.usage"`) {
		t.Fatal("metadata level lost token usage")
	}
}

func runCodexThroughCollector(t *testing.T, contentLevel string) []map[string]any {
	t.Helper()
	hooksManifest, collectorManifest := os.Getenv(envBeaconArtifact), os.Getenv(envOtelcolArtifact)
	if hooksManifest == "" || collectorManifest == "" || runtime.GOOS == "windows" {
		t.Skip("set BACKPLANE_BEACON_ARTIFACT and BACKPLANE_OTELCOL_ARTIFACT to run through the pinned collector")
	}
	h := newHarness(t)
	h.env[envBeaconArtifact] = hooksManifest
	h.env[envOtelcolArtifact] = collectorManifest
	h.server.Policy.Installation.EnabledAgents = []string{"claude_code", "codex_cli"}
	h.server.Policy.Mappings[0].ContentLevel = contentLevel
	h.connect(t)
	codexHome := h.codexHome(t)
	if err := h.run(t, "agents", "install", "codex"); err != nil {
		t.Fatal(err)
	}
	settings, _ := state.Load[state.OTelSettings](store.Layout{Root: h.data}.OTelSettings())
	gate := fmt.Sprintf("http://127.0.0.1:%d", settings.GatePort)
	other := filepath.Join(h.home, "code", "unmapped")
	mustMkdir(t, other)
	sessionStart := func(thread, cwd string) {
		h.app.stdin = strings.NewReader(`{"session_id":` + quoted(thread) + `,"transcript_path":null,"cwd":` + quoted(cwd) + `,"hook_event_name":"SessionStart","model":"gpt-5","permission_mode":"default","source":"startup"}`)
		h.stdout.Reset()
		h.app.runHook([]string{"codex"})
	}
	sessionStart("thread-root", h.repo)
	sessionStart("thread-out", other)
	// Only a subagent's own rollout header proves its parent; the hook's
	// session_id is the tree's root, which the server would keep for good.
	sessions := filepath.Join(codexHome, "sessions", "2026", "09", "21")
	mustMkdir(t, sessions)
	rollout := func(thread, header string) string {
		path := filepath.Join(sessions, "rollout-2026-09-21T14-13-20-"+thread+".jsonl")
		if err := os.WriteFile(path, []byte(header+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	subagentStart := func(thread string, transcript any) {
		hook, _ := json.Marshal(map[string]any{"session_id": "thread-root", "turn_id": "t1", "transcript_path": transcript, "cwd": h.repo, "hook_event_name": "SubagentStart", "model": "gpt-5", "permission_mode": "default", "agent_id": thread, "agent_type": "worker"})
		h.app.stdin = strings.NewReader(string(hook))
		h.app.runHook([]string{"codex"})
	}
	// Synthetic positive case for the own-header lineage contract.
	subagentStart("thread-child", rollout("thread-child", codexSessionMeta("thread-child", "thread-root", h.repo)))
	subagentStart("thread-orphan", nil)
	subagentStart("thread-rootonly", rollout("thread-rootonly", codexSessionMeta("thread-rootonly", "", h.repo)))
	subagentStart("thread-malformed", rollout("thread-malformed", `{"type":"session_meta","payload":{"id":"thread-malformed","session_id":"thread-root","parent_thread_id":"thread-root"`))
	subagentStart("thread-foreign", rollout("thread-other", codexSessionMeta("thread-other", "thread-root", h.repo)))

	logPath := filepath.Join(h.data, "logs", "companion.log")
	cancel, done := h.runDaemonAsync(t, "--log", logPath)
	defer func() {
		cancel()
		<-done
	}()
	waitForLog(t, logPath, "started")
	postUntilAccepted(t, gate+"/v1/logs", codexLogs(nil))
	postUntilAccepted(t, gate+"/v1/traces", `{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"codex_exec"}}]},"scopeSpans":[{"scope":{"name":"codex"},"spans":[{"traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"00f067aa0ba902b7","name":"turn","kind":1,"startTimeUnixNano":"1790000000000000000","endTimeUnixNano":"1790000001000000000","attributes":[{"key":"thread.id","value":{"stringValue":"thread-root"}},{"key":"turn.id","value":{"stringValue":"turn-1"}},{"key":"codex.turn.token_usage.input_tokens","value":{"intValue":"100"}},{"key":"codex.turn.token_usage.output_tokens","value":{"intValue":"20"}},{"key":"codex.turn.token_usage.total_tokens","value":{"intValue":"120"}}],"status":{}}]}]}]}`)
	// A child turn span without thread.id resolves through its trace.
	postUntilAccepted(t, gate+"/v1/traces", `{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"codex_exec"}}]},"scopeSpans":[{"scope":{"name":"codex"},"spans":[`+
		`{"traceId":"7bf92f3577b34da6a3ce929d0e0e4730","spanId":"10f067aa0ba902b1","name":"session_loop","kind":1,"startTimeUnixNano":"1790000002000000000","endTimeUnixNano":"1790000009000000000","attributes":[{"key":"thread.id","value":{"stringValue":"thread-root"}}],"status":{}},`+
		`{"traceId":"7bf92f3577b34da6a3ce929d0e0e4730","spanId":"10f067aa0ba902b2","parentSpanId":"10f067aa0ba902b1","name":"turn","kind":1,"startTimeUnixNano":"1790000003000000000","endTimeUnixNano":"1790000004000000000","attributes":[{"key":"turn.id","value":{"stringValue":"turn-child"}},{"key":"codex.turn.token_usage.input_tokens","value":{"intValue":"777"}},{"key":"codex.turn.token_usage.output_tokens","value":{"intValue":"7"}},{"key":"codex.turn.token_usage.total_tokens","value":{"intValue":"784"}}],"status":{}}]}]}]}`)
	// The late thread's telemetry arrived before its hook; the gate holds it.
	sessionStart("thread-late", h.repo)

	bySession := map[string]int{}
	deadline := time.Now().Add(45 * time.Second)
	for time.Now().Before(deadline) {
		bySession = map[string]int{}
		for _, record := range h.server.Records() {
			bySession[record["native_session_id"].(string)]++
		}
		if bySession["thread-root"] >= 8 && bySession["thread-late"] >= 1 && bySession["thread-child"] >= 1 && allUploaded(bySession, codexLineageNegatives) {
			break
		}
		time.Sleep(200 * time.Millisecond)
	}
	records := h.server.Records()
	uploaded, _ := json.Marshal(records)
	if bySession["thread-root"] < 8 || bySession["thread-late"] < 1 || bySession["thread-child"] < 1 || !allUploaded(bySession, codexLineageNegatives) {
		collectorLog, _ := os.ReadFile(filepath.Join(h.data, "otel", "collector.log"))
		t.Fatalf("records by session %v\nuploaded: %s\ncollector: %s", bySession, uploaded, collectorLog)
	}
	if bySession["thread-out"] != 0 || strings.Contains(string(uploaded), "OTHER_REPO_PROMPT") {
		t.Fatal("out-of-scope Codex thread uploaded")
	}
	for _, identity := range []string{"person@example.com", "laptop.local"} {
		if strings.Contains(string(uploaded), identity) {
			t.Fatalf("identity %s uploaded", identity)
		}
	}
	for _, record := range records {
		if record["harness"] != "codex_cli" || record["collection_method"] != "otlp" || record["mapping_id"] != "m1" {
			t.Fatalf("record envelope: %v", record)
		}
		parent, hasParent := record["parent_native_session_id"]
		if record["native_session_id"] == "thread-child" && parent != "thread-root" || record["native_session_id"] != "thread-child" && hasParent {
			t.Fatalf("parent_native_session_id: %v", record)
		}
	}
	assertEventContract(t, records)
	return records
}

// codexLineageNegatives are subagents whose parent is not proven: no
// rollout, a header naming only the tree's root, a truncated header, and
// another thread's rollout. Each must upload with no parent.
var codexLineageNegatives = []string{"thread-orphan", "thread-rootonly", "thread-malformed", "thread-foreign"}

func allUploaded(bySession map[string]int, threads []string) bool {
	for _, thread := range threads {
		if bySession[thread] < 1 {
			return false
		}
	}
	return true
}

// codexSessionMeta builds a synthetic session_meta line in the lineage shape
// recorded for a Codex Desktop 0.160 subagent, not a captured CLI child
// header: session_id names the tree's root, parent_thread_id (when set) the
// thread that spawned it.
func codexSessionMeta(thread, spawner, cwd string) string {
	payload := map[string]any{"id": thread, "session_id": "thread-root", "timestamp": "2026-09-21T14:13:20.000Z", "cwd": cwd, "originator": "codex_exec", "cli_version": "0.161.0"}
	if spawner != "" {
		payload["parent_thread_id"] = spawner
		payload["source"] = map[string]any{"subagent": map[string]any{"thread_spawn": map[string]any{"parent_thread_id": spawner, "depth": 1}}}
		payload["thread_source"] = "subagent"
	}
	line, _ := json.Marshal(map[string]any{"timestamp": "2026-09-21T14:13:20.000Z", "type": "session_meta", "payload": payload})
	return string(line)
}

var timestampWithOffset = regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?(Z|[+-]\d\d:\d\d)$`)

// assertEventContract checks what the backend enforces on every record:
// each event's session.id equals the record's native_session_id, and every
// timestamp carries a timezone offset.
func assertEventContract(t *testing.T, records []map[string]any) {
	t.Helper()
	for _, record := range records {
		if captured, _ := record["captured_at"].(string); !timestampWithOffset.MatchString(captured) {
			t.Fatalf("captured_at without offset: %q", captured)
		}
		for _, raw := range record["events"].([]any) {
			event := raw.(map[string]any)
			session, _ := event["session"].(map[string]any)
			if session["id"] != record["native_session_id"] {
				t.Fatalf("event session %v != record session %v", session["id"], record["native_session_id"])
			}
			if stamp, _ := event["timestamp"].(string); !timestampWithOffset.MatchString(stamp) {
				t.Fatalf("event timestamp without offset: %q", stamp)
			}
		}
	}
}

func TestPiFullLevelKeepsToolOutputThroughPinnedBeacon(t *testing.T) {
	_, records := runPiThroughPinnedBeacon(t, "full")
	uploaded, _ := json.Marshal(records)
	assertNoImageBytes(t, records)
	assertEventContract(t, records)
	if !strings.Contains(string(uploaded), "PI_TOOL_OUTPUT_MARK") {
		t.Fatal("full level dropped Pi tool output")
	}
	for _, reply := range []string{"plan it", `"done"`} {
		if !strings.Contains(string(uploaded), reply) {
			t.Fatalf("full level dropped the agent's reply %s", reply)
		}
	}
}

func TestCodexFullLevelKeepsToolOutputThroughPinnedCollector(t *testing.T) {
	records := runCodexThroughCollector(t, "full")
	uploaded, _ := json.Marshal(records)
	if !strings.Contains(string(uploaded), "CODEX_TOOL_OUTPUT_MARK") {
		t.Fatal("full level dropped Codex tool output")
	}
	if !strings.Contains(string(uploaded), "CODEX_PATCH_MARK") {
		t.Fatal("full level dropped a Codex patch")
	}
	for _, patched := range codexCommandContentMarks {
		if !strings.Contains(string(uploaded), patched) {
			t.Errorf("full level dropped %s", patched)
		}
	}
}

// Beacon derives a Claude edit's file.diff from its arguments; the diff is
// sent only at the full level.
func TestClaudeEditDiffByLevelThroughPinnedBeacon(t *testing.T) {
	manifest := os.Getenv(envBeaconArtifact)
	if manifest == "" || runtime.GOOS == "windows" {
		t.Skip("set BACKPLANE_BEACON_ARTIFACT to replay through the pinned beacon-hooks executable")
	}
	for _, level := range []string{"metadata", "standard", "full"} {
		t.Run(level, func(t *testing.T) {
			h := newHarness(t)
			h.env[envBeaconArtifact] = manifest
			h.server.Policy.Mappings[0].ContentLevel = level
			h.connect(t)
			h.hook(t, hookPayload(h.repo, "PostToolUse", `,"tool_name":"Edit","tool_use_id":"toolu_edit","tool_input":{"file_path":"main.go","old_string":"old line","new_string":"CLAUDE_EDIT_DIFF_MARK"},"tool_response":{}`))
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			go func() { done <- h.app.run(ctx, []string{"run"}) }()
			for deadline := time.Now().Add(30 * time.Second); len(h.server.Records()) < 1 && time.Now().Before(deadline); {
				time.Sleep(50 * time.Millisecond)
			}
			cancel()
			<-done
			records := h.server.Records()
			if len(records) != 1 {
				t.Fatalf("uploaded %d records", len(records))
			}
			assertEventContract(t, records)
			uploaded, _ := json.Marshal(records)
			// At the metadata level Beacon sees only the arguments' digests and
			// makes no file.modified event.
			if level != "metadata" && (!strings.Contains(string(uploaded), `"action":"file.modified"`) || !strings.Contains(string(uploaded), `"diff_bytes"`)) {
				t.Fatalf("the edit must still be described: %s", uploaded)
			}
			if sent := strings.Contains(string(uploaded), "CLAUDE_EDIT_DIFF_MARK"); sent != (level == "full") {
				t.Fatalf("%s sent the diff: %v", level, sent)
			}
		})
	}
}

// A shell command that writes a file through a heredoc or echo reaches the
// server, through the pinned Beacon, as the command alone below the full
// level: Claude's Bash tool, Pi's bash tool and Pi's user_bash.
func TestShellFileContentByLevelThroughPinnedBeacon(t *testing.T) {
	manifest := os.Getenv(envBeaconArtifact)
	if manifest == "" || runtime.GOOS == "windows" {
		t.Skip("set BACKPLANE_BEACON_ARTIFACT to replay through the pinned beacon-hooks executable")
	}
	claudeCommand := quoted("mkdir -p docs && cat > docs/claude.md <<'EOF'\nCLAUDE_HEREDOC_MARK\nEOF")
	piCommand := quoted("echo 'PI_ECHO_MARK' > docs/pi.txt")
	userCommand := quoted("cat <<EOF | tee docs/user.txt\nPI_USER_BASH_MARK\nEOF")
	for _, level := range []string{"metadata", "standard", "full"} {
		t.Run(level, func(t *testing.T) {
			h := newHarness(t)
			h.env[envBeaconArtifact] = manifest
			h.server.Policy.Installation.EnabledAgents = []string{"claude_code", "pi_cli"}
			h.server.Policy.Mappings[0].ContentLevel = level
			h.connect(t)
			h.hook(t, hookPayload(h.repo, "PreToolUse", `,"tool_name":"Bash","tool_use_id":"toolu_sh","tool_input":{"command":`+claudeCommand+`}`))
			h.hook(t, hookPayload(h.repo, "PostToolUse", `,"tool_name":"Bash","tool_use_id":"toolu_sh","tool_input":{"command":`+claudeCommand+`},"tool_response":{"stdout":""}`))
			cwd := quoted(h.repo)
			for _, event := range []string{
				`{"type":"tool_call","toolName":"bash","toolCallId":"call_sh","input":{"command":` + piCommand + `},"sessionId":"pi-sess-1","cwd":` + cwd + `}`,
				`{"type":"user_bash","command":` + userCommand + `,"excludeFromContext":false,"sessionId":"pi-sess-1","cwd":` + cwd + `}`,
			} {
				h.app.stdin = strings.NewReader(event)
				h.app.runHook([]string{"pi"})
			}
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			go func() { done <- h.app.run(ctx, []string{"run"}) }()
			for deadline := time.Now().Add(30 * time.Second); len(h.server.Records()) < 4 && time.Now().Before(deadline); {
				time.Sleep(50 * time.Millisecond)
			}
			cancel()
			<-done
			records := h.server.Records()
			if len(records) != 4 {
				t.Fatalf("uploaded %d records", len(records))
			}
			assertEventContract(t, records)
			uploaded, _ := json.Marshal(records)
			if level != "metadata" {
				for _, target := range []string{"docs/claude.md", "docs/pi.txt", "docs/user.txt"} {
					if !strings.Contains(string(uploaded), target) {
						t.Errorf("%s must still send the command writing %s", level, target)
					}
				}
			}
			for _, mark := range []string{"CLAUDE_HEREDOC_MARK", "PI_ECHO_MARK", "PI_USER_BASH_MARK"} {
				if sent := strings.Contains(string(uploaded), mark); sent != (level == "full") {
					t.Errorf("%s sent %s: %v", level, mark, sent)
				}
			}
		})
	}
}

// Beacon copies a Pi edit's arguments into raw.pi.input of both the
// tool.invoked and the file.modified event; the text an edit writes is sent
// only at the full level.
func TestPiEditContentByLevelThroughPinnedBeacon(t *testing.T) {
	manifest := os.Getenv(envBeaconArtifact)
	if manifest == "" || runtime.GOOS == "windows" {
		t.Skip("set BACKPLANE_BEACON_ARTIFACT to replay through the pinned beacon-hooks executable")
	}
	for _, level := range []string{"metadata", "standard", "full"} {
		t.Run(level, func(t *testing.T) {
			h := newHarness(t)
			h.env[envBeaconArtifact] = manifest
			h.server.Policy.Installation.EnabledAgents = []string{"claude_code", "pi_cli"}
			h.server.Policy.Mappings[0].ContentLevel = level
			h.connect(t)
			cwd := quoted(h.repo)
			for _, event := range []string{
				`{"type":"tool_call","toolName":"edit","toolCallId":"call_e","input":{"path":"main.go","oldText":"PI_EDIT_OLD_MARK","newText":"PI_EDIT_NEW_MARK"},"sessionId":"pi-sess-1","cwd":` + cwd + `}`,
				`{"type":"tool_result","toolName":"edit","toolCallId":"call_e","input":{"path":"main.go","oldText":"PI_EDIT_OLD_MARK","newText":"PI_EDIT_NEW_MARK"},"content":[{"type":"text","text":"ok"}],"isError":false,"sessionId":"pi-sess-1","cwd":` + cwd + `}`,
				`{"type":"tool_call","toolName":"write","toolCallId":"call_w","input":{"path":"new.go","content":"PI_WRITE_MARK"},"sessionId":"pi-sess-1","cwd":` + cwd + `}`,
			} {
				h.app.stdin = strings.NewReader(event)
				h.app.runHook([]string{"pi"})
			}
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			go func() { done <- h.app.run(ctx, []string{"run"}) }()
			for deadline := time.Now().Add(30 * time.Second); len(h.server.Records()) < 3 && time.Now().Before(deadline); {
				time.Sleep(50 * time.Millisecond)
			}
			cancel()
			<-done
			records := h.server.Records()
			if len(records) != 3 {
				t.Fatalf("uploaded %d records", len(records))
			}
			assertEventContract(t, records)
			uploaded, _ := json.Marshal(records)
			if level != "metadata" && !strings.Contains(string(uploaded), `"path":"main.go"`) {
				t.Fatalf("the edit must still be described: %s", uploaded)
			}
			for _, mark := range []string{"PI_EDIT_OLD_MARK", "PI_EDIT_NEW_MARK", "PI_WRITE_MARK"} {
				if sent := strings.Contains(string(uploaded), mark); sent != (level == "full") {
					t.Errorf("%s sent %s: %v", level, mark, sent)
				}
			}
		})
	}
}

// Beacon's Claude mapper never carries tool_response into its events, so
// uploads hold no Claude tool output at any level; what the levels decide
// is what the companion retains before normalization.
func TestClaudeToolOutputRetentionByLevelThroughPinnedBeacon(t *testing.T) {
	manifest := os.Getenv(envBeaconArtifact)
	if manifest == "" || runtime.GOOS == "windows" {
		t.Skip("set BACKPLANE_BEACON_ARTIFACT to replay through the pinned beacon-hooks executable")
	}
	for _, level := range []string{"metadata", "standard", "full"} {
		t.Run(level, func(t *testing.T) {
			h := newHarness(t)
			h.env[envBeaconArtifact] = manifest
			h.server.Policy.Mappings[0].ContentLevel = level
			h.connect(t)
			h.hook(t, hookPayload(h.repo, "PostToolUse", `,"tool_name":"Bash","tool_use_id":"toolu_out","tool_input":{"command":"make test"},"tool_response":{"stdout":"CLAUDE_TOOL_OUTPUT_MARK"}`))
			names, _ := inbox.List(filepath.Join(h.data, "inbox"))
			item, err := inbox.Read(filepath.Join(h.data, "inbox"), names[0])
			if err != nil {
				t.Fatal(err)
			}
			retained, _ := json.Marshal(item.Payload)
			if kept := strings.Contains(string(retained), "CLAUDE_TOOL_OUTPUT_MARK"); kept != (level == "full") {
				t.Fatalf("%s retained tool output: %v", level, kept)
			}
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			go func() { done <- h.app.run(ctx, []string{"run"}) }()
			for deadline := time.Now().Add(30 * time.Second); len(h.server.Records()) < 1 && time.Now().Before(deadline); {
				time.Sleep(50 * time.Millisecond)
			}
			cancel()
			<-done
			records := h.server.Records()
			if len(records) != 1 {
				t.Fatalf("uploaded %d records", len(records))
			}
			assertEventContract(t, records)
			uploaded, _ := json.Marshal(records)
			if level != "full" && strings.Contains(string(uploaded), "CLAUDE_TOOL_OUTPUT_MARK") {
				t.Fatal("tool output uploaded below the full level")
			}
		})
	}
}
