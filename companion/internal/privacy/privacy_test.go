// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package privacy

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func TestSanitizeRedactsSecretsAndReportsLoss(t *testing.T) {
	input := map[string]any{"prompt": "token=verysecretvalue repeated verysecretvalue", "tool_input": map[string]any{"api_key": "structuredsecret", "text": "bearer abcdefghijklmnop"}, "last_assistant_message": strings.Repeat("x", 5000), "transcript_path": "/private/transcript.jsonl"}
	clean, coverage := Sanitize(input)
	data, _ := json.Marshal(clean)
	for _, secret := range []string{"verysecretvalue", "structuredsecret", "abcdefghijklmnop", "/private/transcript"} {
		if bytes.Contains(data, []byte(secret)) {
			t.Fatalf("retained %s", secret)
		}
	}
	if len(coverage.TruncatedFields) != 1 || coverage.TruncatedFields[0] != "last_assistant_message" {
		t.Fatalf("missing loss metadata: %+v", coverage)
	}
	if coverage.Transcript != "not_read" || len(coverage.RemovedFields) != 1 {
		t.Fatalf("must state transcript limitation: %+v", coverage)
	}
}

func TestCoverageMetadataIsBoundedWithoutChangingMemberNames(t *testing.T) {
	removed := make([]any, 1000)
	for index := range removed {
		removed[index] = map[string]any{"transcript_path": "omitted"}
	}
	nested := any(removed)
	for depth := 0; depth < 10; depth++ {
		nested = map[string]any{strings.Repeat("n", 200): nested}
	}
	clean, coverage := Sanitize(map[string]any{"extra": nested, "another": removed})
	encoded, _ := json.Marshal(coverage)
	if len(encoded) > 9000 || coverage.OmittedFieldPaths == 0 {
		t.Fatalf("coverage not bounded or omission unreported: %d bytes", len(encoded))
	}
	current := clean["extra"]
	for depth := 0; depth < 10; depth++ {
		current = current.(map[string]any)[strings.Repeat("n", 200)]
	}
	if _, ok := current.([]any); !ok {
		t.Fatal("member names were changed")
	}
}

func TestValidateStructureRejectsDepthNodesAndUnsafeMemberNames(t *testing.T) {
	deep := any(0.0)
	for i := 0; i < 70; i++ {
		deep = []any{deep}
	}
	wide := make([]any, 20000)
	for _, value := range []any{
		deep,
		wide,
		map[string]any{"bearer abcdefghijklmnop": "x"},
		map[string]any{strings.Repeat("x", 300): "x"},
	} {
		if err := ValidateStructure(value); err == nil {
			t.Fatalf("accepted unsupported structure %T", value)
		}
	}
	if err := ValidateStructure(map[string]any{"cwd": "/x", "nested": []any{map[string]any{"ok": 1}}}); err != nil {
		t.Fatal(err)
	}
}

func TestContentLevels(t *testing.T) {
	if _, err := ParseContentLevel("verbose"); err == nil {
		t.Fatal("unknown level accepted")
	}
	if level, err := ParseContentLevel(""); err != nil || level != Standard {
		t.Fatal("empty level must default to standard")
	}
	payload := func() map[string]any {
		return map[string]any{
			"session_id": "s1", "cwd": "/repo", "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_use_id": "t1",
			"prompt": "please refactor the secret project", "last_assistant_message": "done", "message": "notified",
			"tool_input":    map[string]any{"command": "make clean-build", "timeout": json.Number("30")},
			"tool_response": map[string]any{"stdout": "diff --git a/x b/x"},
			"error":         "exit 1: build failed",
		}
	}
	for _, level := range []ContentLevel{Standard, Full} {
		out := ApplyContentLevel(payload(), level)
		if out["prompt"] != "please refactor the secret project" {
			t.Fatalf("%s must keep today's sanitized content", level)
		}
	}
	out := ApplyContentLevel(payload(), Metadata)
	encoded, _ := json.Marshal(out)
	for _, content := range []string{"refactor", "clean-build", "diff --git", "build failed", "notified", `"done"`} {
		if bytes.Contains(encoded, []byte(content)) {
			t.Fatalf("metadata level kept content %q: %s", content, encoded)
		}
	}
	for _, kept := range []string{`"session_id":"s1"`, `"tool_name":"Bash"`, `"tool_use_id":"t1"`, `"cwd":"/repo"`, `"timeout":30`} {
		if !bytes.Contains(encoded, []byte(kept)) {
			t.Fatalf("metadata level lost %s: %s", kept, encoded)
		}
	}
	if prompt, _ := out["prompt"].(string); !strings.HasPrefix(prompt, "[omitted 34 bytes sha256:") {
		t.Fatalf("metadata level must keep size and hash: %q", prompt)
	}
	again := ApplyContentLevel(out, Metadata)
	if again["prompt"] != out["prompt"] {
		t.Fatal("metadata stripping is not idempotent")
	}
}

func TestMetadataLevelCoversPiContentButKeepsStructure(t *testing.T) {
	payload := map[string]any{
		"type": "message_end", "sessionId": "s1", "cwd": "/repo",
		"message": map[string]any{
			"role": "assistant", "model": "claude-x", "provider": "anthropic",
			"content": []any{map[string]any{"type": "thinking", "thinking": "secret plan"}, map[string]any{"type": "text", "text": "secret answer"}},
			"usage":   map[string]any{"input": json.Number("10"), "output": json.Number("5")},
		},
		"command": "cat secrets.txt",
		"details": map[string]any{"patch": "diff --git secret"},
	}
	out := ApplyContentLevel(payload, Metadata)
	encoded, _ := json.Marshal(out)
	for _, content := range []string{"secret plan", "secret answer", "cat secrets", "diff --git"} {
		if bytes.Contains(encoded, []byte(content)) {
			t.Fatalf("metadata level kept %q: %s", content, encoded)
		}
	}
	for _, kept := range []string{`"role":"assistant"`, `"type":"thinking"`, `"model":"claude-x"`, `"provider":"anthropic"`, `"input":10`, `"sessionId":"s1"`} {
		if !bytes.Contains(encoded, []byte(kept)) {
			t.Fatalf("metadata level lost structure %s: %s", kept, encoded)
		}
	}
}

func fakeImage() string {
	return strings.Repeat("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk", 40)
}

func TestSanitizeNeverRetainsBinaryAtAnyLevel(t *testing.T) {
	image := fakeImage()
	payload := map[string]any{
		"type":       "input",
		"text":       "look at this",
		"images":     []any{map[string]any{"type": "image", "data": image, "mimeType": "image/png"}},
		"tool_input": map[string]any{"content": []any{map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/jpeg", "data": image}}}},
		"attachment": "data:image/png;base64," + image,
	}
	clean, _ := Sanitize(payload)
	encoded, _ := json.Marshal(clean)
	if bytes.Contains(encoded, []byte(image[:64])) {
		t.Fatalf("image bytes retained after sanitizing: %.300s", encoded)
	}
	piImage := clean["images"].([]any)[0].(map[string]any)
	if piImage["type"] != "image" || piImage["mime"] != "image/png" || piImage["bytes"] == nil || len(piImage["sha256"].(string)) != 64 {
		t.Fatalf("Pi image descriptor: %v", piImage)
	}
	if _, kept := piImage["data"]; kept {
		t.Fatal("image data member kept")
	}
	source := clean["tool_input"].(map[string]any)["content"].([]any)[0].(map[string]any)["source"].(map[string]any)
	if source["type"] != "base64" || source["mime"] != "image/jpeg" || source["sha256"] == nil {
		t.Fatalf("Claude image source descriptor: %v", source)
	}
	if !strings.HasPrefix(clean["attachment"].(string), "[binary omitted ") {
		t.Fatalf("data URL retained: %.80s", clean["attachment"])
	}
	if clean["text"] != "look at this" {
		t.Fatal("ordinary text changed")
	}
	short := map[string]any{"data": "aGVsbG8="}
	if cleanShort, _ := Sanitize(short); cleanShort["data"] != "aGVsbG8=" {
		t.Fatal("short values are not binary payloads")
	}
}

func TestIsBinaryString(t *testing.T) {
	if !IsBinaryString("data", fakeImage()) || !IsBinaryString("anything", "data:image/png;base64,"+fakeImage()) {
		t.Fatal("binary not recognized")
	}
	if IsBinaryString("output", strings.Repeat("plain words ", 200)) || IsBinaryString("text", fakeImage()) {
		t.Fatal("prose, or base64-looking text outside binary keys, must not be treated as binary")
	}
}

func TestStructuralExemptionIsScopedToPiMessages(t *testing.T) {
	piMessage := map[string]any{"message": map[string]any{
		"role": "assistant", "model": "claude-x", "provider": "anthropic",
		"content": []any{map[string]any{"type": "thinking", "thinking": "private plan"}},
	}}
	out := ApplyContentLevel(piMessage, Metadata)
	message := out["message"].(map[string]any)
	part := message["content"].([]any)[0].(map[string]any)
	if message["role"] != "assistant" || message["model"] != "claude-x" || part["type"] != "thinking" || strings.Contains(part["thinking"].(string), "private") {
		t.Fatalf("Pi message structure: %v", message)
	}
	claude := map[string]any{"tool_input": map[string]any{"type": "secret-kind", "model": "secret-model", "role": "admin"}}
	encoded, _ := json.Marshal(ApplyContentLevel(claude, Metadata))
	for _, leaked := range []string{"secret-kind", "secret-model", "admin"} {
		if bytes.Contains(encoded, []byte(leaked)) {
			t.Fatalf("Claude tool_input member %q kept at metadata: %s", leaked, encoded)
		}
	}
	piTool := map[string]any{"type": "tool_call", "input": map[string]any{"provider": "internal-billing", "type": "secret"}}
	encoded, _ = json.Marshal(ApplyContentLevel(piTool, Metadata))
	if bytes.Contains(encoded, []byte("internal-billing")) || bytes.Contains(encoded, []byte(`"secret"`)) || !bytes.Contains(encoded, []byte(`"type":"tool_call"`)) {
		t.Fatalf("Pi tool arguments kept at metadata: %s", encoded)
	}
}

func TestEventContentLevelKeepsOnlyStructuralPaths(t *testing.T) {
	event := map[string]any{
		"schema_version": "1.0", "timestamp": "2026-09-24T12:00:00Z", "message": "PROMPT_AS_MESSAGE",
		"event":   map[string]any{"action": "prompt.submitted", "id": "e1"},
		"session": map[string]any{"id": "thread-root"},
		"harness": map[string]any{"name": "codex_cli", "collection_method": "otlp"},
		"prompt":  map[string]any{"text": "SECRET_PROMPT"},
		"command": map[string]any{"command": "SECRET_COMMAND"},
		"gen_ai":  map[string]any{"usage": map[string]any{"input_tokens": json.Number("5")}, "tool": map[string]any{"call": map[string]any{"id": "call_1"}}, "input": map[string]any{"messages": []any{"SECRET_MESSAGE"}}},
		"raw":     map[string]any{"otel_signal": "logs", "codex": map[string]any{"prompt": "SECRET_RAW"}},
		"tool":    map[string]any{"name": "exec_command", "command": "SECRET_TOOL_COMMAND"},
	}
	out := ApplyEventContentLevel(event, Metadata)
	encoded, _ := json.Marshal(out)
	for _, secret := range []string{"SECRET_PROMPT", "SECRET_COMMAND", "SECRET_MESSAGE", "SECRET_RAW", "SECRET_TOOL_COMMAND", "PROMPT_AS_MESSAGE"} {
		if bytes.Contains(encoded, []byte(secret)) {
			t.Fatalf("%s kept at metadata: %s", secret, encoded)
		}
	}
	for _, kept := range []string{`"action":"prompt.submitted"`, `"id":"thread-root"`, `"input_tokens":5`, `"id":"call_1"`, `"name":"exec_command"`, `"otel_signal":"logs"`, `"collection_method":"otlp"`} {
		if !bytes.Contains(encoded, []byte(kept)) {
			t.Fatalf("structural %s lost: %s", kept, encoded)
		}
	}
	if standard := ApplyEventContentLevel(event, Standard); standard["prompt"].(map[string]any)["text"] != "SECRET_PROMPT" {
		t.Fatal("standard level must not change events")
	}
}

// Pricing needs the model, provider, service tier and auth mode of a usage
// event at every level; they name the plan and model, never the content.
func TestEventContentLevelKeepsPricingMetadata(t *testing.T) {
	event := map[string]any{
		"event":  map[string]any{"action": "codex.sse_event"},
		"gen_ai": map[string]any{"provider": map[string]any{"name": "openai"}, "request": map[string]any{"model": "gpt-5.4"}, "response": map[string]any{"model": "gpt-5.4-2026-03-05"}},
		"raw": map[string]any{"attributes": map[string]any{
			"auth_mode": "Chatgpt", "service_tier": "priority", "provider_name": "openai",
			"input_token_count": "1200", "prompt": "SECRET_RAW_PROMPT",
		}},
	}
	encoded, _ := json.Marshal(ApplyEventContentLevel(event, Metadata))
	// Per-response token counts are not priced from (the turn span is), so
	// they stay digested like any other unknown attribute.
	for _, dropped := range []string{"SECRET_RAW_PROMPT", `"input_token_count":"1200"`} {
		if bytes.Contains(encoded, []byte(dropped)) {
			t.Fatalf("%s kept at metadata: %s", dropped, encoded)
		}
	}
	for _, kept := range []string{`"auth_mode":"Chatgpt"`, `"service_tier":"priority"`, `"provider_name":"openai"`, `"name":"openai"`, `"model":"gpt-5.4"`, `"model":"gpt-5.4-2026-03-05"`} {
		if !bytes.Contains(encoded, []byte(kept)) {
			t.Fatalf("pricing metadata %s lost: %s", kept, encoded)
		}
	}
}

func TestEventContentLevelKeepsClaudeUsageMetadata(t *testing.T) {
	event := map[string]any{
		"event":  map[string]any{"action": "token.usage", "category": "metric"},
		"model":  "claude-sonnet-4-5-20250929",
		"gen_ai": map[string]any{"usage": map[string]any{"input_tokens": 3, "service_tier": "standard", "cache_creation": map[string]any{"ephemeral_1h_input_tokens": 2}}},
	}
	encoded, _ := json.Marshal(ApplyEventContentLevel(event, Metadata))
	for _, kept := range []string{`"service_tier":"standard"`, `"ephemeral_1h_input_tokens":2`, `"model":"claude-sonnet-4-5-20250929"`} {
		if !bytes.Contains(encoded, []byte(kept)) {
			t.Fatalf("usage metadata %s lost: %s", kept, encoded)
		}
	}
}

func TestDataURLsInsideTextAreReplacedInPlace(t *testing.T) {
	image := fakeImage()
	prompt := "compare ![before](data:image/png;base64," + image + ") with ![after](data:image/jpeg;base64," + image[:600] + ") please"
	clean, _ := Sanitize(map[string]any{"prompt": prompt})
	text := clean["prompt"].(string)
	if strings.Contains(text, image[:40]) || strings.Count(text, "[binary omitted ") != 2 {
		t.Fatalf("embedded data URLs not replaced: %.200s", text)
	}
	if !strings.HasPrefix(text, "compare ![before](") || !strings.HasSuffix(text, ") please") {
		t.Fatalf("surrounding text changed: %.200s", text)
	}
}

func TestSmallImagesAreDescribedRegardlessOfSize(t *testing.T) {
	small := fakeImage()[:750]
	for name, object := range map[string]map[string]any{
		"pi":     {"type": "image", "data": small, "mimeType": "image/png"},
		"claude": {"type": "base64", "media_type": "image/gif", "data": small},
		"typed":  {"type": "image", "data": small},
	} {
		clean, _ := Sanitize(map[string]any{"item": object})
		described := clean["item"].(map[string]any)
		if _, kept := described["data"]; kept || described["sha256"] == nil || described["bytes"] == nil {
			t.Errorf("%s: small image kept: %v", name, described)
		}
	}
	plain := map[string]any{"item": map[string]any{"data": "ordinary short value", "kind": "note"}}
	if clean, _ := Sanitize(plain); clean["item"].(map[string]any)["data"] != "ordinary short value" {
		t.Fatal("a data member without a media indicator is not an image")
	}
}

func TestToolOutputByLevel(t *testing.T) {
	longOutput := strings.Repeat("line of tool output\n", 2000)
	claude := func() map[string]any {
		return map[string]any{"hook_event_name": "PostToolUse", "tool_input": map[string]any{"command": "make test"}, "tool_response": map[string]any{"stdout": longOutput, "exit_code": json.Number("0")}}
	}
	members := []string{"tool_response"}

	standard, _ := SanitizeFor(ReduceToolOutput(claude(), members, Standard), members, Standard)
	descriptor, ok := standard["tool_response"].(map[string]any)
	if !ok || descriptor["bytes"] == nil || len(descriptor["sha256"].(string)) != 64 || len(descriptor) != 2 {
		t.Fatalf("standard must replace tool output with {bytes, sha256}: %v", standard["tool_response"])
	}
	if standard["tool_input"].(map[string]any)["command"] != "make test" {
		t.Fatal("standard must keep the command")
	}
	again := ReduceToolOutput(standard, members, Standard)
	if again["tool_response"].(map[string]any)["sha256"] != descriptor["sha256"] {
		t.Fatal("reducing twice must keep the original digest")
	}

	full, coverage := SanitizeFor(ReduceToolOutput(claude(), members, Full), members, Full)
	stdout := full["tool_response"].(map[string]any)["stdout"].(string)
	if len(stdout) > MaxFullToolOutputBytes+64 || !strings.HasPrefix(stdout, "line of tool output") || !strings.HasSuffix(stdout, truncationMarker) {
		t.Fatalf("full must keep tool output bounded with a marker: %d bytes, suffix %q", len(stdout), stdout[len(stdout)-20:])
	}
	if len(stdout) <= contentStringLimit {
		t.Fatal("full must allow more tool output than the general string bound")
	}
	if len(coverage.TruncatedFields) == 0 {
		t.Fatal("truncation not reported")
	}

	metadata := ApplyContentLevel(ReduceToolOutput(claude(), members, Metadata), Metadata)
	encoded, _ := json.Marshal(metadata)
	if bytes.Contains(encoded, []byte("line of tool output")) {
		t.Fatal("metadata kept tool output")
	}
}

func TestEventStandardLevelReplacesToolOutput(t *testing.T) {
	event := map[string]any{
		"event":   map[string]any{"action": "command.executed"},
		"command": map[string]any{"command": "make test", "output": "EVENT_OUTPUT", "stderr": "EVENT_STDERR"},
		"tool":    map[string]any{"name": "exec_command", "output": "TOOL_OUTPUT"},
	}
	encoded, _ := json.Marshal(ApplyEventContentLevel(event, Standard))
	for _, output := range []string{"EVENT_OUTPUT", "EVENT_STDERR", "TOOL_OUTPUT"} {
		if bytes.Contains(encoded, []byte(output)) {
			t.Fatalf("standard kept %s: %s", output, encoded)
		}
	}
	if !bytes.Contains(encoded, []byte("make test")) || !bytes.Contains(encoded, []byte(`"sha256"`)) {
		t.Fatalf("standard must keep the command and describe the output: %s", encoded)
	}
	if full, _ := json.Marshal(ApplyEventContentLevel(event, Full)); !bytes.Contains(full, []byte("EVENT_OUTPUT")) {
		t.Fatal("full must keep output")
	}
}

// piReasoningEvent is the event the pinned Beacon makes of a Pi assistant
// message: the reply under gen_ai.output and the whole message under raw.
func piReasoningEvent() map[string]any {
	return map[string]any{
		"event":   map[string]any{"action": "agent.reasoning"},
		"gen_ai":  map[string]any{"output": map[string]any{"messages": []any{map[string]any{"role": "assistant", "parts": []any{map[string]any{"type": "reasoning", "content": "SENTINEL_EVENT_REASONING"}}}}}},
		"raw":     map[string]any{"pi": map[string]any{"type": "message_end", "message": map[string]any{"role": "assistant", "model": "claude-x", "content": []any{map[string]any{"type": "text", "text": "SENTINEL_EVENT_REPLY"}}}}},
		"session": map[string]any{"id": "s1"},
	}
}

func TestApplyEventContentLevel_StandardWithholdsAssistantReplies(t *testing.T) {
	encoded, _ := json.Marshal(ApplyEventContentLevel(piReasoningEvent(), Standard))
	for _, reply := range []string{"SENTINEL_EVENT_REASONING", "SENTINEL_EVENT_REPLY"} {
		if bytes.Contains(encoded, []byte(reply)) {
			t.Fatalf("standard sent the agent's reply %s: %s", reply, encoded)
		}
	}
	if !bytes.Contains(encoded, []byte(`"model":"claude-x"`)) || !bytes.Contains(encoded, []byte(`"action":"agent.reasoning"`)) {
		t.Fatalf("withholding the reply must keep what describes it: %s", encoded)
	}
}

func TestApplyEventContentLevel_FullKeepsAssistantReplies(t *testing.T) {
	encoded, _ := json.Marshal(ApplyEventContentLevel(piReasoningEvent(), Full))
	for _, reply := range []string{"SENTINEL_EVENT_REASONING", "SENTINEL_EVENT_REPLY"} {
		if !bytes.Contains(encoded, []byte(reply)) {
			t.Fatalf("full must send the agent's reply %s: %s", reply, encoded)
		}
	}
}

func TestApplyContentLevel_StandardWithholdsRepliesIdempotently(t *testing.T) {
	payload := map[string]any{"hook_event_name": "Stop", "session_id": "s1", "last_assistant_message": "the reply"}
	once := ApplyContentLevel(payload, Standard)
	if once["last_assistant_message"] == "the reply" || once["session_id"] != "s1" {
		t.Fatalf("standard reply rule: %v", once)
	}
	if twice := ApplyContentLevel(once, Standard); twice["last_assistant_message"] != once["last_assistant_message"] {
		t.Fatal("withholding a reply twice must keep the first digest")
	}
}

func TestEventMetadataLevelDigestsToolCallArgumentsButKeepsTheCallID(t *testing.T) {
	event := map[string]any{"gen_ai": map[string]any{"tool": map[string]any{"call": map[string]any{"id": "call_1", "arguments": `{"cmd":"cat SECRET_ARGS"}`}}}}
	encoded, _ := json.Marshal(ApplyEventContentLevel(event, Metadata))
	if bytes.Contains(encoded, []byte("SECRET_ARGS")) || !bytes.Contains(encoded, []byte(`"id":"call_1"`)) {
		t.Fatalf("metadata tool call: %s", encoded)
	}
}

func TestSanitizeRemovesAgentSessionFilePaths(t *testing.T) {
	for _, level := range []ContentLevel{Metadata, Standard, Full, Rich} {
		clean, coverage := SanitizeFor(map[string]any{"sessionId": "s", "sessionFile": "/home/me/.pi/agent/sessions/x_s.jsonl"}, nil, level)
		if _, kept := clean["sessionFile"]; kept || !slices.Contains(coverage.RemovedFields, "sessionFile") {
			t.Fatalf("%s: %v %v", level, clean, coverage.RemovedFields)
		}
	}
}
