// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package pi

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestExtensionForwardsEventsWhenLoadedByNode loads the rendered extension
// with a fake Pi API (Pi itself is never run) and a fake companion that
// records what it receives on stdin.
func TestExtensionForwardsEventsWhenLoadedByNode(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil || runtime.GOOS == "windows" || exec.Command(node, "--experimental-strip-types", "--no-warnings", "-e", "").Run() != nil {
		t.Skip("needs node with --experimental-strip-types")
	}
	dir := t.TempDir()
	// Sends run concurrently: each lands in its own file, never interleaved.
	received := filepath.Join(dir, "received")
	os.Mkdir(received, 0o700)
	companion := filepath.Join(dir, "backplane-companion")
	script := "#!/bin/sh\ncat > \"$(mktemp '" + received + "/event.XXXXXX')\"\n"
	if err := os.WriteFile(companion, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	source, err := renderExtension(companion)
	if err != nil {
		t.Fatal(err)
	}
	extension := filepath.Join(dir, extensionFileName)
	os.WriteFile(extension, []byte(source), 0o600)
	harness := filepath.Join(dir, "harness.mjs")
	os.WriteFile(harness, []byte(`
const mod = await import(`+"`"+`file://${process.argv[2]}`+"`"+`)
const handlers = {}
mod.default({ on: (name, fn) => { handlers[name] = fn } })
const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "pi-sess-1", getSessionFile: () => "/sessions/2026_pi-sess-1.jsonl" }, model: { id: "claude-x", provider: "anthropic" } }
const cyclic = { a: 1 }; cyclic.self = cyclic
const returned = []
returned.push(await handlers.tool_call({ type: "tool_call", toolName: "bash", toolCallId: "call_1", input: { command: "make test" }, big: 10n, cyclic, fn: () => 1, sessionId: "spoofed-session", sessionFile: "/spoofed.jsonl", cwd: "/spoofed" }, ctx))
returned.push(await handlers.session_shutdown({ type: "session_shutdown", reason: "quit" }, ctx))
// Older Pi, an in-memory session and a failing manager: the event still goes.
for (const [id, manager] of [["pi-sess-none", {}], ["pi-sess-undefined", { getSessionFile: () => undefined }], ["pi-sess-throws", { getSessionFile: () => { throw new Error("boom") } }]]) {
  returned.push(await handlers.input({ type: "input", text: "hi" }, { cwd: "/repo", sessionManager: { getSessionId: () => id, ...manager } }))
}
console.log(JSON.stringify({ subscribed: Object.keys(handlers).sort(), observesOnly: returned.every((value) => value === undefined) }))
`), 0o600)
	output, err := exec.Command(node, "--experimental-strip-types", "--no-warnings", harness, extension).Output()
	if err != nil {
		t.Fatalf("extension failed to load: %v", err)
	}
	var result struct {
		Subscribed   []string
		ObservesOnly bool
	}
	json.Unmarshal(output, &result)
	if strings.Join(result.Subscribed, ",") != "input,message_end,session_shutdown,session_start,tool_call,tool_result,user_bash" || !result.ObservesOnly {
		t.Fatalf("unexpected extension behavior: %s", output)
	}
	var data []byte
	var events []map[string]any
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		data, events = receivedEvents(received)
		if len(events) == 5 {
			break
		}
	}
	if len(events) != 5 {
		t.Fatalf("companion received %d whole events: %s", len(events), data)
	}
	if strings.Contains(string(data), "spoofed-session") || strings.Contains(string(data), "/spoofed.jsonl") || strings.Contains(string(data), `"cwd":"/spoofed"`) {
		t.Fatalf("event fields overrode the session identity from ctx: %s", data)
	}
	bySession := map[string]int{}
	for _, event := range events {
		session, _ := event["sessionId"].(string)
		bySession[session]++
		_, named := event["sessionFile"]
		if named != (session == "pi-sess-1") {
			t.Errorf("event of %s: sessionFile %v", session, event["sessionFile"])
		}
	}
	for session, want := range map[string]int{"pi-sess-1": 2, "pi-sess-none": 1, "pi-sess-undefined": 1, "pi-sess-throws": 1} {
		if bySession[session] != want {
			t.Errorf("%d events of %s, want %d", bySession[session], session, want)
		}
	}
	for _, want := range []string{`"type":"tool_call"`, `"toolCallId":"call_1"`, `"cwd":"/repo"`, `"eventCwd":"/spoofed"`, `"model":"anthropic/claude-x"`, `"sessionFile":"/sessions/2026_pi-sess-1.jsonl"`, `"big":"10"`, `"type":"session_shutdown"`} {
		if !strings.Contains(string(data), want) {
			t.Errorf("companion did not receive %s: %s", want, data)
		}
	}
}

// receivedEvents decodes each event file the fake companion wrote; one still
// being written is skipped until it is whole.
func receivedEvents(dir string) ([]byte, []map[string]any) {
	entries, _ := os.ReadDir(dir)
	var all []byte
	var events []map[string]any
	for _, entry := range entries {
		body, err := os.ReadFile(filepath.Join(dir, entry.Name()))
		var event map[string]any
		if err != nil || json.Unmarshal(body, &event) != nil {
			continue
		}
		all = append(append(all, body...), '\n')
		events = append(events, event)
	}
	return all, events
}
