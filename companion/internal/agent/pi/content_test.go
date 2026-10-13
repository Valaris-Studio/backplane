// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package pi

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/contracttest"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/richcapture"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

const (
	mainSession = "01a11e77-495e-7096-9830-f863d293518b"
	mainFile    = "sessions/2026-10-09T02-21-36-478Z_" + mainSession + ".jsonl"
	forkSession = "01a11e79-8293-78ea-895f-cf661f71cc8b"
	forkFile    = "sessions/2026-10-09T02-24-02-195Z_" + forkSession + ".jsonl"
	fixtureRoot = "/private/tmp/rc01-pi/work"
	// The sanitized temp dir the fixtures' full-log paths name.
	fixtureTemp = "/tmp/fixture-tmpdir"
)

func contentSource(t *testing.T) agent.ContentSource {
	t.Helper()
	source, ok := any(New()).(agent.ContentSource)
	if !ok {
		t.Fatal("Pi is not a rich capture content source")
	}
	return source
}

type parsedLine struct {
	number int
	raw    []byte
	record agent.ContentRecord
}

func parseSession(t *testing.T, relative, session string) []parsedLine {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(contracttest.SourceDir(t, "pi"), filepath.FromSlash(relative)))
	if err != nil {
		t.Fatal(err)
	}
	return parseLines(t, contracttest.HostFixture(data, fixtureRoot), session)
}

// fixturePath is the fixture's work-tree path rel in this host's spelling.
func fixturePath(rel string) string {
	return filepath.Join(contracttest.HostPath(fixtureRoot), filepath.FromSlash(rel))
}

func parseLines(t *testing.T, data []byte, session string) []parsedLine {
	t.Helper()
	parser := contentSource(t).ContentParser()
	var state json.RawMessage
	var lines []parsedLine
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(nil, 8<<20)
	offset := int64(0)
	for number := 1; scanner.Scan(); number++ {
		raw := append([]byte(nil), scanner.Bytes()...)
		record, next, err := parser.Parse(agent.ContentLine{Bytes: raw, Offset: offset, Harness: ID, NativeSessionID: session}, state)
		if err != nil {
			t.Fatalf("line %d: %v", number, err)
		}
		state = next
		lines = append(lines, parsedLine{number: number, raw: raw, record: record})
		offset += int64(len(raw)) + 1
	}
	return lines
}

func line(t *testing.T, lines []parsedLine, number int) parsedLine {
	t.Helper()
	if number < 1 || number > len(lines) {
		t.Fatalf("no line %d", number)
	}
	return lines[number-1]
}

func item(t *testing.T, parsed parsedLine, part string) agent.ContentItem {
	t.Helper()
	for _, candidate := range parsed.record.Items {
		if candidate.Part == part {
			return candidate
		}
	}
	var parts []string
	for _, candidate := range parsed.record.Items {
		parts = append(parts, candidate.Part+"/"+candidate.Channel)
	}
	t.Fatalf("line %d has no %q item; has %v", parsed.number, part, parts)
	return agent.ContentItem{}
}

func text(t *testing.T, content agent.ContentItem) string {
	t.Helper()
	if content.Text == nil {
		t.Fatalf("%s/%s carries no text", content.NativeRef, content.Part)
	}
	return *content.Text
}

func message(t *testing.T, raw []byte) map[string]any {
	t.Helper()
	var entry struct {
		Message map[string]any `json:"message"`
	}
	if err := json.Unmarshal(raw, &entry); err != nil {
		t.Fatal(err)
	}
	return entry.Message
}

func TestPiSessionParserLabels(t *testing.T) {
	parser := contentSource(t).ContentParser()
	if parser.Kind() != "pi_session" || parser.Version() != "companion-pi-session/1" {
		t.Fatalf("parser %q %q", parser.Kind(), parser.Version())
	}
}

// The managed extension names the session file with every event; only a
// file of the event's own session is taken.
// Every event an extension without sessionFile recorded names no file, the
// fork's session_shutdown above all: its targetSessionFile is another
// session's file.
func TestContentFileRefusesOldExtensionEvents(t *testing.T) {
	source := contentSource(t)
	files, _ := filepath.Glob(filepath.Join(contracttest.SourceDir(t, "pi"), "extension-events", "*.jsonl"))
	checked := 0
	for _, path := range files {
		data, _ := os.ReadFile(path)
		for number, raw := range bytes.Split(bytes.TrimSpace(data), []byte("\n")) {
			var payload map[string]any
			if err := json.Unmarshal(raw, &payload); err != nil {
				t.Fatal(err)
			}
			event, _ := payload["type"].(string)
			if named, ok := source.ContentFile(event, payload); ok {
				t.Errorf("%s:%d (%s) named %q", filepath.Base(path), number+1, event, named)
			}
			checked++
		}
	}
	if checked < 100 {
		t.Fatalf("only %d events", checked)
	}
}

// The session file reaches the daemon only; no event keeps it, at any level.
func TestSessionFileNeverReachesAnEvent(t *testing.T) {
	file := contracttest.HostPath("/home/me/.pi/agent/sessions/--work--/2026-10-09T02-21-36-478Z_" + mainSession + ".jsonl")
	raw, _ := json.Marshal(map[string]any{"type": "tool_result", "sessionId": mainSession, "cwd": "/work", "sessionFile": file, "toolCallId": "call_1", "toolName": "bash", "content": []any{map[string]any{"type": "text", "text": "ok"}}, "isError": false})
	for _, level := range []privacy.ContentLevel{privacy.Metadata, privacy.Standard, privacy.Full, privacy.Rich} {
		observation, payload, err := New().ParseHook(raw)
		if err != nil {
			t.Fatal(err)
		}
		if path, ok := contentSource(t).ContentFile(observation.Event, payload); !ok || path != file {
			t.Fatalf("named %q %v", path, ok)
		}
		clean, coverage := privacy.SanitizeFor(payload, New().ToolOutput(observation.Event), level)
		retained, _ := json.Marshal(privacy.ApplyContentLevel(clean, level))
		beacon, _ := json.Marshal(New().PrepareBeaconInput(observation.Event, clean))
		if bytes.Contains(retained, []byte("sessionFile")) || bytes.Contains(beacon, []byte("sessionFile")) || bytes.Contains(retained, []byte(".jsonl")) {
			t.Errorf("%s: the session file reached the event: %s", level, retained)
		}
		removed := false
		for _, field := range coverage.RemovedFields {
			removed = removed || field == "sessionFile"
		}
		if !removed {
			t.Errorf("%s: removal not recorded: %v", level, coverage.RemovedFields)
		}
	}
}

func TestContentFileNamesTheSessionsOwnFile(t *testing.T) {
	source := contentSource(t)
	sessions := contracttest.HostPath("/home/me/.pi/agent/sessions")
	file := filepath.Join(sessions, "--work--", "2026-10-09T02-21-36-478Z_"+mainSession+".jsonl")
	payload := map[string]any{"type": "message_end", "sessionId": mainSession, "sessionFile": file}
	if path, ok := source.ContentFile("message_end", payload); !ok || path != file {
		t.Fatalf("named %q %v", path, ok)
	}
	for name, refused := range map[string]map[string]any{
		"another session's file": {"sessionId": mainSession, "sessionFile": filepath.Join(sessions, "x_"+forkSession+".jsonl")},
		"relative path":          {"sessionId": mainSession, "sessionFile": "x_" + mainSession + ".jsonl"},
		"no file (in-memory)":    {"sessionId": mainSession},
		"not a string":           {"sessionId": mainSession, "sessionFile": 7},
		"no separator":           {"sessionId": mainSession, "sessionFile": filepath.Join(sessions, "x"+mainSession+".jsonl")},
	} {
		if path, ok := source.ContentFile("input", refused); ok {
			t.Errorf("%s: named %q", name, path)
		}
	}
}

func TestHeaderStatesWhenTheSessionBeganAndItsParent(t *testing.T) {
	parser := contentSource(t).ContentParser()
	first := func(relative string) []byte {
		data, err := os.ReadFile(filepath.Join(contracttest.SourceDir(t, "pi"), filepath.FromSlash(relative)))
		if err != nil {
			t.Fatal(err)
		}
		return data[:bytes.IndexByte(data, '\n')]
	}
	header, ok := parser.Header(first(mainFile))
	if !ok || !header.Began.Equal(time.Date(2026, 10, 9, 2, 21, 36, 478e6, time.UTC)) || header.ParentSessionID != "" {
		t.Fatalf("header %+v %v", header, ok)
	}
	fork, ok := parser.Header(first(forkFile))
	if !ok || fork.ParentSessionID != mainSession || !fork.Began.Equal(time.Date(2026, 10, 9, 2, 24, 2, 195e6, time.UTC)) {
		t.Fatalf("fork header %+v %v", fork, ok)
	}
	if _, ok := parser.Header([]byte(`{"type":"message","id":"a","timestamp":"2026-10-09T02:21:36.515Z"}`)); ok {
		t.Fatal("an entry is not a header")
	}
}

func TestParsesTheJourneyOfOneSession(t *testing.T) {
	lines := parseSession(t, mainFile, mainSession)

	prompt := item(t, line(t, lines, 4), "text:0")
	if prompt.Role != "user" || prompt.Channel != "prompt" || prompt.NativeRef != "a0864fb0" || !strings.HasPrefix(text(t, prompt), "Do these steps in order") {
		t.Errorf("prompt %+v", prompt)
	}
	if at := line(t, lines, 4).record.At; !at.Equal(time.Date(2026, 10, 9, 2, 21, 36, 515e6, time.UTC)) {
		t.Errorf("prompt at %v", at)
	}
	if schema := line(t, lines, 4).record.SchemaVersion; schema != "pi-session/3" {
		t.Errorf("schema version %q", schema)
	}

	reasoning := item(t, line(t, lines, 5), "summary")
	if reasoning.Channel != "reasoning" || text(t, reasoning) != "**Planning sequential tool execution**" {
		t.Errorf("reasoning summary %+v", reasoning)
	}
	if raw := item(t, line(t, lines, 5), "raw"); raw.Coverage != "source_unavailable" || raw.CoverageReason != "encrypted_at_source" || raw.Text != nil {
		t.Errorf("signature %+v", raw)
	}
	for _, content := range line(t, lines, 11).record.Items {
		if content.Part == "summary" {
			t.Error("an empty provider summary became an item")
		}
	}

	callID := "call_fdf50d27d2de1bfc0807e4665e04685e|fc_bc18b8e149513aecfb933937a74f71eb305a8bd92cdd2f2f37"
	call := item(t, line(t, lines, 5), "input")
	if call.Channel != "tool_input" || call.CallID != callID || call.MediaType != "application/json" {
		t.Errorf("tool call %+v", call)
	}
	var arguments map[string]any
	if err := json.Unmarshal([]byte(text(t, call)), &arguments); err != nil || arguments["command"] != "python3 -m pytest -q test_calc.py" {
		t.Errorf("tool input %v %v", arguments, err)
	}

	failed := item(t, line(t, lines, 6), "error")
	if failed.Role != "tool" || failed.Channel != "error" || failed.CallID != callID || failed.NativeRef != "cc9473d0" || !strings.HasSuffix(text(t, failed), "Command exited with code 1") {
		t.Errorf("failed result %+v", failed)
	}
	if item(t, line(t, lines, 8), "error").Channel != "error" {
		t.Error("a failed edit is not an error")
	}

	edit := item(t, line(t, lines, 10), "diff:"+fixturePath("calc.py"))
	if edit.Channel != "diff" || !strings.Contains(text(t, edit), "+    return a + b") {
		t.Errorf("edit %+v", edit)
	}
	if item(t, line(t, lines, 10), "output").Channel != "tool_output" {
		t.Error("the edit's result text is not tool output")
	}

	if passed := item(t, line(t, lines, 12), "output"); passed.Channel != "tool_output" || text(t, passed) != ".                                                                        [100%]\n1 passed in 0.00s\n" {
		t.Errorf("success %+v", passed)
	}
	if whole := item(t, line(t, lines, 14), "output"); whole.SourceTruncated || whole.Store != nil || len(text(t, whole)) != 20001 {
		t.Errorf("a 20,001 B result kept whole: %d B", len(text(t, whole)))
	}

	final := item(t, line(t, lines, 19), "text:1")
	if final.Role != "assistant" || final.Channel != "reply" || final.MediaType != "text/markdown" || !strings.Contains(text(t, final), "BLUEBERRY") {
		t.Errorf("final answer %+v", final)
	}
}

func TestFileSpansAndImagesInAPrompt(t *testing.T) {
	lines := parseSession(t, mainFile, mainSession)

	correction := item(t, line(t, lines, 20), "text:0")
	if !strings.HasPrefix(text(t, correction), "Correction: ") || strings.Contains(text(t, correction), "BLUEBERRY") {
		t.Errorf("the prompt keeps the attached file's body: %q", text(t, correction))
	}
	file := item(t, line(t, lines, 20), "file:"+fixturePath("notes.txt"))
	if file.Channel != "file_content" || file.DisplayPath != fixturePath("notes.txt") || text(t, file) != "notes for attach: the secret word is BLUEBERRY\n" {
		t.Errorf("attached file %+v", file)
	}

	image := item(t, line(t, lines, 26), "image:1")
	data, _ := base64.StdEncoding.DecodeString(message(t, line(t, lines, 26).raw)["content"].([]any)[1].(map[string]any)["data"].(string))
	if image.Channel != "attachment" || image.MediaType != "image/png" || !bytes.Equal(image.Data, data) || len(data) == 0 {
		t.Errorf("image %+v", image)
	}
	if prompt := item(t, line(t, lines, 26), "text:0"); text(t, prompt) != "What color is this image? One word." {
		t.Errorf("image prompt %q", text(t, prompt))
	}
	// The image's empty <file> span names it; it is no file item.
	var parts []string
	for _, content := range line(t, lines, 26).record.Items {
		parts = append(parts, content.Part)
	}
	if strings.Join(parts, ",") != "text:0,image:1,native" {
		t.Errorf("image prompt items %v", parts)
	}
}

// A malformed line leaves the parser's state as it was: the edit after it
// still knows its session's directory and the path its call named.
func TestStateSurvivesAMalformedLine(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(contracttest.SourceDir(t, "pi"), filepath.FromSlash(mainFile)))
	if err != nil {
		t.Fatal(err)
	}
	all := bytes.Split(bytes.TrimSuffix(contracttest.HostFixture(data, fixtureRoot), []byte("\n")), []byte("\n"))
	for name, malformed := range map[string][]byte{"garbage": []byte("\x00not json"), "partial": all[9][:len(all[9])/2]} {
		parser := contentSource(t).ContentParser()
		var state json.RawMessage
		for index := 0; index < 10; index++ {
			if index == 9 {
				before := append(json.RawMessage(nil), state...)
				_, next, err := parser.Parse(agent.ContentLine{Bytes: malformed, Harness: ID, NativeSessionID: mainSession}, state)
				if err == nil || !bytes.Equal(next, before) {
					t.Fatalf("%s: error %v, state %s became %s", name, err, before, next)
				}
				state = next
			}
			record, next, err := parser.Parse(agent.ContentLine{Bytes: all[index], Harness: ID, NativeSessionID: mainSession}, state)
			if err != nil {
				t.Fatal(err)
			}
			state = next
			if index == 9 {
				item(t, parsedLine{number: 10, record: record}, "diff:"+fixturePath("calc.py"))
			}
		}
	}
}

// Synthetic: an assistant text over 64 KiB, multi-byte, is kept whole.
func TestLongMultibyteReplyIsKeptWhole(t *testing.T) {
	long := strings.Repeat("Zoë→日本語🙂 ", 5000)
	raw, _ := json.Marshal(map[string]any{
		"type": "message", "id": "5a7e7e1c", "parentId": nil, "timestamp": "2026-10-09T02:21:50.355Z",
		"message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": long}}, "stopReason": "stop"},
	})
	reply := item(t, line(t, parseLines(t, append(raw, '\n'), "s"), 1), "text:0")
	if len(long) <= 64<<10 || text(t, reply) != long || reply.SourceTruncated {
		t.Fatalf("a %d B reply kept as %d B, truncated %v", len(long), len(text(t, reply)), reply.SourceTruncated)
	}
}

// A fork copies its parent's entries with their ids: the copies' items are
// the parent's, by identity.
func TestForkCopiesKeepTheParentsNativeIDs(t *testing.T) {
	parent := parseSession(t, mainFile, mainSession)
	fork := parseSession(t, forkFile, forkSession)
	identities := func(parsed parsedLine) string {
		var ids []string
		for _, content := range parsed.record.Items {
			ids = append(ids, content.NativeRef+"/"+content.Part)
		}
		return strings.Join(ids, ",")
	}
	declaring := 0
	for number := 2; number <= 27; number++ {
		copied, original := identities(line(t, fork, number)), identities(line(t, parent, number))
		if copied != original {
			t.Errorf("fork line %d is %q, its parent's %q", number, copied, original)
		}
		if copied != "" {
			declaring++
		}
	}
	if declaring < 20 {
		t.Fatalf("only %d copied lines declare items", declaring)
	}
}

func TestRepeatedIdenticalPromptsAreTwoItems(t *testing.T) {
	lines := parseSession(t, mainFile, mainSession)
	first, second := item(t, line(t, lines, 28), "text:0"), item(t, line(t, lines, 30), "text:0")
	if text(t, first) != "ok" || text(t, second) != "ok" || first.NativeRef == second.NativeRef {
		t.Fatalf("prompts %+v %+v", first, second)
	}
}

func TestUserShellCommandAbortAndCompaction(t *testing.T) {
	lines := parseSession(t, mainFile, mainSession)

	command := item(t, line(t, lines, 36), "command")
	output := item(t, line(t, lines, 36), "output")
	if command.Role != "user" || command.Channel != "tool_input" || text(t, command) != "echo user-bash-out; echo to-stderr 1>&2; exit 3" {
		t.Errorf("user shell command %+v", command)
	}
	if output.Channel != "command_output" || text(t, output) != "user-bash-out\nto-stderr\n" {
		t.Errorf("user shell output %+v", output)
	}

	if aborted := item(t, line(t, lines, 41), "error"); text(t, aborted) != "Command aborted" {
		t.Errorf("aborted call %+v", aborted)
	}
	if failure := item(t, line(t, lines, 42), "error"); failure.Role != "assistant" || text(t, failure) != "This operation was aborted" {
		t.Errorf("aborted reply %+v", failure)
	}

	summary := item(t, line(t, lines, 43), "summary")
	if summary.Channel != "summary" || !summary.RestatesContext || !strings.HasPrefix(text(t, summary), "No prior history.") {
		t.Errorf("compaction %+v", summary)
	}
}

func TestProviderErrorsAreErrors(t *testing.T) {
	for _, file := range []string{
		"sessions/2026-10-09T02-21-01-238Z_01a11e76-bfb6-7b85-bfc3-5187c9312ffa.jsonl",
		"sessions/2026-10-09T02-21-14-185Z_01a11e76-f249-72d0-bdf8-46b61e857c42.jsonl",
		"sessions/2026-10-09T02-21-24-029Z_01a11e77-18bd-747e-83b9-2a3966a25607.jsonl",
	} {
		lines := parseSession(t, file, "s")
		failure := item(t, line(t, lines, 5), "error")
		if failure.Channel != "error" || text(t, failure) != message(t, line(t, lines, 5).raw)["errorMessage"] {
			t.Errorf("%s: %+v", file, failure)
		}
	}
}

// OpenAI call ids run to hundreds of characters; the server keys a call by
// the same digest the backend's native_call_key takes, so content and events
// still join on it.
func TestLongCallIDsTakeTheServersCallKey(t *testing.T) {
	long := "call_" + strings.Repeat("a", 60) + "|fc_" + strings.Repeat("Zm9vYmFy+/=", 40)
	sum := sha256.Sum256([]byte(long))
	want := "sha256:" + hex.EncodeToString(sum[:])
	call := `{"type":"message","id":"aa000001","parentId":null,"timestamp":"2026-10-09T02:21:38.833Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"` + long + `","name":"bash","arguments":{"command":"ls"}}]}}`
	result := `{"type":"message","id":"aa000002","parentId":"aa000001","timestamp":"2026-10-09T02:21:39.071Z","message":{"role":"toolResult","toolCallId":"` + long + `","toolName":"bash","content":[{"type":"text","text":"x"}],"isError":false}}`
	lines := parseLines(t, []byte(call+"\n"+result+"\n"), "s")
	for _, content := range append(line(t, lines, 1).record.Items, line(t, lines, 2).record.Items...) {
		if content.Part == "native" {
			continue
		}
		if content.CallID != want || !uplink.NativeIDPattern.MatchString(content.CallID) {
			t.Errorf("%s call id %q, want %q", content.Part, content.CallID, want)
		}
	}
	if native := item(t, line(t, lines, 1), "native"); !strings.Contains(text(t, native), long) {
		t.Error("the native record lost the call's own id")
	}
}

// A call's input is keyed by the call's own id (amendment 32): one entry can
// hold several calls, and the input part is not indexed. Results and texts
// keep their entry id.
func TestToolCallInputsAreKeyedByTheirCallID(t *testing.T) {
	calls := `{"type":"message","id":"bb000001","parentId":null,"timestamp":"2026-10-09T02:21:38.833Z","message":{"role":"assistant","content":[` +
		`{"type":"text","text":"Running both."},` +
		`{"type":"toolCall","id":"call_a|fc_a","name":"bash","arguments":{"command":"ls"}},` +
		`{"type":"toolCall","id":"call_b|fc_b","name":"read","arguments":{"path":"x"}}]}}`
	result := `{"type":"message","id":"bb000002","parentId":"bb000001","timestamp":"2026-10-09T02:21:39.071Z","message":{"role":"toolResult","toolCallId":"call_b|fc_b","toolName":"read","content":[{"type":"text","text":"x"}],"isError":false}}`
	lines := parseLines(t, []byte(calls+"\n"+result+"\n"), "s")
	inputs := map[string]agent.ContentItem{}
	for _, content := range line(t, lines, 1).record.Items {
		switch content.Part {
		case "input":
			inputs[content.CallID] = content
		case "text:0":
			if content.NativeRef != "bb000001" {
				t.Errorf("reply keyed by %q", content.NativeRef)
			}
		}
	}
	first, second := inputs["call_a|fc_a"], inputs["call_b|fc_b"]
	if first.NativeRef != "call_a|fc_a" || second.NativeRef != "call_b|fc_b" {
		t.Fatalf("inputs %+v", inputs)
	}
	if agent.ContentKey(ID, "s", first.NativeRef, first.Part) == agent.ContentKey(ID, "s", second.NativeRef, second.Part) {
		t.Fatal("two calls of one entry share a key")
	}
	if output := item(t, line(t, lines, 2), "output"); output.NativeRef != "bb000002" || output.CallID != "call_b|fc_b" {
		t.Errorf("result %+v", output)
	}
	long := "call_" + strings.Repeat("a", 60) + "|fc_" + strings.Repeat("b", 200)
	longCall := `{"type":"message","id":"bb000003","parentId":null,"timestamp":"2026-10-09T02:21:38.833Z","message":{"role":"assistant","content":[{"type":"toolCall","id":"` + long + `","name":"bash","arguments":{}}]}}`
	if input := item(t, line(t, parseLines(t, []byte(longCall+"\n"), "s"), 1), "input"); input.NativeRef != agent.NativeCallID(long) || input.NativeRef != input.CallID {
		t.Errorf("a long call's input keyed by %q", input.NativeRef)
	}
}

// Pi keeps the last 51,200 B of a long bash output and writes the whole of
// it to a temp log the record names.
func TestTruncatedBashOutputNamesItsFullLog(t *testing.T) {
	lines := parseSession(t, mainFile, mainSession)
	output := item(t, line(t, lines, 16), "output")
	store := output.Store
	// The log must lie in this machine's temp dir, whatever the record says.
	if store == nil || store.Kind != "harness_temp_log" || store.Path != fixtureTemp+"/pi-bash-1a320089ae97d8ce.log" || store.Within != os.TempDir() {
		t.Fatalf("store %+v", store)
	}
	if !output.SourceTruncated || output.OriginalBytes != 126001 {
		t.Errorf("record copy: truncated %v from %d", output.SourceTruncated, output.OriginalBytes)
	}
	full := contracttest.Recipes(t, "pi")[0].Body
	if store.Matches == nil || !store.Matches(full) {
		t.Fatal("the full log does not match the kept tail")
	}
	if store.Matches(append(append([]byte(nil), full...), "more\n"...)) {
		t.Fatal("a log with another tail matches")
	}
}

func TestDeclaredBashOutputCoverage(t *testing.T) {
	temp, outside := t.TempDir(), t.TempDir()
	contracttest.SetTempDir(t, temp)
	raw := contracttest.ReplacePath(line(t, parseSession(t, mainFile, mainSession), 16).raw, fixtureTemp, temp)
	declarer := richcapture.Declarer{
		Harness: ID, NativeSessionID: mainSession, Kind: "pi_session", Parser: "companion-pi-session/1",
		Place: privacy.Place{Roots: []string{contracttest.HostPath(fixtureRoot)}}, Limits: policy.DeviceRichLimits, ObservedAt: time.Now(),
	}
	declare := func() uplink.ContentDeclaration {
		record, _, err := contentSource(t).ContentParser().Parse(agent.ContentLine{Bytes: raw, Harness: ID, NativeSessionID: mainSession}, nil)
		if err != nil {
			t.Fatal(err)
		}
		for _, content := range record.Items {
			if content.Part == "output" {
				return declarer.Declare(record, content, 0).Declaration
			}
		}
		t.Fatal("no output item")
		return uplink.ContentDeclaration{}
	}
	missing := declare()
	if missing.Coverage != "truncated" || missing.CoverageReason == nil || *missing.CoverageReason != "source_limit" || missing.OriginalByteCount == nil || *missing.OriginalByteCount != 126001 {
		t.Fatalf("without the log: %s %v %v", missing.Coverage, missing.CoverageReason, missing.OriginalByteCount)
	}
	full := contracttest.Recipes(t, "pi")[0].Body
	if err := os.WriteFile(filepath.Join(temp, "pi-bash-1a320089ae97d8ce.log"), full, 0o600); err != nil {
		t.Fatal(err)
	}
	captured := declare()
	sum := sha256.Sum256(full)
	if captured.Coverage != "captured" || captured.Source.BodyFrom != "harness_temp_log" || *captured.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("with the log: %s from %q", captured.Coverage, captured.Source.BodyFrom)
	}

	// The same bytes outside the temp dir are not believed.
	elsewhere := filepath.Join(outside, "pi-bash-1a320089ae97d8ce.log")
	if err := os.WriteFile(elsewhere, full, 0o600); err != nil {
		t.Fatal(err)
	}
	raw = contracttest.ReplacePath(raw, filepath.Join(temp, "pi-bash-1a320089ae97d8ce.log"), elsewhere)
	if refused := declare(); refused.Coverage != "truncated" || refused.Source.BodyFrom != "" {
		t.Fatalf("a log outside the temp dir was read: %s from %q", refused.Coverage, refused.Source.BodyFrom)
	}
}

// The header, model and thinking-level entries declare nothing, so they
// have no native record either (amendment 28).
func TestEntriesWithoutContentYieldNothing(t *testing.T) {
	lines := parseSession(t, mainFile, mainSession)
	for _, number := range []int{1, 2, 3} {
		if items := line(t, lines, number).record.Items; len(items) != 0 {
			t.Errorf("line %d: %+v", number, items)
		}
	}
}

func TestNativeRecordsReferenceTheirItems(t *testing.T) {
	lines := parseSession(t, mainFile, mainSession)
	prompt := item(t, line(t, lines, 4), "text:0")
	var record map[string]any
	if err := json.Unmarshal([]byte(text(t, item(t, line(t, lines, 4), "native"))), &record); err != nil {
		t.Fatal(err)
	}
	block := record["message"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"]
	if !jsonEqual(block, map[string]any{"backplane_content_ref": agent.ContentKey(ID, mainSession, prompt.NativeRef, prompt.Part)}) || record["id"] != "a0864fb0" {
		t.Errorf("native record %v", record)
	}
	// The edit's patch is the diff item, named by its raw path for the
	// declarer to place; Pi's display rendering keeps only size and digest.
	var edit map[string]any
	if err := json.Unmarshal([]byte(text(t, item(t, line(t, lines, 10), "native"))), &edit); err != nil {
		t.Fatal(err)
	}
	details := edit["message"].(map[string]any)["details"].(map[string]any)
	if !jsonEqual(details["patch"], map[string]any{"backplane_content_ref": map[string]any{"part": "diff:" + fixturePath("calc.py")}}) {
		t.Errorf("patch kept as %v", details["patch"])
	}
	if display, _ := details["diff"].(map[string]any); display["sha256"] == nil || display["bytes"] == nil {
		t.Errorf("display diff kept as %v", details["diff"])
	}
	// A text holding a file span and the user's own words is both items,
	// in source order (amendment 27).
	correction := item(t, line(t, lines, 20), "text:0")
	var attached map[string]any
	if err := json.Unmarshal([]byte(text(t, item(t, line(t, lines, 20), "native"))), &attached); err != nil {
		t.Fatal(err)
	}
	split := attached["message"].(map[string]any)["content"].([]any)[0].(map[string]any)["text"]
	want := []any{
		map[string]any{"backplane_content_ref": map[string]any{"part": "file:" + fixturePath("notes.txt")}},
		map[string]any{"backplane_content_ref": agent.ContentKey(ID, mainSession, correction.NativeRef, correction.Part)},
	}
	if !jsonEqual(split, want) {
		t.Errorf("split prompt kept as %v", split)
	}

	// The kept tail is an alias of the declared output.
	output := item(t, line(t, lines, 16), "output")
	native := text(t, item(t, line(t, lines, 16), "native"))
	tail := message(t, line(t, lines, 16).raw)["details"].(map[string]any)["truncation"].(map[string]any)["content"].(string)
	if !strings.Contains(native, `"alias_of":"`+agent.ContentKey(ID, mainSession, output.NativeRef, output.Part)+`"`) || strings.Contains(native, tail[len(tail)/2:len(tail)/2+64]) {
		t.Errorf("the kept tail is stored again in the native record (%d B)", len(native))
	}
}

func TestEveryIDFitsTheServersShape(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join(contracttest.SourceDir(t, "pi"), "sessions", "*.jsonl"))
	if len(files) == 0 {
		t.Fatal("no sessions")
	}
	for _, path := range files {
		data, _ := os.ReadFile(path)
		for _, parsed := range parseLines(t, data, "s") {
			for _, content := range parsed.record.Items {
				for name, id := range map[string]string{"native_ref": content.NativeRef, "call_id": content.CallID, "turn_id": content.TurnID} {
					if (id != "" || name == "native_ref") && !uplink.NativeIDPattern.MatchString(id) {
						t.Errorf("%s:%d %s %s %q", filepath.Base(path), parsed.number, content.Part, name, id)
					}
				}
			}
		}
	}
}

func TestManifestContentEvidenceYieldsItems(t *testing.T) {
	data, err := os.ReadFile(filepath.Join(contracttest.SourceDir(t, "pi"), "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		ExpectedCoverage map[string]struct {
			As       string   `json:"as"`
			Evidence []string `json:"evidence"`
		} `json:"expected_coverage"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	lines := parseSession(t, mainFile, mainSession)
	checked := 0
	for class, row := range manifest.ExpectedCoverage {
		if row.As != "content" || class == "native_records" {
			continue
		}
		for _, evidence := range row.Evidence {
			rest, found := strings.CutPrefix(evidence, mainFile+":")
			if !found {
				continue
			}
			number := 0
			for _, r := range rest {
				if r < '0' || r > '9' {
					break
				}
				number = number*10 + int(r-'0')
			}
			if !designatedSource(t, line(t, lines, number).raw) {
				continue
			}
			declared := 0
			for _, content := range line(t, lines, number).record.Items {
				if content.Channel != "native_record" {
					declared++
				}
			}
			if declared == 0 {
				t.Errorf("%s: %s yields no item", class, evidence)
			}
			checked++
		}
	}
	if checked < 10 {
		t.Fatalf("only %d evidence lines checked", checked)
	}
}

func jsonEqual(a, b any) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return bytes.Equal(left, right)
}

// designatedSource: the contract's §9 designated Pi sources.
func designatedSource(t *testing.T, raw []byte) bool {
	t.Helper()
	var entry struct {
		Type    string `json:"type"`
		Message struct {
			Role string `json:"role"`
		} `json:"message"`
	}
	if err := json.Unmarshal(raw, &entry); err != nil {
		t.Fatal(err)
	}
	switch entry.Type {
	case "compaction":
		return true
	case "message":
		switch entry.Message.Role {
		case "user", "assistant", "toolResult", "bashExecution":
			return true
		}
	}
	return false
}
