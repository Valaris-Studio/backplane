// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package claudecode

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

type testEnv struct {
	agent.Env
	settings string
}

func newEnv(t *testing.T) testEnv {
	t.Helper()
	root := t.TempDir()
	home := filepath.Join(root, "home")
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(root, "bin dir", "backplane-companion")
	writeFile(t, executable, "#!/bin/sh\n")
	if err := os.Chmod(executable, 0o755); err != nil {
		t.Fatal(err)
	}
	env := agent.Env{Home: home, Getenv: func(string) string { return "" }, Executable: executable}
	return testEnv{Env: env, settings: filepath.Join(home, ".claude", "settings.json")}
}

func TestInstallPreservesForeignEntriesUnknownFieldsAndNumbers(t *testing.T) {
	env := newEnv(t)
	integer, decimal := "9007199254740993", "0.12345678901234567890123456789"
	original := `{"permissions":{"allow":["Read"]},"future":{"n":` + integer + `,"d":` + decimal + `},"hooks":{"UserPromptSubmit":[{"matcher":"","hooks":[{"type":"command","command":"echo <existing> & more","extra":` + integer + `}]}],"Notification":[{"hooks":[{"type":"command","command":"notify"}]}]}}`
	writeFile(t, env.settings, original)
	claude := New()
	if err := claude.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	first := readFile(t, env.settings)
	if err := claude.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	if second := readFile(t, env.settings); !bytes.Equal(first, second) {
		t.Fatal("install is not idempotent")
	}
	for _, kept := range []string{integer, decimal, "echo <existing> & more", `"notify"`, `"permissions"`} {
		if !bytes.Contains(first, []byte(kept)) {
			t.Fatalf("lost %s: %s", kept, first)
		}
	}
	if count := bytes.Count(first, []byte(integer)); count != 2 {
		t.Fatalf("numbers duplicated or dropped: %d", count)
	}
	var settings struct {
		Hooks map[string][]struct {
			Hooks []struct{ Command string } `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(first, &settings); err != nil {
		t.Fatal(err)
	}
	for _, event := range HookEvents {
		owned := 0
		for _, block := range settings.Hooks[event] {
			for _, hook := range block.Hooks {
				if strings.HasSuffix(hook.Command, " hook claude-code") && strings.Contains(hook.Command, env.Executable) {
					owned++
				}
			}
		}
		if owned != 1 {
			t.Fatalf("%s has %d owned hooks", event, owned)
		}
	}
	if status := claude.Status(env.Env); status.State != agent.Installed {
		t.Fatalf("status after install: %+v", status)
	}
}

func TestUninstallRemovesOnlyOwnedEntries(t *testing.T) {
	env := newEnv(t)
	writeFile(t, env.settings, `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"foreign stop"}]}]},"model":"x"}`)
	claude := New()
	if err := claude.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	if err := claude.Uninstall(env.Env); err != nil {
		t.Fatal(err)
	}
	data := readFile(t, env.settings)
	if bytes.Contains(data, []byte("hook claude-code")) || !bytes.Contains(data, []byte("foreign stop")) || !bytes.Contains(data, []byte(`"model"`)) {
		t.Fatalf("uninstall touched foreign entries or left owned ones: %s", data)
	}
	if bytes.Contains(data, []byte("SessionStart")) {
		t.Fatalf("uninstall left empty owned event lists: %s", data)
	}
	if status := claude.Status(env.Env); status.State != agent.NotInstalled {
		t.Fatalf("status after uninstall: %+v", status)
	}
	if err := claude.Uninstall(env.Env); err != nil {
		t.Fatal("uninstall must be idempotent")
	}
}

func TestInstallCreatesSettingsAndHonorsConfigDir(t *testing.T) {
	env := newEnv(t)
	custom := filepath.Join(env.Home, "custom-claude")
	env.Getenv = func(key string) string {
		if key == "CLAUDE_CONFIG_DIR" {
			return custom
		}
		return ""
	}
	claude := New()
	if err := claude.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(custom, "settings.json")); err != nil {
		t.Fatal("CLAUDE_CONFIG_DIR ignored")
	}
	if _, err := os.Stat(env.settings); !os.IsNotExist(err) {
		t.Fatal("wrote default settings despite CLAUDE_CONFIG_DIR")
	}
	if presence := claude.Discover(env.Env); !presence.Installed || presence.ConfigPath != filepath.Join(custom, "settings.json") {
		t.Fatalf("discovery wrong: %+v", presence)
	}
}

func TestStatusDetectsMissingAndStaleOwnedEntries(t *testing.T) {
	env := newEnv(t)
	claude := New()
	if status := claude.Status(env.Env); status.State != agent.NotInstalled {
		t.Fatalf("fresh home: %+v", status)
	}
	if err := claude.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	var settings map[string]any
	if err := json.Unmarshal(readFile(t, env.settings), &settings); err != nil {
		t.Fatal(err)
	}
	delete(settings["hooks"].(map[string]any), "PreToolUse")
	rewritten, _ := json.Marshal(settings)
	writeFile(t, env.settings, string(rewritten))
	if status := claude.Status(env.Env); status.State != agent.Broken || len(status.Problems) == 0 {
		t.Fatalf("missing owned hook not detected: %+v", status)
	}
	moved := env.Env
	moved.Executable = filepath.Join(filepath.Dir(env.Executable), "elsewhere", "backplane-companion")
	if status := claude.Status(moved); status.State != agent.Broken {
		t.Fatalf("hooks pointing at another companion path not detected: %+v", status)
	}
	if err := claude.Install(moved); err != nil {
		t.Fatal(err)
	}
	data := readFile(t, env.settings)
	if bytes.Contains(data, []byte("'"+env.Executable+"'")) {
		t.Fatalf("reinstall kept stale owned entries: %s", data)
	}
	if status := claude.Status(moved); status.State != agent.Broken {
		t.Fatalf("missing executable must be reported broken: %+v", status)
	}
}

func TestInstallRejectsSymlinksAndCorruptSettings(t *testing.T) {
	env := newEnv(t)
	target := filepath.Join(env.Home, "dotfiles-settings.json")
	writeFile(t, target, `{}`)
	if err := os.MkdirAll(filepath.Dir(env.settings), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, env.settings); err != nil {
		t.Skip(err)
	}
	claude := New()
	if err := claude.Install(env.Env); !errors.Is(err, agent.ErrConfigSymlink) {
		t.Fatalf("symlinked settings accepted: %v", err)
	}
	if string(readFile(t, target)) != `{}` {
		t.Fatal("wrote through symlink")
	}
	os.Remove(env.settings)
	writeFile(t, env.settings, `{"hooks":`)
	if err := claude.Install(env.Env); !errors.Is(err, agent.ErrConfigInvalid) {
		t.Fatalf("corrupt settings accepted: %v", err)
	}
	if string(readFile(t, env.settings)) != `{"hooks":` {
		t.Fatal("corrupt settings overwritten")
	}
	writeFile(t, env.settings, `{"hooks":{"Stop":{"not":"a list"}}}`)
	if err := claude.Install(env.Env); !errors.Is(err, agent.ErrConfigInvalid) {
		t.Fatalf("malformed hook list accepted: %v", err)
	}
	if status := claude.Status(env.Env); status.State != agent.Broken {
		t.Fatalf("invalid settings must report broken: %+v", status)
	}
	relative := env.Env
	relative.Executable = "backplane-companion"
	if err := claude.Install(relative); err == nil {
		t.Fatal("relative companion path accepted")
	}
}

func TestParseHook(t *testing.T) {
	claude := New()
	observation, payload, err := claude.ParseHook([]byte(`{"cwd":"/repo","session_id":"sess-1","hook_event_name":"PostToolUse","tool_name":"Read","tool_use_id":"toolu_1","tool_input":{"n":9007199254740993}}`))
	if err != nil {
		t.Fatal(err)
	}
	if observation != (agent.Observation{NativeSessionID: "sess-1", NativeToolCallID: "toolu_1", Cwd: "/repo", Event: "PostToolUse"}) {
		t.Fatalf("observation: %+v", observation)
	}
	if payload["tool_input"].(map[string]any)["n"] != json.Number("9007199254740993") {
		t.Fatal("number precision lost")
	}
	for _, c := range []struct {
		raw  string
		want error
	}{
		{`{"cwd":`, agent.ErrInvalidHook},
		{`[]`, agent.ErrInvalidHook},
		{`{"a":1} {"b":2}`, agent.ErrInvalidHook},
		{`{"session_id":"s","hook_event_name":"Unknown"}`, agent.ErrUnsupportedEvent},
		{`{"session_id":"../escape","hook_event_name":"Stop"}`, agent.ErrMissingIdentity},
		{`{"session_id":"s","hook_event_name":"PreToolUse","tool_name":"Read"}`, agent.ErrMissingIdentity},
		{`{"session_id":"s","hook_event_name":"PreToolUse","tool_use_id":"t","tool_name":{}}`, agent.ErrMissingIdentity},
		{`{"session_id":"s","hook_event_name":"Stop","bearer abcdefghijklmnop":1}`, agent.ErrInvalidHook},
	} {
		if _, _, err := claude.ParseHook([]byte(c.raw)); !errors.Is(err, c.want) {
			t.Errorf("%s: got %v want %v", c.raw, err, c.want)
		}
	}
	for _, event := range HookEvents {
		if _, ok := claude.BeaconCommand(event); !ok {
			t.Errorf("no Beacon command for %s", event)
		}
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestInstallPreservesExistingFileMode(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permission bits")
	}
	env := newEnv(t)
	writeFile(t, env.settings, `{"model":"x"}`)
	if err := os.Chmod(env.settings, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := New().Install(env.Env); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(env.settings); info.Mode().Perm() != 0o644 {
		t.Fatalf("settings mode changed to %v", info.Mode().Perm())
	}
	fresh := newEnv(t)
	if err := New().Install(fresh.Env); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(fresh.settings); info.Mode().Perm() != 0o600 {
		t.Fatalf("new settings file mode %v", info.Mode().Perm())
	}
}

func TestAdapterShapesClaudePayloads(t *testing.T) {
	claude := New()
	if claude.Ingress() != agent.IngressHook {
		t.Fatal("Claude Code observations arrive through hooks")
	}
	payload := map[string]any{"cwd": "/alias/repo", "session_id": "s1", "tool_use_id": "t1", "tool_input": map[string]any{"file_path": "x"}, "tool_response": "r"}
	claude.RewriteCwd(payload, "/canonical/repo")
	if payload["cwd"] != "/canonical/repo" {
		t.Fatal("cwd not rewritten")
	}
	observation := agent.Observation{NativeSessionID: "s1", NativeToolCallID: "t1"}
	if !claude.IdentityPreserved(observation, payload) {
		t.Fatal("identical identity reported as lost")
	}
	for _, redacted := range []map[string]any{{"session_id": "[REDACTED]", "tool_use_id": "t1"}, {"session_id": "s1", "tool_use_id": "[REDACTED]"}} {
		if claude.IdentityPreserved(observation, redacted) {
			t.Fatalf("redacted identity accepted: %v", redacted)
		}
	}
	failure := claude.PrepareBeaconInput("PostToolUseFailure", payload)
	if _, kept := failure["tool_input"]; kept {
		t.Fatal("pinned mapper workaround not applied")
	}
	if _, kept := failure["tool_response"]; kept {
		t.Fatal("pinned mapper workaround not applied to the result")
	}
	if _, kept := payload["tool_input"]; !kept {
		t.Fatal("workaround mutated the caller's payload")
	}
	if success := claude.PrepareBeaconInput("PostToolUse", payload); success["tool_input"] == nil {
		t.Fatal("successful tool input must reach Beacon")
	}
}

func TestRepairFixesStaleOwnedEntriesButNeverReaddsMissingOnes(t *testing.T) {
	env := newEnv(t)
	claude := New()
	if err := claude.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	var settings map[string]any
	json.Unmarshal(readFile(t, env.settings), &settings)
	hooks := settings["hooks"].(map[string]any)
	delete(hooks, "PreToolUse")
	hooks["Notification"] = []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": "foreign notifier"}}}}
	optedOut, _ := json.Marshal(settings)
	writeFile(t, env.settings, string(optedOut))
	if changed, err := claude.Repair(env.Env); err != nil || changed {
		t.Fatalf("a partial opt-out is not stale: changed=%v %v", changed, err)
	}
	if !bytes.Equal(readFile(t, env.settings), optedOut) {
		t.Fatal("repair rewrote settings without a stale entry")
	}
	moved := env.Env
	moved.Executable = filepath.Join(filepath.Dir(env.Executable), "v2", "backplane-companion")
	changed, err := claude.Repair(moved)
	if err != nil || !changed {
		t.Fatalf("stale entries not repaired: %v %v", changed, err)
	}
	data := string(readFile(t, env.settings))
	if strings.Contains(data, "'"+env.Executable+"'") || !strings.Contains(data, "v2") {
		t.Fatalf("owned entries not repointed: %s", data)
	}
	if strings.Contains(data, "PreToolUse") {
		t.Fatal("repair re-added an event the user removed")
	}
	if !strings.Contains(data, "foreign notifier") {
		t.Fatal("repair touched a foreign entry")
	}
}
