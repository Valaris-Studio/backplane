// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
	"github.com/Valaris-Studio/backplane/companion/internal/contracttest"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
)

// The Codex rollout reader on the daemon's content path, driven by the
// RC-01 rollouts moved into the fixture's home, repository and clock.
const (
	codexCLIThread     = "01a11e74-ad36-7893-afd8-05a514c3a3e3"
	codexDesktopThread = "01a11e78-585e-7f63-af3f-d7e55122bdd2"
	codexDesktopChild  = "01a11e78-d358-7811-8b36-b8d2d969cc0f"
)

// codexContentFixture is Codex CLI and Desktop with mapping m1 at level;
// a rich mapping is granted by the offer.
func codexContentFixture(t *testing.T, level string) *fixture {
	t.Helper()
	f := desktopFixture(t)
	f.server.Lock()
	mapping := richMappingOf(f)
	mapping.ContentLevel = level
	f.server.Policy.Mappings = []policy.Mapping{mapping}
	f.server.Policy.RichCapture = offerFor(map[string]time.Time{})
	if level == "rich" {
		f.server.Policy.RichCapture = offerFor(map[string]time.Time{richMapping: richGrantedAt})
	}
	f.server.Unlock()
	f.forcePolicyRefresh(t)
	f.setupDone = *f.clock
	return f
}

var (
	fixtureTimestamp = regexp.MustCompile(`"(2026-10-09T[0-9:.]+Z)"`)
	lineTimestamp    = regexp.MustCompile(`^\{"timestamp":"([^"]+)"`)
)

// fixtureRolloutLines are an RC-01 rollout's lines, newline included, with
// its paths moved into the fixture and its times moved so its first line
// is at began.
func (f *fixture) fixtureRolloutLines(t *testing.T, surface, file string, began time.Time) []string {
	t.Helper()
	opened, err := os.Open(filepath.Join(contracttest.SourceDir(t, surface), file))
	if err != nil {
		t.Fatal(err)
	}
	defer opened.Close()
	var reader io.Reader = opened
	if strings.HasSuffix(file, ".gz") {
		if reader, err = gzip.NewReader(opened); err != nil {
			t.Fatal(err)
		}
	}
	paths := fixturePathReplacer(f.repo, filepath.Join(f.home, ".codex"))
	var lines []string
	var shift time.Duration
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(nil, 8<<20)
	for scanner.Scan() {
		line := paths.Replace(scanner.Text())
		if lines == nil {
			first, _ := time.Parse(time.RFC3339Nano, fixtureTimestamp.FindStringSubmatch(line)[1])
			shift = began.Sub(first)
		}
		line = fixtureTimestamp.ReplaceAllStringFunc(line, func(quoted string) string {
			at, _ := time.Parse(time.RFC3339Nano, strings.Trim(quoted, `"`))
			return `"` + at.Add(shift).UTC().Format("2006-01-02T15:04:05.000Z") + `"`
		})
		lines = append(lines, line+"\n")
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	return lines
}

// fixtureRolloutLinesAt are fixtureRolloutLines moved so that line number
// anchor is at at.
func (f *fixture) fixtureRolloutLinesAt(t *testing.T, surface, file string, anchor int, at time.Time) []string {
	t.Helper()
	lines := f.fixtureRolloutLines(t, surface, file, at)
	moved, _ := time.Parse(time.RFC3339Nano, lineTimestamp.FindStringSubmatch(lines[anchor-1])[1])
	return f.fixtureRolloutLines(t, surface, file, at.Add(at.Sub(moved)))
}

// jsonPath is path as it appears inside a JSON string, so a Windows path's
// backslashes stay escaped when spliced into a rollout line.
func jsonPath(path string) string {
	quoted, _ := json.Marshal(path)
	return string(quoted[1 : len(quoted)-1])
}

// fixturePathReplacer moves RC-01's paths to repo and codexHome inside
// rollout JSON text. A code-mode workdir ("workdir":"…" or workdir:"…") is a
// string literal inside a JSON string, so its path is escaped twice; those
// pairs come first so the replacer matches them before the plain spelling,
// which every other occurrence, prose included, keeps.
func fixturePathReplacer(repo, codexHome string) *strings.Replacer {
	moves := []struct{ from, to string }{
		{"/private/tmp/fixture-desktop-repo", repo}, {"/tmp/fixture-desktop-repo", repo},
		{"/private/tmp/fixture-repo", repo}, {"/tmp/fixture-repo", repo},
		{"/home/fixture/.codex", codexHome},
	}
	var pairs []string
	for _, workdir := range []string{`\"workdir\":\"`, `workdir:\"`} {
		for _, move := range moves {
			pairs = append(pairs, workdir+move.from, workdir+jsonPath(jsonPath(move.to)))
		}
	}
	for _, move := range moves {
		pairs = append(pairs, move.from, jsonPath(move.to))
	}
	return strings.NewReplacer(pairs...)
}

// A fixture path is spliced into rollout JSON text, also where the rollout
// holds it twice encoded (a tool call's arguments string): a Windows path's
// backslashes must stay escaped at each level, or the line stops being JSON.
func TestAFixturePathSplicedIntoARolloutLineStaysJSON(t *testing.T) {
	for _, path := range []string{`C:\a\b`, `C:\Users\qa\AppData\Local\Temp\home\code\app`, "/home/qa/code/app"} {
		paths := fixturePathReplacer(path, path)
		line := paths.Replace(`{"type":"session_meta","payload":{"cwd":"/tmp/fixture-repo"}}`)
		var decoded struct {
			Payload struct {
				Cwd string `json:"cwd"`
			} `json:"payload"`
		}
		if err := json.Unmarshal([]byte(line), &decoded); err != nil || decoded.Payload.Cwd != path {
			t.Fatalf("%q spliced into %s decodes as %q, %v", path, line, decoded.Payload.Cwd, err)
		}
		call := paths.Replace(`{"arguments":"{\"workdir\":\"/tmp/fixture-repo\"}"}`)
		var outer struct {
			Arguments string `json:"arguments"`
		}
		var inner struct {
			Workdir string `json:"workdir"`
		}
		if err := json.Unmarshal([]byte(call), &outer); err != nil {
			t.Fatalf("%q spliced into %s: %v", path, call, err)
		}
		if err := json.Unmarshal([]byte(outer.Arguments), &inner); err != nil || inner.Workdir != path {
			t.Fatalf("%q spliced into the arguments %s decodes as %q, %v", path, outer.Arguments, inner.Workdir, err)
		}
		// The code-mode script's own spelling, a JavaScript string literal.
		var input struct {
			Input string `json:"input"`
		}
		script := paths.Replace(`{"input":"tools.exec_command({cmd:\"ls\",workdir:\"/tmp/fixture-repo\"})"}`)
		if err := json.Unmarshal([]byte(script), &input); err != nil {
			t.Fatalf("%q spliced into %s: %v", path, script, err)
		}
		literal := strings.TrimSuffix(strings.SplitN(input.Input, "workdir:", 2)[1], "})")
		if workdir, err := strconv.Unquote(literal); err != nil || workdir != path {
			t.Fatalf("%q spliced into the script %s reads as %q, %v", path, input.Input, workdir, err)
		}
		// Prose quoting a path holds it once encoded, as the agent wrote it.
		var prose struct {
			Text string `json:"text"`
		}
		if err := json.Unmarshal([]byte(paths.Replace(`{"text":"<image path=\"/tmp/fixture-repo/swatch.png\">"}`)), &prose); err != nil || prose.Text != `<image path="`+path+`/swatch.png">` {
			t.Fatalf("%q spliced into prose reads as %q, %v", path, prose.Text, err)
		}
	}
}

func (f *fixture) codexRollout(thread string) string {
	return filepath.Join(f.home, ".codex", "sessions", "2026", "10", "08", "rollout-2026-10-08T22-18-46-"+thread+".jsonl")
}

func writeLines(t *testing.T, path string, lines []string) {
	t.Helper()
	appendSession(t, path, strings.Join(lines, ""))
}

// codexHook runs a Codex hook naming the thread's rollout.
func (f *fixture) codexHook(t *testing.T, thread, event, source string) {
	t.Helper()
	input, _ := json.Marshal(map[string]any{"session_id": thread, "transcript_path": f.codexRollout(thread), "cwd": f.repo, "hook_event_name": event, "model": "gpt-6-luna", "permission_mode": "default", "source": source})
	if err := f.shim.Handle("codex", bytes.NewReader(input)); err != nil {
		t.Fatal(err)
	}
}

func declarationsByKey(f *fixture) map[string][]map[string]any {
	found := map[string][]map[string]any{}
	for _, declaration := range f.server.Declarations() {
		key := declaration["content_key"].(string)
		found[key] = append(found[key], declaration)
	}
	return found
}

func inlineTextOf(declarations []map[string]any) string {
	if len(declarations) != 1 {
		return ""
	}
	inline, _ := declarations[0]["inline_text"].(string)
	return inline
}

func contentRecords(f *fixture) []map[string]any {
	var found []map[string]any
	for _, record := range f.server.Records() {
		if contents, _ := record["contents"].([]any); len(contents) > 0 {
			found = append(found, record)
		}
	}
	return found
}

func usageLinesOf(lines []string, thread string) int {
	count := 0
	for _, line := range lines {
		if strings.Contains(line, `"type":"token_usage_record"`) && strings.Contains(line, `"thread_id":"`+thread+`"`) {
			count++
		}
	}
	return count
}

// The CLI as a hook names it: every native item once, the bodies verified
// by the server, usage counted once from the rollout and never by content.
func TestACodexCLISessionIsCapturedOnceBesideItsUsage(t *testing.T) {
	f := codexContentFixture(t, "rich")
	began := f.since(t, 10*time.Second)
	lines := f.fixtureRolloutLines(t, "codex-cli", "rollout-main.jsonl", began)
	f.codexHook(t, codexCLIThread, "SessionStart", "startup")
	writeLines(t, f.codexRollout(codexCLIThread), lines)
	f.since(t, 10*time.Minute)
	f.tickUntilSettled(t)

	declared := declarationsByKey(f)
	for key, declarations := range declared {
		if len(declarations) != 1 {
			t.Fatalf("%s declared %d times", key, len(declarations))
		}
	}
	key := func(ref, part string) string { return agent.ContentKey(codex.ID, codexCLIThread, ref, part) }
	if body := f.server.Body(key("01a11e74-c2f3-70a2-9353-38d7dcca1633", "text:2")); !strings.HasPrefix(string(body), "In one line, name the two dominant colors") {
		t.Fatalf("prompt body %q", body)
	}
	swatch, _ := os.ReadFile(filepath.Join(contracttest.SourceDir(t, "codex-cli"), "swatch.png"))
	if body := f.server.Body(key("msg_01a11e74-c2f3-70a2-9353-38c2c70d62f1", "image:1")); !bytes.Equal(body, swatch) {
		t.Fatalf("the attached image arrived as %d bytes", len(body))
	}
	if body := f.server.Body(key("exec-108385a1-d77d-46dd-b61a-d2774fe910fa", "stdout")); len(body) != 90090 {
		t.Fatalf("the 90,090-byte command output arrived as %d bytes", len(body))
	}
	if body := f.server.Body(key("exec-03edcc97-aa71-4a66-9a1a-51189cde38c4", "diff:calc.py")); !strings.Contains(string(body), "+    return a + b") {
		t.Fatalf("the apply_patch diff under its placed path: %q", body)
	}
	editRecord := f.server.Body(key("exec-03edcc97-aa71-4a66-9a1a-51189cde38c4", "native"))
	if editRecord == nil {
		editRecord = []byte(inlineTextOf(declarationsByKey(f)[key("exec-03edcc97-aa71-4a66-9a1a-51189cde38c4", "native")]))
	}
	if !strings.Contains(string(editRecord), `"unified_diff":{"backplane_content_ref":"`+key("exec-03edcc97-aa71-4a66-9a1a-51189cde38c4", "diff:calc.py")+`"}`) {
		t.Fatalf("the edit's native record does not reference its placed diff: %s", editRecord)
	}
	for _, record := range contentRecords(f) {
		if events, _ := record["events"].([]any); record["harness"] != codex.ID || len(events) != 0 || record["native_session_id"] != codexCLIThread {
			t.Fatalf("content record %v", record)
		}
	}
	usage := 0
	for _, record := range usageRecords(f.server.Records()) {
		usage += len(record["events"].([]any))
	}
	if want := usageLinesOf(lines, codexCLIThread); usage != want {
		t.Fatalf("usage counted %d times, the rollout records %d responses", usage, want)
	}
	encoded, _ := json.Marshal(f.server.Records())
	for _, local := range []string{f.home, "file://"} {
		if strings.Contains(string(encoded), local) {
			t.Fatalf("%q left the device", local)
		}
	}
}

// Desktop runs no hooks: discovery finds the rollout and its subagent's,
// the header admits the first turn, and the harness is Desktop's.
func TestACodexDesktopSessionIsFoundWithoutHooks(t *testing.T) {
	f := codexContentFixture(t, "rich")
	began := f.since(t, 10*time.Second)
	writeLines(t, f.codexRollout(codexDesktopThread), f.fixtureRolloutLines(t, "codex-desktop", "rollout-main.jsonl.gz", began))
	writeLines(t, f.codexRollout(codexDesktopChild), f.fixtureRolloutLines(t, "codex-desktop", "rollout-subagent.jsonl", began.Add(31*time.Second)))
	// A CLI session of the same mapping and generation, beside it.
	f.codexHook(t, codexCLIThread, "SessionStart", "startup")
	writeLines(t, f.codexRollout(codexCLIThread), f.fixtureRolloutLines(t, "codex-cli", "rollout-main.jsonl", began))
	f.since(t, 10*time.Minute)
	f.tickUntilSettled(t)
	for key, declarations := range declarationsByKey(f) {
		if len(declarations) != 1 {
			t.Fatalf("%s declared %d times", key, len(declarations))
		}
	}

	key := func(session, ref, part string) string { return agent.ContentKey(codex.DesktopID, session, ref, part) }
	if body := f.server.Body(key(codexDesktopThread, "01a11e78-61dc-7d63-8fcd-ad7574631429", "text:1")); len(body) == 0 {
		t.Fatal("the first prompt, written before discovery found the file, is missing")
	}
	truncated := declarationsByKey(f)[key(codexDesktopThread, "exec-e4bb0390-612d-4308-bcfd-e40a530bc99d", "stdout")]
	if len(truncated) != 1 || truncated[0]["coverage"] != "truncated" || truncated[0]["coverage_reason"] != "source_limit" || truncated[0]["original_byte_count"] != float64(1200017) {
		t.Fatalf("the output Codex cut: %v", truncated)
	}
	if copies := declarationsByKey(f)[key(codexDesktopThread, "msg_01a11e78-61dc-7d63-8fcd-ad68c9bc6acb", "image:1")]; len(copies) != 1 {
		t.Fatalf("the image compaction re-copied is declared %d times", len(copies))
	}
	if body := f.server.Body(key(codexDesktopChild, "msg_086d8e06a084ea5d016ac8501973208193b22171ff2bf68f90", "text:0")); len(body) == 0 {
		t.Fatal("the subagent's reply is missing from its own session")
	}
	// One generation, named per harness: the same id on every Desktop
	// record, read after read, and another one on the CLI's.
	generations := map[any]map[any]bool{}
	sessions := map[any]bool{}
	for _, record := range contentRecords(f) {
		generation, _ := record["capture_generation"].(map[string]any)
		if generations[record["harness"]] == nil {
			generations[record["harness"]] = map[any]bool{}
		}
		generations[record["harness"]][generation["id"]] = true
		if record["harness"] == codex.DesktopID {
			sessions[record["native_session_id"]] = true
		}
	}
	desktopIDs, cliIDs := generations[codex.DesktopID], generations[codex.ID]
	if len(desktopIDs) != 1 || len(cliIDs) != 1 || fmt.Sprint(desktopIDs) == fmt.Sprint(cliIDs) || len(contentRecords(f)) < 3 {
		t.Fatalf("generation ids by harness %v over %d records", generations, len(contentRecords(f)))
	}
	if fmt.Sprint(sessions) != fmt.Sprint(map[any]bool{codexDesktopThread: true, codexDesktopChild: true}) {
		t.Fatalf("Desktop content sessions %v", sessions)
	}
}

// Resuming a session begun before capture reads none of what it said
// then: only the new turn is content.
func TestAResumedCodexSessionCapturesOnlyItsNewTurn(t *testing.T) {
	f := codexContentFixture(t, "rich")
	lines := f.fixtureRolloutLines(t, "codex-cli", "rollout-main.jsonl", f.setupDone.Add(-time.Minute))
	writeLines(t, f.codexRollout(codexCLIThread), lines[:54])
	f.since(t, 5*time.Second)
	f.codexHook(t, codexCLIThread, "SessionStart", "resume")
	f.tick(t)
	writeLines(t, f.codexRollout(codexCLIThread), lines[54:91])
	f.since(t, 10*time.Minute)
	f.tickUntilSettled(t)
	declared := declarationsByKey(f)
	key := func(ref, part string) string { return agent.ContentKey(codex.ID, codexCLIThread, ref, part) }
	if len(declared[key("01a11e74-c2f3-70a2-9353-38d7dcca1633", "text:2")]) != 0 {
		t.Fatal("the turn before capture began was declared")
	}
	if len(declared[key("01a11e76-4485-7f30-b83e-d26b95a53180", "text:0")]) != 1 {
		t.Fatalf("the resumed turn's correction is missing: %d declared", len(declared))
	}
}

// A line half written is read once it is whole, and only then.
func TestAPartlyWrittenRolloutLineIsDeclaredOnceComplete(t *testing.T) {
	f := codexContentFixture(t, "rich")
	lines := f.fixtureRolloutLines(t, "codex-cli", "rollout-main.jsonl", f.since(t, 10*time.Second))
	path := f.codexRollout(codexCLIThread)
	f.codexHook(t, codexCLIThread, "SessionStart", "startup")
	prompt := lines[9]
	writeLines(t, path, append(append([]string{}, lines[:9]...), prompt[:len(prompt)/2]))
	f.since(t, time.Minute)
	f.tick(t)
	f.tick(t)
	key := agent.ContentKey(codex.ID, codexCLIThread, "01a11e74-c2f3-70a2-9353-38d7dcca1633", "text:2")
	if len(declarationsByKey(f)[key]) != 0 {
		t.Fatal("a half-written line was declared")
	}
	writeLines(t, path, []string{prompt[len(prompt)/2:]})
	f.tickUntilSettled(t)
	if declared := declarationsByKey(f)[key]; len(declared) != 1 {
		t.Fatalf("the completed line declared %d times", len(declared))
	}
}

// A Standard mapping keeps Codex events-only: the rollout's usage is
// counted, nothing of it becomes content.
func TestAStandardCodexMappingStaysEventsOnly(t *testing.T) {
	f := codexContentFixture(t, "standard")
	lines := f.fixtureRolloutLines(t, "codex-cli", "rollout-main.jsonl", f.since(t, 10*time.Second))
	f.codexHook(t, codexCLIThread, "SessionStart", "startup")
	writeLines(t, f.codexRollout(codexCLIThread), lines)
	f.since(t, 10*time.Minute)
	for range 5 {
		f.tick(t)
		*f.clock = f.clock.Add(time.Second)
	}
	if declared := f.server.Declarations(); len(declared) != 0 {
		t.Fatalf("a standard mapping declared %d contents", len(declared))
	}
	if len(usageRecords(f.server.Records())) == 0 {
		t.Fatal("the rollout's usage was not counted")
	}
}

// A thread whose traces count its usage keeps them: its content adds no
// usage, and its rollout's usage is not read.
func TestTracedCodexUsageIsNotCountedAgainByContent(t *testing.T) {
	f := codexContentFixture(t, "rich")
	began := f.since(t, 10*time.Second)
	f.codexHook(t, codexCLIThread, "SessionStart", "startup")
	f.appendRuntime(t, traceUsage(codexCLIThread, codex.ID, "01a11e74-b87f-70c1-b545-73f2c743f983", 620))
	writeLines(t, f.codexRollout(codexCLIThread), f.fixtureRolloutLines(t, "codex-cli", "rollout-main.jsonl", began))
	f.since(t, 10*time.Minute)
	f.tickUntilSettled(t)
	if found := usageBy(f.server.Records()); fmt.Sprint(found) != "map[codex_cli/otlp:[620]]" {
		t.Fatalf("usage %v, want the trace's alone", found)
	}
	if len(f.server.Declarations()) == 0 {
		t.Fatal("no content declared beside the traces")
	}
}

// The hookless Desktop path has no hook to gate it, so the windows alone
// decide: what a session says while its mapping is not rich (standard,
// paused, the offer withdrawn, Codex switched off) is never declared, the backlog of the
// window before (written, not yet read) is declared under its own
// generation, and returning to rich starts a new generation that never
// backfills the gap.
func TestDesktopContentFollowsPolicyChangesWithoutHooks(t *testing.T) {
	setMapping := func(level string, grants map[string]time.Time) func(t *testing.T, f *fixture) {
		return func(t *testing.T, f *fixture) {
			f.server.Lock()
			f.server.Policy.Mappings[0].ContentLevel = level
			f.server.Policy.RichCapture = offerFor(grants)
			f.server.Unlock()
			f.forcePolicyRefresh(t)
		}
	}
	paused := func(on bool) func(t *testing.T, f *fixture) {
		return func(t *testing.T, f *fixture) {
			f.setPaused(t, on)
			*f.clock = f.clock.Add(time.Second)
			f.tick(t)
		}
	}
	// Desktop follows the Codex switch (policy.AgentEnabled): switching
	// Codex off and on is a gap of Desktop's windows too, by timestamp.
	codexEnabled := func(on bool) func(t *testing.T, f *fixture) {
		return func(t *testing.T, f *fixture) {
			f.server.Lock()
			f.server.Policy.Installation.EnabledAgents = []string{"claude_code"}
			if on {
				f.server.Policy.Installation.EnabledAgents = append(f.server.Policy.Installation.EnabledAgents, "codex_cli", "codex_desktop")
			}
			f.server.Unlock()
			f.forcePolicyRefresh(t)
		}
	}
	cases := map[string]struct {
		leave, back func(t *testing.T, f *fixture)
	}{
		"standard":       {setMapping("standard", map[string]time.Time{}), nil},
		"paused":         {paused(true), paused(false)},
		"withdrawn":      {setMapping("rich", map[string]time.Time{}), nil},
		"codex disabled": {codexEnabled(false), codexEnabled(true)},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			f := codexContentFixture(t, "rich")
			path := f.codexRollout(codexDesktopThread)
			turn1 := f.fixtureRolloutLines(t, "codex-desktop", "rollout-main.jsonl.gz", f.since(t, 10*time.Second))
			// Read up to the prompt, so the file has its cursor; the rest of
			// the turn is backlog when the policy changes.
			writeLines(t, path, turn1[:9])
			*f.clock = f.clock.Add(15 * time.Second)
			f.tick(t)
			writeLines(t, path, turn1[9:29])
			change.leave(t, f)
			writeLines(t, path, f.fixtureRolloutLinesAt(t, "codex-desktop", "rollout-main.jsonl.gz", 30, f.stamp())[29:55])
			*f.clock = f.clock.Add(time.Minute)
			f.tick(t)
			f.tick(t)
			back := change.back
			if back == nil {
				back = func(t *testing.T, f *fixture) {
					setMapping("rich", map[string]time.Time{richMapping: *f.clock})(t, f)
				}
			}
			back(t, f)
			writeLines(t, path, f.fixtureRolloutLinesAt(t, "codex-desktop", "rollout-main.jsonl.gz", 56, f.stamp())[55:90])
			*f.clock = f.clock.Add(time.Minute)
			f.tickUntilSettled(t)

			key := func(ref string, part string) string {
				return agent.ContentKey(codex.DesktopID, codexDesktopThread, ref, part)
			}
			declared := declarationsByKey(f)
			before, during, after := key("01a11e78-61dc-7d63-8fcd-ad7574631429", "text:1"), key("01a11e78-7d3b-7603-ab2e-85b6a425ef98", "text:0"), key("01a11e78-bcb9-7321-b3c2-bb301dfcdbed", "text:0")
			if len(declared[before]) != 1 || len(declared[after]) != 1 {
				t.Fatalf("declared before %d, after %d; want each once", len(declared[before]), len(declared[after]))
			}
			if len(declared[during]) != 0 {
				t.Fatal("a turn said while the mapping was not rich was declared")
			}
			if generationOf(t, f, before) == generationOf(t, f, after) {
				t.Fatal("returning to rich continued the old generation")
			}
		})
	}
}

// A CLI subagent's hooks name its own rollout beside its agent_id, so the
// child thread they record is a content source of its own: the child's
// content and usage are its own session's, the parent's are the parent's.
func TestACodexCLISubagentIsItsOwnContentSession(t *testing.T) {
	f := codexContentFixture(t, "rich")
	const parent, child = "01a12103-dd1f-7a01-8d95-bf9d35e041d1", "01a12103-f912-7191-ac17-e29079b4869f"
	at := f.since(t, 10*time.Second)
	reply := func(thread, id, text string) string {
		return rolloutLine(t, at.Add(2*time.Second), "event_msg", map[string]any{"type": "item_completed", "thread_id": thread, "turn_id": "turn-" + thread[:8], "item": map[string]any{"type": "AgentMessage", "id": id, "content": []any{map[string]any{"type": "Text", "text": text}}}})
	}
	session := func(thread, root string) string {
		return rolloutLine(t, at, "session_meta", map[string]any{"id": thread, "session_id": root, "timestamp": at.Format(time.RFC3339Nano), "cwd": f.repo, "originator": "codex_exec", "cli_version": "0.161.0"}) +
			rolloutLine(t, at.Add(time.Second), "turn_context", map[string]any{"turn_id": "turn-" + thread[:8], "cwd": f.repo, "model": "gpt-6-luna"})
	}
	appendSession(t, f.codexRollout(parent), session(parent, parent)+reply(parent, "msg_parent", "spawned and waited")+rolloutRecord(t, at.Add(3*time.Second), parent, "resp_parent", 40))
	appendSession(t, f.codexRollout(child), session(child, parent)+reply(child, "msg_child", "child-ok")+rolloutRecord(t, at.Add(3*time.Second), child, "resp_child", 7))
	f.codexHook(t, parent, "SessionStart", "startup")
	hook, _ := json.Marshal(map[string]any{"session_id": parent, "agent_id": child, "transcript_path": f.codexRollout(child), "cwd": f.repo, "hook_event_name": "SubagentStart", "model": "gpt-6-luna", "permission_mode": "default"})
	if err := f.shim.Handle("codex", bytes.NewReader(hook)); err != nil {
		t.Fatal(err)
	}
	f.since(t, 10*time.Minute)
	f.tickUntilSettled(t)
	if body := f.server.Body(agent.ContentKey(codex.ID, child, "msg_child", "text:0")); string(body) != "child-ok" {
		t.Fatalf("the child's reply in its own session: %q", body)
	}
	if body := f.server.Body(agent.ContentKey(codex.ID, parent, "msg_parent", "text:0")); string(body) != "spawned and waited" {
		t.Fatalf("the parent's reply: %q", body)
	}
	usage := map[any][]float64{}
	for _, record := range usageRecords(f.server.Records()) {
		for _, event := range record["events"].([]any) {
			usage[record["native_session_id"]] = append(usage[record["native_session_id"]], event.(map[string]any)["gen_ai"].(map[string]any)["usage"].(map[string]any)["output_tokens"].(float64))
		}
	}
	if fmt.Sprint(usage[parent]) != "[40]" || fmt.Sprint(usage[child]) != "[7]" {
		t.Fatalf("usage by session %v", usage)
	}
}

// The content twin of TestCodexRolloutOutsideTheSessionsDirectoryIsNeverRead:
// a hook may name any path; outside $CODEX_HOME/sessions it is never read.
func TestACodexRolloutOutsideTheSessionsDirectoryIsNeverReadForContent(t *testing.T) {
	f := codexContentFixture(t, "rich")
	elsewhere := filepath.Join(f.home, "elsewhere", "rollout-2026-10-08T22-18-46-"+codexCLIThread+".jsonl")
	writeLines(t, elsewhere, f.fixtureRolloutLines(t, "codex-cli", "rollout-main.jsonl", f.since(t, 10*time.Second)))
	input, _ := json.Marshal(map[string]any{"session_id": codexCLIThread, "transcript_path": elsewhere, "cwd": f.repo, "hook_event_name": "SessionStart", "model": "gpt-6-luna", "permission_mode": "default", "source": "startup"})
	if err := f.shim.Handle("codex", bytes.NewReader(input)); err != nil {
		t.Fatal(err)
	}
	f.since(t, 10*time.Minute)
	for range 5 {
		f.tick(t)
		*f.clock = f.clock.Add(time.Second)
	}
	if declared := f.server.Declarations(); len(declared) != 0 {
		t.Fatalf("a rollout outside ~/.codex/sessions was read for content: %d declarations", len(declared))
	}
	if _, found, _ := contentCursors(f.layout).Load(elsewhere); found {
		t.Fatal("a rollout outside ~/.codex/sessions has a content cursor")
	}
	// The positive control: the same rollout under ~/.codex/sessions, named
	// by the same hook, is read.
	inside := f.codexRollout(codexCLIThread)
	writeLines(t, inside, f.fixtureRolloutLines(t, "codex-cli", "rollout-main.jsonl", f.stamp()))
	input, _ = json.Marshal(map[string]any{"session_id": codexCLIThread, "transcript_path": inside, "cwd": f.repo, "hook_event_name": "UserPromptSubmit", "model": "gpt-6-luna", "permission_mode": "default"})
	if err := f.shim.Handle("codex", bytes.NewReader(input)); err != nil {
		t.Fatal(err)
	}
	f.since(t, 30*time.Minute)
	f.tickUntilSettled(t)
	if len(f.server.Declarations()) == 0 {
		t.Fatal("the same rollout inside ~/.codex/sessions was not read")
	}
	if _, found, _ := contentCursors(f.layout).Load(inside); !found {
		t.Fatal("the rollout inside ~/.codex/sessions has no content cursor")
	}
}
