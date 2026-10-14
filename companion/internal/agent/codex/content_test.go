// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/contracttest"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

// The RC-01 rollouts, as codex-cli 0.161.0 and Codex Desktop's app-server
// 0.160.0 wrote them, drive the parser line by line with its own state, as
// the daemon reads a session file.
const (
	cliThread     = "01a11e74-ad36-7893-afd8-05a514c3a3e3"
	cliForkThread = "01a11e7a-685c-7440-88a7-e7ef8e4a962a"
	desktopMain   = "01a11e78-585e-7f63-af3f-d7e55122bdd2"
	desktopChild  = "01a11e78-d358-7811-8b36-b8d2d969cc0f"
	desktopFork   = "01a11e78-e40c-7053-b316-e3e45bb698dd"
)

type contentLineItem struct {
	line   int
	record agent.ContentRecord
	item   agent.ContentItem
}

type parsedRollout struct {
	records map[int]agent.ContentRecord
	items   []contentLineItem
	errors  int
}

func fixtureRolloutLines(t *testing.T, surface, name string) [][]byte {
	t.Helper()
	file, err := os.Open(filepath.Join(contracttest.SourceDir(t, surface), name))
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	var reader io.Reader = file
	if strings.HasSuffix(name, ".gz") {
		unzipped, err := gzip.NewReader(file)
		if err != nil {
			t.Fatal(err)
		}
		reader = unzipped
	}
	var lines [][]byte
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(nil, 8<<20)
	for scanner.Scan() {
		lines = append(lines, bytes.Clone(scanner.Bytes()))
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return lines
}

// parseRolloutLines parses lines from the 1-based line number from onward,
// starting with no parser state, as a checkpoint past the file's start does.
func parseRolloutLines(t *testing.T, lines [][]byte, from int, harness, session string) parsedRollout {
	t.Helper()
	parser := New().ContentParser()
	parsed := parsedRollout{records: map[int]agent.ContentRecord{}}
	var state json.RawMessage
	offset := int64(0)
	for index, line := range lines {
		number := index + 1
		if number < from {
			offset += int64(len(line)) + 1
			continue
		}
		record, next, err := parser.Parse(agent.ContentLine{Bytes: line, Offset: offset, Harness: harness, NativeSessionID: session}, state)
		state = next
		offset += int64(len(line)) + 1
		if err != nil {
			parsed.errors++
			continue
		}
		parsed.records[number] = record
		if record.Copied {
			continue
		}
		for _, item := range record.Items {
			parsed.items = append(parsed.items, contentLineItem{line: number, record: record, item: item})
		}
	}
	return parsed
}

func parseFixture(t *testing.T, surface, name, harness, session string) parsedRollout {
	t.Helper()
	return parseRolloutLines(t, fixtureRolloutLines(t, surface, name), 1, harness, session)
}

func (p parsedRollout) find(t *testing.T, ref, part string) contentLineItem {
	t.Helper()
	for _, found := range p.items {
		if found.item.NativeRef == ref && found.item.Part == part {
			return found
		}
	}
	t.Fatalf("no item %s %s among %d items", ref, part, len(p.items))
	return contentLineItem{}
}

func (p parsedRollout) has(ref, part string) bool {
	for _, found := range p.items {
		if found.item.NativeRef == ref && found.item.Part == part {
			return true
		}
	}
	return false
}

func (p parsedRollout) where(match func(agent.ContentItem) bool) []contentLineItem {
	var found []contentLineItem
	for _, candidate := range p.items {
		if match(candidate.item) {
			found = append(found, candidate)
		}
	}
	return found
}

func (p parsedRollout) onLine(number int) []agent.ContentItem {
	var items []agent.ContentItem
	for _, found := range p.items {
		if found.line == number {
			items = append(items, found.item)
		}
	}
	return items
}

func bodyOf(t *testing.T, found contentLineItem) string {
	t.Helper()
	if found.item.Text == nil {
		t.Fatalf("%s %s has no text (coverage %q %q)", found.item.NativeRef, found.item.Part, found.item.Coverage, found.item.CoverageReason)
	}
	return *found.item.Text
}

func wantChannel(t *testing.T, found contentLineItem, role, channel, mediaType string) {
	t.Helper()
	item := found.item
	if item.Role != role || item.Channel != channel || item.MediaType != mediaType {
		t.Fatalf("%s %s (line %d) is %s/%s/%s, want %s/%s/%s", item.NativeRef, item.Part, found.line, item.Role, item.Channel, item.MediaType, role, channel, mediaType)
	}
}

func wantCoverage(t *testing.T, found contentLineItem, coverage, reason string) {
	t.Helper()
	item := found.item
	if item.Coverage != coverage || item.CoverageReason != reason || item.Text != nil || item.Data != nil {
		t.Fatalf("%s %s is %q/%q with a body %v, want %s/%s and no body", item.NativeRef, item.Part, item.Coverage, item.CoverageReason, item.Text != nil || item.Data != nil, coverage, reason)
	}
}

// partGrammar is the contract's frozen part grammar (§4).
var partGrammar = regexp.MustCompile(`^(text:[0-9]+|image:[0-9]+|instruction:[0-9]+|input|output|error|command|stdout|stderr|aggregated|summary|raw|native|context:[a-z_]+|diff:.+|file:.+)$`)

var (
	contentRoles    = map[string]bool{"user": true, "assistant": true, "tool": true, "system": true, "developer": true, "unknown": true}
	contentChannels = map[string]bool{"prompt": true, "reply": true, "reasoning": true, "tool_input": true, "tool_output": true, "diff": true, "file_content": true, "command_output": true, "error": true, "summary": true, "instruction": true, "native_record": true, "attachment": true}
)

// Every item is one the server can take: native ids in its shape, parts in
// the grammar, vocabulary from the schema, one item per (ref, part).
func assertWellFormed(t *testing.T, name string, parsed parsedRollout) {
	t.Helper()
	seen := map[string]int{}
	for _, found := range parsed.items {
		item := found.item
		where := name + ":" + strconv.Itoa(found.line) + " " + item.NativeRef + " " + item.Part
		if !uplink.NativeIDPattern.MatchString(item.NativeRef) || !partGrammar.MatchString(item.Part) {
			t.Errorf("%s: native ref or part outside the contract", where)
		}
		for _, id := range []string{item.CallID, item.ParentCallID, item.TurnID} {
			if id != "" && !uplink.NativeIDPattern.MatchString(id) {
				t.Errorf("%s: link %q is not a native id", where, id)
			}
		}
		if !contentRoles[item.Role] || !contentChannels[item.Channel] {
			t.Errorf("%s: role %q channel %q", where, item.Role, item.Channel)
		}
		if item.Channel != "attachment" && item.Text != nil && !uplink.TextMediaTypes[item.MediaType] {
			t.Errorf("%s: text body typed %q", where, item.MediaType)
		}
		if found.record.At.IsZero() || found.record.SchemaVersion == "" {
			t.Errorf("%s: record at %v schema %q", where, found.record.At, found.record.SchemaVersion)
		}
		key := item.NativeRef + "\x00" + item.Part
		if previous, twice := seen[key]; twice {
			t.Errorf("%s: declared on line %d already", where, previous)
		}
		seen[key] = found.line
	}
}

func TestTheContentSourceIsTheCodexRollout(t *testing.T) {
	parser := New().ContentParser()
	if parser.Kind() != "codex_rollout" || parser.Version() != "companion-codex-rollout/1" {
		t.Fatalf("kind %q version %q", parser.Kind(), parser.Version())
	}
	var _ agent.ContentSource = New()
	var _ agent.ContentDiscoverer = New()
}

// Amendment 37: the codex adapter serves Desktop's harness besides its
// own, so Desktop's windows and generations are its own.
func TestTheAdapterServesCodexDesktop(t *testing.T) {
	var family agent.HarnessFamily = New()
	if harnesses := family.Harnesses(); len(harnesses) != 1 || harnesses[0] != DesktopID {
		t.Fatalf("harnesses %v", harnesses)
	}
}

func TestTheHeaderIsTheSessionMeta(t *testing.T) {
	// The harness is the one session_meta's originator names, however the
	// file was found (amendment 24).
	cases := []struct {
		surface, file, began, parent, harness string
	}{
		{"codex-cli", "rollout-main.jsonl", "2026-10-09T02:18:46.577Z", "", ID},
		{"codex-cli", "rollout-fork.jsonl", "2026-10-09T02:25:01.029Z", cliThread, ID},
		{"codex-desktop", "rollout-main.jsonl.gz", "2026-10-09T02:22:46.326Z", "", DesktopID},
		{"codex-desktop", "rollout-fork.jsonl", "2026-10-09T02:23:21.621Z", desktopMain, DesktopID},
		// A subagent is its own session; it forks no history.
		{"codex-desktop", "rollout-subagent.jsonl", "2026-10-09T02:23:17.358Z", "", DesktopID},
	}
	parser := New().ContentParser()
	for _, c := range cases {
		header, ok := parser.Header(fixtureRolloutLines(t, c.surface, c.file)[0])
		want, _ := time.Parse(time.RFC3339Nano, c.began)
		if !ok || !header.Began.Equal(want) || header.ParentSessionID != c.parent || header.Harness != c.harness {
			t.Errorf("%s/%s: header %+v %v, want began %s parent %q harness %s", c.surface, c.file, header, ok, c.began, c.parent, c.harness)
		}
	}
	for _, line := range []string{
		`{"timestamp":"2026-10-09T02:18:48.563Z","type":"event_msg","payload":{"type":"task_started"}}`,
		`{"timestamp":"2026-10-09T02:18:48.563Z","type":"session_meta","payload":{"id":"x"}}`,
		`not json`,
	} {
		if header, ok := parser.Header([]byte(line)); ok {
			t.Errorf("%s: header %+v from a line that states no session start", line, header)
		}
	}
}

func TestTheCLIRolloutDeclaresItsContentOnce(t *testing.T) {
	parsed := parseFixture(t, "codex-cli", "rollout-main.jsonl", ID, cliThread)
	if parsed.errors != 0 {
		t.Fatalf("%d lines failed to parse", parsed.errors)
	}
	assertWellFormed(t, "codex-cli/rollout-main.jsonl", parsed)

	prompt := parsed.find(t, "01a11e74-c2f3-70a2-9353-38d7dcca1633", "text:2")
	wantChannel(t, prompt, "user", "prompt", "text/plain")
	if !strings.HasPrefix(bodyOf(t, prompt), "In one line, name the two dominant colors") || prompt.item.TurnID != "01a11e74-b87f-70c1-b545-73f2c743f983" {
		t.Fatalf("prompt %q turn %q", bodyOf(t, prompt), prompt.item.TurnID)
	}
	if prompt.record.Cwd != "/tmp/fixture-repo" || prompt.record.SchemaVersion != "codex_rollout/0.161.0" || !prompt.record.At.Equal(time.Date(2026, 10, 9, 2, 18, 50, 999_000_000, time.UTC)) {
		t.Fatalf("prompt record cwd %q schema %q at %v", prompt.record.Cwd, prompt.record.SchemaVersion, prompt.record.At)
	}
	// The local_image entries are paths, never opened; the rollout's own
	// copy of the prompt under the message id is not declared again.
	for _, part := range []string{"text:0", "text:1"} {
		if parsed.has("01a11e74-c2f3-70a2-9353-38d7dcca1633", part) {
			t.Fatalf("a local_image path was declared as %s", part)
		}
	}
	if parsed.has("msg_01a11e74-c2f3-70a2-9353-38c2c70d62f1", "text:4") {
		t.Fatal("the response_item copy of the prompt was declared")
	}
	correction := parsed.find(t, "01a11e76-4485-7f30-b83e-d26b95a53180", "text:0")
	if !strings.HasPrefix(bodyOf(t, correction), "Correction: I asked for update_plan") {
		t.Fatalf("correction %q", bodyOf(t, correction))
	}

	image := parsed.find(t, "msg_01a11e74-c2f3-70a2-9353-38c2c70d62f1", "image:1")
	wantChannel(t, image, "user", "attachment", "image/png")
	swatch, err := os.ReadFile(filepath.Join(contracttest.SourceDir(t, "codex-cli"), "swatch.png"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(image.item.Data, swatch) || image.item.TurnID != prompt.item.TurnID {
		t.Fatalf("image of %d bytes in turn %q, want swatch.png's %d", len(image.item.Data), image.item.TurnID, len(swatch))
	}
	missing := parsed.find(t, "msg_01a11e74-c2f3-70a2-9353-38c2c70d62f1", "image:3")
	wantCoverage(t, missing, "source_unavailable", "file_missing")
	if missing.item.Channel != "attachment" {
		t.Fatalf("the unreadable image is declared on %s", missing.item.Channel)
	}

	reply := parsed.find(t, "msg_02b4a41fbe374028016ac84f0ca8c081969130546a1cf86a73", "text:0")
	wantChannel(t, reply, "assistant", "reply", "text/markdown")
	final := parsed.find(t, "msg_02b4a41fbe374028016ac84f193bec8196a89b57c3b648b2c9", "text:0")
	if !strings.Contains(bodyOf(t, final), "Größe ✓ 完了") {
		t.Fatalf("final answer %q", bodyOf(t, final))
	}
	if replies := parsed.where(func(item agent.ContentItem) bool {
		return item.NativeRef == "msg_02b4a41fbe374028016ac84f0ca8c081969130546a1cf86a73" && item.Channel == "reply"
	}); len(replies) != 1 {
		t.Fatalf("the reply and its response_item copy share one id; declared %d times", len(replies))
	}

	// Low effort: no summary, and the reasoning itself only as ciphertext.
	if parsed.has("rs_0879edd5866a49f3016ac84f7097a88195b8a1fbaff2c8a90f", "summary") {
		t.Fatal("an empty reasoning summary was declared")
	}
	// The placeholder comes from the completed item (line 69), whose raw
	// content is empty; never from the response_item holding the ciphertext.
	raw := parsed.find(t, "rs_0879edd5866a49f3016ac84f7097a88195b8a1fbaff2c8a90f", "raw")
	wantChannel(t, raw, "assistant", "reasoning", raw.item.MediaType)
	wantCoverage(t, raw, "source_unavailable", "encrypted_at_source")
	if raw.line != 69 || len(parsed.onLine(70)) != 0 {
		t.Fatalf("raw reasoning declared from line %d; the ciphertext line declared %d items", raw.line, len(parsed.onLine(70)))
	}

	script := parsed.find(t, "ctc_02b4a41fbe374028016ac84f1002f881969e0f92f15a941b6f", "input")
	wantChannel(t, script, "assistant", "tool_input", "text/plain")
	if script.item.CallID != "call_80cc8e6c8a51452e908a64b58e3f3004" || !strings.HasPrefix(bodyOf(t, script), "const r = await tools.exec_command(") {
		t.Fatalf("code-mode script call %q: %q", script.item.CallID, bodyOf(t, script))
	}
	scriptOutput := parsed.find(t, "ctco_01a11e74-d965-7c71-b1ae-8782ef8f5159", "output")
	wantChannel(t, scriptOutput, "tool", "tool_output", "text/plain")
	if scriptOutput.item.CallID != script.item.CallID || !strings.HasPrefix(bodyOf(t, scriptOutput), "Script completed\nWall time 0.2 seconds\nOutput:\nWarning: truncated output") {
		t.Fatalf("script output call %q: %q", scriptOutput.item.CallID, bodyOf(t, scriptOutput))
	}

	command := parsed.find(t, "exec-108385a1-d77d-46dd-b61a-d2774fe910fa", "command")
	wantChannel(t, command, "tool", "tool_input", "text/plain")
	if bodyOf(t, command) != "python3 gen.py 20000 && python3 gen.py 70000" {
		t.Fatalf("command %q", bodyOf(t, command))
	}
	stdout := parsed.find(t, "exec-108385a1-d77d-46dd-b61a-d2774fe910fa", "stdout")
	wantChannel(t, stdout, "tool", "command_output", "text/plain")
	// The CommandExecution is the hook's tool_use_id; the code-mode script
	// that ran it encloses it.
	if len(bodyOf(t, stdout)) != 90090 || stdout.item.SourceTruncated || stdout.item.CallID != "exec-108385a1-d77d-46dd-b61a-d2774fe910fa" || stdout.item.ParentCallID != script.item.CallID {
		t.Fatalf("stdout of %d bytes, truncated %v, call %q parent %q", len(bodyOf(t, stdout)), stdout.item.SourceTruncated, stdout.item.CallID, stdout.item.ParentCallID)
	}
	for _, alias := range []string{"aggregated", "stderr"} {
		if parsed.has("exec-108385a1-d77d-46dd-b61a-d2774fe910fa", alias) {
			t.Fatalf("%s equal to stdout or empty was declared", alias)
		}
	}
	failed := parsed.find(t, "exec-61954b01-ace6-4a76-8be7-cd8a9a9c5d1d", "stdout")
	if !strings.Contains(bodyOf(t, failed), "AssertionError: add(2,2) != 4") || failed.item.CallID != "exec-61954b01-ace6-4a76-8be7-cd8a9a9c5d1d" {
		t.Fatalf("the failing check's output %q, call %q", bodyOf(t, failed), failed.item.CallID)
	}

	diff := parsed.find(t, "exec-03edcc97-aa71-4a66-9a1a-51189cde38c4", "diff:/tmp/fixture-repo/calc.py")
	wantChannel(t, diff, "tool", "diff", "text/x-diff")
	if bodyOf(t, diff) != "@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a - b\n+    return a + b\n" || diff.item.ParentCallID != "call_1a9ac07b60164721935f070519003fea" || diff.item.CallID != "exec-03edcc97-aa71-4a66-9a1a-51189cde38c4" {
		t.Fatalf("diff %q call %q parent %q", bodyOf(t, diff), diff.item.CallID, diff.item.ParentCallID)
	}
	patch := parsed.find(t, "ctc_02b4a41fbe374028016ac84f16a4b08196a429020c71372f4f", "input")
	if !strings.Contains(bodyOf(t, patch), "*** Begin Patch") {
		t.Fatalf("the apply_patch envelope is not in its script: %q", bodyOf(t, patch))
	}

	mcpInput := parsed.find(t, "exec-0856099e-bdd6-4b92-bc66-a06d819386b0", "input")
	wantChannel(t, mcpInput, "assistant", "tool_input", "application/json")
	if bodyOf(t, mcpInput) != `{"text":"mcp ✓ ok"}` || mcpInput.item.CallID != "exec-0856099e-bdd6-4b92-bc66-a06d819386b0" {
		t.Fatalf("MCP arguments %q call %q", bodyOf(t, mcpInput), mcpInput.item.CallID)
	}
	mcpOutput := parsed.find(t, "exec-0856099e-bdd6-4b92-bc66-a06d819386b0", "output")
	wantChannel(t, mcpOutput, "tool", "tool_output", "application/json")
	var result map[string]any
	if json.Unmarshal([]byte(bodyOf(t, mcpOutput)), &result) != nil || result["structuredContent"] == nil {
		t.Fatalf("MCP result %q", bodyOf(t, mcpOutput))
	}
	mcpError := parsed.find(t, "exec-45caf814-9fa9-4848-91fd-a63520b1eec3", "error")
	wantChannel(t, mcpError, "tool", "error", "text/plain")
	if bodyOf(t, mcpError) != "MCP tool call requires approval, but approval policy is never" || mcpError.item.CallID != "exec-45caf814-9fa9-4848-91fd-a63520b1eec3" {
		t.Fatalf("MCP error %q call %q", bodyOf(t, mcpError), mcpError.item.CallID)
	}

	agentsMD := parsed.find(t, "msg_01a11e74-c2c2-7f50-a38f-676bd02c1d65", "instruction:0")
	wantChannel(t, agentsMD, "user", "instruction", "text/markdown")
	// The header names the repository; the path is joined in this host's spelling.
	if agentsMD.item.DisplayPath != filepath.Join("/tmp/fixture-repo", "AGENTS.md") || !strings.Contains(bodyOf(t, agentsMD), "# Fixture repo instructions") {
		t.Fatalf("AGENTS.md at %q: %q", agentsMD.item.DisplayPath, bodyOf(t, agentsMD))
	}
	for _, harnessContext := range []struct{ ref, part string }{
		{cliThread, "context:base_instructions"},
		{"msg_01a11e74-c2c2-7f50-a38f-6736b86fe6ce", "text:0"},
		{"msg_01a11e74-c2c2-7f50-a38f-6736b86fe6ce", "text:3"},
		{"msg_01a11e74-c2c2-7f50-a38f-67457b7cb65e", "text:0"},
		{"msg_01a11e74-c2c2-7f50-a38f-676bd02c1d65", "text:1"},
		{"ordinal:6", "context:world_state"},
	} {
		found := parsed.find(t, harnessContext.ref, harnessContext.part)
		wantCoverage(t, found, "withheld_by_policy", "harness_context")
		if found.item.Channel != "instruction" || found.item.OriginalBytes <= 0 {
			t.Fatalf("harness context %s %s on %s, %d bytes", harnessContext.ref, harnessContext.part, found.item.Channel, found.item.OriginalBytes)
		}
	}

	// Two identical commands are two items: identity is the item id.
	first, second := parsed.find(t, "exec-58e9c9fd-910b-4b32-9e72-771bd4bbf352", "stdout"), parsed.find(t, "exec-52548e1c-60d1-4f35-bf3b-85b1ad819c64", "stdout")
	if bodyOf(t, first) != bodyOf(t, second) || !strings.Contains(bodyOf(t, first), "héllo wörld 🌍 — ünïcödé") {
		t.Fatalf("repeated commands %q and %q", bodyOf(t, first), bodyOf(t, second))
	}

	// Usage, settings and lifecycle are events or nothing, never content.
	for number, record := range parsed.records {
		line := fixtureRolloutLines(t, "codex-cli", "rollout-main.jsonl")[number-1]
		for _, never := range []string{`"type":"token_usage_record"`, `"type":"token_count"`, `"type":"turn_context"`, `"type":"task_started"`, `"type":"task_complete"`, `"type":"thread_settings_applied"`} {
			if bytes.Contains(line, []byte(never)) && len(record.Items) > 0 {
				t.Errorf("line %d (%s) declared %d items", number, never, len(record.Items))
			}
		}
	}
	// A world_state delta restates settings; only the full state is the
	// harness context declared (ordinal:6).
	if items := parsed.onLine(59); len(items) != 0 {
		t.Fatalf("the world_state delta on line 59 declared %+v", items)
	}
}

func nativeRecordOf(t *testing.T, parsed parsedRollout, ref string) map[string]any {
	t.Helper()
	found := parsed.find(t, ref, "native")
	wantChannel(t, found, found.item.Role, "native_record", "application/json")
	var record map[string]any
	decoder := json.NewDecoder(strings.NewReader(bodyOf(t, found)))
	decoder.UseNumber()
	if err := decoder.Decode(&record); err != nil {
		t.Fatalf("native record of %s: %v", ref, err)
	}
	return record
}

func nativeLeaf(value any, path ...string) any {
	for _, key := range path {
		object, _ := value.(map[string]any)
		value = object[key]
	}
	return value
}

// A native record keeps the line's shape; every body it declared is a
// reference, every copy of one a digest naming it, so no text is stored
// twice.
func TestANativeRecordReferencesTheBodiesItsLineDeclared(t *testing.T) {
	parsed := parseFixture(t, "codex-cli", "rollout-main.jsonl", ID, cliThread)
	const exec = "exec-108385a1-d77d-46dd-b61a-d2774fe910fa"
	record := nativeRecordOf(t, parsed, exec)
	item := nativeLeaf(record, "payload", "item")
	stdoutKey := agent.ContentKey(ID, cliThread, exec, "stdout")
	if ref := nativeLeaf(item, "stdout", "backplane_content_ref"); ref != stdoutKey {
		t.Fatalf("stdout leaf %v, want a reference to %s", nativeLeaf(item, "stdout"), stdoutKey)
	}
	if ref := nativeLeaf(item, "command", "backplane_content_ref"); ref != agent.ContentKey(ID, cliThread, exec, "command") {
		t.Fatalf("command leaf %v", nativeLeaf(item, "command"))
	}
	for _, alias := range []string{"aggregated_output", "formatted_output"} {
		leaf, _ := nativeLeaf(item, alias).(map[string]any)
		if leaf["alias_of"] != stdoutKey || leaf["sha256"] == nil || leaf["bytes"] == nil {
			t.Fatalf("%s leaf %v, want a digest aliasing stdout", alias, leaf)
		}
	}
	if nativeLeaf(item, "exit_code") != json.Number("0") || nativeLeaf(record, "type") != "event_msg" || nativeLeaf(item, "type") != "CommandExecution" {
		t.Fatalf("the record's own metadata is gone: %v", record)
	}
	encoded := bodyOf(t, parsed.find(t, exec, "native"))
	if strings.Contains(encoded, "rc-fixture-line-0123456789") || strings.Contains(encoded, "file://") {
		t.Fatalf("the native record repeats a body or keeps a file URL: %.300s", encoded)
	}
	for _, found := range parsed.where(func(item agent.ContentItem) bool { return item.Channel == "native_record" }) {
		if strings.Contains(bodyOf(t, found), "gAAAAA") {
			t.Fatalf("native record of %s keeps ciphertext", found.item.NativeRef)
		}
	}
	// A path part's key hashes the placed path, which only the core knows:
	// the leaf names the raw part for the declarer to resolve (amendment 22).
	const edit = "exec-03edcc97-aa71-4a66-9a1a-51189cde38c4"
	diffLeaf, _ := nativeLeaf(nativeRecordOf(t, parsed, edit), "payload", "item", "changes", "/tmp/fixture-repo/calc.py", "unified_diff").(map[string]any)
	if ref, _ := diffLeaf["backplane_content_ref"].(map[string]any); len(diffLeaf) != 1 || len(ref) != 1 || ref["part"] != "diff:/tmp/fixture-repo/calc.py" {
		t.Fatalf("the diff leaf is %v, want a part reference for the core to place", diffLeaf)
	}
	// Harness-context lines declare a metadata-only item, so they keep a
	// native record whose harness-context leaves are digests (amendment
	// 30); account identity never appears in it.
	for _, harnessLeaf := range []struct {
		ref  string
		path []string
	}{
		{cliThread, []string{"payload", "base_instructions", "text"}},
		{cliThread, []string{"payload", "creator_user_id"}},
		{cliThread, []string{"payload", "creator_account_id"}},
		{"ordinal:6", []string{"payload", "state"}},
	} {
		leaf, _ := nativeLeaf(nativeRecordOf(t, parsed, harnessLeaf.ref), harnessLeaf.path...).(map[string]any)
		if len(leaf) != 2 || leaf["bytes"] == nil || leaf["sha256"] == nil {
			t.Fatalf("%s %v is %v, want {bytes, sha256}", harnessLeaf.ref, harnessLeaf.path, leaf)
		}
	}
	developer := nativeRecordOf(t, parsed, "msg_01a11e74-c2c2-7f50-a38f-6736b86fe6ce")
	contents, _ := nativeLeaf(developer, "payload", "content").([]any)
	if len(contents) != 4 {
		t.Fatalf("developer message contents %v", contents)
	}
	for index, entry := range contents {
		if leaf, _ := nativeLeaf(entry, "text").(map[string]any); leaf["sha256"] == nil || leaf["alias_of"] != nil {
			t.Fatalf("developer content %d is %v, want a digest", index, nativeLeaf(entry, "text"))
		}
	}
	agentsMessage := nativeRecordOf(t, parsed, "msg_01a11e74-c2c2-7f50-a38f-676bd02c1d65")
	agentsContents, _ := nativeLeaf(agentsMessage, "payload", "content").([]any)
	if len(agentsContents) != 2 || nativeLeaf(agentsContents[0], "text", "backplane_content_ref") != agent.ContentKey(ID, cliThread, "msg_01a11e74-c2c2-7f50-a38f-676bd02c1d65", "instruction:0") {
		t.Fatalf("the AGENTS.md message's native record %v", agentsMessage)
	}
	for _, ref := range []string{cliThread, "msg_01a11e74-c2c2-7f50-a38f-6736b86fe6ce", "ordinal:6"} {
		encoded := bodyOf(t, parsed.find(t, ref, "native"))
		for _, never := range []string{"fixture-filler", "# Fixture repo instructions", "user-fixture000000000000000", "00000000-0000-4000-8000-00000000f1x7"} {
			if strings.Contains(encoded, never) {
				t.Fatalf("the native record of %s keeps %q", ref, never)
			}
		}
	}
}

func TestTheDesktopRolloutDeclaresItsOwnSurface(t *testing.T) {
	parsed := parseFixture(t, "codex-desktop", "rollout-main.jsonl.gz", DesktopID, desktopMain)
	if parsed.errors != 0 {
		t.Fatalf("%d lines failed to parse", parsed.errors)
	}
	assertWellFormed(t, "codex-desktop/rollout-main.jsonl.gz", parsed)

	prompt := parsed.find(t, "01a11e78-61dc-7d63-8fcd-ad7574631429", "text:1")
	if prompt.record.SchemaVersion != "codex_rollout/0.160.0" || prompt.record.Cwd != "/tmp/fixture-desktop-repo" {
		t.Fatalf("prompt record %q in %q", prompt.record.SchemaVersion, prompt.record.Cwd)
	}
	image := parsed.find(t, "msg_01a11e78-61dc-7d63-8fcd-ad68c9bc6acb", "image:1")
	swatch, _ := os.ReadFile(filepath.Join(contracttest.SourceDir(t, "codex-desktop"), "swatch.png"))
	if !bytes.Equal(image.item.Data, swatch) {
		t.Fatalf("Desktop image of %d bytes", len(image.item.Data))
	}

	// Codex kept 1 MiB of the 1,200,017 bytes and said how much it left out.
	stdout := parsed.find(t, "exec-e4bb0390-612d-4308-bcfd-e40a530bc99d", "stdout")
	if !stdout.item.SourceTruncated || stdout.item.OriginalBytes != 1200017 || !strings.Contains(bodyOf(t, stdout), "... 151441 bytes omitted ...") {
		t.Fatalf("stdout truncated %v from %d (%d bytes kept)", stdout.item.SourceTruncated, stdout.item.OriginalBytes, len(bodyOf(t, stdout)))
	}

	summary := parsed.find(t, "rs_08ed2a6c631e1773016ac84ffb37b88196b23bdd2cbf1fd27d", "summary")
	wantChannel(t, summary, "assistant", "reasoning", "text/markdown")
	if bodyOf(t, summary) != "**Applying exact patch**" {
		t.Fatalf("summary %q", bodyOf(t, summary))
	}
	wantCoverage(t, parsed.find(t, "rs_08ed2a6c631e1773016ac84ffb37b88196b23bdd2cbf1fd27d", "raw"), "source_unavailable", "encrypted_at_source")

	added := parsed.find(t, "exec-cd387fa1-9dea-4c84-bfa4-ff68f85b1a33", "file:/tmp/fixture-desktop-repo/notes.txt")
	wantChannel(t, added, "tool", "file_content", "text/plain")
	if bodyOf(t, added) != "desktop ✓ 完了\n" {
		t.Fatalf("added file %q", bodyOf(t, added))
	}

	// The failure on this surface: a declined escalation. The command that
	// was approved ran and is declared; the declined one never ran, so
	// nothing invents its output, and its approval stays an event.
	approved := parsed.find(t, "exec-d9a3b290-538f-41ff-8e1f-e3da8e7a7953", "command")
	if approved.item.CallID != "exec-d9a3b290-538f-41ff-8e1f-e3da8e7a7953" || approved.item.ParentCallID != "call_6a4cfcedac5145989361b2a885de266b" {
		t.Fatalf("approved command call %q parent %q", approved.item.CallID, approved.item.ParentCallID)
	}
	if ran := parsed.where(func(item agent.ContentItem) bool { return item.ParentCallID == "call_eed74b2870964c3ead8eec47270f2290" }); len(ran) != 0 {
		t.Fatalf("the declined command yielded %+v", ran)
	}
	if declined := parsed.find(t, "ctco_01a11e78-96a0-7452-9bbb-d930affc15b6", "output"); !strings.HasPrefix(bodyOf(t, declined), "Script failed") {
		t.Fatalf("the declined script's output %q", bodyOf(t, declined))
	}
	interrupted := parsed.find(t, "ctco_01a11e78-b2fc-74f3-bac3-b76d4347975a", "output")
	if bodyOf(t, interrupted) != "aborted by user after 3.2s" {
		t.Fatalf("interrupted script output %q", bodyOf(t, interrupted))
	}
	// The interrupted command, written turns later: grouped by its turn,
	// no enclosing call can be told.
	late := parsed.find(t, "exec-a229ac61-db3a-4ceb-a887-09b00cceac7f", "command")
	if late.line != 121 || late.item.TurnID != "01a11e78-9a13-7423-9caa-8f571a6b3251" || late.item.ParentCallID != "" || bodyOf(t, late) != "sleep 20 && echo late" {
		t.Fatalf("late command on line %d turn %q parent %q: %q", late.line, late.item.TurnID, late.item.ParentCallID, bodyOf(t, late))
	}

	// Compaction re-copies kept messages, the image among them, under their
	// original ids: a copy, never content. The summary itself is encrypted.
	if items := parsed.onLine(72); len(items) != 0 || !parsed.records[72].Copied {
		t.Fatalf("the compacted line declared %d items, copied %v", len(items), parsed.records[72].Copied)
	}
	// Interruptions stay events; inter-agent metadata is a marker.
	for _, number := range []int{69, 114} {
		if items := parsed.onLine(number); len(items) != 0 || parsed.records[number].Copied {
			t.Fatalf("line %d declared %+v", number, items)
		}
	}
	compaction := parsed.find(t, "01a11e78-b314-7b51-bf72-f8e92f92c428", "summary")
	wantChannel(t, compaction, "system", "summary", compaction.item.MediaType)
	wantCoverage(t, compaction, "source_unavailable", "encrypted_at_source")

	spawn := parsed.find(t, "fc_08ed2a6c631e1773016ac8501518f88196986f2f29dedc6966", "input")
	wantCoverage(t, spawn, "source_unavailable", "encrypted_at_source")
	if spawn.item.CallID != "call_944fbb24c79346eb99011b38cf03c263" || spawn.item.Channel != "tool_input" {
		t.Fatalf("spawn_agent call %q on %s", spawn.item.CallID, spawn.item.Channel)
	}
	spawned := parsed.find(t, "fco_01a11e78-d3a3-7a22-900f-8a85b8ee0e62", "output")
	if bodyOf(t, spawned) != `{"task_name":"/root/run_echo"}` || spawned.item.CallID != spawn.item.CallID {
		t.Fatalf("spawn_agent output %q call %q", bodyOf(t, spawned), spawned.item.CallID)
	}
	childAnswer := parsed.find(t, "amsg_01a11e78-e40b-7cb3-8c5c-4f8c44bc562f", "text:0")
	if !strings.Contains(bodyOf(t, childAnswer), "child-ok") {
		t.Fatalf("the subagent's answer to its parent %q", bodyOf(t, childAnswer))
	}
}

func TestASubagentRolloutIsItsOwnSession(t *testing.T) {
	parsed := parseFixture(t, "codex-desktop", "rollout-subagent.jsonl", DesktopID, desktopChild)
	assertWellFormed(t, "codex-desktop/rollout-subagent.jsonl", parsed)
	task := parsed.find(t, "amsg_01a11e78-d916-77a0-aa7a-2f697146cdf6", "text:0")
	if !strings.HasPrefix(bodyOf(t, task), "Message Type: NEW_TASK") {
		t.Fatalf("the subagent's task %q", bodyOf(t, task))
	}
	wantCoverage(t, parsed.find(t, "amsg_01a11e78-d916-77a0-aa7a-2f697146cdf6", "text:1"), "source_unavailable", "encrypted_at_source")
	answer := parsed.find(t, "msg_086d8e06a084ea5d016ac8501973208193b22171ff2bf68f90", "text:0")
	if answer.item.Channel != "reply" || answer.record.Copied {
		t.Fatalf("the subagent's reply %+v", answer.item)
	}
	if command := parsed.find(t, "exec-9fb41c24-27a6-47f8-ae97-0a4dfc08ff38", "stdout"); !strings.Contains(bodyOf(t, command), "child-ok") {
		t.Fatalf("the subagent's command output %q", bodyOf(t, command))
	}
}

// A fork references its parent's history; what it writes before its first
// turn starts is synthetic, never this session's content.
func TestAForkDeclaresOnlyItsOwnTurns(t *testing.T) {
	desktop := parseFixture(t, "codex-desktop", "rollout-fork.jsonl", DesktopID, desktopFork)
	for _, number := range []int{3, 4} {
		if items := desktop.onLine(number); len(items) != 0 {
			t.Fatalf("synthetic fork line %d declared %+v", number, items)
		}
	}
	if !desktop.records[3].Copied {
		t.Fatal("the synthetic turn_aborted message is not marked a copy")
	}
	desktop.find(t, "01a11e78-e7c5-77c2-a8c6-37bbd563abb4", "text:0")
	cli := parseFixture(t, "codex-cli", "rollout-fork.jsonl", ID, cliForkThread)
	reply := cli.find(t, "msg_0edc33fc0b4c1955016ac85082c5a4819381471420307fabc3", "text:0")
	if reply.item.Channel != "reply" {
		t.Fatalf("the fork's reply %+v", reply.item)
	}
	cli.find(t, "01a11e7a-7705-7640-a5a1-b09a1efeb52c", "text:0")
}

// Resuming starts reading at the file's end with no parser state: links
// and scope still come from the lines read.
func TestAResumedReadLinksWhatItReads(t *testing.T) {
	parsed := parseRolloutLines(t, fixtureRolloutLines(t, "codex-cli", "rollout-main.jsonl"), 92, ID, cliThread)
	failed := parsed.find(t, "exec-45caf814-9fa9-4848-91fd-a63520b1eec3", "error")
	if failed.item.TurnID != "01a11e78-99f3-78d3-bec1-189e127167da" || failed.item.ParentCallID != "call_0dfa456efaef4907b487a820d02fe328" || failed.record.Cwd != "/private/tmp/fixture-repo" {
		t.Fatalf("resumed read: turn %q parent %q cwd %q", failed.item.TurnID, failed.item.ParentCallID, failed.record.Cwd)
	}
	assertWellFormed(t, "codex-cli/rollout-main.jsonl from 92", parsed)
	for _, found := range parsed.items {
		if found.line < 92 {
			t.Fatalf("line %d before the resume point was declared", found.line)
		}
		// session_meta was never read, so its cli_version is not known.
		if found.record.SchemaVersion != "codex_rollout/unknown" {
			t.Fatalf("line %d schema %q", found.line, found.record.SchemaVersion)
		}
	}
}

func rolloutLineOf(t *testing.T, kind string, payload map[string]any) []byte {
	t.Helper()
	encoded, err := json.Marshal(map[string]any{"timestamp": "2026-10-09T03:00:00.000Z", "type": kind, "payload": payload})
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

// A reasoning item with its raw text keeps it: the ciphertext of the same
// item that follows is never declared over it as a placeholder.
func TestRawReasoningIsNeverReplacedByItsCiphertext(t *testing.T) {
	lines := [][]byte{
		rolloutLineOf(t, "event_msg", map[string]any{"type": "item_completed", "thread_id": cliThread, "turn_id": "turn-r", "item": map[string]any{"type": "Reasoning", "id": "rs_raw1", "summary_text": []any{}, "raw_content": []any{"thinking out loud"}}}),
		rolloutLineOf(t, "response_item", map[string]any{"type": "reasoning", "id": "rs_raw1", "summary": []any{}, "encrypted_content": "gAAAAAopaque", "internal_chat_message_metadata_passthrough": map[string]any{"turn_id": "turn-r"}}),
	}
	parsed := parseRolloutLines(t, lines, 1, ID, cliThread)
	raws := parsed.where(func(item agent.ContentItem) bool { return item.NativeRef == "rs_raw1" && item.Part == "raw" })
	if len(raws) != 1 || raws[0].item.Text == nil || *raws[0].item.Text != "thinking out loud" {
		t.Fatalf("raw reasoning declared as %+v", raws)
	}
}

// A line naming another thread (a parent's record) is that thread's.
func TestALineOfAnotherThreadIsACopy(t *testing.T) {
	line := rolloutLineOf(t, "event_msg", map[string]any{"type": "item_completed", "thread_id": desktopMain, "turn_id": "turn-x", "item": map[string]any{"type": "AgentMessage", "id": "msg_other", "content": []any{map[string]any{"type": "Text", "text": "the parent's words"}}}})
	parsed := parseRolloutLines(t, [][]byte{line}, 1, DesktopID, desktopChild)
	if len(parsed.items) != 0 || !parsed.records[1].Copied {
		t.Fatalf("a line of %s declared %d items in %s", desktopMain, len(parsed.items), desktopChild)
	}
}

func TestARemoteImageIsDeclaredUnavailable(t *testing.T) {
	line := rolloutLineOf(t, "response_item", map[string]any{"type": "message", "id": "msg_remote", "role": "user",
		"content": []any{map[string]any{"type": "input_image", "image_url": "https://example.com/cat.png"}},
		"internal_chat_message_metadata_passthrough": map[string]any{"turn_id": "turn-i", "content_item_kinds": []any{"user.image"}}})
	parsed := parseRolloutLines(t, [][]byte{line}, 1, ID, cliThread)
	wantCoverage(t, parsed.find(t, "msg_remote", "image:0"), "source_unavailable", "remote_reference")
}

func TestUnknownAndBrokenLinesDeclareNothing(t *testing.T) {
	parser := New().ContentParser()
	unknown := rolloutLineOf(t, "event_msg", map[string]any{"type": "some_future_event", "item": map[string]any{"type": "Hologram", "id": "h1", "text": "?"}})
	record, state, err := parser.Parse(agent.ContentLine{Bytes: unknown, Harness: ID, NativeSessionID: cliThread}, nil)
	if err != nil || len(record.Items) != 0 {
		t.Fatalf("an unknown line: %+v, state %s, %v", record, state, err)
	}
	if _, _, err := parser.Parse(agent.ContentLine{Bytes: []byte(`{"timestamp":`), Harness: ID, NativeSessionID: cliThread}, state); err == nil {
		t.Fatal("a broken line parsed")
	}
}

// The daemon keeps whatever state Parse returns, so a line that fails to
// parse must hand back the state it was given, byte for byte.
func TestABrokenLineLeavesTheParserStateAsItWas(t *testing.T) {
	parser := New().ContentParser()
	lines := fixtureRolloutLines(t, "codex-cli", "rollout-main.jsonl")
	var state json.RawMessage
	// Inside turn 1's code-mode script: turn, cwd and the open call are set.
	for _, line := range lines[:23] {
		_, state, _ = parser.Parse(agent.ContentLine{Bytes: line, Harness: ID, NativeSessionID: cliThread}, state)
	}
	before := bytes.Clone(state)
	broken := [][]byte{
		[]byte(`{"timestamp":`),
		[]byte(`{"timestamp":"2026-10-09T02:18:56.600Z","type":"event_msg","payload":{"type":"item_completed","turn_id":"turn-other","item":{"type":"CommandExecution","id":"exec-x","stdout":`),
		[]byte(`{"timestamp":"not a time","type":"turn_context","payload":{"turn_id":"turn-other","cwd":"/elsewhere"}}`),
	}
	for _, line := range broken {
		_, after, err := parser.Parse(agent.ContentLine{Bytes: line, Harness: ID, NativeSessionID: cliThread}, state)
		if err == nil {
			t.Fatalf("%s parsed", line)
		}
		if !bytes.Equal(after, before) {
			t.Fatalf("%s changed the state from %s to %s", line, before, after)
		}
	}
	// The next line still links to the script the state holds open, in
	// the turn and directory it held before the broken lines.
	record, _, err := parser.Parse(agent.ContentLine{Bytes: lines[24], Harness: ID, NativeSessionID: cliThread}, state)
	if err != nil {
		t.Fatal(err)
	}
	var stdouts []agent.ContentItem
	for _, item := range record.Items {
		if item.Part == "stdout" {
			stdouts = append(stdouts, item)
		}
	}
	if len(stdouts) != 1 || stdouts[0].ParentCallID != "call_80cc8e6c8a51452e908a64b58e3f3004" || stdouts[0].TurnID != "01a11e74-b87f-70c1-b545-73f2c743f983" || record.Cwd != "/tmp/fixture-repo" {
		t.Fatalf("after broken lines line 25 declared stdout %+v in %q", stdouts, record.Cwd)
	}
}

// Amendment 25: a first read from mid-file, its turn_context and the
// script around it skipped, links nothing it did not read and guesses no
// version.
func TestAMidFileReadWithoutStateGuessesNothing(t *testing.T) {
	parsed := parseRolloutLines(t, fixtureRolloutLines(t, "codex-cli", "rollout-main.jsonl"), 25, ID, cliThread)
	assertWellFormed(t, "codex-cli/rollout-main.jsonl from 25", parsed)
	stdout := parsed.find(t, "exec-108385a1-d77d-46dd-b61a-d2774fe910fa", "stdout")
	if stdout.item.TurnID != "" && stdout.item.TurnID != "01a11e74-b87f-70c1-b545-73f2c743f983" {
		t.Fatalf("turn %q is neither unknown nor the line's own", stdout.item.TurnID)
	}
	if stdout.record.Cwd != "" || stdout.item.ParentCallID != "" || stdout.record.SchemaVersion != "codex_rollout/unknown" {
		t.Fatalf("guessed cwd %q parent %q schema %q", stdout.record.Cwd, stdout.item.ParentCallID, stdout.record.SchemaVersion)
	}
}

// Fixture parity, row by row: every content row a surface's manifest
// states, its own or inherited, is checked against that surface's own
// fixtures; a row they cannot show must be stated not_exercised there.
// Desktop is never qualified by the CLI's evidence, nor the CLI by
// Desktop's.
func TestEachSurfaceMatchesItsOwnManifest(t *testing.T) {
	cli := parseFixture(t, "codex-cli", "rollout-main.jsonl", ID, cliThread)
	desktop := parseFixture(t, "codex-desktop", "rollout-main.jsonl.gz", DesktopID, desktopMain)
	child := parseFixture(t, "codex-desktop", "rollout-subagent.jsonl", DesktopID, desktopChild)
	captured := func(parsed parsedRollout, channel string) func(t *testing.T) {
		return func(t *testing.T) {
			if len(parsed.where(func(item agent.ContentItem) bool {
				return item.Channel == channel && item.Coverage == "" && (item.Text != nil || item.Data != nil)
			})) == 0 {
				t.Fatalf("no %s captured", channel)
			}
		}
	}
	withCoverage := func(parsed parsedRollout, part, coverage, reason string) func(t *testing.T) {
		return func(t *testing.T) {
			if len(parsed.where(func(item agent.ContentItem) bool {
				return strings.HasPrefix(item.Part, part) && item.Coverage == coverage && item.CoverageReason == reason
			})) == 0 {
				t.Fatalf("no %s part %s/%s", part, coverage, reason)
			}
		}
	}
	checks := map[string]map[string]func(t *testing.T){
		"codex-cli": {
			"prompt":     captured(cli, "prompt"),
			"correction": func(t *testing.T) { cli.find(t, "01a11e76-4485-7f30-b83e-d26b95a53180", "text:0") },
			"attachment_image": func(t *testing.T) {
				captured(cli, "attachment")(t)
				withCoverage(cli, "image:", "source_unavailable", "file_missing")(t)
			},
			"reply":             captured(cli, "reply"),
			"reasoning_raw":     withCoverage(cli, "raw", "source_unavailable", "encrypted_at_source"),
			"reasoning_summary": func(t *testing.T) { expectNone(t, cli, "summary") },
			"tool_input":        captured(cli, "tool_input"),
			"tool_output":       captured(cli, "tool_output"),
			"command":           func(t *testing.T) { cli.find(t, "exec-61954b01-ace6-4a76-8be7-cd8a9a9c5d1d", "command") },
			"command_output":    captured(cli, "command_output"),
			"file_edit":         captured(cli, "diff"),
			"mcp_call":          func(t *testing.T) { cli.find(t, "exec-0856099e-bdd6-4b92-bc66-a06d819386b0", "output") },
			"error":             captured(cli, "error"),
			"instructions":      captured(cli, "instruction"),
			"harness_context":   withCoverage(cli, "", "withheld_by_policy", "harness_context"),
			"native_records":    captured(cli, "native_record"),
		},
		"codex-desktop": {
			"prompt":             captured(desktop, "prompt"),
			"attachment_image":   captured(desktop, "attachment"),
			"reply":              captured(desktop, "reply"),
			"reasoning_summary":  captured(desktop, "reasoning"),
			"reasoning_raw":      withCoverage(desktop, "raw", "source_unavailable", "encrypted_at_source"),
			"command":            func(t *testing.T) { desktop.find(t, "exec-a229ac61-db3a-4ceb-a887-09b00cceac7f", "command") },
			"command_output":     func(t *testing.T) { captured(desktop, "command_output")(t); desktopTruncatedAtSource(t, desktop) },
			"compaction_summary": withCoverage(desktop, "summary", "source_unavailable", "encrypted_at_source"),
			"subagent":           captured(child, "reply"),
			"native_records":     captured(desktop, "native_record"),
			"tool_input":         captured(desktop, "tool_input"),
			"tool_output":        captured(desktop, "tool_output"),
			"file_edit":          captured(desktop, "file_content"),
			"instructions":       captured(desktop, "instruction"),
			"harness_context":    withCoverage(desktop, "", "withheld_by_policy", "harness_context"),
		},
	}
	cliRows := readManifest(t, "codex-cli")
	effective := map[string]map[string]manifestRow{"codex-cli": cliRows, "codex-desktop": {}}
	for class, row := range cliRows {
		effective["codex-desktop"][class] = row
	}
	for class, row := range readManifest(t, "codex-desktop") {
		effective["codex-desktop"][class] = row
	}
	for surface, rows := range effective {
		for class, row := range rows {
			if row.As != "content" {
				continue
			}
			check, checked := checks[surface][class]
			if !checked {
				t.Errorf("%s states %s %s but nothing checks it against its own fixtures: state it not_exercised there", surface, class, row.ExpectedState)
				continue
			}
			if surface == "codex-cli" && strings.Contains(row.Note+strings.Join(row.Evidence, " "), "codex-desktop") {
				t.Errorf("codex-cli states %s from Desktop's evidence", class)
			}
			t.Run(surface+"/"+class, check)
		}
	}
	t.Run("codex-cli/attachment_file", func(t *testing.T) { expectOnlyImages(t, cli) })
}

func expectNone(t *testing.T, parsed parsedRollout, part string) {
	t.Helper()
	if found := parsed.where(func(item agent.ContentItem) bool { return item.Part == part }); len(found) != 0 {
		t.Fatalf("%d %s parts declared", len(found), part)
	}
}

func expectOnlyImages(t *testing.T, parsed parsedRollout) {
	t.Helper()
	for _, found := range parsed.where(func(item agent.ContentItem) bool { return item.Channel == "attachment" }) {
		if !strings.HasPrefix(found.item.Part, "image:") {
			t.Fatalf("a file attachment %s %s", found.item.NativeRef, found.item.Part)
		}
	}
}

func desktopTruncatedAtSource(t *testing.T, parsed parsedRollout) {
	t.Helper()
	if found := parsed.where(func(item agent.ContentItem) bool { return item.SourceTruncated && item.Channel == "command_output" }); len(found) == 0 {
		t.Fatal("no command output declared as cut by Codex")
	}
}

type manifestRow struct {
	As            string   `json:"as"`
	ExpectedState string   `json:"expected_state"`
	Note          string   `json:"note"`
	Evidence      []string `json:"evidence"`
}

func readManifest(t *testing.T, surface string) map[string]manifestRow {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(contracttest.SourceDir(t, surface), "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		ExpectedCoverage map[string]manifestRow `json:"expected_coverage"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	return manifest.ExpectedCoverage
}

func TestContentFileIsTheRolloutAHookNames(t *testing.T) {
	codex := New()
	rollout := contracttest.HostPath("/home/user/.codex/sessions/2026/10/09/rollout-2026-10-09T10-14-24-" + cliThread + ".jsonl")
	// Stop names the rollout too, so the final answer need not wait for the
	// next poll.
	for _, event := range []string{"SessionStart", "UserPromptSubmit", "PreToolUse", "Stop"} {
		if path, ok := codex.ContentFile(event, map[string]any{"session_id": cliThread, "transcript_path": rollout}); !ok || path != rollout {
			t.Errorf("%s names %q %v", event, path, ok)
		}
	}
	refused := []struct {
		event   string
		payload map[string]any
	}{
		{"SessionEnd", map[string]any{"session_id": cliThread, "transcript_path": rollout}},
		// The rollout of another thread is never this session's file.
		{"SessionStart", map[string]any{"session_id": cliThread, "transcript_path": contracttest.HostPath("/home/user/.codex/sessions/2026/10/09/rollout-2026-10-09T10-14-30-01a12103-f912-7191-ac17-e29079b4869f.jsonl")}},
		{"SessionStart", map[string]any{"session_id": cliThread, "transcript_path": "rollout.jsonl"}},
		{"SessionStart", map[string]any{"session_id": cliThread, "transcript_path": contracttest.HostPath("/home/user/notes.txt")}},
		// codex-cli 0.161: a subagent's hooks carry the parent's session_id
		// beside the child's agent_id and transcript_path.
		{"SubagentStart", map[string]any{"session_id": cliThread, "agent_id": "01a12103-f912-7191-ac17-e29079b4869f", "transcript_path": rollout}},
		{"PreToolUse", map[string]any{"session_id": cliThread, "agent_id": "01a12103-f912-7191-ac17-e29079b4869f", "transcript_path": rollout}},
	}
	for _, c := range refused {
		if path, ok := codex.ContentFile(c.event, c.payload); ok {
			t.Errorf("%s %v named %q", c.event, c.payload, path)
		}
	}
}

func TestDataURLImagesDecode(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\nfixture")
	line := rolloutLineOf(t, "response_item", map[string]any{"type": "message", "id": "msg_inline", "role": "user",
		"content": []any{map[string]any{"type": "input_image", "image_url": "data:image/png;base64," + base64.StdEncoding.EncodeToString(png)}}})
	parsed := parseRolloutLines(t, [][]byte{line}, 1, ID, cliThread)
	if image := parsed.find(t, "msg_inline", "image:0"); !bytes.Equal(image.item.Data, png) || image.item.MediaType != "image/png" {
		t.Fatalf("decoded %q as %s", image.item.Data, image.item.MediaType)
	}
}

// Amendment 31: the app-server's deltas are not a source, but they are the
// evidence that a completed record loses nothing of what streamed.
func TestDesktopCompletedItemsHoldEveryStreamedDelta(t *testing.T) {
	parsed := parseFixture(t, "codex-desktop", "rollout-main.jsonl.gz", DesktopID, desktopMain)
	replies := map[string]string{}
	summaries := map[string][]string{}
	for _, line := range fixtureRolloutLines(t, "codex-desktop", "appserver-transcript.jsonl.gz") {
		var entry struct {
			Msg struct {
				Method string `json:"method"`
				Params struct {
					ThreadID     string `json:"threadId"`
					ItemID       string `json:"itemId"`
					Delta        string `json:"delta"`
					SummaryIndex int    `json:"summaryIndex"`
				} `json:"params"`
			} `json:"msg"`
		}
		if err := json.Unmarshal(line, &entry); err != nil {
			t.Fatal(err)
		}
		params := entry.Msg.Params
		if params.ThreadID != desktopMain {
			continue
		}
		switch entry.Msg.Method {
		case "item/agentMessage/delta":
			replies[params.ItemID] += params.Delta
		case "item/reasoning/summaryTextDelta":
			for len(summaries[params.ItemID]) <= params.SummaryIndex {
				summaries[params.ItemID] = append(summaries[params.ItemID], "")
			}
			summaries[params.ItemID][params.SummaryIndex] += params.Delta
		}
	}
	if len(replies) == 0 || len(summaries) == 0 {
		t.Fatalf("the transcript streamed %d replies and %d summaries", len(replies), len(summaries))
	}
	for id, streamed := range replies {
		var declared strings.Builder
		for _, found := range parsed.where(func(item agent.ContentItem) bool { return item.NativeRef == id && item.Channel == "reply" }) {
			declared.WriteString(bodyOf(t, found))
		}
		if declared.String() != streamed {
			t.Errorf("reply %s declared %q, streamed %q", id, declared.String(), streamed)
		}
	}
	for id, parts := range summaries {
		if declared := bodyOf(t, parsed.find(t, id, "summary")); declared != strings.Join(parts, "\n\n") {
			t.Errorf("summary %s declared %q, streamed %q", id, declared, parts)
		}
	}
}

// An item started or updated is not yet what it will be: only its
// completed record declares it, once.
func TestAStartedOrUpdatedItemDeclaresNothing(t *testing.T) {
	command := func(kind, stdout, status string) []byte {
		return rolloutLineOf(t, "event_msg", map[string]any{"type": kind, "thread_id": cliThread, "turn_id": "turn-s", "item": map[string]any{
			"type": "CommandExecution", "id": "exec-streaming", "command": []any{"/bin/zsh", "-lc", "make test"},
			"status": status, "stdout": stdout, "stderr": "", "aggregated_output": stdout,
		}})
	}
	lines := [][]byte{
		command("item_started", "", "in_progress"),
		command("item_updated", "ok 1/3\n", "in_progress"),
		command("item_completed", "ok 1/3\nok 2/3\nok 3/3\n", "completed"),
	}
	parsed := parseRolloutLines(t, lines, 1, ID, cliThread)
	for _, number := range []int{1, 2} {
		if items := parsed.onLine(number); len(items) != 0 {
			t.Fatalf("line %d declared %+v", number, items)
		}
	}
	if stdout := parsed.find(t, "exec-streaming", "stdout"); stdout.line != 3 || bodyOf(t, stdout) != "ok 1/3\nok 2/3\nok 3/3\n" {
		t.Fatalf("stdout from line %d: %q", stdout.line, bodyOf(t, stdout))
	}
}

// Content joins the events by call id: every tool_use_id the hooks named
// for an item in the rollout is some item's call_id, and the code-mode
// script's call_… id appears only on the script and as the parent.
func TestCallIDsAreTheOnesTheHooksAndTracesName(t *testing.T) {
	parsed := parseFixture(t, "codex-cli", "rollout-main.jsonl", ID, cliThread)
	rollout := bytes.Join(fixtureRolloutLines(t, "codex-cli", "rollout-main.jsonl"), []byte("\n"))
	named := 0
	for _, line := range fixtureRolloutLines(t, "codex-cli", "hooks.jsonl") {
		var hook struct {
			Payload struct {
				ToolUseID string `json:"tool_use_id"`
			} `json:"payload"`
		}
		json.Unmarshal(line, &hook)
		id := hook.Payload.ToolUseID
		if id == "" || !bytes.Contains(rollout, []byte(`"id":"`+id+`"`)) {
			continue
		}
		named++
		if len(parsed.where(func(item agent.ContentItem) bool { return item.CallID == id })) == 0 {
			t.Errorf("no content carries the hooks' tool_use_id %s", id)
		}
	}
	if named < 10 {
		t.Fatalf("only %d hook tool_use_ids name rollout items", named)
	}
	scriptRefs := regexp.MustCompile(`^(ctc|ctco|fc|fco)_`)
	for _, found := range parsed.items {
		if strings.HasPrefix(found.item.CallID, "call_") && !scriptRefs.MatchString(found.item.NativeRef) {
			t.Errorf("%s %s carries the script's call id %s as its own", found.item.NativeRef, found.item.Part, found.item.CallID)
		}
	}
}

// Late richer content in the other order: the ciphertext's response_item
// first, the completed item with the raw text after. A placeholder comes
// only from the designated item, never from the response_item.
func TestRawReasoningAfterItsCiphertextIsStillDeclaredWithItsText(t *testing.T) {
	lines := [][]byte{
		rolloutLineOf(t, "response_item", map[string]any{"type": "reasoning", "id": "rs_raw2", "summary": []any{}, "encrypted_content": "gAAAAAopaque", "internal_chat_message_metadata_passthrough": map[string]any{"turn_id": "turn-r"}}),
		rolloutLineOf(t, "event_msg", map[string]any{"type": "item_completed", "thread_id": cliThread, "turn_id": "turn-r", "item": map[string]any{"type": "Reasoning", "id": "rs_raw2", "summary_text": []any{}, "raw_content": []any{"thinking out loud"}}}),
	}
	parsed := parseRolloutLines(t, lines, 1, ID, cliThread)
	if items := parsed.onLine(1); len(items) != 0 {
		t.Fatalf("the response_item declared %+v", items)
	}
	raw := parsed.find(t, "rs_raw2", "raw")
	if raw.line != 2 || bodyOf(t, raw) != "thinking out loud" {
		t.Fatalf("raw from line %d: %+v", raw.line, raw.item)
	}
}
