// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package claudecode

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

const usageSession = "5f0c2d1e-usage-session"

var usageNow = time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)

type line map[string]any

// assistant builds one transcript line the way Claude Code writes it: one
// line per content block, each repeating the request's usage.
func assistant(messageID, requestID, timestamp string, usage map[string]any, content ...any) line {
	if content == nil {
		content = []any{map[string]any{"type": "text", "text": "SECRET_ASSISTANT_TEXT"}}
	}
	return line{
		"type": "assistant", "uuid": "u-" + messageID, "parentUuid": "p", "sessionId": usageSession,
		"version": "2.1.3", "cwd": "/SECRET/cwd", "gitBranch": "SECRET_BRANCH", "timestamp": timestamp, "requestId": requestID,
		"message": map[string]any{
			"id": messageID, "type": "message", "role": "assistant", "model": "claude-sonnet-4-5-20250929",
			"content": content, "stop_reason": nil, "usage": usage,
		},
	}
}

func tokens(input, cacheRead, cacheWrite, output int) map[string]any {
	return map[string]any{
		"input_tokens": input, "cache_read_input_tokens": cacheRead, "cache_creation_input_tokens": cacheWrite,
		"output_tokens": output, "service_tier": "standard",
	}
}

func encodeLines(t *testing.T, lines ...any) string {
	t.Helper()
	var builder strings.Builder
	for _, value := range lines {
		if raw, ok := value.(string); ok {
			builder.WriteString(raw + "\n")
			continue
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		builder.Write(encoded)
		builder.WriteByte('\n')
	}
	return builder.String()
}

type transcriptFixture struct {
	path     string
	cursor   json.RawMessage
	deferred int
}

func newTranscript(t *testing.T, content string) *transcriptFixture {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "projects", "-Users-me-app")
	path := filepath.Join(dir, usageSession+".jsonl")
	writeFile(t, path, content)
	return &transcriptFixture{path: path}
}

func (f *transcriptFixture) appendText(t *testing.T, text string) {
	t.Helper()
	file, err := os.OpenFile(f.path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	if _, err := file.WriteString(text); err != nil {
		t.Fatal(err)
	}
}

func (f *transcriptFixture) subagent(t *testing.T, name, content string, modified time.Time) string {
	t.Helper()
	path := filepath.Join(strings.TrimSuffix(f.path, ".jsonl"), "subagents", name)
	writeFile(t, path, content)
	if err := os.Chtimes(path, modified, modified); err != nil {
		t.Fatal(err)
	}
	return path
}

// read runs one boundary read and keeps the cursor for the next one.
func (f *transcriptFixture) read(t *testing.T, event string, now time.Time) []map[string]any {
	t.Helper()
	return f.readUntil(t, event, now, time.Time{})
}

// readUntil is a boundary read for a hook fired at until.
func (f *transcriptFixture) readUntil(t *testing.T, event string, now, until time.Time) []map[string]any {
	t.Helper()
	result, err := New().ReadUsage(agent.UsageRead{Transcript: f.path, SessionID: usageSession, Event: event, Now: now, Until: until}, f.cursor)
	if err != nil {
		t.Fatal(err)
	}
	f.cursor, f.deferred = result.Cursor, result.DeferredFiles
	events := result.Events
	decoded := make([]map[string]any, len(events))
	for index, raw := range events {
		if err := json.Unmarshal(raw, &decoded[index]); err != nil {
			t.Fatalf("event %d is not JSON: %s", index, raw)
		}
	}
	return decoded
}

func usageOf(t *testing.T, event map[string]any) map[string]any {
	t.Helper()
	usage, ok := dig(event, "gen_ai", "usage").(map[string]any)
	if !ok {
		t.Fatalf("event has no usage: %v", event)
	}
	return usage
}

func dig(value any, path ...string) any {
	for _, key := range path {
		object, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		value = object[key]
	}
	return value
}

func number(value any) int {
	if typed, ok := value.(float64); ok {
		return int(typed)
	}
	return -1
}

func TestUsageTranscriptOnlyAtResponseBoundaries(t *testing.T) {
	path := filepath.Join(t.TempDir(), "s.jsonl")
	claude := New()
	for event, want := range map[string]bool{"Stop": true, "SessionEnd": true, "SessionStart": true, "PreToolUse": false, "UserPromptSubmit": false} {
		got, ok := claude.UsageTranscript(event, map[string]any{"transcript_path": path, "source": "startup"})
		if ok != want || ok && got != path {
			t.Fatalf("%s: got %q %v", event, got, ok)
		}
	}
	for source, want := range map[any]bool{"startup": true, "resume": true, "compact": false, "clear": false, nil: false} {
		if _, ok := claude.UsageTranscript("SessionStart", map[string]any{"transcript_path": path, "source": source}); ok != want {
			t.Fatalf("SessionStart from %v: %v", source, ok)
		}
	}
	for _, rejected := range []any{"relative/s.jsonl", "/DO_NOT_OPEN_TRANSCRIPT", "/etc/passwd", nil, 42, "/a/s.jsonl\x00x", ""} {
		if got, ok := claude.UsageTranscript("Stop", map[string]any{"transcript_path": rejected}); ok {
			t.Fatalf("accepted %v as %q", rejected, got)
		}
	}
}

func TestUsageDedupesTheContentBlocksOfOneRequest(t *testing.T) {
	f := newTranscript(t, encodeLines(t,
		line{"type": "user", "sessionId": usageSession, "timestamp": "2026-09-25T11:00:00Z", "message": map[string]any{"role": "user", "content": "SECRET_PROMPT"}},
		assistant("msg_01", "req_01", "2026-09-25T11:00:01.100Z", tokens(3, 1000, 200, 1), map[string]any{"type": "thinking", "thinking": "SECRET_THINKING"}),
		assistant("msg_01", "req_01", "2026-09-25T11:00:01.200Z", tokens(3, 1000, 200, 1)),
		assistant("msg_01", "req_01", "2026-09-25T11:00:01.300Z", tokens(3, 1000, 200, 420), map[string]any{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": map[string]any{"command": "SECRET_TOOL_INPUT"}}),
		assistant("msg_02", "req_02", "2026-09-25T11:00:05Z", tokens(1, 1200, 0, 30)),
	))
	events := f.read(t, "Stop", usageNow)
	if len(events) != 2 {
		t.Fatalf("want one event per request, got %d: %v", len(events), events)
	}
	first := usageOf(t, events[0])
	if number(first["input_tokens"]) != 3 || number(dig(first, "cache_read", "input_tokens")) != 1000 ||
		number(dig(first, "cache_creation", "input_tokens")) != 200 || number(first["output_tokens"]) != 420 {
		t.Fatalf("the most complete copy must win: %v", first)
	}
	if events[0]["model"] != "claude-sonnet-4-5-20250929" || dig(events[0], "event", "action") != "token.usage" ||
		dig(events[0], "event", "category") != "metric" || dig(events[0], "event", "fidelity") != "observed" ||
		dig(events[0], "session", "id") != usageSession || dig(events[0], "harness", "name") != ID ||
		dig(events[0], "harness", "collection_method") != "poll" || first["service_tier"] != "standard" {
		t.Fatalf("event shape: %v", events[0])
	}
	if _, hasRaw := events[0]["raw"]; hasRaw || first["cost_usd"] != nil {
		t.Fatalf("no raw payload and no cost: the backend estimates it: %v", events[0])
	}
	if events[0]["timestamp"] != "2026-09-25T11:00:01.1Z" {
		t.Fatalf("timestamp is the request's first line: %v", events[0]["timestamp"])
	}
	if again := f.read(t, "Stop", usageNow); len(again) != 0 {
		t.Fatalf("a second read with no new lines re-emitted %d events", len(again))
	}
}

func TestUsageEventIDsAreDeterministicPerRequest(t *testing.T) {
	content := encodeLines(t,
		assistant("msg_01", "req_01", "2026-09-25T11:00:01Z", tokens(3, 0, 0, 5)),
		assistant("msg_01", "req_02", "2026-09-25T11:00:02Z", tokens(3, 0, 0, 5)),
	)
	first := newTranscript(t, content).read(t, "Stop", usageNow)
	second := newTranscript(t, content).read(t, "Stop", usageNow)
	if len(first) != 2 || len(second) != 2 {
		t.Fatalf("got %d and %d events", len(first), len(second))
	}
	for index := range first {
		if id := dig(first[index], "event", "id"); id != dig(second[index], "event", "id") {
			t.Fatalf("event %d id is not stable: %v vs %v", index, id, dig(second[index], "event", "id"))
		}
	}
	// The backend's per-session dedup key: sha256 of claude_code:usage:<message.id>:<requestId>.
	sum := sha256.Sum256([]byte("claude_code:usage:msg_01:req_01"))
	if dig(first[0], "event", "id") != hex.EncodeToString(sum[:]) {
		t.Fatalf("event id %v", dig(first[0], "event", "id"))
	}
	if dig(first[0], "event", "id") == dig(first[1], "event", "id") {
		t.Fatal("distinct requests share an event id")
	}
}

func TestUsageSplitsFiveMinuteAndOneHourCacheWrites(t *testing.T) {
	usage := tokens(10, 0, 3000, 50)
	usage["cache_creation"] = map[string]any{"ephemeral_5m_input_tokens": 1000, "ephemeral_1h_input_tokens": 2000}
	events := newTranscript(t, encodeLines(t, assistant("msg_01", "req_01", "2026-09-25T11:00:01Z", usage))).read(t, "Stop", usageNow)
	if len(events) != 1 {
		t.Fatalf("got %d events", len(events))
	}
	written := dig(usageOf(t, events[0]), "cache_creation").(map[string]any)
	if number(written["input_tokens"]) != 3000 || number(written["ephemeral_1h_input_tokens"]) != 2000 || len(written) != 2 {
		t.Fatalf("cache writes: %v", written)
	}
	plain := newTranscript(t, encodeLines(t, assistant("msg_01", "req_01", "2026-09-25T11:00:01Z", tokens(10, 0, 3000, 50)))).read(t, "Stop", usageNow)
	if written := dig(usageOf(t, plain[0]), "cache_creation").(map[string]any); len(written) != 1 || number(written["input_tokens"]) != 3000 {
		t.Fatalf("without a split the 1h share is omitted: %v", written)
	}
}

func TestUsageHoldsBackAPartialLastLineUntilItIsComplete(t *testing.T) {
	complete := encodeLines(t, assistant("msg_01", "req_01", "2026-09-25T11:00:01Z", tokens(3, 0, 0, 5)))
	partial := encodeLines(t, assistant("msg_02", "req_02", "2026-09-25T11:00:02Z", tokens(4, 0, 0, 6)))
	f := newTranscript(t, complete+partial[:len(partial)/2])
	// The partial line may continue the last request, so that waits too.
	if events := f.read(t, "Stop", usageNow); len(events) != 0 {
		t.Fatalf("nothing is final while a line is being written, got %d", len(events))
	}
	f.appendText(t, partial[len(partial)/2:])
	events := f.read(t, "Stop", usageNow)
	if len(events) != 2 || number(usageOf(t, events[1])["output_tokens"]) != 6 {
		t.Fatalf("each request is read once when complete, got %v", events)
	}
	if again := f.read(t, "Stop", usageNow); len(again) != 0 {
		t.Fatalf("re-emitted %v", again)
	}
}

func TestUsageSessionEndReadsEverythingComplete(t *testing.T) {
	complete := encodeLines(t, assistant("msg_01", "req_01", "2026-09-25T11:00:01Z", tokens(3, 0, 0, 5)))
	f := newTranscript(t, complete+`{"type":"assistant","message":{"id":"msg_02","usa`)
	if events := f.read(t, "SessionEnd", usageNow); len(events) != 1 {
		t.Fatalf("the session end emits every complete request: %v", events)
	}
}

// A request whose lines are still being written when a partial line is seen
// is held back whole, so its most complete copy is the one emitted.
func TestUsageHoldsBackTheTrailingRequestWhileItIsBeingWritten(t *testing.T) {
	early := encodeLines(t,
		assistant("msg_01", "req_01", "2026-09-25T11:00:01Z", tokens(3, 0, 0, 5)),
		assistant("msg_02", "req_02", "2026-09-25T11:00:02Z", tokens(4, 0, 0, 1)),
	)
	rest := encodeLines(t, assistant("msg_02", "req_02", "2026-09-25T11:00:02.5Z", tokens(4, 0, 0, 900)))
	f := newTranscript(t, early+rest[:10])
	events := f.read(t, "Stop", usageNow)
	if len(events) != 1 || number(usageOf(t, events[0])["output_tokens"]) != 5 {
		t.Fatalf("the trailing request must wait: %v", events)
	}
	f.appendText(t, rest[10:])
	events = f.read(t, "Stop", usageNow)
	if len(events) != 1 || number(usageOf(t, events[0])["output_tokens"]) != 900 {
		t.Fatalf("want the complete trailing request, got %v", events)
	}
}

// A request that began after the boundary's hook may still be streaming
// when the daemon reads, its complete lines carrying a partial output count.
func TestUsageHoldsBackRequestsThatBeganAfterTheBoundary(t *testing.T) {
	stop := time.Date(2026, 9, 25, 11, 0, 3, 0, time.UTC)
	f := newTranscript(t, encodeLines(t,
		assistant("msg_01", "req_01", "2026-09-25T11:00:01Z", tokens(3, 0, 0, 5)),
		assistant("msg_02", "req_02", "2026-09-25T11:00:04Z", tokens(4, 0, 0, 1)),
	))
	subagentLine := assistant("msg_sub", "req_sub", "2026-09-25T11:00:05Z", tokens(4, 0, 0, 2))
	subagentLine["isSidechain"] = true
	subagent := f.subagent(t, "agent-late.jsonl", encodeLines(t, subagentLine), usageNow.Add(-time.Minute))
	events := f.readUntil(t, "Stop", usageNow, stop)
	if len(events) != 1 || number(usageOf(t, events[0])["output_tokens"]) != 5 {
		t.Fatalf("only the request before the Stop is final: %v", events)
	}
	f.appendText(t, encodeLines(t, assistant("msg_02", "req_02", "2026-09-25T11:00:06Z", tokens(4, 0, 0, 900))))
	file, _ := os.OpenFile(subagent, os.O_APPEND|os.O_WRONLY, 0)
	file.WriteString(encodeLines(t, func() line {
		l := assistant("msg_sub", "req_sub", "2026-09-25T11:00:07Z", tokens(4, 0, 0, 70))
		l["isSidechain"] = true
		return l
	}()))
	file.Close()
	os.Chtimes(subagent, usageNow.Add(-time.Minute), usageNow.Add(-time.Minute))
	events = f.readUntil(t, "Stop", usageNow, stop.Add(time.Minute))
	var outputs []int
	for _, event := range events {
		outputs = append(outputs, number(usageOf(t, event)["output_tokens"]))
	}
	if fmt.Sprint(outputs) != "[900 70]" {
		t.Fatalf("each request once, at its final count: %v", outputs)
	}
}

func TestUsageRereadsATranscriptThatShrank(t *testing.T) {
	f := newTranscript(t, encodeLines(t,
		assistant("msg_01", "req_01", "2026-09-25T11:00:01Z", tokens(3, 0, 0, 5)),
		assistant("msg_02", "req_02", "2026-09-25T11:00:02Z", tokens(3, 0, 0, 5)),
	))
	before := f.read(t, "Stop", usageNow)
	writeFile(t, f.path, encodeLines(t, assistant("msg_01", "req_01", "2026-09-25T11:00:01Z", tokens(3, 0, 0, 5))))
	after := f.read(t, "Stop", usageNow)
	if len(after) != 1 || dig(after[0], "event", "id") != dig(before[0], "event", "id") {
		t.Fatalf("a truncated transcript is read again from the start, with the same ids: %v", after)
	}
}

func TestUsageToleratesCorruptAndForeignLines(t *testing.T) {
	events := newTranscript(t, encodeLines(t,
		`{"type":"assistant","message":{"id":"msg_x","usage":{"input_tokens":"many"}}`,
		`not json at all "usage"`,
		`null`,
		`[1,2,3]`,
		`{"type":"assistant","message":"SECRET_STRING_MESSAGE","usage":{}}`,
		line{"type": "summary", "summary": "SECRET_SUMMARY", "leafUuid": "x"},
		line{"type": "user", "sessionId": usageSession, "timestamp": "2026-09-25T11:00:00Z", "toolUseResult": map[string]any{"usage": "SECRET_TOOL_RESULT"}, "message": map[string]any{"role": "user", "content": "x"}},
		assistant("msg_bad_ts", "req_bad_ts", "yesterday", tokens(3, 0, 0, 5)),
		assistant("msg_01", "req_01", "2026-09-25T11:00:01Z", tokens(3, 0, 0, 5)),
	)).read(t, "Stop", usageNow)
	if len(events) != 1 || number(usageOf(t, events[0])["output_tokens"]) != 5 {
		t.Fatalf("want only the valid assistant request, got %v", events)
	}
}

func TestUsageReadsHugeLinesWithoutKeepingTheirContent(t *testing.T) {
	huge := strings.Repeat("SECRET_HUGE_CONTENT ", 400_000)
	events := newTranscript(t, encodeLines(t,
		assistant("msg_01", "req_01", "2026-09-25T11:00:01Z", tokens(3, 0, 0, 5), map[string]any{"type": "tool_use", "name": "Write", "input": map[string]any{"content": huge}}),
		assistant("msg_02", "req_02", "2026-09-25T11:00:02Z", tokens(3, 0, 0, 7)),
	)).read(t, "Stop", usageNow)
	if len(events) != 2 {
		t.Fatalf("got %d events", len(events))
	}
	encoded, _ := json.Marshal(events)
	if strings.Contains(string(encoded), "SECRET") || len(encoded) > 4096 {
		t.Fatalf("content leaked or events too large (%d bytes)", len(encoded))
	}
}

func TestUsageAttributesSubagentTranscriptsToTheSession(t *testing.T) {
	f := newTranscript(t, encodeLines(t, assistant("msg_parent", "req_parent", "2026-09-25T11:00:01Z", tokens(3, 5000, 0, 5))))
	subagentLine := func(messageID, requestID string, usage map[string]any) line {
		entry := assistant(messageID, requestID, "2026-09-25T11:00:03Z", usage)
		entry["isSidechain"], entry["agentId"] = true, "a1b2c3d4"
		return entry
	}
	f.subagent(t, "agent-a1b2c3d4.jsonl", encodeLines(t,
		// A /btw aside replays a parent response under a new request id.
		subagentLine("msg_parent", "req_replayed", tokens(3, 5000, 0, 5)),
		subagentLine("msg_child", "req_child", tokens(8, 100, 50, 60)),
	), usageNow.Add(-time.Minute))
	events := f.read(t, "Stop", usageNow)
	if len(events) != 2 {
		t.Fatalf("want the parent and the subagent request, got %d: %v", len(events), events)
	}
	child := events[1]
	if dig(child, "session", "id") != usageSession || number(usageOf(t, child)["output_tokens"]) != 60 {
		t.Fatalf("subagent attribution: %v", child)
	}
	if again := f.read(t, "Stop", usageNow); len(again) != 0 {
		t.Fatalf("subagent lines re-emitted: %v", again)
	}
	// A replay arriving in a later read is still recognized.
	f.subagent(t, "agent-e5f6.jsonl", encodeLines(t, subagentLine("msg_parent", "req_later", tokens(3, 5000, 0, 5))), usageNow.Add(-time.Minute))
	if later := f.read(t, "Stop", usageNow); len(later) != 0 {
		t.Fatalf("a later replay of a parent response counted again: %v", later)
	}
}

func TestUsageWaitsForAnActiveSubagentUntilTheSessionEnds(t *testing.T) {
	f := newTranscript(t, "")
	entry := assistant("msg_child", "req_child", "2026-09-25T11:00:03Z", tokens(8, 0, 0, 60))
	entry["isSidechain"] = true
	f.subagent(t, "agent-busy.jsonl", encodeLines(t, entry), usageNow.Add(-2*time.Second))
	if events := f.read(t, "Stop", usageNow); len(events) != 0 {
		t.Fatalf("a subagent written seconds ago may be mid-response: %v", events)
	}
	if events := f.read(t, "SessionEnd", usageNow); len(events) != 1 {
		t.Fatalf("the session end reads everything: %v", events)
	}
}

// Only a bounded number of changed subagent transcripts is read at once,
// newest first; unchanged ones cost nothing, and the rest wait.
func TestUsageReadsTheNewestChangedSubagentsFirst(t *testing.T) {
	previous := maxSubagentReads
	maxSubagentReads = 2
	t.Cleanup(func() { maxSubagentReads = previous })
	f := newTranscript(t, "")
	for index, age := range []time.Duration{3 * time.Minute, 2 * time.Minute, time.Minute} {
		entry := assistant(fmt.Sprintf("msg_%d", index), fmt.Sprintf("req_%d", index), "2026-09-25T11:00:03Z", tokens(1, 0, 0, index+1))
		entry["isSidechain"] = true
		f.subagent(t, fmt.Sprintf("agent-%d.jsonl", index), encodeLines(t, entry), usageNow.Add(-age))
	}
	outputs := func(events []map[string]any) (found []int) {
		for _, event := range events {
			found = append(found, number(usageOf(t, event)["output_tokens"]))
		}
		sort.Ints(found)
		return found
	}
	if got := outputs(f.read(t, "Stop", usageNow)); fmt.Sprint(got) != "[2 3]" || f.deferred != 1 {
		t.Fatalf("want the two newest, one deferred; got %v, %d deferred", got, f.deferred)
	}
	if got := outputs(f.read(t, "Stop", usageNow)); fmt.Sprint(got) != "[1]" || f.deferred != 0 {
		t.Fatalf("the unchanged files are free, so the deferred one is read next: %v, %d deferred", got, f.deferred)
	}
}

func TestUsageSkipsResponsesCopiedFromAnotherSession(t *testing.T) {
	copied := assistant("msg_old", "req_old", "2026-09-24T11:00:01Z", tokens(3, 0, 0, 5))
	copied["sessionId"] = "an-earlier-session"
	events := newTranscript(t, encodeLines(t, copied, assistant("msg_01", "req_01", "2026-09-25T11:00:01Z", tokens(3, 0, 0, 7)))).read(t, "Stop", usageNow)
	if len(events) != 1 || number(usageOf(t, events[0])["output_tokens"]) != 7 {
		t.Fatalf("a resumed session's copied history belongs to its first session: %v", events)
	}
}

func TestUsageCountsAdvisorIterationsUnderTheirOwnModel(t *testing.T) {
	usage := tokens(2, 226584, 7853, 491)
	usage["iterations"] = []any{
		map[string]any{"type": "message", "input_tokens": 1, "output_tokens": 45},
		map[string]any{"type": "advisor_message", "model": "claude-opus-4-6", "input_tokens": 159419, "output_tokens": 7805, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0},
	}
	events := newTranscript(t, encodeLines(t, assistant("msg_01", "req_01", "2026-09-25T11:00:01Z", usage))).read(t, "Stop", usageNow)
	if len(events) != 2 || events[1]["model"] != "claude-opus-4-6" || number(usageOf(t, events[1])["input_tokens"]) != 159419 {
		t.Fatalf("advisor usage: %v", events)
	}
	fast := tokens(2, 0, 0, 1)
	fast["speed"] = "fast"
	fast["iterations"] = usage["iterations"]
	events = newTranscript(t, encodeLines(t, assistant("msg_02", "req_02", "2026-09-25T11:00:01Z", fast))).read(t, "Stop", usageNow)
	if len(events) != 2 || usageOf(t, events[1])["speed"] != "fast" {
		t.Fatalf("an advisor call in fast mode keeps the speed: %v", events)
	}
	if number(usageOf(t, events[0])["input_tokens"]) != 2 || dig(events[0], "event", "id") == dig(events[1], "event", "id") {
		t.Fatalf("the main request keeps its own usage and id: %v", events)
	}
}

func TestUsageSkipsSyntheticMessagesAndFutureStamps(t *testing.T) {
	synthetic := assistant("msg_syn", "req_syn", "2026-09-25T11:00:01Z", tokens(3, 0, 0, 5))
	synthetic["message"].(map[string]any)["model"] = "<synthetic>"
	events := newTranscript(t, encodeLines(t,
		synthetic,
		assistant("msg_future", "req_future", "2026-09-27T11:00:01Z", tokens(3, 0, 0, 5)),
		assistant("msg_01", "req_01", "2026-09-25T11:00:01Z", tokens(3, 0, 0, 7)),
	)).read(t, "Stop", usageNow)
	if len(events) != 1 || number(usageOf(t, events[0])["output_tokens"]) != 7 {
		t.Fatalf("want only the real, plausibly stamped request: %v", events)
	}
}

func TestUsageKeepsOnlyClaudeModelIDs(t *testing.T) {
	for model, want := range map[string]bool{
		"claude-opus-4-6": true, "claude-sonnet-4-5[1m]": true, "claude-sonnet-4-5@20250929": true,
		"us.anthropic.claude-sonnet-4-5-20250929-v1:0": true, "anthropic.claude-haiku-4-5": true,
		"gpt-5": false, "SECRET_model": false, "claudeX": false, "claude": false, "<synthetic>": false,
	} {
		if got := modelID.MatchString(model); got != want {
			t.Errorf("%s: %v", model, got)
		}
	}
}

// A session whose last response never reached a Stop (the agent crashed)
// flushes the held-back tail when it starts again.
func TestUsageSessionStartFlushesATailLeftByACrash(t *testing.T) {
	f := newTranscript(t, encodeLines(t, assistant("msg_01", "req_01", "2026-09-25T11:00:01Z", tokens(3, 0, 0, 5)))+`{"type":"assistant","message":{"id":"msg_02"`)
	if events := f.read(t, "Stop", usageNow); len(events) != 0 {
		t.Fatalf("held back while a line is unfinished: %v", events)
	}
	if events := f.read(t, "SessionStart", usageNow); len(events) != 1 {
		t.Fatalf("the next start of the session emits the complete tail: %v", events)
	}
}

func TestUsageCarriesFastModeSoTheRowIsFlagged(t *testing.T) {
	usage := tokens(3, 0, 0, 5)
	usage["speed"] = "fast"
	events := newTranscript(t, encodeLines(t, assistant("msg_01", "req_01", "2026-09-25T11:00:01Z", usage))).read(t, "Stop", usageNow)
	if len(events) != 1 || usageOf(t, events[0])["speed"] != "fast" {
		t.Fatalf("speed: %v", events)
	}
}

// Usage from a time capture was not allowed is passed over, and the cursor
// moves past it so a later read never reconsiders it.
func TestUsageOutsideTheAllowedWindowsIsPassedOverForGood(t *testing.T) {
	f := newTranscript(t, encodeLines(t,
		assistant("msg_before", "req_before", "2026-09-25T10:00:00Z", tokens(3, 0, 0, 1)),
		assistant("msg_paused", "req_paused", "2026-09-25T10:30:00Z", tokens(3, 0, 0, 2)),
		assistant("msg_after", "req_after", "2026-09-25T11:00:00Z", tokens(3, 0, 0, 3)),
	))
	allowed := func(at time.Time) bool {
		return at.Equal(time.Date(2026, 9, 25, 10, 0, 0, 0, time.UTC)) || !at.Before(time.Date(2026, 9, 25, 11, 0, 0, 0, time.UTC))
	}
	result, err := New().ReadUsage(agent.UsageRead{Transcript: f.path, SessionID: usageSession, Event: "Stop", Now: usageNow, Allowed: allowed}, nil)
	if err != nil {
		t.Fatal(err)
	}
	events, next := result.Events, result.Cursor
	var outputs []int
	for _, raw := range events {
		var event map[string]any
		json.Unmarshal(raw, &event)
		outputs = append(outputs, number(usageOf(t, event)["output_tokens"]))
	}
	if fmt.Sprint(outputs) != "[1 3]" {
		t.Fatalf("want the requests inside the windows, got outputs %v", outputs)
	}
	f.cursor = next
	if again := f.read(t, "Stop", usageNow); len(again) != 0 {
		t.Fatalf("a passed-over request came back on a later read: %v", again)
	}
}

// structuralUsageLeaves are every leaf a usage event may carry: identity,
// timing, model and token counts. Nothing a person or the model wrote.
var structuralUsageLeaves = map[string]bool{
	"schema_version": true, "timestamp": true, "model": true,
	"event.id": true, "event.action": true, "event.category": true, "event.fidelity": true,
	"harness.name": true, "harness.collection_method": true, "session.id": true,
	"gen_ai.usage.input_tokens": true, "gen_ai.usage.output_tokens": true,
	"gen_ai.usage.cache_read.input_tokens": true, "gen_ai.usage.cache_creation.input_tokens": true,
	"gen_ai.usage.cache_creation.ephemeral_1h_input_tokens": true, "gen_ai.usage.service_tier": true, "gen_ai.usage.speed": true,
}

func leaves(value any, path string, into map[string]any) {
	if object, ok := value.(map[string]any); ok {
		for key, child := range object {
			next := key
			if path != "" {
				next = path + "." + key
			}
			leaves(child, next, into)
		}
		return
	}
	into[path] = value
}

func TestUsageEventsNeverCarryTranscriptContentEvenFromAdversarialLines(t *testing.T) {
	sneaky := tokens(3, 0, 0, 5)
	sneaky["service_tier"] = "SECRET tier with spaces"
	sneaky["speed"] = "SECRET_SPEED\nnewline"
	sneaky["server_tool_use"] = map[string]any{"web_search_requests": "SECRET_NESTED"}
	sneaky["extra_text"] = "SECRET_EXTRA"
	hostile := assistant("SECRET msg id", "SECRET req id", "2026-09-25T11:00:01Z", sneaky,
		map[string]any{"type": "text", "text": `SECRET_TEXT","usage":{"input_tokens":999999}`})
	hostile["agentId"] = "SECRET agent id"
	hostile["isSidechain"] = false
	message := hostile["message"].(map[string]any)
	message["model"] = "SECRET model name with spaces"
	message["usage_note"] = "SECRET_NOTE"
	lookalike := assistant("msg_02", "req_02", "2026-09-25T11:00:02Z", tokens(1, 0, 0, 1))
	lookalike["message"].(map[string]any)["content"] = []any{map[string]any{"type": "tool_use", "input": map[string]any{"message": map[string]any{"model": "SECRET_NESTED_MODEL", "usage": map[string]any{"input_tokens": 777777}}}}}
	lookalike["toolUseResult"] = map[string]any{"stdout": "SECRET_STDOUT"}
	events := newTranscript(t, encodeLines(t, hostile, lookalike, `{"type":"assistant","message":{"id":"msg_03","model":"SECRET_UNCLOSED`)).read(t, "SessionEnd", usageNow)
	if len(events) != 2 {
		t.Fatalf("got %d events: %v", len(events), events)
	}
	encoded, _ := json.Marshal(events)
	for _, forbidden := range []string{"SECRET", "999999", "777777", "/SECRET/cwd", "toolu_"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("%q reached an event: %s", forbidden, encoded)
		}
	}
	for _, event := range events {
		found := map[string]any{}
		leaves(event, "", found)
		var unexpected []string
		for path := range found {
			if !structuralUsageLeaves[path] {
				unexpected = append(unexpected, path)
			}
		}
		sort.Strings(unexpected)
		if len(unexpected) > 0 {
			t.Fatalf("non-structural members %v in %v", unexpected, event)
		}
	}
	if _, hasModel := events[0]["model"]; hasModel {
		t.Fatalf("a model id that is not an identifier is dropped: %v", events[0])
	}
}

func TestUsageIgnoresAMissingTranscript(t *testing.T) {
	result, err := New().ReadUsage(agent.UsageRead{Transcript: filepath.Join(t.TempDir(), "never-written.jsonl"), SessionID: usageSession, Event: "Stop", Now: usageNow}, nil)
	if err != nil || len(result.Events) != 0 {
		t.Fatalf("missing transcript: %v %v", result.Events, err)
	}
	if result.Cursor == nil {
		t.Fatal("the cursor is always returned")
	}
}

func TestUsageCursorStaysBoundedOnLongSessions(t *testing.T) {
	var builder strings.Builder
	for index := range 3 * maxParentMessages / 2 {
		builder.WriteString(encodeLines(t, assistant(fmt.Sprintf("msg_%06d", index), fmt.Sprintf("req_%06d", index), "2026-09-25T11:00:01Z", tokens(1, 0, 0, 1), map[string]any{"type": "text", "text": "x"})))
	}
	f := newTranscript(t, builder.String())
	events := f.read(t, "Stop", usageNow)
	if len(events) != 3*maxParentMessages/2 {
		t.Fatalf("got %d events", len(events))
	}
	if len(f.cursor) > maxParentMessages*24+4096 {
		t.Fatalf("cursor grew to %d bytes", len(f.cursor))
	}
}
