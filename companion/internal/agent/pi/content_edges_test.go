// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package pi

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

// Synthetic entries, each the shape Pi 0.84.4 writes for a case the RC-01
// sessions do not exercise.

// assertWellFormed: no two items of a record share a key, and its native
// record is JSON.
func assertWellFormed(t *testing.T, parsed parsedLine) {
	t.Helper()
	keys := map[string]string{}
	for _, content := range parsed.record.Items {
		key := agent.ContentKey(ID, "s", content.NativeRef, content.Part)
		if earlier, taken := keys[key]; taken {
			t.Errorf("line %d: %s and %s share a key", parsed.number, earlier, content.Part)
		}
		keys[key] = content.Part
		if content.Channel == "native_record" && !json.Valid([]byte(text(t, content))) {
			t.Errorf("line %d: native record is not JSON", parsed.number)
		}
	}
}

func nativeOf(t *testing.T, parsed parsedLine) map[string]any {
	t.Helper()
	var record map[string]any
	if err := json.Unmarshal([]byte(text(t, item(t, parsed, "native"))), &record); err != nil {
		t.Fatal(err)
	}
	return record
}

func blocksOf(t *testing.T, record map[string]any) []any {
	t.Helper()
	return record["message"].(map[string]any)["content"].([]any)
}

func isDigest(value any) bool {
	leaf, ok := value.(map[string]any)
	return ok && leaf["sha256"] != nil && leaf["bytes"] != nil && leaf["alias_of"] == nil
}

// Amendment 35: an entry's thinking blocks are one summary, joined in
// block order, and one raw when any carries a signature.
func TestThinkingBlocksAreOneSummaryAndOneRaw(t *testing.T) {
	entry := `{"type":"message","id":"cc000001","parentId":null,"timestamp":"2026-10-09T02:21:38.833Z","message":{"role":"assistant","content":[` +
		`{"type":"thinking","thinking":"**First**","thinkingSignature":"sig-1"},` +
		`{"type":"text","text":"Between."},` +
		`{"type":"thinking","thinking":"**Second**","thinkingSignature":"sig-2"},` +
		`{"type":"toolCall","id":"call_t|fc_t","name":"bash","arguments":{"command":"ls"}}]}}`
	parsed := line(t, parseLines(t, []byte(entry+"\n"), "s"), 1)
	assertWellFormed(t, parsed)
	if summary := item(t, parsed, "summary"); text(t, summary) != "**First**\n\n**Second**" {
		t.Errorf("summary %q", text(t, summary))
	}
	raws := 0
	for _, content := range parsed.record.Items {
		if content.Part == "raw" {
			raws++
		}
	}
	if raws != 1 || text(t, item(t, parsed, "text:1")) != "Between." || item(t, parsed, "input").CallID != "call_t|fc_t" {
		t.Errorf("items %+v", parsed.record.Items)
	}
}

// Amendment 36: read with no state the session's directory is unknown, and
// a relative path is passed on as named; no root is invented.
func TestRelativeEditPathWithoutStateStaysRelative(t *testing.T) {
	raw := line(t, parseSession(t, mainFile, mainSession), 10).raw
	record, _, err := contentSource(t).ContentParser().Parse(agent.ContentLine{Bytes: raw, Harness: ID, NativeSessionID: mainSession}, nil)
	if err != nil {
		t.Fatal(err)
	}
	parsed := parsedLine{number: 10, record: record}
	if diff := item(t, parsed, "diff:calc.py"); diff.DisplayPath != "" {
		t.Errorf("diff %+v", diff)
	}
	for _, content := range record.Items {
		if strings.Contains(content.Part, "/") {
			t.Errorf("invented a root: %s", content.Part)
		}
	}
	details := nativeOf(t, parsed)["message"].(map[string]any)["details"].(map[string]any)
	if !jsonEqual(details["patch"], map[string]any{"backplane_content_ref": map[string]any{"part": "diff:calc.py"}}) {
		t.Errorf("patch placeholder %v", details["patch"])
	}
}

func TestUndecodableImageDataIsDigested(t *testing.T) {
	entry := `{"type":"message","id":"cc000002","parentId":null,"timestamp":"2026-10-09T02:22:31.832Z","message":{"role":"user","content":[{"type":"text","text":"Look."},{"type":"image","mimeType":"image/png","data":"not*base64"},{"type":"image","mimeType":"image/png","data":""}]}}`
	parsed := line(t, parseLines(t, []byte(entry+"\n"), "s"), 1)
	blocks := blocksOf(t, nativeOf(t, parsed))
	for _, index := range []int{1, 2} {
		if data := blocks[index].(map[string]any)["data"]; !isDigest(data) {
			t.Errorf("image %d data kept as %v", index, data)
		}
	}
	for _, content := range parsed.record.Items {
		if strings.HasPrefix(content.Part, "image:") {
			t.Errorf("declared %s", content.Part)
		}
	}
}

func TestWhitespaceLeftOfAPromptIsNoPrompt(t *testing.T) {
	entry := `{"type":"message","id":"cc000003","parentId":null,"timestamp":"2026-10-09T02:22:31.832Z","message":{"role":"user","content":[{"type":"text","text":"<file name=\"/w/notes.txt\">\nbody\n</file>\n  \n"}]}}`
	parsed := line(t, parseLines(t, []byte(entry+"\n"), "s"), 1)
	for _, content := range parsed.record.Items {
		if content.Channel == "prompt" {
			t.Errorf("whitespace declared as prompt %q", text(t, content))
		}
	}
	item(t, parsed, "file:/w/notes.txt")
}

func TestToolCallWithoutAnIDKeepsOnlyADigest(t *testing.T) {
	entry := `{"type":"message","id":"cc000004","parentId":null,"timestamp":"2026-10-09T02:21:38.833Z","message":{"role":"assistant","content":[{"type":"text","text":"Calling."},{"type":"toolCall","id":"","name":"bash","arguments":{"command":"echo secret-ish"}}]}}`
	parsed := line(t, parseLines(t, []byte(entry+"\n"), "s"), 1)
	call := blocksOf(t, nativeOf(t, parsed))[1].(map[string]any)
	if strings.Contains(text(t, item(t, parsed, "native")), "secret-ish") || call["arguments"] == nil {
		t.Errorf("arguments of an id-less call kept as %v", call["arguments"])
	}
}

// Only the first text block refers to the joined output; the others are
// held in it.
func TestSeveralResultTextBlocksAreStoredOnce(t *testing.T) {
	entry := `{"type":"message","id":"cc000005","parentId":null,"timestamp":"2026-10-09T02:21:39.071Z","message":{"role":"toolResult","toolCallId":"call_m|fc_m","toolName":"read","content":[{"type":"text","text":"part one"},{"type":"text","text":"part two"}],"isError":false}}`
	parsed := line(t, parseLines(t, []byte(entry+"\n"), "s"), 1)
	output := item(t, parsed, "output")
	if text(t, output) != "part one\npart two" {
		t.Errorf("output %q", text(t, output))
	}
	blocks := blocksOf(t, nativeOf(t, parsed))
	key := agent.ContentKey(ID, "s", output.NativeRef, output.Part)
	if !jsonEqual(blocks[0].(map[string]any)["text"], map[string]any{"backplane_content_ref": key}) {
		t.Errorf("first block %v", blocks[0])
	}
	second, _ := blocks[1].(map[string]any)["text"].(map[string]any)
	if second["alias_of"] != key || second["sha256"] == nil {
		t.Errorf("second block %v", blocks[1])
	}
}

// A user shell command Pi cut: its output's full log counts only inside the
// temp dir and only when it ends with the kept output.
func TestTruncatedUserShellOutputNamesItsLog(t *testing.T) {
	entry := `{"type":"message","id":"cc000006","parentId":null,"timestamp":"2026-10-09T02:23:40.909Z","message":{"role":"bashExecution","command":"yes | head -n 100000","output":"y\ny\n","exitCode":0,"cancelled":false,"truncated":true,"fullOutputPath":"/tmp/x/pi-bash-00.log"}}`
	parsed := line(t, parseLines(t, []byte(entry+"\n"), "s"), 1)
	output := item(t, parsed, "output")
	if !output.SourceTruncated || output.Store == nil || output.Store.Kind != "harness_temp_log" || output.Store.Within != os.TempDir() {
		t.Fatalf("output %+v", output)
	}
	if !output.Store.Matches([]byte(strings.Repeat("y\n", 1000))) || output.Store.Matches([]byte("y\nn\n")) {
		t.Error("the log's tail check is wrong")
	}
}

func TestBranchSummaryRestatesContext(t *testing.T) {
	entry := `{"type":"branch_summary","id":"cc000007","parentId":"a0864fb0","timestamp":"2026-10-09T02:24:02.195Z","fromId":"d4473726","summary":"The abandoned branch fixed calc.py."}`
	parsed := line(t, parseLines(t, []byte(entry+"\n"), "s"), 1)
	if summary := item(t, parsed, "summary"); !summary.RestatesContext || text(t, summary) != "The abandoned branch fixed calc.py." {
		t.Errorf("branch summary %+v", summary)
	}
}

// Amendment 34: Pi's sessions live under its agent dir, which
// PI_CODING_AGENT_DIR moves; a sessionDir in its global settings adds one.
func TestContentRootsAreThePiSessionDirs(t *testing.T) {
	roots := func(env agent.Env) []string {
		source, ok := any(New()).(interface{ ContentRoots(agent.Env) []string })
		if !ok {
			t.Fatal("Pi names no content roots")
		}
		return source.ContentRoots(env)
	}
	home := t.TempDir()
	if got := roots(agent.Env{Home: home, Getenv: func(string) string { return "" }}); strings.Join(got, ",") != filepath.Join(home, ".pi", "agent", "sessions") {
		t.Errorf("default roots %v", got)
	}
	moved := filepath.Join(t.TempDir(), "agent")
	env := agent.Env{Home: home, Getenv: func(key string) string {
		if key == "PI_CODING_AGENT_DIR" {
			return moved
		}
		return ""
	}}
	if got := roots(env); strings.Join(got, ",") != filepath.Join(moved, "sessions") {
		t.Errorf("roots under PI_CODING_AGENT_DIR %v", got)
	}
	custom := filepath.Join(t.TempDir(), "elsewhere")
	os.MkdirAll(moved, 0o700)
	settings, _ := json.Marshal(map[string]string{"sessionDir": custom})
	os.WriteFile(filepath.Join(moved, "settings.json"), settings, 0o600)
	if got := roots(env); strings.Join(got, ",") != filepath.Join(moved, "sessions")+","+custom {
		t.Errorf("roots with a settings sessionDir %v", got)
	}
	os.WriteFile(filepath.Join(moved, "settings.json"), []byte(`{"sessionDir":"relative/dir"}`), 0o600)
	if got := roots(env); strings.Join(got, ",") != filepath.Join(moved, "sessions") {
		t.Errorf("a relative sessionDir became a root: %v", got)
	}
	os.WriteFile(filepath.Join(moved, "settings.json"), []byte(`{"sessionDir":"~/pi-sessions"}`), 0o600)
	if got := roots(env); strings.Join(got, ",") != filepath.Join(moved, "sessions")+","+filepath.Join(home, "pi-sessions") {
		t.Errorf("a ~/ sessionDir did not expand: %v", got)
	}
	// Settings past the size Pi's own settings can sensibly have are not read.
	os.WriteFile(filepath.Join(moved, "settings.json"), []byte(`{"sessionDir":"`+custom+`","pad":"`+strings.Repeat("x", 64<<10)+`"}`), 0o600)
	if got := roots(env); strings.Join(got, ",") != filepath.Join(moved, "sessions") {
		t.Errorf("an oversized settings file was read: %v", got)
	}
	relative := agent.Env{Home: home, Getenv: func(key string) string {
		if key == "PI_CODING_AGENT_DIR" {
			return "relative/agent"
		}
		return ""
	}}
	if got := roots(relative); strings.Join(got, ",") != filepath.Join(home, ".pi", "agent", "sessions") {
		t.Errorf("a relative PI_CODING_AGENT_DIR was honoured: %v", got)
	}
}
