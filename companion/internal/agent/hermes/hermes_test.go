// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package hermes

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/claudecode"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/pi"
)

const (
	fixtureSession = "20260924_115958_a1b2c3"
	fixtureCallID  = "toolu_01AbCdEf"
	// sentinelMark starts every content value the fixtures carry.
	sentinelMark = "HERMES_SENTINEL"
)

var subscribedEvents = []string{"on_session_start", "post_tool_call", "post_approval_response", "on_session_finalize"}

// beaconCommands: post_approval_response is the pinned beacon-hooks
// permission-request, the only command that emits approval.denied for a deny.
var beaconCommands = map[string]string{
	"on_session_start":       "session-start",
	"post_tool_call":         "post-tool",
	"post_approval_response": "permission-request",
	"on_session_finalize":    "session-end",
}

// fakeAPIKey is assembled at run time so the tree holds no credential-shaped
// literal; it escapes the redaction heuristics, so only projection removes it.
func fakeAPIKey() string { return "sk-" + "proj-" + strings.Repeat("Q7x", 12) }

func readFixture(t *testing.T, name, cwd string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	quotedCwd, _ := json.Marshal(cwd)
	data = bytes.ReplaceAll(data, []byte(`"__CWD__"`), quotedCwd)
	return bytes.ReplaceAll(data, []byte("__API_KEY__"), []byte(fakeAPIKey()))
}

func input(t *testing.T, event, cwd string) []byte {
	return readFixture(t, event+".input.json", cwd)
}

func goldenPayload(t *testing.T, event, cwd string) map[string]any {
	return decodeJSON(t, readFixture(t, event+".payload.json", cwd))
}

func decodeJSON(t *testing.T, data []byte) map[string]any {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value map[string]any
	if err := decoder.Decode(&value); err != nil {
		t.Fatalf("%v: %s", err, data)
	}
	return value
}

func canonical(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// withoutNullToolMembers drops the tool_name and tool_input nulls the plugin
// sends on events that are not tool calls: whether the projection keeps those
// nulls is left open, nothing else is.
func withoutNullToolMembers(event string, payload map[string]any) map[string]any {
	if event == "post_tool_call" {
		return payload
	}
	out := make(map[string]any, len(payload))
	for key, value := range payload {
		if (key == "tool_name" || key == "tool_input") && value == nil {
			continue
		}
		out[key] = value
	}
	return out
}

func parse(t *testing.T, raw []byte) (agent.Observation, map[string]any) {
	t.Helper()
	observation, payload, err := New().ParseHook(raw)
	if err != nil {
		t.Fatalf("ParseHook: %v", err)
	}
	return observation, payload
}

// variant is an event's fixture input after edit.
func variant(t *testing.T, event, cwd string, edit func(payload, extra map[string]any)) []byte {
	t.Helper()
	payload := decodeJSON(t, input(t, event, cwd))
	extra, _ := payload["extra"].(map[string]any)
	edit(payload, extra)
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

// member reads a dotted path such as "extra.status".
func member(payload map[string]any, path string) (any, bool) {
	var current any = payload
	for _, name := range strings.Split(path, ".") {
		object, isObject := current.(map[string]any)
		if !isObject {
			return nil, false
		}
		if current, isObject = object[name]; !isObject {
			return nil, false
		}
	}
	return current, true
}

// withoutMember is a deep copy of payload without the dotted path.
func withoutMember(t *testing.T, payload map[string]any, path string) map[string]any {
	t.Helper()
	copied := decodeJSON(t, []byte(canonical(t, payload)))
	names := strings.Split(path, ".")
	parent := copied
	for _, name := range names[:len(names)-1] {
		next, _ := parent[name].(map[string]any)
		if next == nil {
			return copied
		}
		parent = next
	}
	delete(parent, names[len(names)-1])
	return copied
}

func assertNoContent(t *testing.T, where string, encoded string) {
	t.Helper()
	for _, leaked := range []string{sentinelMark, fakeAPIKey(), "sha256:", "[omitted", "[REDACTED"} {
		if strings.Contains(encoded, leaked) {
			t.Fatalf("%s retains %q: %s", where, leaked, encoded)
		}
	}
}

func TestAdapterIsTheHermesAgentReachedAsHermes(t *testing.T) {
	adapter := New()
	if adapter.ID() != "hermes_agent" || adapter.Ingress() != agent.IngressPlugin || adapter.BeaconPlatform() != "hermes" {
		t.Fatalf("id %q, ingress %q, platform %q", adapter.ID(), adapter.Ingress(), adapter.BeaconPlatform())
	}
	if aliases := adapter.Aliases(); len(aliases) != 1 || aliases[0] != "hermes" {
		t.Fatalf("aliases %v", aliases)
	}
	registry := agent.NewRegistry(claudecode.New(), codex.New(), pi.New(), adapter)
	for _, name := range []string{"hermes", "hermes_agent", "hermes-agent"} {
		if found, err := registry.Lookup(name); err != nil || found.ID() != "hermes_agent" {
			t.Fatalf("`hook %s` does not reach the adapter: %v", name, err)
		}
	}
	var asAgent agent.Agent = adapter
	if _, ok := asAgent.(agent.CaptureKeySource); !ok {
		t.Fatal("hermes must name an inbox item by what it observed")
	}
	if _, ok := asAgent.(agent.EventProjector); !ok {
		t.Fatal("hermes must keep only its allowlisted event members")
	}
}

func TestExistingAgentsImplementNeitherCaptureKeysNorProjection(t *testing.T) {
	for _, existing := range []agent.Agent{claudecode.New(), codex.New(), pi.New()} {
		if _, ok := existing.(agent.CaptureKeySource); ok {
			t.Errorf("%s would stop naming captures by inbox item", existing.ID())
		}
		if _, ok := existing.(agent.EventProjector); ok {
			t.Errorf("%s would have its Beacon events projected", existing.ID())
		}
	}
}

func TestParseHookProjectsEachSubscribedEventToItsGolden(t *testing.T) {
	adapter := New()
	cwd := t.TempDir()
	for _, event := range subscribedEvents {
		observation, payload := parse(t, input(t, event, cwd))
		if got, want := canonical(t, withoutNullToolMembers(event, payload)), canonical(t, goldenPayload(t, event, cwd)); got != want {
			t.Fatalf("%s projection\n got %s\nwant %s", event, got, want)
		}
		assertNoContent(t, event, canonical(t, payload))
		if observation.Event != event || observation.NativeSessionID != fixtureSession || observation.Cwd != cwd {
			t.Fatalf("%s observation %+v", event, observation)
		}
		if event == "post_tool_call" && observation.NativeToolCallID != fixtureCallID {
			t.Fatalf("tool call id %q", observation.NativeToolCallID)
		}
		if event == "on_session_start" || event == "on_session_finalize" {
			if observation.NativeToolCallID != "" {
				t.Fatalf("%s carries a tool call id %q", event, observation.NativeToolCallID)
			}
		}
		if command, ok := adapter.BeaconCommand(event); !ok || command != beaconCommands[event] {
			t.Fatalf("%s: beacon command %q, want %q", event, command, beaconCommands[event])
		}
		if !adapter.IdentityPreserved(observation, payload) {
			t.Fatalf("%s: identity not preserved on an untouched payload", event)
		}
		if prepared := adapter.PrepareBeaconInput(event, payload); canonical(t, prepared) != canonical(t, payload) {
			t.Fatalf("%s: Beacon input changed: %s", event, canonical(t, prepared))
		}
		if output := adapter.ToolOutput(event); output != nil {
			t.Fatalf("%s: tool output members %v", event, output)
		}
	}
}

func TestParseHookDropsMembersOutsideTheAllowlist(t *testing.T) {
	cases := []struct {
		name, event, path string
		value             any
	}{
		{"status outside its enum", "post_tool_call", "extra.status", "HERMES_SENTINEL_STATUS"},
		{"status as an object", "post_tool_call", "extra.status", map[string]any{"value": "ok", "note": "HERMES_SENTINEL_STATUS"}},
		{"negative duration", "post_tool_call", "extra.duration_ms", -1},
		{"fractional duration", "post_tool_call", "extra.duration_ms", 1.5},
		{"duration as text", "post_tool_call", "extra.duration_ms", "42"},
		{"observed_at not RFC 3339", "post_tool_call", "extra.observed_at", "HERMES_SENTINEL yesterday"},
		{"tool name outside its alphabet", "post_tool_call", "tool_name", "make deploy HERMES_SENTINEL"},
		{"tool name over 128 bytes", "post_tool_call", "tool_name", strings.Repeat("t", 129)},
		{"tool input carrying arguments", "post_tool_call", "tool_input", map[string]any{"command": "HERMES_SENTINEL_ARGS"}},
		{"model outside its alphabet", "on_session_start", "extra.model", "claude sonnet HERMES_SENTINEL"},
		{"model over 128 bytes", "on_session_start", "extra.model", strings.Repeat("m", 129)},
		{"free-text finalize reason", "on_session_finalize", "extra.reason", "HERMES_SENTINEL the user typed quit"},
		{"finalize reason over 32 bytes", "on_session_finalize", "extra.reason", "a" + strings.Repeat("b", 32)},
		{"finalize reason with a digit", "on_session_finalize", "extra.reason", "reason2"},
		{"nested unknown member", "post_approval_response", "extra.context", map[string]any{"prompt": map[string]any{"text": "HERMES_SENTINEL_NESTED"}}},
	}
	cwd := t.TempDir()
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			raw := variant(t, c.event, cwd, func(payload, _ map[string]any) {
				names := strings.Split(c.path, ".")
				parent := payload
				for _, name := range names[:len(names)-1] {
					parent = parent[name].(map[string]any)
				}
				parent[names[len(names)-1]] = c.value
			})
			observation, payload, err := New().ParseHook(raw)
			if err != nil {
				t.Fatalf("a disallowed member must be dropped, not refuse the event: %v", err)
			}
			if value, kept := member(payload, c.path); kept && !(c.path == "tool_input" && value == nil) {
				t.Fatalf("%s kept as %v", c.path, value)
			}
			assertNoContent(t, c.name, canonical(t, payload))
			got := withoutMember(t, withoutNullToolMembers(c.event, payload), c.path)
			want := withoutMember(t, goldenPayload(t, c.event, cwd), c.path)
			if canonical(t, got) != canonical(t, want) {
				t.Fatalf("dropping %s changed the rest\n got %s\nwant %s", c.path, canonical(t, got), canonical(t, want))
			}
			if observation.NativeSessionID != fixtureSession {
				t.Fatalf("observation %+v", observation)
			}
		})
	}
}

func TestParseHookKeepsEveryAllowedValue(t *testing.T) {
	cwd := t.TempDir()
	cases := []struct {
		event, path string
		values      []any
	}{
		{"post_tool_call", "extra.status", []any{"ok", "error", "blocked", "cancelled"}},
		{"post_tool_call", "extra.duration_ms", []any{0, 1, 86400000}},
		{"post_tool_call", "extra.platform", []any{"cli", "tui", "desktop", "acp"}},
		{"on_session_finalize", "extra.reason", []any{"cli_close", "new_session", "resumed_other", "session_boundary", "shutdown", "a" + strings.Repeat("b", 31)}},
		{"on_session_start", "extra.model", []any{"gpt-5.1", "openrouter/qwen/qwen3-coder:free", strings.Repeat("m", 128)}},
		{"post_tool_call", "tool_name", []any{"terminal", "read_file", "mcp__github__create_issue", strings.Repeat("t", 128)}},
	}
	for _, c := range cases {
		for _, value := range c.values {
			raw := variant(t, c.event, cwd, func(payload, _ map[string]any) {
				names := strings.Split(c.path, ".")
				parent := payload
				for _, name := range names[:len(names)-1] {
					parent = parent[name].(map[string]any)
				}
				parent[names[len(names)-1]] = value
			})
			_, payload := parse(t, raw)
			kept, found := member(payload, c.path)
			if !found || canonical(t, kept) != canonical(t, value) {
				t.Fatalf("%s %s=%v was not kept: %s", c.event, c.path, value, canonical(t, payload))
			}
		}
	}
}

func TestParseHookNeverRetainsACredentialShapedMemberName(t *testing.T) {
	name := "sk-" + strings.Repeat("Q7x", 8)
	cwd := t.TempDir()
	placements := map[string]func(payload, extra map[string]any){
		"top level": func(payload, _ map[string]any) { payload[name] = "x" },
		"in extra":  func(_, extra map[string]any) { extra[name] = "x" },
		"nested":    func(_, extra map[string]any) { extra["headers"] = map[string]any{name: "x"} },
	}
	for placement, edit := range placements {
		_, payload, err := New().ParseHook(variant(t, "post_tool_call", cwd, edit))
		if err != nil {
			if !errors.Is(err, agent.ErrInvalidHook) {
				t.Fatalf("%s: refused with %v", placement, err)
			}
			continue
		}
		if strings.Contains(canonical(t, payload), name) {
			t.Fatalf("%s: a credential-shaped member name was retained", placement)
		}
	}
}

func TestParseHookRefusesMissingOrInvalidIdentity(t *testing.T) {
	cwd := t.TempDir()
	cases := map[string]func(payload, extra map[string]any){
		"no session id":             func(payload, _ map[string]any) { delete(payload, "session_id") },
		"empty session id":          func(payload, _ map[string]any) { payload["session_id"] = "" },
		"session id leading _":      func(payload, _ map[string]any) { payload["session_id"] = "_20260924_115958_a1b2c3" },
		"session id with a space":   func(payload, _ map[string]any) { payload["session_id"] = "20260924 115958" },
		"session id over 200":       func(payload, _ map[string]any) { payload["session_id"] = "a" + strings.Repeat("b", 200) },
		"session id as an object":   func(payload, _ map[string]any) { payload["session_id"] = map[string]any{"id": fixtureSession} },
		"no tool call id":           func(payload, _ map[string]any) { delete(payload, "tool_call_id") },
		"empty tool call id":        func(payload, _ map[string]any) { payload["tool_call_id"] = "" },
		"tool call id with a space": func(payload, _ map[string]any) { payload["tool_call_id"] = "toolu 01" },
		"tool call id over 4096":    func(payload, _ map[string]any) { payload["tool_call_id"] = "c" + strings.Repeat("a", 4096) },
		"tool call id only in extra": func(payload, extra map[string]any) {
			extra["tool_call_id"] = payload["tool_call_id"]
			delete(payload, "tool_call_id")
		},
		"no cwd":       func(payload, _ map[string]any) { delete(payload, "cwd") },
		"relative cwd": func(payload, _ map[string]any) { payload["cwd"] = filepath.Join("code", "project") },
		"empty cwd":    func(payload, _ map[string]any) { payload["cwd"] = "" },
	}
	for name, edit := range cases {
		if _, _, err := New().ParseHook(variant(t, "post_tool_call", cwd, edit)); !errors.Is(err, agent.ErrMissingIdentity) {
			t.Errorf("%s: got %v, want %v", name, err, agent.ErrMissingIdentity)
		}
	}
	for _, event := range []string{"on_session_start", "post_approval_response", "on_session_finalize"} {
		raw := variant(t, event, cwd, func(payload, _ map[string]any) { delete(payload, "session_id") })
		if _, _, err := New().ParseHook(raw); !errors.Is(err, agent.ErrMissingIdentity) {
			t.Errorf("%s without a session id: got %v", event, err)
		}
	}
}

func TestParseHookAcceptsIdentitiesAtTheirBounds(t *testing.T) {
	cwd := t.TempDir()
	// 200 bytes is the longest call id the backend keeps; a longer one is replaced (uploaded_call_id_test.go).
	for _, callID := range []string{"c" + strings.Repeat("a", 199), "call_x|fc_ab+/cd==", "call:1@provider.example"} {
		observation, payload := parse(t, variant(t, "post_tool_call", cwd, func(payload, _ map[string]any) { payload["tool_call_id"] = callID }))
		if observation.NativeToolCallID != callID || payload["tool_call_id"] != callID {
			t.Fatalf("tool call id %q became %q", callID, observation.NativeToolCallID)
		}
	}
	longest := "a" + strings.Repeat("b", 199)
	observation, payload := parse(t, variant(t, "on_session_start", cwd, func(payload, _ map[string]any) { payload["session_id"] = longest }))
	if observation.NativeSessionID != longest || payload["session_id"] != longest {
		t.Fatalf("session id %q", observation.NativeSessionID)
	}
}

func TestParseHookRejectsMalformedPayloads(t *testing.T) {
	golden := string(input(t, "post_tool_call", t.TempDir()))
	deep := strings.Repeat("[", 80) + strings.Repeat("]", 80)
	for name, raw := range map[string]string{
		"not json":        "HERMES_SENTINEL not json",
		"truncated":       golden[:len(golden)/2],
		"two values":      `{"hook_event_name":"on_session_start"}{"hook_event_name":"on_session_start"}`,
		"an array":        `["HERMES_SENTINEL"]`,
		"null":            `null`,
		"too deeply nest": strings.Replace(golden, `"tool_input": null`, `"tool_input": null, "nest": `+deep, 1),
	} {
		if _, _, err := New().ParseHook([]byte(raw)); !errors.Is(err, agent.ErrInvalidHook) {
			t.Errorf("%s: got %v, want %v", name, err, agent.ErrInvalidHook)
		}
	}
}

func TestOnlyTheFourObserverEventsAreSupported(t *testing.T) {
	adapter := New()
	cwd := t.TempDir()
	for _, event := range []string{"stop", "on_session_end", "pre_tool_call", "pre_llm_call", "post_llm_call", "post_api_request", "api_request_error", "subagent_start", "subagent_stop", "on_session_reset", "post_compaction", "agent_loop_stopped", "on_human_input_resolved", "pre_verify", "transform_tool_result", ""} {
		if command, ok := adapter.BeaconCommand(event); ok {
			t.Errorf("%q maps to %q", event, command)
		}
		raw := variant(t, "post_tool_call", cwd, func(payload, _ map[string]any) { payload["hook_event_name"] = event })
		if _, _, err := adapter.ParseHook(raw); !errors.Is(err, agent.ErrUnsupportedEvent) {
			t.Errorf("%q: got %v, want %v", event, err, agent.ErrUnsupportedEvent)
		}
	}
}

func TestParseHookIgnoresSessionsOnMessagingSurfaces(t *testing.T) {
	cwd := t.TempDir()
	for _, event := range subscribedEvents {
		for _, surface := range []string{"telegram", "discord", "slack", "whatsapp", "signal", "email", "webhook"} {
			raw := variant(t, event, cwd, func(_, extra map[string]any) { extra["platform"] = surface })
			if _, _, err := New().ParseHook(raw); !errors.Is(err, agent.ErrIgnoredEvent) {
				t.Errorf("%s on %s: got %v, want %v", event, surface, err, agent.ErrIgnoredEvent)
			}
		}
	}
}

func TestParseHookIgnoresApprovalsThatLetTheCommandRun(t *testing.T) {
	cwd := t.TempDir()
	for _, choice := range []any{"once", "session", "always", "smart_approve", "cancelled", "notify_failed", nil} {
		raw := variant(t, "post_approval_response", cwd, func(_, extra map[string]any) {
			if choice == nil {
				delete(extra, "choice")
				return
			}
			extra["choice"] = choice
		})
		if _, _, err := New().ParseHook(raw); !errors.Is(err, agent.ErrIgnoredEvent) {
			t.Errorf("choice %v: got %v, want %v", choice, err, agent.ErrIgnoredEvent)
		}
	}
}

func TestParseHookCollapsesDenyingChoicesToDeny(t *testing.T) {
	cwd := t.TempDir()
	for _, choice := range []string{"deny", "smart_deny", "timeout"} {
		_, payload := parse(t, variant(t, "post_approval_response", cwd, func(_, extra map[string]any) { extra["choice"] = choice }))
		if got, want := canonical(t, withoutNullToolMembers("post_approval_response", payload)), canonical(t, goldenPayload(t, "post_approval_response", cwd)); got != want {
			t.Fatalf("choice %s\n got %s\nwant %s", choice, got, want)
		}
	}
}

func TestIdentityPreservedAndRewriteCwd(t *testing.T) {
	adapter := New()
	observation, payload := parse(t, input(t, "post_tool_call", t.TempDir()))
	edited := func(edit func(map[string]any)) map[string]any {
		copied := make(map[string]any, len(payload))
		for key, value := range payload {
			copied[key] = value
		}
		edit(copied)
		return copied
	}
	for name, sanitized := range map[string]map[string]any{
		"redacted session id":  edited(func(p map[string]any) { p["session_id"] = "[REDACTED]" }),
		"changed tool call id": edited(func(p map[string]any) { p["tool_call_id"] = "toolu_other" }),
		"lost tool call id":    edited(func(p map[string]any) { delete(p, "tool_call_id") }),
	} {
		if adapter.IdentityPreserved(observation, sanitized) {
			t.Errorf("%s accepted", name)
		}
	}
	canonicalCwd := filepath.Join(t.TempDir(), "project")
	adapter.RewriteCwd(payload, canonicalCwd)
	if payload["cwd"] != canonicalCwd {
		t.Fatalf("cwd not rewritten: %v", payload["cwd"])
	}
}
