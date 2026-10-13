// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package pi

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
)

type testEnv struct {
	agent.Env
	extensions string
}

func newEnv(t *testing.T) testEnv {
	t.Helper()
	root := t.TempDir()
	home := filepath.Join(root, "home")
	os.MkdirAll(home, 0o700)
	executable := filepath.Join(root, "bin", "backplane-companion")
	os.MkdirAll(filepath.Dir(executable), 0o700)
	os.WriteFile(executable, []byte("#!/bin/sh\n"), 0o755)
	env := agent.Env{Home: home, Getenv: func(string) string { return "" }, Executable: executable}
	return testEnv{Env: env, extensions: filepath.Join(home, ".pi", "agent", "extensions")}
}

func (e testEnv) extension() string { return filepath.Join(e.extensions, extensionFileName) }

func read(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestInstallWritesOneOwnedExtensionAndIsIdempotent(t *testing.T) {
	env := newEnv(t)
	pi := New()
	if status := pi.Status(env.Env); status.State != agent.NotInstalled {
		t.Fatalf("fresh home: %+v", status)
	}
	if err := pi.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	source := read(t, env.extension())
	argv, _ := json.Marshal([]string{env.Executable, "hook", "pi"})
	for _, want := range []string{ownershipMarker, "const companionArgv: string[] = " + string(argv), `"session_start"`, `"message_end"`, "sendTimeoutMs = 2000", "windowsHide: true"} {
		if !strings.Contains(source, want) {
			t.Errorf("extension missing %q", want)
		}
	}
	for _, event := range SupportedEvents {
		if !strings.Contains(source, `"`+event+`"`) {
			t.Errorf("extension does not subscribe to %s", event)
		}
	}
	if strings.Contains(source, "block:") || strings.Contains(source, `action: "transform"`) {
		t.Fatal("extension must only observe")
	}
	if err := pi.Install(env.Env); err != nil || read(t, env.extension()) != source {
		t.Fatalf("reinstall not idempotent: %v", err)
	}
	if status := pi.Status(env.Env); status.State != agent.Installed || status.ConfigPath != env.extension() {
		t.Fatalf("status after install: %+v", status)
	}
	if err := pi.Uninstall(env.Env); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(env.extension()); !os.IsNotExist(err) {
		t.Fatal("owned extension left after uninstall")
	}
	if err := pi.Uninstall(env.Env); err != nil {
		t.Fatal("uninstall must be idempotent")
	}
}

func TestForeignAndBeaconExtensionsAreNeverTouched(t *testing.T) {
	env := newEnv(t)
	os.MkdirAll(env.extensions, 0o700)
	foreign := filepath.Join(env.extensions, "my-tools.ts")
	beacon := filepath.Join(env.extensions, "beacon.ts")
	os.WriteFile(foreign, []byte("export default function () {}\n"), 0o644)
	os.WriteFile(beacon, []byte("// beacon-managed-pi-extension:v1\n"), 0o644)
	pi := New()
	if err := pi.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	status := pi.Status(env.Env)
	if status.State != agent.Installed || !contains(status.Notes, "coexists_with_beacon_extension") {
		t.Fatalf("coexistence with Beacon not reported: %+v", status)
	}
	if err := pi.Uninstall(env.Env); err != nil {
		t.Fatal(err)
	}
	if read(t, foreign) != "export default function () {}\n" || read(t, beacon) != "// beacon-managed-pi-extension:v1\n" {
		t.Fatal("a foreign or Beacon extension was changed")
	}
	os.WriteFile(env.extension(), []byte("// someone else's file with our name\n"), 0o644)
	if err := pi.Install(env.Env); !errors.Is(err, agent.ErrConfigForeign) {
		t.Fatalf("overwrote a foreign file at our path: %v", err)
	}
	if err := pi.Uninstall(env.Env); !errors.Is(err, agent.ErrConfigForeign) {
		t.Fatalf("removed a foreign file at our path: %v", err)
	}
	if status := pi.Status(env.Env); status.State != agent.Broken || !contains(status.Problems, "extension_not_owned") {
		t.Fatalf("foreign file at our path: %+v", status)
	}
	if changed, err := pi.Repair(env.Env); changed || !errors.Is(err, agent.ErrConfigForeign) {
		t.Fatalf("repair touched a foreign file: %v %v", changed, err)
	}
}

func TestRepairRepointsAStaleExtensionButNeverRecreatesARemovedOne(t *testing.T) {
	env := newEnv(t)
	pi := New()
	old := env.Env
	old.Executable = filepath.Join(filepath.Dir(env.Executable), "old", "backplane-companion")
	if err := pi.Install(old); err != nil {
		t.Fatal(err)
	}
	if status := pi.Status(env.Env); status.State != agent.Broken || !contains(status.Problems, "extension:stale") {
		t.Fatalf("stale extension not detected: %+v", status)
	}
	changed, err := pi.Repair(env.Env)
	if err != nil || !changed || !strings.Contains(read(t, env.extension()), env.Executable) {
		t.Fatalf("stale extension not repaired: %v %v", changed, err)
	}
	if changed, _ := pi.Repair(env.Env); changed {
		t.Fatal("repair of a current extension reported a change")
	}
	os.Remove(env.extension())
	if changed, err := pi.Repair(env.Env); err != nil || changed {
		t.Fatalf("repair recreated a removed extension: %v %v", changed, err)
	}
	if _, err := os.Stat(env.extension()); !os.IsNotExist(err) {
		t.Fatal("the user's opt-out was undone")
	}
	if status := pi.Status(env.Env); status.State != agent.NotInstalled {
		t.Fatalf("removed extension should read as not installed: %+v", status)
	}
}

func TestMissingCompanionExecutableIsBroken(t *testing.T) {
	env := newEnv(t)
	pi := New()
	pi.Install(env.Env)
	os.Remove(env.Executable)
	if status := pi.Status(env.Env); status.State != agent.Broken || !contains(status.Problems, "companion_executable_missing") {
		t.Fatalf("missing executable: %+v", status)
	}
}

func TestAgentDirOverrideAndDiscovery(t *testing.T) {
	env := newEnv(t)
	custom := filepath.Join(env.Home, "pi-state")
	bin := filepath.Join(env.Home, "bin")
	os.MkdirAll(bin, 0o700)
	name, script := "pi", "#!/bin/sh\n"
	if runtime.GOOS == "windows" {
		name, script = "pi.cmd", "@echo off\r\n"
	}
	if err := os.WriteFile(filepath.Join(bin, name), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	env.Getenv = func(key string) string {
		switch key {
		case "PI_CODING_AGENT_DIR":
			return custom
		case "PATH":
			return bin
		}
		return ""
	}
	pi := New()
	presence := pi.Discover(env.Env)
	if !presence.Installed || presence.ConfigPath != filepath.Join(custom, "extensions", extensionFileName) {
		t.Fatalf("discovery: %+v", presence)
	}
	if err := pi.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(custom, "extensions", extensionFileName)); err != nil {
		t.Fatal("PI_CODING_AGENT_DIR ignored")
	}
	if _, err := os.Stat(filepath.Join(env.Home, ".pi")); !os.IsNotExist(err) {
		t.Fatal("wrote ~/.pi despite the override")
	}
	bare := newEnv(t)
	if New().Discover(bare.Env).Installed {
		t.Fatal("discovered Pi without an executable or state directory")
	}
}

func TestInstallPreservesModeAndRejectsSymlinkedExtension(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX modes and symlinks")
	}
	env := newEnv(t)
	pi := New()
	os.MkdirAll(env.extensions, 0o700)
	target := filepath.Join(env.Home, "elsewhere.ts")
	os.WriteFile(target, []byte("x"), 0o644)
	if err := os.Symlink(target, env.extension()); err != nil {
		t.Skip(err)
	}
	if err := pi.Install(env.Env); !errors.Is(err, agent.ErrConfigSymlink) {
		t.Fatalf("symlinked extension accepted: %v", err)
	}
	if read(t, target) != "x" {
		t.Fatal("wrote through a symlink")
	}
}

// fixtures are Pi event payloads as the managed extension forwards them:
// the event itself plus sessionId, cwd and model lifted from the context.
var fixtures = map[string]string{
	"session_start":    `{"type":"session_start","reason":"startup","sessionId":"pi-sess-1","cwd":"/repo","model":"anthropic/claude-x"}`,
	"input":            `{"type":"input","text":"fix the build","source":"interactive","sessionId":"pi-sess-1","cwd":"/repo"}`,
	"tool_call":        `{"type":"tool_call","toolName":"bash","toolCallId":"call_1","input":{"command":"make test"},"sessionId":"pi-sess-1","cwd":"/repo"}`,
	"tool_result":      `{"type":"tool_result","toolName":"bash","toolCallId":"call_1","input":{"command":"make test"},"content":[{"type":"text","text":"ok"}],"isError":false,"sessionId":"pi-sess-1","cwd":"/repo"}`,
	"user_bash":        `{"type":"user_bash","command":"ls","excludeFromContext":false,"sessionId":"pi-sess-1","cwd":"/repo"}`,
	"message_end":      `{"type":"message_end","message":{"role":"assistant","model":"claude-x","content":[{"type":"thinking","thinking":"plan it"},{"type":"text","text":"done"}],"usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"cost":{"total":0.001}}},"sessionId":"pi-sess-1","cwd":"/repo"}`,
	"session_shutdown": `{"type":"session_shutdown","reason":"quit","sessionId":"pi-sess-1","cwd":"/repo"}`,
}

func TestParseHookForEachSubscribedEvent(t *testing.T) {
	pi := New()
	if len(fixtures) != len(SupportedEvents) {
		t.Fatal("a fixture per subscribed event is required")
	}
	for _, event := range SupportedEvents {
		observation, payload, err := pi.ParseHook([]byte(fixtures[event]))
		if err != nil {
			t.Fatalf("%s: %v", event, err)
		}
		if observation.Event != event || observation.NativeSessionID != "pi-sess-1" || observation.Cwd != "/repo" {
			t.Fatalf("%s: observation %+v", event, observation)
		}
		wantCallID := ""
		if event == "tool_call" || event == "tool_result" {
			wantCallID = "call_1"
		}
		if observation.NativeToolCallID != wantCallID {
			t.Fatalf("%s: tool call id %q", event, observation.NativeToolCallID)
		}
		if command, ok := pi.BeaconCommand(event); !ok || command != "pi-event" {
			t.Fatalf("%s: beacon command %q", event, command)
		}
		if !pi.IdentityPreserved(observation, payload) {
			t.Fatalf("%s: identity not preserved on an untouched payload", event)
		}
		if prepared := pi.PrepareBeaconInput(event, payload); prepared["type"] != event {
			t.Fatalf("%s: Beacon input changed", event)
		}
	}
	if pi.BeaconPlatform() != "pi" || pi.Ingress() != agent.IngressPlugin || pi.ID() != "pi_cli" {
		t.Fatal("platform, ingress or id do not match Beacon's labels")
	}
}

func TestParseHookRejectsUnusableAndIgnoresUnmappedEvents(t *testing.T) {
	pi := New()
	for raw, want := range map[string]error{
		`{"type":"message_end","message":{"role":"user","content":"hi"},"sessionId":"s","cwd":"/repo"}`: agent.ErrIgnoredEvent,
		`{"type":"turn_start","sessionId":"s","cwd":"/repo"}`:                                           agent.ErrUnsupportedEvent,
		`{"type":"tool_approval_resolved","approved":true,"sessionId":"s","cwd":"/repo"}`:               agent.ErrUnsupportedEvent,
		`{"type":"input","text":"x","cwd":"/repo"}`:                                                     agent.ErrMissingIdentity,
		`{"type":"tool_call","toolName":"bash","sessionId":"s","cwd":"/repo"}`:                          agent.ErrMissingIdentity,
		`{"type":"tool_result","toolCallId":"c1","sessionId":"s","cwd":"/repo"}`:                        agent.ErrMissingIdentity,
		`not json`: agent.ErrInvalidHook,
	} {
		if _, _, err := pi.ParseHook([]byte(raw)); !errors.Is(err, want) {
			t.Errorf("%s: got %v want %v", raw, err, want)
		}
	}
	observation := agent.Observation{NativeSessionID: "s", NativeToolCallID: "c1"}
	if pi.IdentityPreserved(observation, map[string]any{"sessionId": "[REDACTED]", "toolCallId": "c1"}) {
		t.Fatal("redacted session id accepted")
	}
	payload := map[string]any{"cwd": "/alias"}
	pi.RewriteCwd(payload, "/canonical")
	if payload["cwd"] != "/canonical" {
		t.Fatal("cwd not rewritten")
	}
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// Pi on OpenAI's Responses API joins the call id and the item id with `|`, and
// the item id alone can run to hundreds of characters. Such calls must still be
// captured, with their id intact through sanitizing, or they could never link.
func TestParseHookAcceptsOpenAIToolCallIDs(t *testing.T) {
	pi := New()
	callID := "call_" + strings.Repeat("A1b2", 6) + "|fc_" + strings.Repeat("0123456789abcdef", 26)
	if len(callID) != 449 {
		t.Fatalf("fixture id is %d characters", len(callID))
	}
	raw := `{"type":"tool_call","toolName":"valaris_get_card","toolCallId":"` + callID + `","input":{"card_id":"c-1"},"sessionId":"pi-sess-1","cwd":"/repo"}`
	observation, payload, err := pi.ParseHook([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if observation.NativeToolCallID != callID {
		t.Fatalf("tool call id %q", observation.NativeToolCallID)
	}
	clean, _ := privacy.SanitizeFor(payload, pi.ToolOutput("tool_call"), privacy.Standard)
	if !pi.IdentityPreserved(observation, clean) {
		t.Fatalf("sanitizing changed the tool call id: %v", clean["toolCallId"])
	}
}

// The item-id half from github-copilot, openai-codex and opencode can carry
// base64 characters (+, /, =); it must pass, and survive sanitizing, the same
// alphabet the MCP server and backend accept.
func TestParseHookAcceptsBase64ToolCallIDs(t *testing.T) {
	pi := New()
	for _, callID := range []string{
		"call_x|fc_ab+/cd==",
		"call_" + strings.Repeat("A1b2", 6) + "|fc_" + strings.Repeat("ab+/cd==", 55),
	} {
		raw := `{"type":"tool_call","toolName":"valaris_get_card","toolCallId":"` + callID + `","input":{"card_id":"c-1"},"sessionId":"pi-sess-1","cwd":"/repo"}`
		observation, payload, err := pi.ParseHook([]byte(raw))
		if err != nil {
			t.Fatalf("%s: %v", callID, err)
		}
		if observation.NativeToolCallID != callID {
			t.Fatalf("tool call id %q", observation.NativeToolCallID)
		}
		clean, _ := privacy.SanitizeFor(payload, pi.ToolOutput("tool_call"), privacy.Standard)
		if !pi.IdentityPreserved(observation, clean) {
			t.Fatalf("sanitizing changed the tool call id: %v", clean["toolCallId"])
		}
	}
}
