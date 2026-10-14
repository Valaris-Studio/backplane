// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/pelletier/go-toml/v2"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

type testEnv struct {
	agent.Env
	codexHome string
}

func newEnv(t *testing.T) testEnv {
	t.Helper()
	root, _ := filepath.EvalSymlinks(t.TempDir())
	home := filepath.Join(root, "home")
	codexHome := filepath.Join(home, ".codex")
	os.MkdirAll(codexHome, 0o700)
	executable := filepath.Join(root, "bin", "backplane-companion")
	os.MkdirAll(filepath.Dir(executable), 0o700)
	os.WriteFile(executable, []byte("#!/bin/sh\n"), 0o755)
	env := agent.Env{
		Home:       home,
		Getenv:     func(string) string { return "" },
		Executable: executable,
		Telemetry:  agent.Telemetry{Endpoint: "http://127.0.0.1:14327", LogUserPrompt: true},
	}
	return testEnv{Env: env, codexHome: codexHome}
}

func (e testEnv) hooksFile() string  { return filepath.Join(e.codexHome, "hooks.json") }
func (e testEnv) configFile() string { return filepath.Join(e.codexHome, "config.toml") }

func read(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func write(t *testing.T, path, content string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o700)
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readTOML(t *testing.T, path string) map[string]any {
	t.Helper()
	var value map[string]any
	if err := toml.Unmarshal([]byte(read(t, path)), &value); err != nil {
		t.Fatalf("config.toml no longer parses: %v\n%s", err, read(t, path))
	}
	return value
}

// Vectors computed by running the rust-v0.144.1 serde types and
// version_for_toml (toml 0.9.5) verbatim; see the CR-5 handoff.
func TestTrustHashMatchesCodexVectors(t *testing.T) {
	cases := []struct {
		label, command string
		timeout        int
		want           string
	}{
		{"session_start", "'/Applications/Backplane Companion/backplane-companion' hook codex", 10, "sha256:5feec4a5b560ed8a6df4f6cbdfb7a83b19870f02d5c581b5eb7cce87103ea067"},
		{"pre_tool_use", `'/opt/it'"'"'s/backplane-companion' hook codex`, 10, "sha256:e1a226f0b702a1a168ed9d93b13934c39e479e92790232fe994d17030b7ce385"},
		// serde_json writes U+2028/U+2029 raw; encoding/json escapes them.
		{"session_start", "'/opt/line" + string(rune(0x2028)) + "sep" + string(rune(0x2029)) + "/backplane-companion' hook codex", 10, "sha256:407e723e91ee07fe70a7b4765d7c4e5a6c1273159bc8bb706cb43da211c68671"},
	}
	for _, c := range cases {
		if got := trustHash(c.label, c.command, c.timeout); got != c.want {
			t.Errorf("%s: %s, want %s", c.label, got, c.want)
		}
	}
}

func TestInstallMergesHooksPreservingForeignEntries(t *testing.T) {
	env := newEnv(t)
	write(t, env.hooksFile(), `{"description":"mine","hooks":{"PreToolUse":[{"matcher":"^Bash$","hooks":[{"type":"command","command":"guard.sh","timeout":9007199254740993}]}],"Stop":[{"hooks":[{"type":"command","command":"notify"}]}]}}`)
	codex := New()
	if err := codex.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	first := read(t, env.hooksFile())
	if err := codex.Install(env.Env); err != nil || read(t, env.hooksFile()) != first {
		t.Fatalf("install not idempotent: %v", err)
	}
	for _, kept := range []string{`"description": "mine"`, "guard.sh", "9007199254740993", `"notify"`, `"^Bash$"`} {
		if !strings.Contains(first, kept) {
			t.Fatalf("lost %s:\n%s", kept, first)
		}
	}
	var file struct {
		Hooks map[string][]struct {
			Matcher *string `json:"matcher"`
			Hooks   []struct {
				Type    string `json:"type"`
				Command string `json:"command"`
				Timeout int    `json:"timeout"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal([]byte(first), &file); err != nil {
		t.Fatal(err)
	}
	for _, event := range HookEvents {
		groups := file.Hooks[event]
		last := groups[len(groups)-1]
		if last.Matcher != nil || len(last.Hooks) != 1 || last.Hooks[0].Command != hookCommandFor(t, env.Executable) || last.Hooks[0].Timeout != hookTimeoutSeconds {
			t.Fatalf("%s: owned group %+v", event, last)
		}
	}
	var raw map[string]any
	json.Unmarshal([]byte(first), &raw)
	if len(raw) != 2 {
		t.Fatalf("hooks.json only allows description and hooks at the top level: %v", raw)
	}
	if err := codex.Uninstall(env.Env); err != nil {
		t.Fatal(err)
	}
	after := read(t, env.hooksFile())
	if strings.Contains(after, "hook codex") || !strings.Contains(after, "guard.sh") || !strings.Contains(after, "9007199254740993") {
		t.Fatalf("uninstall touched foreign hooks or left ours:\n%s", after)
	}
}

func hookCommandFor(t *testing.T, executable string) string {
	t.Helper()
	command, err := hookCommand(executable)
	if err != nil {
		t.Fatal(err)
	}
	return command
}

func TestConfigBlockPreservesCommentsAndForeignSettings(t *testing.T) {
	env := newEnv(t)
	original := `# my codex settings
model = "gpt-5" # favourite

[otel]
environment = "work" # keep me

[mcp_servers.backplane]
command = "uvx"
args = ["backplane-mcp"]
`
	write(t, env.configFile(), original)
	codex := New()
	if err := codex.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	text := read(t, env.configFile())
	for _, kept := range []string{"# my codex settings", `# favourite`, `# keep me`, "[mcp_servers.backplane]"} {
		if !strings.Contains(text, kept) {
			t.Fatalf("lost %q:\n%s", kept, text)
		}
	}
	config := readTOML(t, env.configFile())
	otel := config["otel"].(map[string]any)
	logs := otel["exporter"].(map[string]any)["otlp-http"].(map[string]any)
	traces := otel["trace_exporter"].(map[string]any)["otlp-http"].(map[string]any)
	if logs["endpoint"] != "http://127.0.0.1:14327/v1/logs" || logs["protocol"] != "json" || traces["endpoint"] != "http://127.0.0.1:14327/v1/traces" || traces["protocol"] != "json" {
		t.Fatalf("exporters not pointed at the gate: %v", otel)
	}
	if otel["log_user_prompt"] != true || otel["environment"] != "work" {
		t.Fatalf("otel table: %v", otel)
	}
	if _, has := otel["metrics_exporter"]; has {
		t.Fatal("metrics must not be exported")
	}
	if err := codex.Install(env.Env); err != nil || read(t, env.configFile()) != text {
		t.Fatalf("config install not idempotent: %v", err)
	}
	if err := codex.Uninstall(env.Env); err != nil {
		t.Fatal(err)
	}
	if read(t, env.configFile()) != original {
		t.Fatalf("uninstall did not restore the original file exactly:\n%s", read(t, env.configFile()))
	}
}

func TestConfigCreatedWhenMissingAndMetadataDisablesPromptLogging(t *testing.T) {
	env := newEnv(t)
	env.Telemetry.LogUserPrompt = false
	if err := New().Install(env.Env); err != nil {
		t.Fatal(err)
	}
	otel := readTOML(t, env.configFile())["otel"].(map[string]any)
	if otel["log_user_prompt"] != false {
		t.Fatalf("log_user_prompt must follow the content level: %v", otel)
	}
	env.Telemetry.LogUserPrompt = true
	if changed, err := New().Repair(env.Env); err != nil || !changed {
		t.Fatalf("repair did not update log_user_prompt: %v %v", changed, err)
	}
	if readTOML(t, env.configFile())["otel"].(map[string]any)["log_user_prompt"] != true {
		t.Fatal("log_user_prompt not updated")
	}
}

func TestExistingOtelExporterIsAConflictAndLeftAlone(t *testing.T) {
	for name, config := range map[string]string{
		"log exporter":   "[otel.exporter.otlp-grpc]\nendpoint = \"http://collector:4317\"\n",
		"trace exporter": "[otel]\ntrace_exporter = \"statsig\"\n",
		"inline otel":    "otel = { exporter = \"none\" }\n",
	} {
		t.Run(name, func(t *testing.T) {
			env := newEnv(t)
			write(t, env.configFile(), config)
			codex := New()
			if err := codex.Install(env.Env); err != nil {
				t.Fatal(err)
			}
			if read(t, env.configFile()) != config {
				t.Fatal("overwrote an existing otel exporter")
			}
			status := codex.Status(env.Env)
			if !contains(status.Problems, "conflict_existing_otel") {
				t.Fatalf("conflict not reported: %+v", status)
			}
			if err := codex.Uninstall(env.Env); err != nil || read(t, env.configFile()) != config {
				t.Fatal("uninstall touched a foreign otel exporter")
			}
		})
	}
}

func TestUserSetLogUserPromptIsRespected(t *testing.T) {
	env := newEnv(t)
	write(t, env.configFile(), "[otel]\nlog_user_prompt = false\n")
	if err := New().Install(env.Env); err != nil {
		t.Fatal(err)
	}
	otel := readTOML(t, env.configFile())["otel"].(map[string]any)
	if otel["log_user_prompt"] != false || otel["exporter"] == nil {
		t.Fatalf("user choice overridden or exporter missing: %v", otel)
	}
	if !containsString(New().Status(env.Env).Notes, "log_user_prompt_set_by_user") {
		t.Fatal("user-set log_user_prompt not noted")
	}
}

func TestInvalidConfigIsNeverRewritten(t *testing.T) {
	env := newEnv(t)
	write(t, env.configFile(), "model = \n")
	if err := New().Install(env.Env); !errors.Is(err, agent.ErrConfigInvalid) {
		t.Fatalf("invalid config accepted: %v", err)
	}
	if read(t, env.configFile()) != "model = \n" {
		t.Fatal("invalid config rewritten")
	}
}

func stateFor(t *testing.T, env testEnv, trusted map[string]string) string {
	t.Helper()
	var builder strings.Builder
	for key, hash := range trusted {
		builder.WriteString("[hooks.state." + tomlString(key) + "]\ntrusted_hash = " + tomlString(hash) + "\n")
	}
	return builder.String()
}

func TestTrustDetection(t *testing.T) {
	env := newEnv(t)
	codex := New()
	if err := codex.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	status := codex.Status(env.Env)
	if status.State != agent.NeedsTrust || status.Trust != "needs_trust" {
		t.Fatalf("fresh hooks must need trust: %+v", status)
	}
	command := hookCommandFor(t, env.Executable)
	trusted := map[string]string{}
	for _, event := range HookEvents {
		key := env.hooksFile() + ":" + eventLabels[event] + ":0:0"
		trusted[key] = trustHash(eventLabels[event], command, hookTimeoutSeconds)
	}
	configText := read(t, env.configFile())
	write(t, env.configFile(), configText+stateFor(t, env, trusted))
	if status := codex.Status(env.Env); status.State != agent.Installed || status.Trust != "trusted" {
		t.Fatalf("trusted hooks not detected: %+v", status)
	}
	modified := map[string]string{}
	for key := range trusted {
		modified[key] = "sha256:" + strings.Repeat("0", 64)
	}
	write(t, env.configFile(), configText+stateFor(t, env, modified))
	if status := codex.Status(env.Env); status.State != agent.NeedsTrust || status.Trust != "modified" {
		t.Fatalf("modified hooks not detected: %+v", status)
	}
	write(t, env.configFile(), configText+"[hooks.state."+tomlString(env.hooksFile()+":session_start:0:0")+"]\nenabled = false\n")
	if status := codex.Status(env.Env); !contains(status.Problems, "hook_disabled_in_codex") {
		t.Fatalf("disabled hook not detected: %+v", status)
	}
	write(t, env.configFile(), "not = [valid\n")
	if status := codex.Status(env.Env); status.Trust != "trust_unknown" {
		t.Fatalf("unreadable config must yield trust_unknown: %+v", status)
	}
}

func TestTrustKeysFollowOurGroupIndex(t *testing.T) {
	env := newEnv(t)
	write(t, env.hooksFile(), `{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"a"}]},{"hooks":[{"type":"command","command":"b"}]}]}}`)
	codex := New()
	codex.Install(env.Env)
	command := hookCommandFor(t, env.Executable)
	trusted := map[string]string{}
	for _, event := range HookEvents {
		group := "0"
		if event == "SessionStart" {
			group = "2"
		}
		trusted[env.hooksFile()+":"+eventLabels[event]+":"+group+":0"] = trustHash(eventLabels[event], command, hookTimeoutSeconds)
	}
	write(t, env.configFile(), read(t, env.configFile())+stateFor(t, env, trusted))
	if status := codex.Status(env.Env); status.Trust != "trusted" {
		t.Fatalf("group index not honored: %+v", status)
	}
}

func TestRepairRepointsStaleHooksAndNeverReaddsRemovedOnes(t *testing.T) {
	env := newEnv(t)
	codex := New()
	old := env.Env
	old.Executable = filepath.Join(filepath.Dir(env.Executable), "old", "backplane-companion")
	codex.Install(old)
	var file map[string]any
	json.Unmarshal([]byte(read(t, env.hooksFile())), &file)
	delete(file["hooks"].(map[string]any), "PreToolUse")
	edited, _ := json.Marshal(file)
	write(t, env.hooksFile(), string(edited))
	changed, err := codex.Repair(env.Env)
	if err != nil || !changed {
		t.Fatalf("stale hooks not repaired: %v %v", changed, err)
	}
	hooks := read(t, env.hooksFile())
	if strings.Contains(hooks, old.Executable) || strings.Contains(hooks, "PreToolUse") {
		t.Fatalf("repair left stale entries or re-added a removed hook:\n%s", hooks)
	}
	if status := codex.Status(env.Env); !contains(status.Problems, "PreToolUse:missing") {
		t.Fatalf("missing hook not reported: %+v", status)
	}
}

func TestSymlinkedCodexFilesAreRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	env := newEnv(t)
	target := filepath.Join(env.Home, "dotfiles-config.toml")
	write(t, target, "model = \"x\"\n")
	if err := os.Symlink(target, env.configFile()); err != nil {
		t.Skip(err)
	}
	if err := New().Install(env.Env); !errors.Is(err, agent.ErrConfigSymlink) {
		t.Fatalf("symlinked config.toml accepted: %v", err)
	}
	if read(t, target) != "model = \"x\"\n" {
		t.Fatal("wrote through a symlink")
	}
}

func TestCodexHomeOverrideAndDiscovery(t *testing.T) {
	env := newEnv(t)
	custom := filepath.Join(env.Home, "codex-home")
	os.MkdirAll(custom, 0o700)
	env.Getenv = func(key string) string {
		if key == "CODEX_HOME" {
			return custom
		}
		return ""
	}
	codex := New()
	if presence := codex.Discover(env.Env); !presence.Installed || presence.ConfigPath != filepath.Join(custom, "hooks.json") {
		t.Fatalf("discovery: %+v", presence)
	}
	codex.Install(env.Env)
	if _, err := os.Stat(filepath.Join(custom, "hooks.json")); err != nil {
		t.Fatal("CODEX_HOME ignored")
	}
}

var hookFixtures = map[string]string{
	"SessionStart":     `{"session_id":"thread-root","transcript_path":null,"cwd":"/repo","hook_event_name":"SessionStart","model":"gpt-5","permission_mode":"default","source":"startup"}`,
	"SubagentStart":    `{"session_id":"thread-root","turn_id":"t1","transcript_path":null,"cwd":"/repo/sub","hook_event_name":"SubagentStart","model":"gpt-5","permission_mode":"default","agent_id":"thread-child","agent_type":"worker"}`,
	"UserPromptSubmit": `{"session_id":"thread-root","turn_id":"t1","transcript_path":null,"cwd":"/repo","hook_event_name":"UserPromptSubmit","model":"gpt-5","permission_mode":"default","prompt":"hello"}`,
	"PreToolUse":       `{"session_id":"thread-root","turn_id":"t2","agent_id":"thread-child","agent_type":"worker","transcript_path":null,"cwd":"/repo/sub","hook_event_name":"PreToolUse","model":"gpt-5","permission_mode":"default","tool_name":"exec_command","tool_input":{"cmd":"ls"},"tool_use_id":"call_1"}`,
}

func TestParseHookResolvesThreadIDs(t *testing.T) {
	codex := New()
	want := map[string]string{"SessionStart": "thread-root", "SubagentStart": "thread-child", "UserPromptSubmit": "thread-root", "PreToolUse": "thread-child"}
	for event, raw := range hookFixtures {
		observation, payload, err := codex.ParseHook([]byte(raw))
		if err != nil {
			t.Fatalf("%s: %v", event, err)
		}
		if observation.ThreadID != want[event] || observation.NativeSessionID != "thread-root" || observation.Event != event {
			t.Fatalf("%s: %+v", event, observation)
		}
		if !codex.IdentityPreserved(observation, payload) {
			t.Fatalf("%s: identity", event)
		}
	}
	for raw, wantErr := range map[string]error{
		`{"session_id":"s","cwd":"/r","hook_event_name":"Stop"}`:                       agent.ErrUnsupportedEvent,
		`{"cwd":"/r","hook_event_name":"SessionStart"}`:                                agent.ErrMissingIdentity,
		`{"session_id":"s","cwd":"/r","hook_event_name":"SubagentStart"}`:              agent.ErrMissingIdentity,
		`{"session_id":"s","cwd":"/r","hook_event_name":"PreToolUse","tool_name":"x"}`: agent.ErrMissingIdentity,
	} {
		if _, _, err := codex.ParseHook([]byte(raw)); !errors.Is(err, wantErr) {
			t.Errorf("%s: got %v want %v", raw, err, wantErr)
		}
	}
	if codex.Ingress() != agent.IngressOTLP || codex.ID() != "codex_cli" {
		t.Fatal("ingress or id")
	}
	if _, ok := codex.BeaconCommand("SessionStart"); ok {
		t.Fatal("Codex hooks carry scope, not telemetry; they must not be normalized")
	}
}

func TestHarnessForServiceName(t *testing.T) {
	for service, want := range map[string]string{"codex-app-server": DesktopID, "codex_exec": ID, "codex-tui": ID, "": ID} {
		if got := HarnessForService(service); got != want {
			t.Errorf("%q: %s", service, got)
		}
	}
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func TestRepairRefreshesTheBlockInPlaceWhenCodexAppendedAfterIt(t *testing.T) {
	env := newEnv(t)
	codex := New()
	if err := codex.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	appended := "\n[hooks.state." + tomlString(env.hooksFile()+":session_start:0:0") + "]\ntrusted_hash = \"sha256:x\"\n"
	write(t, env.configFile(), read(t, env.configFile())+appended)
	if changed, err := codex.Repair(env.Env); err != nil || changed {
		t.Fatalf("a current block must not be rewritten: %v %v", changed, err)
	}
	env.Telemetry.Endpoint = "http://127.0.0.1:15000"
	if changed, err := codex.Repair(env.Env); err != nil || !changed {
		t.Fatalf("stale endpoint not refreshed: %v %v", changed, err)
	}
	text := read(t, env.configFile())
	if !strings.HasSuffix(text, appended) || strings.Count(text, blockBegin) != 1 || !strings.Contains(text, "127.0.0.1:15000/v1/logs") {
		t.Fatalf("block not refreshed in place:\n%s", text)
	}
	if err := codex.Uninstall(env.Env); err != nil {
		t.Fatal(err)
	}
	if text := read(t, env.configFile()); strings.Contains(text, "backplane-companion") || !strings.Contains(text, "trusted_hash") {
		t.Fatalf("uninstall removed Codex's own state or left ours:\n%s", text)
	}
}

func TestOtelKeysInsideOtherTablesAreNotAConflict(t *testing.T) {
	env := newEnv(t)
	original := "[profiles.work]\notel = 1\nmodel = \"gpt-5\"\n"
	write(t, env.configFile(), original)
	codex := New()
	if err := codex.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	if status := codex.Status(env.Env); containsString(status.Problems, "conflict_existing_otel") {
		t.Fatalf("a profile's otel key was treated as a conflict: %+v", status)
	}
	config := readTOML(t, env.configFile())
	if config["profiles"].(map[string]any)["work"].(map[string]any)["otel"] != int64(1) || config["otel"] == nil {
		t.Fatalf("config: %v", config)
	}
}

func TestUninstallIsByteExactWithoutATrailingNewline(t *testing.T) {
	for _, original := range []string{"model = \"gpt-5\"", "[otel]\nenvironment = \"work\"", "model = \"gpt-5\"\r\n"} {
		env := newEnv(t)
		write(t, env.configFile(), original)
		codex := New()
		if err := codex.Install(env.Env); err != nil {
			t.Fatal(err)
		}
		readTOML(t, env.configFile())
		if err := codex.Uninstall(env.Env); err != nil {
			t.Fatal(err)
		}
		if got := read(t, env.configFile()); got != original {
			t.Fatalf("uninstall changed %q into %q", original, got)
		}
	}
}

// codexAppend reproduces how Codex (toml_edit) adds tables after install:
// our END marker is a trailing document comment, so toml_edit keeps it at the
// very end of the file, after the tables it inserts.
func codexAppend(text, tables string) string {
	withoutEnd := strings.Replace(text, blockEnd+"\n", "", 1)
	return withoutEnd + tables + blockEnd + "\n"
}

func codexTables(env testEnv) string {
	return "\n[projects.\"/x\"]\ntrust_level = \"trusted\"\n" +
		"\n[hooks.state." + tomlString(env.hooksFile()+":session_start:0:0") + "]\ntrusted_hash = \"sha256:foreign\"\n" +
		"\n[tui]\nnotifications = true\n"
}

func TestUninstallKeepsTheTablesCodexAppendsAfterTheBlock(t *testing.T) {
	for name, simulate := range map[string]func(text, tables string) string{
		"end marker moved to the end": codexAppend,
		"appended after the marker":   func(text, tables string) string { return text + tables },
	} {
		env := newEnv(t)
		original := "model = \"gpt-5\"\n"
		write(t, env.configFile(), original)
		codex := New()
		if err := codex.Install(env.Env); err != nil {
			t.Fatal(err)
		}
		tables := codexTables(env)
		write(t, env.configFile(), simulate(read(t, env.configFile()), tables))
		readTOML(t, env.configFile())
		if err := codex.Uninstall(env.Env); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got := read(t, env.configFile()); got != original+tables {
			t.Fatalf("%s: uninstall must remove only our lines, got:\n%s", name, got)
		}
	}
}

func TestReinstallAndRepairAfterCodexAppendsNeitherDuplicateNorEat(t *testing.T) {
	env := newEnv(t)
	original := "model = \"gpt-5\"\n"
	write(t, env.configFile(), original)
	codex := New()
	if err := codex.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	tables := codexTables(env)
	appended := codexAppend(read(t, env.configFile()), tables)
	write(t, env.configFile(), appended)
	if err := codex.Install(env.Env); err != nil || read(t, env.configFile()) != appended {
		t.Fatalf("a current install must not rewrite: %v\n%s", err, read(t, env.configFile()))
	}
	env.Telemetry.Endpoint = "http://127.0.0.1:15000"
	if changed, err := codex.Repair(env.Env); err != nil || !changed {
		t.Fatalf("stale endpoint not refreshed: %v %v", changed, err)
	}
	text := read(t, env.configFile())
	if strings.Count(text, blockBegin) != 1 || strings.Count(text, blockEnd) != 1 || !strings.HasSuffix(text, tables) || !strings.Contains(text, "127.0.0.1:15000/v1/logs") {
		t.Fatalf("repair duplicated the block or ate Codex's tables:\n%s", text)
	}
	env.Telemetry.Endpoint = "http://127.0.0.1:16000"
	if err := codex.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	text = read(t, env.configFile())
	if strings.Count(text, blockBegin) != 1 || !strings.HasSuffix(text, tables) || !strings.Contains(text, "127.0.0.1:16000/v1/traces") {
		t.Fatalf("re-install duplicated the block or ate Codex's tables:\n%s", text)
	}
	if err := codex.Uninstall(env.Env); err != nil {
		t.Fatal(err)
	}
	if got := read(t, env.configFile()); got != original+tables {
		t.Fatalf("uninstall after repair, got:\n%s", got)
	}
}

func TestRemovalRefusesToDropSettingsItDidNotWrite(t *testing.T) {
	env := newEnv(t)
	codex := New()
	if err := codex.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	// A user key typed inside our exporter table is not ours to delete, and
	// dropping only our lines would move it into another table.
	edited := strings.Replace(read(t, env.configFile()), "protocol = \"json\"\n", "protocol = \"json\"\nheaders = { x = \"1\" }\n", 1)
	write(t, env.configFile(), edited)
	if err := codex.Uninstall(env.Env); !errors.Is(err, agent.ErrConfigInvalid) {
		t.Fatalf("an unsafe removal was not refused: %v", err)
	}
	if read(t, env.configFile()) != edited {
		t.Fatal("config.toml changed although removal was refused")
	}
}

func TestHooksFileCodexWouldRejectIsNeverWritten(t *testing.T) {
	// Each is a file codex-cli 0.144.1 refuses as a whole ("failed to parse
	// hooks config"), which disables our hooks along with the user's.
	invalid := map[string]string{
		"unknown top-level field": `{"SessionStart":[{"hooks":[{"type":"command","command":"guard.sh"}]}]}`,
		"hooks null":              `{"hooks":null}`,
		"event not a list":        `{"hooks":{"Stop":{"hooks":[]}}}`,
		"group not an object":     `{"hooks":{"Stop":["guard.sh"]}}`,
		"handlers not a list":     `{"hooks":{"Stop":[{"hooks":{"type":"command"}}]}}`,
		"handler not an object":   `{"hooks":{"Stop":[{"hooks":["guard.sh"]}]}}`,
		"unknown handler type":    `{"hooks":{"Stop":[{"hooks":[{"type":"script","command":"guard.sh"}]}]}}`,
		"command missing":         `{"hooks":{"Stop":[{"hooks":[{"type":"command"}]}]}}`,
		"timeout not a number":    `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"guard.sh","timeout":"5"}]}]}}`,
		"timeout negative":        `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"guard.sh","timeout":-1}]}]}}`,
		"handlers null":           `{"hooks":{"Stop":[{"hooks":null}]}}`,
		"schema key":              `{"$schema":"https://example.com/hooks.json","hooks":{}}`,
		"not json":                `{"hooks":`,
	}
	for name, content := range invalid {
		env := newEnv(t)
		write(t, env.hooksFile(), content)
		codex := New()
		if err := codex.Install(env.Env); !errors.Is(err, agent.ErrConfigInvalid) {
			t.Errorf("%s: install accepted it: %v", name, err)
		}
		if changed, err := codex.Repair(env.Env); changed || !errors.Is(err, agent.ErrConfigInvalid) {
			t.Errorf("%s: repair accepted it: %v %v", name, changed, err)
		}
		if read(t, env.hooksFile()) != content {
			t.Errorf("%s: hooks.json was written", name)
		}
		if status := codex.Status(env.Env); status.State != agent.InvalidConfig || !contains(status.Problems, "hooks_invalid") {
			t.Errorf("%s: status %+v, want invalid_config", name, status)
		}
	}
}

func TestHooksFileShapesCodexAcceptsAreStillEdited(t *testing.T) {
	// Codex ignores unknown events and extra members of groups and handlers.
	for _, content := range []string{
		`{"description":"mine"}`,
		`{"hooks":{"FutureEvent":[{"hooks":[{"type":"prompt","prompt":"x"}]}]}}`,
		`{"hooks":{"Stop":[{"note":1,"hooks":[{"type":"command","command":"notify","timeout":5,"extra":true}]},{}]}}`,
		// timeout is an Option<u64> in Codex.
		`{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"notify","timeout":null}]}]}}`,
	} {
		env := newEnv(t)
		write(t, env.hooksFile(), content)
		if err := New().Install(env.Env); err != nil {
			t.Errorf("%s: %v", content, err)
		}
	}
}

func TestUninstallStillRecoversAConfigTheUserBrokeAfterTheBlock(t *testing.T) {
	env := newEnv(t)
	original := "model = \"gpt-5\"\n"
	write(t, env.configFile(), original)
	codex := New()
	if err := codex.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	// A second [otel] table makes the file invalid until our block is gone.
	userAppended := "\n[otel]\nenvironment = \"dev\"\n"
	write(t, env.configFile(), read(t, env.configFile())+userAppended)
	if err := codex.Uninstall(env.Env); err != nil {
		t.Fatalf("uninstall must still strip the block: %v", err)
	}
	if got := read(t, env.configFile()); got != original+userAppended {
		t.Fatalf("uninstall must remove only our lines, got:\n%s", got)
	}
}

func TestUninstallOfABrokenConfigRefusesToDropForeignLines(t *testing.T) {
	env := newEnv(t)
	codex := New()
	if err := codex.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	edited := strings.Replace(read(t, env.configFile()), blockEnd+"\n", "headers = { x = \"1\" }\n"+blockEnd+"\n", 1) + "\n[otel]\nenvironment = \"dev\"\n"
	write(t, env.configFile(), edited)
	if err := codex.Uninstall(env.Env); !errors.Is(err, agent.ErrConfigInvalid) {
		t.Fatalf("a removal that cannot be verified was not refused: %v", err)
	}
	if read(t, env.configFile()) != edited {
		t.Fatal("config.toml changed although removal was refused")
	}
}

func TestUninstallKeepsTheFinalNewlineOfTablesCodexAppended(t *testing.T) {
	env := newEnv(t)
	original := "model = \"gpt-5\""
	write(t, env.configFile(), original)
	codex := New()
	if err := codex.Install(env.Env); err != nil {
		t.Fatal(err)
	}
	tables := codexTables(env)
	write(t, env.configFile(), codexAppend(read(t, env.configFile()), tables))
	if err := codex.Uninstall(env.Env); err != nil {
		t.Fatal(err)
	}
	if got := read(t, env.configFile()); got != original+"\n"+tables {
		t.Fatalf("uninstall must keep Codex's final newline, got %q", got)
	}
}

func TestUninstallOfABrokenConfigRefusesUserCopiesOfOurTables(t *testing.T) {
	// Each copy matches our format inside the block, which makes the file
	// invalid; the line-by-line fallback must not claim the user's lines.
	for name, copied := range map[string]string{
		"exporter table": "[otel.exporter.otlp-http]\nendpoint = \"http://mine/v1/logs\"\nprotocol = \"json\"\n",
		"otel table":     "[otel]\nlog_user_prompt = false\n",
	} {
		env := newEnv(t)
		write(t, env.configFile(), "model = \"gpt-5\"\r\n")
		codex := New()
		if err := codex.Install(env.Env); err != nil {
			t.Fatal(err)
		}
		edited := strings.Replace(read(t, env.configFile()), blockEnd+"\n", copied+blockEnd+"\n", 1)
		write(t, env.configFile(), edited)
		if err := toml.Unmarshal([]byte(edited), new(map[string]any)); err == nil {
			t.Fatalf("%s: the copy must make the file invalid to reach the fallback", name)
		}
		if err := codex.Uninstall(env.Env); !errors.Is(err, agent.ErrConfigInvalid) {
			t.Errorf("%s: removal that would drop the user's copy was not refused: %v", name, err)
		}
		if got := read(t, env.configFile()); got != edited {
			t.Errorf("%s: config.toml changed although removal was refused:\n%s", name, got)
		}
	}
}
