// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

const rolloutThread = "019a8f2e-7c1d-7b3a-9e41-5d2c8a6f0b11"

var rolloutNow = time.Date(2026, 9, 29, 12, 0, 0, 0, time.UTC)

type rolloutEntry map[string]any

func rolloutStamp(offset time.Duration) string {
	return rolloutNow.Add(-time.Hour + offset).Format(time.RFC3339Nano)
}

// The shapes below are Codex's RolloutLine: {timestamp, type, payload}.
func sessionMeta(originator string) rolloutEntry {
	return rolloutEntry{"timestamp": rolloutStamp(0), "type": "session_meta", "payload": map[string]any{
		"id": rolloutThread, "session_id": rolloutThread, "timestamp": rolloutStamp(0), "cwd": "/SECRET/cwd",
		"originator": originator, "cli_version": "0.155.0-alpha.16", "model_provider": "openai",
		"base_instructions": map[string]any{"text": "SECRET_INSTRUCTIONS"},
	}}
}

func turnContext(model string) rolloutEntry {
	return rolloutEntry{"timestamp": rolloutStamp(time.Second), "type": "turn_context", "payload": map[string]any{
		"turn_id": "turn-1", "cwd": "/SECRET/cwd", "model": model, "approval_policy": "on-request",
		"user_instructions": "SECRET_USER_INSTRUCTIONS",
	}}
}

func codexTokens(input, cached, cacheWrite, output, reasoning int) map[string]any {
	return map[string]any{
		"input_tokens": input, "cached_input_tokens": cached, "cache_write_input_tokens": cacheWrite,
		"output_tokens": output, "reasoning_output_tokens": reasoning, "total_tokens": input + output,
	}
}

func usageRecord(offset time.Duration, thread, responseID string, usage map[string]any) rolloutEntry {
	return rolloutEntry{"timestamp": rolloutStamp(offset), "type": "token_usage_record", "payload": map[string]any{
		"thread_id": thread, "turn_id": "turn-1", "session_id": thread, "root_turn_id": "turn-1", "response_id": responseID,
		"usage": usage, "turn_token_usage": usage, "thread_token_usage": usage,
	}}
}

func tokenCount(offset time.Duration, total map[string]any, planType any) rolloutEntry {
	payload := map[string]any{"type": "token_count", "info": nil, "rate_limits": nil}
	if total != nil {
		payload["info"] = map[string]any{"total_token_usage": total, "last_token_usage": total, "model_context_window": 272000}
	}
	if planType != nil {
		payload["rate_limits"] = map[string]any{"plan_type": planType, "primary": map[string]any{"used_percent": 12.5}}
	}
	return rolloutEntry{"timestamp": rolloutStamp(offset), "type": "event_msg", "payload": payload}
}

func userMessage(offset time.Duration, text string) rolloutEntry {
	return rolloutEntry{"timestamp": rolloutStamp(offset), "type": "response_item", "payload": map[string]any{
		"type": "message", "role": "user", "content": []any{map[string]any{"type": "input_text", "text": text}},
	}}
}

func encodeRollout(t *testing.T, entries ...any) string {
	t.Helper()
	var builder strings.Builder
	for _, value := range entries {
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

type rolloutFixture struct {
	env    testEnv
	path   string
	cursor json.RawMessage
	// harness is what the session's telemetry named, if anything.
	harness string
	last    agent.UsageResult
}

func newRollout(t *testing.T, content string) *rolloutFixture {
	t.Helper()
	env := newEnv(t)
	path := filepath.Join(env.codexHome, "sessions", "2026", "09", "29", "rollout-2026-09-29T11-00-00-"+rolloutThread+".jsonl")
	write(t, path, content)
	return &rolloutFixture{env: env, path: path}
}

func (f *rolloutFixture) appendText(t *testing.T, text string) {
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

// read is a poll with nothing held back; readUntil holds back lines written
// after until.
func (f *rolloutFixture) read(t *testing.T) []map[string]any {
	t.Helper()
	return f.readUntil(t, time.Time{})
}

func (f *rolloutFixture) readUntil(t *testing.T, until time.Time) []map[string]any {
	t.Helper()
	return f.readPath(t, f.path, until)
}

func (f *rolloutFixture) readPath(t *testing.T, path string, until time.Time) []map[string]any {
	t.Helper()
	result, err := New().ReadUsage(agent.UsageRead{Transcript: path, SessionID: rolloutThread, Now: rolloutNow, Until: until, Env: f.env.Env, Harness: f.harness}, f.cursor)
	if err != nil {
		t.Fatal(err)
	}
	if result.Cursor == nil {
		t.Fatal("the cursor is always returned")
	}
	f.cursor, f.last = result.Cursor, result
	decoded := make([]map[string]any, len(result.Events))
	for index, raw := range result.Events {
		if err := json.Unmarshal(raw, &decoded[index]); err != nil {
			t.Fatalf("event %d is not JSON: %s", index, raw)
		}
	}
	return decoded
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

func count(value any) int {
	if typed, ok := value.(float64); ok {
		return int(typed)
	}
	return -1
}

func outputs(events []map[string]any) []int {
	found := []int{}
	for _, event := range events {
		found = append(found, count(dig(event, "gen_ai", "usage", "output_tokens")))
	}
	return found
}

func TestUsageTranscript_TakesTheRolloutPathFromEveryHook(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rollout-x.jsonl")
	codex := New()
	for _, event := range HookEvents {
		got, ok := codex.UsageTranscript(event, map[string]any{"transcript_path": path})
		if !ok || got != path {
			t.Fatalf("%s: %q %v", event, got, ok)
		}
	}
	for name, value := range map[string]any{"null": nil, "relative": "sessions/rollout-x.jsonl", "not jsonl": filepath.Join(t.TempDir(), "rollout-x.json"), "nul byte": path + "\x00.jsonl", "not a string": 7} {
		if _, ok := codex.UsageTranscript("SessionStart", map[string]any{"transcript_path": value}); ok {
			t.Fatalf("%s transcript_path accepted", name)
		}
	}
}

func TestRolloutUsage_CountsEachResponseRecordOnce(t *testing.T) {
	f := newRollout(t, encodeRollout(t,
		sessionMeta("Codex Desktop"), turnContext("gpt-5.4"), userMessage(2*time.Second, "SECRET_PROMPT"),
		usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(12000, 9000, 500, 800, 300)),
		tokenCount(3*time.Second, codexTokens(12000, 9000, 500, 800, 300), nil),
		usageRecord(4*time.Second, rolloutThread, "resp_02", codexTokens(13000, 12000, 0, 100, 0)),
	))
	events := f.read(t)
	if len(events) != 2 {
		t.Fatalf("want one event per response record, got %d: %v", len(events), events)
	}
	first := events[0]
	if dig(first, "event", "action") != "token.usage" || dig(first, "harness", "name") != DesktopID || dig(first, "harness", "collection_method") != "poll" || dig(first, "session", "id") != rolloutThread {
		t.Fatalf("envelope: %v", first)
	}
	if first["model"] != "gpt-5.4" || first["timestamp"] != rolloutStamp(3*time.Second) {
		t.Fatalf("model and time: %v", first)
	}
	// Codex counts cached and cache-written tokens inside input_tokens and
	// reasoning inside output_tokens; the event carries the disjoint split.
	usage := dig(first, "gen_ai", "usage")
	if count(dig(usage, "input_tokens")) != 2500 || count(dig(usage, "cache_read", "input_tokens")) != 9000 || count(dig(usage, "cache_creation", "input_tokens")) != 500 || count(dig(usage, "output_tokens")) != 800 || count(dig(usage, "reasoning", "output_tokens")) != 300 {
		t.Fatalf("usage split: %v", usage)
	}
	if f.last.Harness != DesktopID {
		t.Fatalf("result harness %q", f.last.Harness)
	}
	if again := f.read(t); len(again) != 0 {
		t.Fatalf("a read after the cursor re-emitted %v", again)
	}
	ids := func(events []map[string]any) string {
		var found []string
		for _, event := range events {
			found = append(found, fmt.Sprint(dig(event, "event", "id")))
		}
		return strings.Join(found, ",")
	}
	f.cursor = nil
	if replay := f.read(t); ids(replay) != ids(events) {
		t.Fatal("a re-read from scratch must yield the same event ids, which the backend recognizes")
	}
}

func TestRolloutUsage_FallsBackToTokenCountTotalsWithoutRecords(t *testing.T) {
	f := newRollout(t, encodeRollout(t,
		sessionMeta("codex_cli_rs"), turnContext("gpt-5.3-codex"),
		tokenCount(2*time.Second, nil, nil),
		tokenCount(3*time.Second, codexTokens(1000, 600, 0, 50, 10), nil),
		// Codex repeats the total when only the rate limits changed.
		tokenCount(4*time.Second, codexTokens(1000, 600, 0, 50, 10), nil),
		tokenCount(5*time.Second, codexTokens(3000, 2600, 0, 80, 10), nil),
	))
	events := f.read(t)
	if fmt.Sprint(outputs(events)) != "[50 30]" {
		t.Fatalf("want the per-response deltas of the running total, got %v", outputs(events))
	}
	second := dig(events[1], "gen_ai", "usage")
	if count(dig(second, "input_tokens")) != 0 || count(dig(second, "cache_read", "input_tokens")) != 2000 {
		t.Fatalf("second delta: %v", second)
	}
	if dig(events[0], "harness", "name") != ID {
		t.Fatalf("a CLI originator is the CLI harness: %v", events[0])
	}
	f.appendText(t, encodeRollout(t, tokenCount(6*time.Second, codexTokens(3500, 2600, 0, 100, 10), nil)))
	if later := f.read(t); fmt.Sprint(outputs(later)) != "[20]" {
		t.Fatalf("a later read continues from the counted total, got %v", outputs(later))
	}
}

func TestRolloutUsage_RecordsWinOverTokenCountsInTheSameFile(t *testing.T) {
	f := newRollout(t, encodeRollout(t,
		sessionMeta("Codex Desktop"), turnContext("gpt-5.4"),
		tokenCount(2*time.Second, codexTokens(1000, 0, 0, 50, 0), nil),
	))
	f.cursor = nil
	f.appendText(t, encodeRollout(t, usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(1000, 0, 0, 50, 0))))
	if events := f.read(t); fmt.Sprint(outputs(events)) != "[50]" {
		t.Fatalf("records and token counts describe the same responses; want the record alone, got %v", outputs(events))
	}
	f.appendText(t, encodeRollout(t, tokenCount(5*time.Second, codexTokens(2000, 0, 0, 90, 0), nil)))
	if events := f.read(t); len(events) != 0 {
		t.Fatalf("once records were seen, token counts are never counted: %v", events)
	}
}

func TestRolloutUsage_HoldsBackLinesWrittenAfterUntil(t *testing.T) {
	f := newRollout(t, encodeRollout(t,
		sessionMeta("Codex Desktop"), turnContext("gpt-5.4"),
		usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(100, 0, 0, 1, 0)),
		usageRecord(10*time.Second, rolloutThread, "resp_02", codexTokens(100, 0, 0, 2, 0)),
	))
	until, _ := time.Parse(time.RFC3339Nano, rolloutStamp(5*time.Second))
	if events := f.readUntil(t, until); fmt.Sprint(outputs(events)) != "[1]" {
		t.Fatalf("want only the settled response, got %v", outputs(events))
	}
	if events := f.read(t); fmt.Sprint(outputs(events)) != "[2]" || events[0]["model"] != "gpt-5.4" {
		t.Fatalf("the held response comes later, once, under its model: %v", events)
	}
}

func TestRolloutUsage_HoldsBackAPartialLastLine(t *testing.T) {
	complete := encodeRollout(t, sessionMeta("Codex Desktop"), usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(100, 0, 0, 1, 0)))
	partial := encodeRollout(t, usageRecord(4*time.Second, rolloutThread, "resp_02", codexTokens(100, 0, 0, 2, 0)))
	f := newRollout(t, complete+partial[:len(partial)/2])
	if events := f.read(t); fmt.Sprint(outputs(events)) != "[1]" {
		t.Fatalf("got %v", outputs(events))
	}
	f.appendText(t, partial[len(partial)/2:])
	if events := f.read(t); fmt.Sprint(outputs(events)) != "[2]" {
		t.Fatalf("the completed line is read once: %v", outputs(events))
	}
}

func TestRolloutUsage_ToleratesMalformedAndNullLines(t *testing.T) {
	f := newRollout(t, encodeRollout(t,
		sessionMeta("Codex Desktop"),
		`{"type":"token_usage_record","payload":`,
		`not json at all`,
		`{"timestamp":"yesterday","type":"token_usage_record","payload":{"thread_id":"`+rolloutThread+`","response_id":"resp_bad","usage":{"output_tokens":9}}}`,
		`{"timestamp":"`+rolloutStamp(2*time.Second)+`","type":"token_usage_record","payload":{"thread_id":"`+rolloutThread+`","response_id":"resp_str","usage":{"output_tokens":"lots"}}}`,
		`{"timestamp":"`+rolloutStamp(2*time.Second)+`","type":"token_usage_record","payload":{"thread_id":"`+rolloutThread+`","response_id":"resp_null","usage":null}}`,
		tokenCount(2*time.Second, nil, nil),
		usageRecord(3*time.Second, rolloutThread, "resp_ok", codexTokens(100, 0, 0, 7, 0)),
	))
	if events := f.read(t); fmt.Sprint(outputs(events)) != "[7]" {
		t.Fatalf("only the well-formed record counts, got %v", events)
	}
}

func TestRolloutUsage_SkipsOtherThreadsAndFutureStamps(t *testing.T) {
	future := usageRecord(3*time.Second, rolloutThread, "resp_future", codexTokens(100, 0, 0, 9, 0))
	future["timestamp"] = rolloutNow.Add(48 * time.Hour).Format(time.RFC3339Nano)
	f := newRollout(t, encodeRollout(t,
		sessionMeta("Codex Desktop"),
		usageRecord(2*time.Second, "019a8f2e-0000-7000-8000-000000000000", "resp_other", codexTokens(100, 0, 0, 5, 0)),
		future,
		usageRecord(3*time.Second, rolloutThread, "resp_mine", codexTokens(100, 0, 0, 6, 0)),
	))
	if events := f.read(t); fmt.Sprint(outputs(events)) != "[6]" {
		t.Fatalf("got %v", outputs(events))
	}
	other := newRollout(t, strings.Replace(encodeRollout(t, sessionMeta("codex_cli_rs"), tokenCount(3*time.Second, codexTokens(100, 0, 0, 4, 0), nil)), rolloutThread, "019a8f2e-0000-7000-8000-000000000000", 1))
	if events := other.read(t); len(events) != 0 {
		t.Fatalf("token counts of another thread's rollout are not this session's: %v", events)
	}
}

func TestRolloutUsage_IgnoresMissingAndUnreadableRollouts(t *testing.T) {
	f := newRollout(t, encodeRollout(t, sessionMeta("Codex Desktop"), usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(100, 0, 0, 1, 0))))
	missing := filepath.Join(filepath.Dir(f.path), "rollout-2026-09-29T11-00-00-never-written.jsonl")
	if events := f.readPath(t, missing, time.Time{}); len(events) != 0 {
		t.Fatalf("missing rollout: %v", events)
	}
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		return
	}
	os.Chmod(f.path, 0)
	defer os.Chmod(f.path, 0o600)
	if events := f.read(t); len(events) != 0 {
		t.Fatalf("unreadable rollout: %v", events)
	}
	os.Chmod(f.path, 0o600)
	if events := f.read(t); fmt.Sprint(outputs(events)) != "[1]" {
		t.Fatalf("an unreadable rollout is read once it is readable again: %v", outputs(events))
	}
}

func TestRolloutUsage_ReadsOnlyRegularFilesInsideTheSessionsDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	content := encodeRollout(t, sessionMeta("Codex Desktop"), usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(100, 0, 0, 1, 0)))
	f := newRollout(t, content)
	outside := filepath.Join(filepath.Dir(f.env.codexHome), "elsewhere", "rollout-2026-09-29T11-00-00-"+rolloutThread+".jsonl")
	write(t, outside, content)
	beside := filepath.Join(f.env.codexHome, "archived_sessions", "rollout-2026-09-29T11-00-00-"+rolloutThread+".jsonl")
	write(t, beside, content)
	sessions := filepath.Join(f.env.codexHome, "sessions")
	linkedFile := filepath.Join(sessions, "2026", "09", "29", "rollout-2026-09-29T11-00-01-"+rolloutThread+".jsonl")
	if err := os.Symlink(outside, linkedFile); err != nil {
		t.Fatal(err)
	}
	linkedDir := filepath.Join(sessions, "2026", "10")
	if err := os.Symlink(filepath.Dir(outside), linkedDir); err != nil {
		t.Fatal(err)
	}
	for name, path := range map[string]string{
		"outside the codex home":        outside,
		"another codex directory":       beside,
		"a symlink to a file outside":   linkedFile,
		"through a symlinked directory": filepath.Join(linkedDir, filepath.Base(outside)),
		"dot-dot out of sessions":       filepath.Join(sessions, "..", "archived_sessions", filepath.Base(beside)),
		"a directory named like a file": filepath.Join(sessions, "2026", "09"),
		"not a rollout file":            filepath.Join(sessions, "2026", "09", "29", "notes.jsonl"),
		"relative to the sessions dir":  filepath.Join("2026", "09", "29", filepath.Base(f.path)),
	} {
		if name == "not a rollout file" {
			write(t, path, content)
		}
		f.cursor = nil
		if events := f.readPath(t, path, time.Time{}); len(events) != 0 {
			t.Fatalf("%s: read %v", name, events)
		}
	}
	codexHome := filepath.Join(filepath.Dir(f.env.codexHome), "custom-codex")
	custom := filepath.Join(codexHome, "sessions", "2026", "09", "29", filepath.Base(f.path))
	write(t, custom, content)
	f.env.Getenv = func(key string) string {
		if key == "CODEX_HOME" {
			return codexHome
		}
		return ""
	}
	f.cursor = nil
	if events := f.readPath(t, custom, time.Time{}); len(events) != 1 {
		t.Fatalf("CODEX_HOME moves the sessions directory: %v", events)
	}
	f.cursor = nil
	if events := f.readPath(t, f.path, time.Time{}); len(events) != 0 {
		t.Fatalf("with CODEX_HOME set, ~/.codex/sessions is outside it: %v", events)
	}
}

func TestRolloutUsage_SkipsOversizedLinesWhole(t *testing.T) {
	huge := userMessage(2*time.Second, strings.Repeat("SECRET_HUGE ", maxRolloutLineBytes/8))
	huge["payload"].(map[string]any)["usage"] = codexTokens(1, 0, 0, 999999, 0)
	huge["type"] = "token_usage_record"
	f := newRollout(t, encodeRollout(t, sessionMeta("Codex Desktop"), huge, usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(100, 0, 0, 1, 0))))
	if events := f.read(t); fmt.Sprint(outputs(events)) != "[1]" {
		t.Fatalf("an oversized line is skipped and reading goes on: %v", outputs(events))
	}
}

func TestRolloutUsage_BoundsOneRead(t *testing.T) {
	previous := maxRolloutReadBytes
	maxRolloutReadBytes = 2048
	defer func() { maxRolloutReadBytes = previous }()
	var entries []any
	entries = append(entries, sessionMeta("Codex Desktop"))
	for index := range 40 {
		entries = append(entries, usageRecord(3*time.Second, rolloutThread, fmt.Sprintf("resp_%02d", index), codexTokens(100, 0, 0, 1, 0)))
	}
	f := newRollout(t, encodeRollout(t, entries...))
	total := 0
	for reads := 0; reads < 100; reads++ {
		events := f.read(t)
		if len(events) == 0 {
			break
		}
		total += len(events)
		if len(events) == 40 {
			t.Fatal("one read went past its byte budget")
		}
		if f.last.DeferredFiles != 1 && total < 40 {
			t.Fatal("a read cut short says the rollout was left for later")
		}
	}
	if total != 40 {
		t.Fatalf("the rest waits for later reads and nothing is lost or repeated: %d", total)
	}
}

// A read cut short by its budget cannot know whether a record for the same
// response follows, so its token counts wait; being running totals, nothing
// is lost by waiting.
func TestRolloutUsage_TokenCountsWaitUntilARecordCannotFollow(t *testing.T) {
	head := encodeRollout(t, sessionMeta("Codex Desktop"), tokenCount(2*time.Second, codexTokens(1000, 0, 0, 50, 0), nil))
	previous := maxRolloutReadBytes
	maxRolloutReadBytes = int64(len(head))
	defer func() { maxRolloutReadBytes = previous }()
	f := newRollout(t, head+encodeRollout(t, usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(1000, 0, 0, 50, 0))))
	if events := f.read(t); len(events) != 0 {
		t.Fatalf("a cut-short read emitted token counts: %v", events)
	}
	if events := f.read(t); fmt.Sprint(outputs(events)) != "[50]" {
		t.Fatalf("want the record alone, got %v", outputs(events))
	}

	fallback := newRollout(t, head+encodeRollout(t, tokenCount(3*time.Second, codexTokens(2000, 0, 0, 80, 0), nil), tokenCount(4*time.Second, codexTokens(3000, 0, 0, 95, 0), nil)))
	total := 0
	for reads := 0; reads < 10; reads++ {
		for _, output := range outputs(fallback.read(t)) {
			total += output
		}
	}
	if total != 95 {
		t.Fatalf("without records the running total is counted exactly once: %d", total)
	}
}

// Every leaf a usage event may carry: identifiers, times and counts.
var structuralRolloutLeaves = map[string]bool{
	"schema_version": true, "timestamp": true, "model": true,
	"event.id": true, "event.action": true, "event.category": true, "event.fidelity": true,
	"harness.name": true, "harness.collection_method": true, "session.id": true,
	"gen_ai.usage.input_tokens": true, "gen_ai.usage.output_tokens": true,
	"gen_ai.usage.cache_read.input_tokens": true, "gen_ai.usage.cache_creation.input_tokens": true,
	"gen_ai.usage.reasoning.output_tokens": true,
	"raw.source":                           true, "raw.attributes.auth_mode": true,
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

func TestRolloutUsage_NeverCarriesRolloutContentEvenFromAdversarialLines(t *testing.T) {
	hostile := usageRecord(3*time.Second, rolloutThread, "SECRET response id", codexTokens(100, 0, 0, 3, 0))
	payload := hostile["payload"].(map[string]any)
	payload["usage"].(map[string]any)["note"] = "SECRET_NOTE"
	payload["message"] = "SECRET_MESSAGE"
	lookalike := userMessage(4*time.Second, `SECRET_TEXT","type":"token_usage_record","usage":{"output_tokens":777777}`)
	lookalike["payload"].(map[string]any)["thread_id"] = rolloutThread
	f := newRollout(t, encodeRollout(t,
		sessionMeta("SECRET originator"), turnContext("SECRET model with spaces"), hostile, lookalike,
		tokenCount(5*time.Second, codexTokens(100, 0, 0, 3, 0), "SECRET plan"),
		`{"type":"token_usage_record","payload":{"thread_id":"`+rolloutThread+`","usage":{"output_tokens":1},"text":"SECRET_UNCLOSED`,
	))
	events := f.read(t)
	if fmt.Sprint(outputs(events)) != "[3]" {
		t.Fatalf("got %v", events)
	}
	encoded, _ := json.Marshal(events)
	for _, forbidden := range []string{"SECRET", "777777", "/SECRET/cwd"} {
		if strings.Contains(string(encoded), forbidden) {
			t.Fatalf("%q reached an event: %s", forbidden, encoded)
		}
	}
	for _, event := range events {
		found := map[string]any{}
		leaves(event, "", found)
		var unexpected []string
		for path := range found {
			if !structuralRolloutLeaves[path] {
				unexpected = append(unexpected, path)
			}
		}
		sort.Strings(unexpected)
		if len(unexpected) > 0 {
			t.Fatalf("non-structural members %v in %v", unexpected, event)
		}
	}
	if _, hasModel := events[0]["model"]; hasModel {
		t.Fatalf("a model that is not an identifier is dropped: %v", events[0])
	}
}

func TestRolloutUsage_TelemetryHarnessOverridesTheOriginator(t *testing.T) {
	f := newRollout(t, encodeRollout(t, sessionMeta("codex_vscode"), usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(100, 0, 0, 1, 0))))
	if events := f.read(t); dig(events[0], "harness", "name") != DesktopID {
		t.Fatalf("an app-server client other than the CLI is Codex Desktop's harness: %v", events[0])
	}
	f.cursor, f.harness = nil, ID
	if events := f.read(t); dig(events[0], "harness", "name") != ID || f.last.Harness != ID {
		t.Fatalf("the harness the telemetry named wins: %v", events[0])
	}
	f.cursor, f.harness = nil, "claude_code"
	if events := f.read(t); dig(events[0], "harness", "name") != DesktopID {
		t.Fatalf("a hint that is not a Codex harness is ignored: %v", events[0])
	}
}

func TestRolloutUsage_APlanMarksTheSessionAsASubscription(t *testing.T) {
	f := newRollout(t, encodeRollout(t,
		sessionMeta("Codex Desktop"),
		usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(100, 0, 0, 1, 0)),
		tokenCount(3*time.Second, codexTokens(100, 0, 0, 1, 0), "pro"),
		usageRecord(4*time.Second, rolloutThread, "resp_02", codexTokens(100, 0, 0, 2, 0)),
	))
	events := f.read(t)
	if len(events) != 2 || dig(events[0], "raw", "attributes", "auth_mode") != nil || dig(events[1], "raw", "attributes", "auth_mode") != "chatgpt" {
		t.Fatalf("a ChatGPT plan in the rate limits is a subscription from then on: %v", events)
	}
	without := newRollout(t, encodeRollout(t, sessionMeta("Codex Desktop"), tokenCount(2*time.Second, nil, nil), usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(100, 0, 0, 1, 0))))
	if events := without.read(t); dig(events[0], "raw", "attributes", "auth_mode") != nil {
		t.Fatalf("no plan says nothing about how the session is paid for: %v", events[0])
	}
}

func TestRolloutUsage_OutsideTheAllowedWindowsIsPassedOverForGood(t *testing.T) {
	f := newRollout(t, encodeRollout(t,
		sessionMeta("Codex Desktop"),
		usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(100, 0, 0, 1, 0)),
		usageRecord(4*time.Second, rolloutThread, "resp_02", codexTokens(100, 0, 0, 2, 0)),
	))
	cutoff, _ := time.Parse(time.RFC3339Nano, rolloutStamp(4*time.Second))
	result, err := New().ReadUsage(agent.UsageRead{Transcript: f.path, SessionID: rolloutThread, Now: rolloutNow, Env: f.env.Env, Allowed: func(at time.Time) bool { return !at.Before(cutoff) }}, nil)
	if err != nil || len(result.Events) != 1 {
		t.Fatalf("got %d events, %v", len(result.Events), err)
	}
	f.cursor = result.Cursor
	if events := f.read(t); len(events) != 0 {
		t.Fatalf("usage passed over is never read again: %v", events)
	}
}

// On a volume that folds case and Unicode form, another spelling of the
// sessions directory is the same directory: read, never wrongly refused.
func TestRolloutUsage_ConfinementComparesCanonicalSpellings(t *testing.T) {
	content := encodeRollout(t, sessionMeta("Codex Desktop"), usageRecord(3*time.Second, rolloutThread, "resp_01", codexTokens(100, 0, 0, 1, 0)))
	f := newRollout(t, content)
	upper := filepath.Join(filepath.Dir(f.env.codexHome), ".CODEX", "SESSIONS")
	if _, err := os.Stat(upper); err != nil {
		t.Skip("case-sensitive volume")
	}
	respelled := filepath.Join(upper, strings.TrimPrefix(f.path, filepath.Join(f.env.codexHome, "sessions")))
	if events := f.readPath(t, respelled, time.Time{}); len(events) != 1 {
		t.Fatalf("a case variant of the sessions directory was refused: %v", events)
	}

	composed := filepath.Join(filepath.Dir(f.env.codexHome), "café-codex")
	decomposed := filepath.Join(filepath.Dir(f.env.codexHome), "café-codex")
	custom := filepath.Join(composed, "sessions", "2026", "09", "29", filepath.Base(f.path))
	write(t, custom, content)
	f.env.Getenv = func(key string) string {
		if key == "CODEX_HOME" {
			return strings.ToUpper(decomposed)
		}
		return ""
	}
	f.cursor = nil
	if events := f.readPath(t, filepath.Join(decomposed, "sessions", "2026", "09", "29", filepath.Base(f.path)), time.Time{}); len(events) != 1 {
		t.Fatalf("CODEX_HOME and the path in other case and Unicode forms were refused: %v", events)
	}
	f.cursor = nil
	if events := f.readPath(t, filepath.Join(strings.ToUpper(f.env.codexHome), "sessions", "2026", "09", "29", filepath.Base(f.path)), time.Time{}); len(events) != 0 {
		t.Fatalf("a respelled ~/.codex is still outside a CODEX_HOME elsewhere: %v", events)
	}
}

// A running total that drops was restarted (a compaction, /new): what it
// counts after the drop is new usage, counted from zero.
func TestRolloutUsage_ARestartedRunningTotalIsCountedFromZero(t *testing.T) {
	total := func(offset time.Duration, output int) rolloutEntry {
		return tokenCount(offset, map[string]any{"input_tokens": 0, "output_tokens": output, "total_tokens": output}, nil)
	}
	f := newRollout(t, encodeRollout(t, sessionMeta("codex_cli_rs"), total(2*time.Second, 100), total(3*time.Second, 250), total(4*time.Second, 250), total(5*time.Second, 40), total(6*time.Second, 90)))
	events := f.read(t)
	sum := 0
	for _, output := range outputs(events) {
		sum += output
	}
	if sum != 340 || fmt.Sprint(outputs(events)) != "[100 150 40 50]" {
		t.Fatalf("want 250 before the restart and 90 after, got %v", outputs(events))
	}
	f.cursor = nil
	if replay := f.read(t); fmt.Sprint(outputs(replay)) != "[100 150 40 50]" {
		t.Fatalf("a re-read yields the same usage: %v", outputs(replay))
	}
}
