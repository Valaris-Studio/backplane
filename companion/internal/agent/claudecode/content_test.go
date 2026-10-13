// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package claudecode

import (
	"bufio"
	"bytes"
	"crypto/sha256"
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
	fixtureProjects    = "projects/-private-tmp-rc01-cc-work"
	mainSession        = "11111111-1111-4111-8111-000000000001"
	edgeSession        = "11111111-1111-4111-8111-000000000003"
	largeSession       = "11111111-1111-4111-8111-000000000004"
	subagentTranscript = mainSession + "/subagents/agent-a6f374664b0fc6919.jsonl"
	// The sanitized home the fixtures' own paths name.
	fixtureProjectsDir = "/home/fixture/.claude/projects/-private-tmp-rc01-cc-work"
	fixtureRoot        = "/private/tmp/rc01-cc/work"
)

func contentSource(t *testing.T) agent.ContentSource {
	t.Helper()
	source, ok := any(New()).(agent.ContentSource)
	if !ok {
		t.Fatal("Claude Code is not a rich capture content source")
	}
	return source
}

// parsedLine is one transcript line as the parser read it, numbered from 1
// like the manifest's evidence.
type parsedLine struct {
	number int
	raw    []byte
	record agent.ContentRecord
}

// parseTranscript reads a fixture transcript in order, threading the
// parser's state from line to line as the daemon does.
func parseTranscript(t *testing.T, relative string) []parsedLine {
	t.Helper()
	path := filepath.Join(contracttest.SourceDir(t, "claude-code"), filepath.FromSlash(relative))
	return parseFile(t, path, mainSession)
}

func parseFile(t *testing.T, path, session string) []parsedLine {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	parser := contentSource(t).ContentParser()
	var state json.RawMessage
	var lines []parsedLine
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(nil, 8<<20)
	offset := int64(0)
	for number := 1; scanner.Scan(); number++ {
		raw := append([]byte(nil), scanner.Bytes()...)
		record, next, err := parser.Parse(agent.ContentLine{Bytes: raw, Offset: offset, Path: path, Harness: ID, NativeSessionID: session}, state)
		if err != nil {
			t.Fatalf("%s:%d: %v", filepath.Base(path), number, err)
		}
		state = next
		lines = append(lines, parsedLine{number: number, raw: raw, record: record})
		offset += int64(len(raw)) + 1
	}
	return lines
}

func nth(t *testing.T, lines []parsedLine, number int) parsedLine {
	t.Helper()
	if number < 1 || number > len(lines) {
		t.Fatalf("no line %d", number)
	}
	return lines[number-1]
}

// item is the line's item of a part; it fails when there is none.
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

// field reads a string member of a raw line by a dotted path.
func field(t *testing.T, raw []byte, path ...string) any {
	t.Helper()
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	for _, key := range path {
		switch typed := value.(type) {
		case map[string]any:
			value = typed[key]
		case []any:
			index := 0
			for _, r := range key {
				index = index*10 + int(r-'0')
			}
			value = typed[index]
		default:
			t.Fatalf("no %v in line", path)
		}
	}
	return value
}

func TestClaudeTranscriptParserLabels(t *testing.T) {
	parser := contentSource(t).ContentParser()
	if parser.Kind() != "claude_transcript" || parser.Version() != "companion-claude-transcript/1" {
		t.Fatalf("parser %q %q", parser.Kind(), parser.Version())
	}
}

func TestContentFileNamesTheTranscriptEveryHookCarries(t *testing.T) {
	source := contentSource(t)
	transcript := filepath.Join(contracttest.HostPath(fixtureProjectsDir), mainSession+".jsonl")
	payload := map[string]any{"session_id": mainSession, "transcript_path": transcript, "hook_event_name": "UserPromptSubmit"}
	if path, ok := source.ContentFile("UserPromptSubmit", payload); !ok || path != transcript {
		t.Fatalf("named %q %v, want the transcript", path, ok)
	}
	for name, refused := range map[string]map[string]any{
		"another session's file": {"session_id": mainSession, "transcript_path": filepath.Join(contracttest.HostPath(fixtureProjectsDir), edgeSession+".jsonl")},
		"relative path":          {"session_id": mainSession, "transcript_path": mainSession + ".jsonl"},
		"not a transcript":       {"session_id": mainSession, "transcript_path": filepath.Join(contracttest.HostPath(fixtureProjectsDir), mainSession+".txt")},
		"no path":                {"session_id": mainSession},
	} {
		if path, ok := source.ContentFile("Stop", refused); ok {
			t.Errorf("%s: named %q", name, path)
		}
	}
}

// A subagent writes its own transcript beside the session's; the hooks that
// fire inside it, and the Agent call's completion, name that file.
func TestContentFileNamesTheSubagentTranscript(t *testing.T) {
	source := contentSource(t)
	transcript := filepath.Join(contracttest.HostPath(fixtureProjectsDir), mainSession+".jsonl")
	child := filepath.Join(contracttest.HostPath(fixtureProjectsDir), filepath.FromSlash(subagentTranscript))
	inside := map[string]any{"session_id": mainSession, "transcript_path": transcript, "agent_id": "a6f374664b0fc6919", "tool_name": "Bash", "tool_use_id": "toolu_x"}
	if path, ok := source.ContentFile("PreToolUse", inside); !ok || path != child {
		t.Fatalf("a hook inside the subagent named %q %v, want %q", path, ok, child)
	}
	completed := map[string]any{"session_id": mainSession, "transcript_path": transcript, "tool_name": "Agent", "tool_use_id": "toolu_Lo8AU6XiTidkfVKmAEpvaOrK", "tool_response": map[string]any{"agentId": "a6f374664b0fc6919", "status": "completed"}}
	if path, ok := source.ContentFile("PostToolUse", completed); !ok || path != child {
		t.Fatalf("the Agent call's completion named %q %v, want %q", path, ok, child)
	}
	// ':' would name an NTFS alternate data stream on Windows.
	for _, unsafe := range []string{"../../x", "a6f3:stream"} {
		escaping := map[string]any{"session_id": mainSession, "transcript_path": transcript, "agent_id": unsafe}
		if path, ok := source.ContentFile("PreToolUse", escaping); ok && path != transcript {
			t.Fatalf("agent id %q named %q", unsafe, path)
		}
	}
}

// Every hook fixture of a session names that session's transcript or one of
// its subagents' files, never anything else.
func TestContentFileOverTheHookFixtures(t *testing.T) {
	source := contentSource(t)
	data, err := os.ReadFile(filepath.Join(contracttest.SourceDir(t, "claude-code"), "hooks", "hooks.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	named := 0
	for number, raw := range bytes.Split(bytes.TrimSpace(data), []byte("\n")) {
		// Unparsed events name nothing; among them InstructionsLoaded, which
		// on resume carries a throwaway session id that must never become a
		// session or a file.
		observation, payload, err := New().ParseHook(contracttest.HostFixture(raw, fixtureProjectsDir))
		if err != nil {
			continue
		}
		path, ok := source.ContentFile(observation.Event, payload)
		if !ok {
			t.Errorf("hooks.jsonl:%d (%s) names no session file", number+1, observation.Event)
			continue
		}
		named++
		dir := filepath.Dir(payload["transcript_path"].(string))
		session := filepath.Join(dir, observation.NativeSessionID)
		if path != filepath.Join(dir, observation.NativeSessionID+".jsonl") && !strings.HasPrefix(path, session+string(filepath.Separator)+"subagents"+string(filepath.Separator)+"agent-") {
			t.Errorf("hooks.jsonl:%d named %q", number+1, path)
		}
	}
	if named == 0 {
		t.Fatal("no hook fixture parsed")
	}
}

func TestHeaderOnlyForASubagentsOwnStart(t *testing.T) {
	parser := contentSource(t).ContentParser()
	dir := contracttest.SourceDir(t, "claude-code")
	first := func(relative string) []byte {
		data, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(relative)))
		if err != nil {
			t.Fatal(err)
		}
		return data[:bytes.IndexByte(data, '\n')]
	}
	// A main transcript's first record may be a fork's copy of another
	// session's: its first hook bounds it, never a record.
	for _, relative := range []string{fixtureProjects + "/" + mainSession + ".jsonl", fixtureProjects + "/22c4542f-0080-4fa1-b64f-6f111f506ef8.jsonl"} {
		if header, ok := parser.Header(first(relative)); ok {
			t.Errorf("%s: header %+v", relative, header)
		}
	}
	header, ok := parser.Header(first(fixtureProjects + "/" + subagentTranscript))
	if !ok || !header.Began.Equal(time.Date(2026, 10, 9, 2, 17, 18, 345e6, time.UTC)) || header.ParentSessionID != "" {
		t.Fatalf("subagent header %+v %v", header, ok)
	}
}

func TestParsesTheJourneyOfOneSession(t *testing.T) {
	lines := parseTranscript(t, fixtureProjects+"/"+mainSession+".jsonl")

	prompt := item(t, nth(t, lines, 4), "text:0")
	if prompt.Role != "user" || prompt.Channel != "prompt" || prompt.NativeRef != "ea4eb6b1-9bd1-41e3-9ce4-e1bf79ad2019" || prompt.TurnID != "48d2127b-b96c-4ab1-b0b8-4280e58ee4b6" {
		t.Errorf("prompt %+v", prompt)
	}
	if text(t, prompt) != field(t, nth(t, lines, 4).raw, "message", "content") {
		t.Error("the prompt is not the text the user sent")
	}
	if at := nth(t, lines, 4).record.At; !at.Equal(time.Date(2026, 10, 9, 2, 15, 37, 247e6, time.UTC)) {
		t.Errorf("prompt at %v", at)
	}
	if schema := nth(t, lines, 4).record.SchemaVersion; schema != "claude-code/2.1.293" {
		t.Errorf("schema version %q", schema)
	}

	// The assistant's blocks carry no promptId: they belong to the turn of
	// the prompt before them.
	call := item(t, nth(t, lines, 34), "input")
	if call.Role != "assistant" || call.Channel != "tool_input" || call.CallID != "toolu_QXLeqmnmouXwgAmrOuBpPJ12" || call.TurnID != "48d2127b-b96c-4ab1-b0b8-4280e58ee4b6" || call.MediaType != "application/json" {
		t.Errorf("tool call %+v", call)
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(text(t, call)), &input); err != nil || input["command"] != "python3 -m pytest -q test_calc.py" {
		t.Errorf("tool input %v %v", input, err)
	}

	failed := item(t, nth(t, lines, 36), "error")
	if failed.Role != "tool" || failed.Channel != "error" || failed.CallID != call.CallID || !strings.HasPrefix(text(t, failed), "Exit code 1\n") {
		t.Errorf("failed tool result %+v", failed)
	}

	edit := item(t, nth(t, lines, 50), "diff:"+fixtureRoot+"/calc.py")
	if edit.Channel != "diff" || edit.CallID != "toolu_4V6gbjtMOpur7m0ukoIc3PfI" {
		t.Errorf("edit %+v", edit)
	}
	for _, want := range []string{"@@ -1,5 +1,5 @@", "\n-    return a - b\n", "\n+    return a + b\n"} {
		if !strings.Contains(text(t, edit), want) {
			t.Errorf("edit diff lacks %q: %q", want, text(t, edit))
		}
	}
	originalFile := field(t, nth(t, lines, 50).raw, "toolUseResult", "originalFile").(string)
	for _, content := range nth(t, lines, 50).record.Items {
		if content.Part != "native" && content.Text != nil && strings.Contains(*content.Text, originalFile) {
			t.Errorf("%s keeps the pre-image as content", content.Part)
		}
	}

	retried := item(t, nth(t, lines, 59), "output")
	if retried.Channel != "tool_output" || retried.CallID != "toolu_RDzj5T3uHCfF4ApprVtq2CCi" || !strings.HasSuffix(text(t, retried), "2 passed in 0.00s") {
		t.Errorf("success after the fix %+v", retried)
	}

	inline := item(t, nth(t, lines, 66), "output")
	if inline.Channel != "tool_output" || inline.SourceTruncated || inline.Store != nil || len(text(t, inline)) != 20000 {
		t.Errorf("a 20,000 B result kept whole: %d B, truncated %v", len(text(t, inline)), inline.SourceTruncated)
	}

	reply := item(t, nth(t, lines, 86), "text:0")
	if reply.Role != "assistant" || reply.Channel != "reply" || reply.MediaType != "text/markdown" || text(t, reply) != field(t, nth(t, lines, 86).raw, "message", "content", "0", "text") {
		t.Errorf("final answer %+v", reply)
	}

	correction := item(t, nth(t, lines, 94), "text:0")
	if correction.Channel != "prompt" || !strings.HasPrefix(text(t, correction), "Correction: ") || correction.TurnID != "6df8b363-80e5-4c2c-8c58-c67aabf8a272" {
		t.Errorf("correction %+v", correction)
	}
}

func TestRepeatedIdenticalPromptsAreTwoItems(t *testing.T) {
	lines := parseTranscript(t, fixtureProjects+"/"+mainSession+".jsonl")
	first, second := item(t, nth(t, lines, 155), "text:0"), item(t, nth(t, lines, 166), "text:0")
	if text(t, first) != "ok" || text(t, second) != "ok" {
		t.Fatalf("prompts %q %q", text(t, first), text(t, second))
	}
	if agent.ContentKey(ID, mainSession, first.NativeRef, first.Part) == agent.ContentKey(ID, mainSession, second.NativeRef, second.Part) {
		t.Fatal("two prompts with the same words share one identity")
	}
}

func TestReasoningWithoutTextIsEncryptedAtSource(t *testing.T) {
	lines := parseTranscript(t, fixtureProjects+"/"+mainSession+".jsonl")
	raw := item(t, nth(t, lines, 21), "raw")
	if raw.Channel != "reasoning" || raw.Coverage != "source_unavailable" || raw.CoverageReason != "encrypted_at_source" || raw.Text != nil {
		t.Fatalf("signature-only thinking %+v", raw)
	}
	for _, content := range nth(t, lines, 21).record.Items {
		if content.Part == "summary" {
			t.Fatal("an empty thinking text became a summary")
		}
	}
}

func TestAttachmentsInstructionsAndHarnessContext(t *testing.T) {
	lines := parseTranscript(t, fixtureProjects+"/"+mainSession+".jsonl")

	file := item(t, nth(t, lines, 95), "file:"+fixtureRoot+"/notes.txt")
	if file.Channel != "file_content" || file.DisplayPath != fixtureRoot+"/notes.txt" || text(t, file) != "notes for attach: the secret word is BLUEBERRY\n" || file.RestatesContext {
		t.Errorf("@file attachment %+v", file)
	}

	cached, err := os.ReadFile(filepath.Join(contracttest.SourceDir(t, "claude-code"), "image-cache", "-private-tmp-rc01-cc-work", mainSession, "images", "1.png"))
	if err != nil {
		t.Fatal(err)
	}
	pasted := item(t, nth(t, lines, 136), "image:1")
	if pasted.Role != "user" || pasted.Channel != "attachment" || pasted.MediaType != "image/png" || !bytes.Equal(pasted.Data, cached) {
		t.Errorf("pasted image %+v", pasted)
	}
	if item(t, nth(t, lines, 136), "text:0").Channel != "prompt" {
		t.Error("the image's prompt text is not a prompt")
	}
	read := item(t, nth(t, lines, 143), "image:0")
	if read.Role != "tool" || read.Channel != "attachment" || read.CallID != "toolu_CZY16HubBS7xw9EBRnnON8QK" || !bytes.Equal(read.Data, cached) {
		t.Errorf("image a tool read %+v", read)
	}
	// The temp image cache line names a path; it is never a body.
	if items := nth(t, lines, 139).record.Items; len(items) != 0 {
		t.Errorf("the image cache reference declared %d items", len(items))
	}

	instructions := item(t, nth(t, lines, 13), "instruction:0")
	if instructions.Channel != "instruction" || instructions.DisplayPath != fixtureRoot+"/CLAUDE.md" || !strings.Contains(text(t, instructions), "RC01-CLAUDE-MD-MARKER") {
		t.Errorf("instructions %+v", instructions)
	}

	for number, kind := range map[int]string{18: "prompt_snapshot", 9: "skill_listing", 16: "credential_org", 5: "environment", 31: "deferred_tools_record"} {
		context := item(t, nth(t, lines, number), "context:"+kind)
		// Kind, size and digest are kept (§6); the size is the attachment's.
		if context.Channel != "instruction" || context.Coverage != "withheld_by_policy" || context.CoverageReason != "harness_context" || context.Text != nil || context.Data != nil || context.OriginalBytes <= 0 {
			t.Errorf("line %d %s %+v", number, kind, context)
		}
	}
}

func TestCompactionSummaryAndReattachedFilesRestateContext(t *testing.T) {
	lines := parseTranscript(t, fixtureProjects+"/"+mainSession+".jsonl")
	summary := item(t, nth(t, lines, 199), "summary")
	if summary.Channel != "summary" || !summary.RestatesContext || !strings.HasPrefix(text(t, summary), "This session is being continued") {
		t.Errorf("compaction summary %+v", summary)
	}
	for number, name := range map[int]string{203: "test_calc.py", 204: "calc.py", 205: "notes.txt"} {
		reattached := item(t, nth(t, lines, number), "file:"+fixtureRoot+"/"+name)
		if !reattached.RestatesContext {
			t.Errorf("line %d: a file re-attached after compaction is new content", number)
		}
	}
	// After the next prompt, an attached file is the user's again.
	for _, parsed := range lines[205:] {
		for _, content := range parsed.record.Items {
			if content.Channel == "file_content" && content.RestatesContext {
				t.Errorf("line %d still restates context", parsed.number)
			}
		}
	}
}

// Copies of what the transcript already holds as an item, harness markers
// and lifecycle lines are never content, and a line that declares nothing
// has no native record either (amendment 28). Interruptions remain events.
func TestCopiesMarkersAndLifecycleYieldNothing(t *testing.T) {
	cases := map[string][]int{
		mainSession: {1, 2, 3, 6, 12, 19, 88, 90, 130, 198, 200, 201, 202},
		edgeSession: {39, 40},
	}
	for session, numbers := range cases {
		lines := parseTranscript(t, fixtureProjects+"/"+session+".jsonl")
		for _, number := range numbers {
			parsed := nth(t, lines, number)
			if len(parsed.record.Items) != 0 {
				var parts []string
				for _, content := range parsed.record.Items {
					parts = append(parts, content.Part+"/"+content.Channel)
				}
				t.Errorf("%s:%d (%v) declared %v", session[len(session)-4:], number, field(t, parsed.raw, "type"), parts)
			}
		}
	}
}

// A line nothing can parse leaves the parser's state as it was: the daemon
// keeps the state a failed parse returns, so the turn after it still knows
// its prompt.
func TestStateSurvivesAMalformedLine(t *testing.T) {
	path := filepath.Join(contracttest.SourceDir(t, "claude-code"), filepath.FromSlash(fixtureProjects), mainSession+".jsonl")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	all := bytes.Split(bytes.TrimSuffix(data, []byte("\n")), []byte("\n"))
	for name, malformed := range map[string][]byte{"garbage": []byte("\x00not json"), "partial": all[33][:len(all[33])/2]} {
		parser := contentSource(t).ContentParser()
		var state json.RawMessage
		for index := 0; index < 34; index++ {
			if index == 4 {
				before := append(json.RawMessage(nil), state...)
				_, next, err := parser.Parse(agent.ContentLine{Bytes: malformed, Path: path, Harness: ID, NativeSessionID: mainSession}, state)
				if err == nil {
					t.Fatalf("%s: a malformed line parsed", name)
				}
				if !bytes.Equal(next, before) {
					t.Fatalf("%s: state %s became %s", name, before, next)
				}
				state = next
			}
			record, next, err := parser.Parse(agent.ContentLine{Bytes: all[index], Path: path, Harness: ID, NativeSessionID: mainSession}, state)
			if err != nil {
				t.Fatal(err)
			}
			state = next
			if index == 33 {
				if got := item(t, parsedLine{number: 34, raw: all[index], record: record}, "input").TurnID; got != "48d2127b-b96c-4ab1-b0b8-4280e58ee4b6" {
					t.Errorf("%s: the call after it is in turn %q", name, got)
				}
			}
		}
	}
}

// Read from mid-way with no state (a session resumed after admission), an
// assistant block's turn is unknown, never guessed from its parent uuid.
func TestUnknownTurnIsEmpty(t *testing.T) {
	path := filepath.Join(contracttest.SourceDir(t, "claude-code"), filepath.FromSlash(fixtureProjects), mainSession+".jsonl")
	record := parseOne(t, lineBytes(t, fixtureProjects+"/"+mainSession+".jsonl", 34), path, mainSession)
	if call := item(t, parsedLine{number: 34, record: record}, "input"); call.TurnID != "" || call.CallID != "toolu_QXLeqmnmouXwgAmrOuBpPJ12" {
		t.Fatalf("call read without state %+v", call)
	}
}

// Synthetic: an assistant text over 64 KiB, multi-byte, is kept whole.
func TestLongMultibyteReplyIsKeptWhole(t *testing.T) {
	long := strings.Repeat("Zoë→日本語🙂 ", 5000)
	raw, _ := json.Marshal(map[string]any{
		"parentUuid": nil, "type": "assistant", "uuid": "5a7e7e1c-0000-4000-8000-000000000001", "timestamp": "2026-10-09T02:15:50.167Z", "version": "2.1.293",
		"message": map[string]any{"id": "msg_synthetic", "role": "assistant", "type": "message", "content": []any{map[string]any{"type": "text", "text": long}}},
	})
	reply := item(t, parsedLine{record: parseOne(t, raw, filepath.Join(fixtureProjectsDir, mainSession+".jsonl"), mainSession)}, "text:0")
	if len(long) <= 64<<10 || text(t, reply) != long || reply.SourceTruncated {
		t.Fatalf("a %d B reply kept as %d B, truncated %v", len(long), len(text(t, reply)), reply.SourceTruncated)
	}
}

// A fork copies its parent's records with their own ids: the copies' items
// are the parent's, by identity.
func TestForkCopiesKeepTheParentsNativeIDs(t *testing.T) {
	parent := parseTranscript(t, fixtureProjects+"/"+mainSession+".jsonl")
	fork := parseTranscript(t, fixtureProjects+"/22c4542f-0080-4fa1-b64f-6f111f506ef8.jsonl")
	copied, original := item(t, nth(t, fork, 6), "summary"), item(t, nth(t, parent, 199), "summary")
	if copied.NativeRef != original.NativeRef || copied.NativeRef != "f69e5b06-d884-4e39-a614-74072ecce576" {
		t.Fatalf("fork copy %q, parent %q", copied.NativeRef, original.NativeRef)
	}
}

func TestHarnessBlockedCallIsAnError(t *testing.T) {
	lines := parseTranscript(t, fixtureProjects+"/"+edgeSession+".jsonl")
	blocked := item(t, nth(t, lines, 22), "error")
	if blocked.Channel != "error" || blocked.CallID != "toolu_ATNHmNhJGJ7aHjzSOsCzi6A0" {
		t.Fatalf("harness block %+v", blocked)
	}
}

func TestSubagentItemsLandInTheParentSession(t *testing.T) {
	lines := parseTranscript(t, fixtureProjects+"/"+subagentTranscript)
	prompt := item(t, nth(t, lines, 1), "text:0")
	if prompt.Channel != "prompt" || prompt.NativeRef != "c1f7c0b3-3a9b-42a3-a855-53ab49e2c63c" || prompt.TurnID != "edef645e-44e3-43dd-b0e7-0da9c852fda9" {
		t.Errorf("subagent prompt %+v", prompt)
	}
	for _, parsed := range lines {
		for _, content := range parsed.record.Items {
			if content.Channel != "native_record" && content.ParentCallID != "toolu_Lo8AU6XiTidkfVKmAEpvaOrK" {
				t.Errorf("line %d %s: parent call %q, want the Agent call", parsed.number, content.Part, content.ParentCallID)
			}
			// The sidecar gives the relation only, never content.
			if content.Text != nil && strings.Contains(*content.Text, "requestShape") {
				t.Errorf("line %d %s declares the sidecar", parsed.number, content.Part)
			}
		}
	}
}

// Without its sidecar a child's items keep their turn but name no parent
// call: the relation is omitted, never guessed.
func TestSubagentWithoutItsSidecarNamesNoParentCall(t *testing.T) {
	source, err := os.ReadFile(filepath.Join(contracttest.SourceDir(t, "claude-code"), filepath.FromSlash(fixtureProjects+"/"+subagentTranscript)))
	if err != nil {
		t.Fatal(err)
	}
	child := filepath.Join(t.TempDir(), "-private-tmp-rc01-cc-work", mainSession, "subagents", "agent-a6f374664b0fc6919.jsonl")
	if err := os.MkdirAll(filepath.Dir(child), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(child, source, 0o600); err != nil {
		t.Fatal(err)
	}
	lines := parseFile(t, child, mainSession)
	if item(t, nth(t, lines, 1), "text:0").TurnID != "edef645e-44e3-43dd-b0e7-0da9c852fda9" {
		t.Error("the child's prompt lost its turn")
	}
	for _, parsed := range lines {
		for _, content := range parsed.record.Items {
			if content.ParentCallID != "" {
				t.Errorf("line %d %s: guessed parent call %q", parsed.number, content.Part, content.ParentCallID)
			}
		}
	}
}

// A sidecar that is no JSON, or names a call id the server would refuse,
// gives no relation.
func TestUnusableSidecarNamesNoParentCall(t *testing.T) {
	source, err := os.ReadFile(filepath.Join(contracttest.SourceDir(t, "claude-code"), filepath.FromSlash(fixtureProjects+"/"+subagentTranscript)))
	if err != nil {
		t.Fatal(err)
	}
	for name, meta := range map[string]string{
		"malformed":       `{"toolUseId":`,
		"not a native id": `{"agentType":"general-purpose","toolUseId":"../toolu x"}`,
	} {
		child := filepath.Join(t.TempDir(), "-private-tmp-rc01-cc-work", mainSession, "subagents", "agent-a6f374664b0fc6919.jsonl")
		os.MkdirAll(filepath.Dir(child), 0o700)
		os.WriteFile(child, source, 0o600)
		os.WriteFile(strings.TrimSuffix(child, ".jsonl")+".meta.json", []byte(meta), 0o600)
		for _, parsed := range parseFile(t, child, mainSession) {
			for _, content := range parsed.record.Items {
				if content.ParentCallID != "" {
					t.Errorf("%s sidecar: line %d parent call %q", name, parsed.number, content.ParentCallID)
				}
			}
		}
	}
}

// Every id the parser hands on is one the server keeps.
func TestEveryIDFitsTheServersShape(t *testing.T) {
	dir := filepath.Join(contracttest.SourceDir(t, "claude-code"), filepath.FromSlash(fixtureProjects))
	files, _ := filepath.Glob(filepath.Join(dir, "*.jsonl"))
	files = append(files, filepath.Join(dir, filepath.FromSlash(subagentTranscript)))
	for _, path := range files {
		for _, parsed := range parseFile(t, path, mainSession) {
			for _, content := range parsed.record.Items {
				for name, id := range map[string]string{"native_ref": content.NativeRef, "call_id": content.CallID, "parent_call_id": content.ParentCallID, "turn_id": content.TurnID} {
					if (id != "" || name == "native_ref") && !uplink.NativeIDPattern.MatchString(id) {
						t.Errorf("%s:%d %s %s %q", filepath.Base(path), parsed.number, content.Part, name, id)
					}
				}
			}
		}
	}
}

// fixtureParity: every transcript line the manifest cites as evidence of a
// content class yields an item; the source matrix is what the parser reads.
func TestManifestContentEvidenceYieldsItems(t *testing.T) {
	dir := contracttest.SourceDir(t, "claude-code")
	data, err := os.ReadFile(filepath.Join(dir, "manifest.json"))
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
	parsed := map[string][]parsedLine{}
	checked := 0
	for class, row := range manifest.ExpectedCoverage {
		if row.As != "content" || class == "native_records" {
			continue
		}
		for _, evidence := range row.Evidence {
			file, rest, found := strings.Cut(evidence, ".jsonl:")
			if !found || !strings.HasPrefix(file, "projects/") {
				continue
			}
			relative := file + ".jsonl"
			if parsed[relative] == nil {
				parsed[relative] = parseTranscript(t, relative)
			}
			for _, number := range evidenceLines(rest) {
				evidenced := nth(t, parsed[relative], number)
				if !designatedSource(t, evidenced.raw) {
					continue
				}
				declared := 0
				for _, content := range evidenced.record.Items {
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
	}
	if checked < 10 {
		t.Fatalf("only %d evidence lines checked", checked)
	}
}

// evidenceLines reads "74", "203-205" or "66 toolUseResult..." as numbers.
func evidenceLines(reference string) []int {
	var bounds []int
	number, digits := 0, false
	for _, r := range reference + " " {
		switch {
		case r >= '0' && r <= '9':
			number, digits = number*10+int(r-'0'), true
		case r == '-' && digits && len(bounds) == 0:
			bounds, number, digits = append(bounds, number), 0, false
		default:
			if digits {
				bounds = append(bounds, number)
			}
			if len(bounds) == 1 {
				return bounds
			}
			var lines []int
			for line := bounds[0]; line <= bounds[1]; line++ {
				lines = append(lines, line)
			}
			return lines
		}
	}
	return nil
}

// designatedSource: the contract's §9 designated Claude sources. Evidence
// that is a reference, a lifecycle line, a marker or a copy is not one.
func designatedSource(t *testing.T, raw []byte) bool {
	t.Helper()
	var record struct {
		Type       string `json:"type"`
		IsMeta     bool   `json:"isMeta"`
		Attachment struct {
			Type string `json:"type"`
		} `json:"attachment"`
		Message struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if err := json.Unmarshal(raw, &record); err != nil {
		t.Fatal(err)
	}
	switch record.Type {
	case "assistant":
		return true
	case "user":
		// A prompt is a string or a list of blocks; markers take either form.
		var prompt string
		if json.Unmarshal(record.Message.Content, &prompt) != nil {
			var blocks []struct {
				Type string `json:"type"`
				Text string `json:"text"`
			}
			json.Unmarshal(record.Message.Content, &blocks)
			for _, block := range blocks {
				if block.Type == "text" {
					prompt = block.Text
					break
				}
			}
		}
		for _, marker := range []string{"<command-", "<local-command", "[Request interrupted by user"} {
			if strings.HasPrefix(prompt, marker) {
				return false
			}
		}
		return !record.IsMeta
	case "attachment":
		switch record.Attachment.Type {
		case "file", "instructions", "prompt_snapshot", "skill_listing":
			return true
		}
	}
	return false
}

// The tool output Claude keeps only in its session store: the store holds
// the whole body; the record keeps a 2 KB preview and a 30,000 B cut copy.
func TestPersistedOutputIsReadFromTheSessionStore(t *testing.T) {
	lines := parseTranscript(t, fixtureProjects+"/"+mainSession+".jsonl")
	output := item(t, nth(t, lines, 74), "output")
	store := output.Store
	persisted := fixtureProjectsDir + "/" + mainSession + "/tool-results/btcg91vyr.txt"
	// The store lies beside the transcript the line was read from, whatever
	// path the record names.
	within := filepath.Join(contracttest.SourceDir(t, "claude-code"), filepath.FromSlash(fixtureProjects), mainSession, "tool-results")
	if store == nil || store.Kind != "harness_session_store" || store.Path != persisted || store.Within != within {
		t.Fatalf("store %+v, want within %s", store, within)
	}
	// Without a usable store the cut copy is what remains: truncated by the
	// agent, from the size it stated.
	if !output.SourceTruncated || output.OriginalBytes != 126001 || len(text(t, output)) != 30001 || output.CallID != "toolu_3GJyDJBzwrt4IBd8NaaGeMKs" {
		t.Errorf("record copy: truncated %v from %d, %d B", output.SourceTruncated, output.OriginalBytes, len(text(t, output)))
	}
	body := recipe(t, "btcg91vyr.txt")
	if store.Matches == nil || !store.Matches(body) {
		t.Fatal("the store's body does not match the record's preview")
	}
	if store.Matches(append([]byte("another head "), body...)) {
		t.Fatal("a body with another head matches the preview")
	}
}

// Through the real declarer: a valid store body is captured whole; without
// it the cut copy is declared truncated/source_limit.
func TestDeclaredPersistedOutputCoverage(t *testing.T) {
	root := t.TempDir()
	projects := filepath.Join(root, "projects", "-private-tmp-rc01-cc-work")
	raw := contracttest.ReplacePath(lineBytes(t, fixtureProjects+"/"+mainSession+".jsonl", 74), fixtureProjectsDir, projects)
	body := recipe(t, "btcg91vyr.txt")
	declarer := richcapture.Declarer{
		Harness: ID, NativeSessionID: mainSession, Kind: "claude_transcript", Parser: "companion-claude-transcript/1",
		Place: privacy.Place{Roots: []string{fixtureRoot}}, Limits: policy.DeviceRichLimits, ObservedAt: time.Now(),
	}
	transcript := filepath.Join(projects, mainSession+".jsonl")
	declare := func() uplink.ContentDeclaration {
		record := parseOne(t, raw, transcript, mainSession)
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
		t.Fatalf("without the store: %s %v %v", missing.Coverage, missing.CoverageReason, missing.OriginalByteCount)
	}

	store := filepath.Join(projects, mainSession, "tool-results", "btcg91vyr.txt")
	if err := os.MkdirAll(filepath.Dir(store), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(store, body, 0o600); err != nil {
		t.Fatal(err)
	}
	captured := declare()
	sum := sha256.Sum256(body)
	if captured.Coverage != "captured" || captured.Source.BodyFrom != "harness_session_store" || captured.SHA256 == nil || *captured.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatalf("with the store: %s from %q", captured.Coverage, captured.Source.BodyFrom)
	}

	// A record naming a store under another session's directory is not
	// believed: the store must lie beside the transcript read.
	elsewhere := filepath.Join(root, "elsewhere", mainSession, "tool-results", "btcg91vyr.txt")
	if err := os.MkdirAll(filepath.Dir(elsewhere), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(elsewhere, body, 0o600); err != nil {
		t.Fatal(err)
	}
	raw = contracttest.ReplacePath(raw, store, elsewhere)
	if refused := declare(); refused.Coverage != "truncated" || refused.Source.BodyFrom != "" {
		t.Fatalf("a store the record names elsewhere was read: %s from %q", refused.Coverage, refused.Source.BodyFrom)
	}
}

func TestLargeSessionStoresMatchTheirRecipes(t *testing.T) {
	lines := parseTranscript(t, fixtureProjects+"/"+largeSession+".jsonl")
	for number, name := range map[int]string{24: "blckqbi6v.txt", 76: "b8cvlbc5o.txt"} {
		output := item(t, nth(t, lines, number), "output")
		if output.Store == nil || !strings.HasSuffix(output.Store.Path, largeSession+"/tool-results/"+name) || !output.Store.Matches(recipe(t, name)) {
			t.Errorf("line %d: store %+v", number, output.Store)
		}
	}
}

// Native records keep the line's structure for reparsing. Leaves declared as
// items become references, harness context and pre-images keep only their
// size and digest: no text is stored twice.
func TestNativeRecordsReferenceTheirItems(t *testing.T) {
	lines := parseTranscript(t, fixtureProjects+"/"+mainSession+".jsonl")
	native := func(number int) map[string]any {
		t.Helper()
		content := item(t, nth(t, lines, number), "native")
		if content.Channel != "native_record" || content.MediaType != "application/json" {
			t.Fatalf("line %d native %+v", number, content)
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(text(t, content)), &record); err != nil {
			t.Fatalf("line %d: %v", number, err)
		}
		return record
	}

	prompt := item(t, nth(t, lines, 4), "text:0")
	record := native(4)
	reference := record["message"].(map[string]any)["content"]
	want := map[string]any{"backplane_content_ref": agent.ContentKey(ID, mainSession, prompt.NativeRef, prompt.Part)}
	if !jsonEqual(reference, want) || record["uuid"] != prompt.NativeRef || record["promptId"] != prompt.TurnID {
		t.Errorf("prompt native record %v", record)
	}

	// A diff: or file: part's key hashes the placed path, which only the
	// declarer knows: the record names the part, the declarer resolves it.
	edit := native(50)["toolUseResult"].(map[string]any)
	if !jsonEqual(edit["structuredPatch"], map[string]any{"backplane_content_ref": map[string]any{"part": "diff:" + fixtureRoot + "/calc.py"}}) {
		t.Errorf("edit diff kept as %v", edit["structuredPatch"])
	}
	attached := native(95)["attachment"].(map[string]any)["content"].(map[string]any)["file"].(map[string]any)["content"]
	if !jsonEqual(attached, map[string]any{"backplane_content_ref": map[string]any{"part": "file:" + fixtureRoot + "/notes.txt"}}) {
		t.Errorf("attached file kept as %v", attached)
	}
	instruction := item(t, nth(t, lines, 13), "instruction:0")
	files := native(13)["attachment"].(map[string]any)["files"].([]any)
	if !jsonEqual(files[0].(map[string]any)["content"], map[string]any{"backplane_content_ref": agent.ContentKey(ID, mainSession, instruction.NativeRef, instruction.Part)}) {
		t.Errorf("instruction kept as %v", files[0])
	}

	// The result echoes the edit's input: aliases of the tool_use item.
	editInput := agent.ContentKey(ID, mainSession, field(t, nth(t, lines, 50).raw, "sourceToolAssistantUUID").(string), "input")
	for _, echo := range []string{"oldString", "newString"} {
		alias, _ := edit[echo].(map[string]any)
		if alias["alias_of"] != editInput || alias["sha256"] == nil {
			t.Errorf("%s kept as %v", echo, edit[echo])
		}
	}

	original := field(t, nth(t, lines, 50).raw, "toolUseResult", "originalFile").(string)
	sum := sha256.Sum256([]byte(original))
	digest := edit["originalFile"]
	if !jsonEqual(digest, map[string]any{"bytes": len(original), "sha256": hex.EncodeToString(sum[:])}) {
		t.Errorf("pre-image kept as %v", digest)
	}

	// The 30,000 B copy and the hook-visible preview alias the stored output.
	output := item(t, nth(t, lines, 74), "output")
	result := native(74)["toolUseResult"].(map[string]any)
	stdout, _ := result["stdout"].(map[string]any)
	if stdout["alias_of"] != agent.ContentKey(ID, mainSession, output.NativeRef, output.Part) || stdout["bytes"] == nil {
		t.Errorf("cut copy kept as %v", result["stdout"])
	}

	snapshot := native(18)
	if strings.Contains(text(t, item(t, nth(t, lines, 18), "native")), "fixture-filler") {
		t.Errorf("harness context kept verbatim in its native record: %v", snapshot)
	}

}

func jsonEqual(a, b any) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return bytes.Equal(left, right)
}

func lineBytes(t *testing.T, relative string, number int) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(contracttest.SourceDir(t, "claude-code"), filepath.FromSlash(relative)))
	if err != nil {
		t.Fatal(err)
	}
	lines := bytes.Split(data, []byte("\n"))
	return lines[number-1]
}

func parseOne(t *testing.T, raw []byte, path, session string) agent.ContentRecord {
	t.Helper()
	record, _, err := contentSource(t).ContentParser().Parse(agent.ContentLine{Bytes: raw, Path: path, Harness: ID, NativeSessionID: session}, nil)
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func recipe(t *testing.T, name string) []byte {
	t.Helper()
	for _, recipe := range contracttest.Recipes(t, "claude-code") {
		if filepath.Base(recipe.NativePath) == name {
			return recipe.Body
		}
	}
	t.Fatalf("no recipe %s", name)
	return nil
}

// A result of tool references only (ToolSearch) is output as its blocks.
func TestToolReferenceResultIsJSONOutput(t *testing.T) {
	lines := parseTranscript(t, fixtureProjects+"/"+mainSession+".jsonl")
	output := item(t, nth(t, lines, 24), "output")
	blocks, _ := json.Marshal(field(t, nth(t, lines, 24).raw, "message", "content", "0", "content"))
	if output.MediaType != "application/json" || output.CallID != "toolu_tnndixBpW4oMXL4WRDJyJBHc" || !jsonEqualText(t, text(t, output), string(blocks)) {
		t.Errorf("tool reference output %+v", output)
	}
}

func jsonEqualText(t *testing.T, a, b string) bool {
	t.Helper()
	var left, right any
	if json.Unmarshal([]byte(a), &left) != nil || json.Unmarshal([]byte(b), &right) != nil {
		return false
	}
	return jsonEqual(left, right)
}

// Synthetic: a persisted output with no cut copy beside it (a non-Bash tool)
// keeps the preview, never the wrapper around it.
func TestPersistedOutputWithoutACopyKeepsThePreview(t *testing.T) {
	raw := lineBytes(t, fixtureProjects+"/"+mainSession+".jsonl", 74)
	var record map[string]any
	json.Unmarshal(raw, &record)
	delete(record["toolUseResult"].(map[string]any), "stdout")
	raw, _ = json.Marshal(record)
	path := filepath.Join(fixtureProjectsDir, mainSession+".jsonl")
	output := item(t, parsedLine{number: 74, record: parseOne(t, raw, path, mainSession)}, "output")
	preview := text(t, output)
	if strings.Contains(preview, "persisted-output") || strings.Contains(preview, "Full output saved to") || !strings.HasPrefix(preview, "Zoë→日本語🙂 ") || !output.SourceTruncated {
		t.Errorf("record copy %q…", preview[:min(len(preview), 80)])
	}
}

// stderr is part of what the output holds, not a whole copy of it: its
// digest, never an alias.
func TestStderrIsDigestedNotAliased(t *testing.T) {
	raw := lineBytes(t, fixtureProjects+"/"+mainSession+".jsonl", 66)
	raw = bytes.Replace(raw, []byte(`"stderr":""`), []byte(`"stderr":"a warning"`), 1)
	path := filepath.Join(fixtureProjectsDir, mainSession+".jsonl")
	record := parseOne(t, raw, path, mainSession)
	var native map[string]any
	json.Unmarshal([]byte(text(t, item(t, parsedLine{number: 66, record: record}, "native"))), &native)
	stderr, _ := native["toolUseResult"].(map[string]any)["stderr"].(map[string]any)
	if stderr["sha256"] == nil || stderr["alias_of"] != nil {
		t.Errorf("stderr kept as %v", stderr)
	}
}

// Amendment 34: Claude's sessions live under <config dir>/projects, which
// CLAUDE_CONFIG_DIR moves.
func TestContentRootsAreTheProjectsDir(t *testing.T) {
	roots := func(env agent.Env) []string {
		source, ok := any(New()).(interface{ ContentRoots(agent.Env) []string })
		if !ok {
			t.Fatal("Claude Code names no content roots")
		}
		return source.ContentRoots(env)
	}
	home := t.TempDir()
	if got := roots(agent.Env{Home: home, Getenv: func(string) string { return "" }}); strings.Join(got, ",") != filepath.Join(home, ".claude", "projects") {
		t.Errorf("default roots %v", got)
	}
	moved := filepath.Join(t.TempDir(), "claude-config")
	env := agent.Env{Home: home, Getenv: func(key string) string {
		if key == "CLAUDE_CONFIG_DIR" {
			return moved
		}
		return ""
	}}
	if got := roots(env); strings.Join(got, ",") != filepath.Join(moved, "projects") {
		t.Errorf("roots under CLAUDE_CONFIG_DIR %v", got)
	}
	relative := agent.Env{Home: home, Getenv: func(key string) string {
		if key == "CLAUDE_CONFIG_DIR" {
			return "relative/config"
		}
		return ""
	}}
	if got := roots(relative); strings.Join(got, ",") != filepath.Join(home, ".claude", "projects") {
		t.Errorf("a relative CLAUDE_CONFIG_DIR was honoured: %v", got)
	}
}
