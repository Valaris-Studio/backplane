// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Card 0ac035df step 3b — the isolated CODEX_HOME is built on EVERY Codex
// launch, so whatever the real ~/.codex/config.toml said about WHERE to send
// requests must travel with it. A host whose config selects a custom
// `model_provider` (a proxy, with `env_key` naming the credential variable)
// keeps that provider's key in auth.json; with auth.json alone codex falls
// back to api.openai.com and every turn dies with 401 before the model runs
// (observed live 2026-09-02 on this very host). That is now a regression for
// every proxied host, not a probe-only nuisance.
//
// Contract pinned here:
//   - model, model_provider, every [model_providers.*] table and every
//     [projects.*] table are carried into the isolated config.toml;
//   - operator policy that would weaken the launch (sandbox_mode,
//     approval_policy, foreign [mcp_servers.*]) is NOT carried;
//   - the runner's own [mcp_servers.valaris] block still appears only when
//     MCP wiring is requested, and the rules file is always written;
//   - a provider whose env_key is absent from the process env gets it from
//     auth.json; a present env value wins;
//   - an unparsable real config.toml fails the launch loudly, naming the path.
//
// Implementer note: the runner's go.mod carries NO TOML library (checked
// 2026-09-02). The assertions below compare key/value pairs per table, not
// bytes, so either a hand-rolled table-aware line filter or a small
// dependency (e.g. github.com/pelletier/go-toml/v2 or BurntSushi/toml) can
// satisfy them — pick the smallest option that round-trips the tables above.

const realCodexConfigWithProxy = `model = "gpt-5.6-sol"
personality = "pragmatic"
model_reasoning_effort = "medium"
sandbox_mode = "danger-full-access"
approval_policy = "on-request"

model_provider = "valaris"

[model_providers.valaris]
base_url = "https://proxy.example.test/v1"
name="valaris"
env_key = "OPENAI_API_KEY"
wire_api = "responses"

[projects."/some/path"]
trust_level = "trusted"

[mcp_servers.other]
command = "other-mcp"
args = ["--serve"]
`

// writeFakeRealCodexHome builds a stand-in for the operator's ~/.codex with
// the given config.toml (omitted when empty) and auth.json.
func writeFakeRealCodexHome(t *testing.T, configTOML, authJSON string) string {
	t.Helper()
	real := t.TempDir()
	if configTOML != "" {
		if err := os.WriteFile(filepath.Join(real, "config.toml"), []byte(configTOML), 0o600); err != nil {
			t.Fatalf("write real config.toml: %v", err)
		}
	}
	if authJSON != "" {
		if err := os.WriteFile(filepath.Join(real, "auth.json"), []byte(authJSON), 0o600); err != nil {
			t.Fatalf("write real auth.json: %v", err)
		}
	}
	return real
}

// tomlKeyValues is a deliberately tiny table-aware reader: it maps
// "<table>\x00<key>" → raw value text for flat `key = value` lines, with ""
// as the top-level table. Whitespace around `=` is ignored so a re-rendered
// (round-tripped) config compares equal to the hand-written original. It is
// enough to pin routing values without a TOML dependency in the test.
func tomlKeyValues(doc string) map[string]string {
	kv := map[string]string{}
	table := ""
	for _, line := range strings.Split(doc, "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			continue
		}
		if strings.HasPrefix(trimmed, "[") {
			table = strings.TrimSpace(strings.Trim(trimmed, "[]"))
			continue
		}
		key, value, ok := strings.Cut(trimmed, "=")
		if !ok {
			continue
		}
		kv[table+"\x00"+strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	return kv
}

func assertTOMLValue(t *testing.T, doc, table, key, want string) {
	t.Helper()
	got, ok := tomlKeyValues(doc)[table+"\x00"+key]
	if !ok {
		t.Errorf("isolated config.toml missing [%s] %s (want %s):\n%s", table, key, want, doc)
		return
	}
	if got != want {
		t.Errorf("isolated config.toml [%s] %s = %s, want %s", table, key, got, want)
	}
}

func assertTOMLAbsent(t *testing.T, doc, table, key string) {
	t.Helper()
	if got, ok := tomlKeyValues(doc)[table+"\x00"+key]; ok {
		t.Errorf("isolated config.toml must NOT carry [%s] %s (got %s):\n%s", table, key, got, doc)
	}
}

func assertRoutingCarried(t *testing.T, doc string) {
	t.Helper()
	assertTOMLValue(t, doc, "", "model", `"gpt-5.6-sol"`)
	assertTOMLValue(t, doc, "", "model_provider", `"valaris"`)
	assertTOMLValue(t, doc, "model_providers.valaris", "base_url", `"https://proxy.example.test/v1"`)
	assertTOMLValue(t, doc, "model_providers.valaris", "name", `"valaris"`)
	assertTOMLValue(t, doc, "model_providers.valaris", "env_key", `"OPENAI_API_KEY"`)
	assertTOMLValue(t, doc, "model_providers.valaris", "wire_api", `"responses"`)
	assertTOMLValue(t, doc, `projects."/some/path"`, "trust_level", `"trusted"`)

	assertTOMLAbsent(t, doc, "", "sandbox_mode")
	assertTOMLAbsent(t, doc, "", "approval_policy")
	assertTOMLAbsent(t, doc, "", "personality")
	assertTOMLAbsent(t, doc, "mcp_servers.other", "command")
	if strings.Contains(doc, "[mcp_servers.other]") {
		t.Errorf("a foreign [mcp_servers.other] table must not be carried into the launch home:\n%s", doc)
	}
}

func TestCodexLaunchHome_CarriesModelRoutingFromRealConfig(t *testing.T) {
	real := writeFakeRealCodexHome(t, realCodexConfigWithProxy, `{"auth_mode":"apikey","OPENAI_API_KEY":"sk-test"}`)

	t.Run("without_mcp_wiring", func(t *testing.T) {
		home, cleanup, err := codexLaunchHome(codexHomeSpec{
			RealCodexHome: real,
			DenyRules:     renderCodexDenyRules(SafeToolDenyFloor),
		})
		if err != nil {
			t.Fatalf("codexLaunchHome: %v", err)
		}
		defer cleanup()

		doc := readCodexConfigToml(t, home)
		assertRoutingCarried(t, doc)
		if strings.Contains(doc, "[mcp_servers.valaris]") {
			t.Errorf("no MCP template → no [mcp_servers.valaris] block:\n%s", doc)
		}
		if _, err := os.Stat(filepath.Join(home, filepath.FromSlash(codexDenyRulesRelPath))); err != nil {
			t.Errorf("rules file must still be written alongside the routing config: %v", err)
		}
	})

	t.Run("with_mcp_wiring", func(t *testing.T) {
		home, cleanup, err := codexLaunchHome(codexHomeSpec{
			RealCodexHome:   real,
			MCPTemplatePath: writeStaticTemplate(t),
			AllowedTools:    []string{"mcp__valaris__get_card"},
			DenyRules:       renderCodexDenyRules(SafeToolDenyFloor),
		})
		if err != nil {
			t.Fatalf("codexLaunchHome: %v", err)
		}
		defer cleanup()

		doc := readCodexConfigToml(t, home)
		assertRoutingCarried(t, doc)
		assertTOMLValue(t, doc, "mcp_servers.valaris", "command", `"bash"`)
		assertTOMLValue(t, doc, "mcp_servers.valaris.env", "VALARIS_MCP_ALLOWLIST", `"get_card"`)
		if _, err := os.Stat(filepath.Join(home, filepath.FromSlash(codexDenyRulesRelPath))); err != nil {
			t.Errorf("rules file must still be written alongside MCP wiring + routing: %v", err)
		}
	})
}

// A host with no real config.toml (plain `codex login`, built-in openai
// provider) must launch exactly as before: no routing keys, no error.
func TestCodexLaunchHome_NoRealConfigIsFine(t *testing.T) {
	real := writeFakeRealCodexHome(t, "", `{"auth_mode":"chatgpt"}`)

	home, cleanup, err := codexLaunchHome(codexHomeSpec{
		RealCodexHome: real,
		DenyRules:     renderCodexDenyRules(SafeToolDenyFloor),
	})
	if err != nil {
		t.Fatalf("codexLaunchHome with no real config.toml must succeed: %v", err)
	}
	defer cleanup()

	if raw, err := os.ReadFile(filepath.Join(home, "config.toml")); err == nil {
		doc := string(raw)
		assertTOMLAbsent(t, doc, "", "model")
		assertTOMLAbsent(t, doc, "", "model_provider")
		if strings.Contains(doc, "[model_providers.") {
			t.Errorf("no real config → no [model_providers.*] tables:\n%s", doc)
		}
	}

	cap := newCodexCapture(t)
	t.Setenv("CODEX_HOME", real)
	cli := &CodexCLI{CodexBin: cap.fake}
	if _, err := cli.Execute(context.Background(), "p", Options{}); err != nil {
		t.Fatalf("Execute must succeed with a real home holding only auth.json: %v", err)
	}
}

// The selected provider's env_key credential lives in auth.json (that is
// where `codex login --api-key` stores it), but codex reads a custom
// provider's key ONLY from the named env var. The driver must bridge the two
// — mirroring providerKeyEnv in codex_execpolicy_live_integration_test.go,
// which this lifts into production — while a value already present in the
// process env always wins and auth.json is not consulted.
func TestCodexLaunchHome_ProviderEnvKeyInjectedFromAuthJSON(t *testing.T) {
	real := writeFakeRealCodexHome(t, realCodexConfigWithProxy,
		`{"auth_mode":"apikey","OPENAI_API_KEY":"sk-from-auth-json"}`)

	envValueOf := func(t *testing.T, cap codexCapture, name string) string {
		t.Helper()
		for _, line := range strings.Split(cap.read(t, cap.env, "env"), "\n") {
			if strings.HasPrefix(line, name+"=") {
				return strings.TrimPrefix(line, name+"=")
			}
		}
		return ""
	}

	t.Run("absent_from_env_comes_from_auth_json", func(t *testing.T) {
		cap := newCodexCapture(t)
		t.Setenv("CODEX_HOME", real)
		t.Setenv("OPENAI_API_KEY", "") // registers restore; then truly unset
		os.Unsetenv("OPENAI_API_KEY")

		cli := &CodexCLI{CodexBin: cap.fake}
		if _, err := cli.Execute(context.Background(), "p", Options{}); err != nil {
			t.Fatalf("execute: %v", err)
		}
		if got := envValueOf(t, cap, "OPENAI_API_KEY"); got != "sk-from-auth-json" {
			t.Errorf("spawned codex must see OPENAI_API_KEY from auth.json (provider env_key), got %q", got)
		}
	})

	t.Run("present_in_env_wins", func(t *testing.T) {
		cap := newCodexCapture(t)
		t.Setenv("CODEX_HOME", real)
		t.Setenv("OPENAI_API_KEY", "sk-from-env")

		cli := &CodexCLI{CodexBin: cap.fake}
		if _, err := cli.Execute(context.Background(), "p", Options{}); err != nil {
			t.Fatalf("execute: %v", err)
		}
		if got := envValueOf(t, cap, "OPENAI_API_KEY"); got != "sk-from-env" {
			t.Errorf("process env must win over auth.json, got %q", got)
		}
		if strings.Contains(cap.read(t, cap.env, "env"), "sk-from-auth-json") {
			t.Error("auth.json value must not be injected when the env already carries the key")
		}
	})

	t.Run("no_env_key_provider_injects_nothing", func(t *testing.T) {
		cap := newCodexCapture(t)
		t.Setenv("CODEX_HOME", writeFakeRealCodexHome(t, "", `{"auth_mode":"apikey","OPENAI_API_KEY":"sk-from-auth-json"}`))
		t.Setenv("OPENAI_API_KEY", "")
		os.Unsetenv("OPENAI_API_KEY")

		cli := &CodexCLI{CodexBin: cap.fake}
		if _, err := cli.Execute(context.Background(), "p", Options{}); err != nil {
			t.Fatalf("execute: %v", err)
		}
		// Built-in openai provider reads auth.json itself; nothing to bridge.
		if got := envValueOf(t, cap, "OPENAI_API_KEY"); got != "" {
			t.Errorf("no custom provider selected → no injection, got OPENAI_API_KEY=%q", got)
		}
	})

	// Round 2: the provider may be declared with top-level dotted keys or a
	// single-line inline table (both accepted by codex) — env_key discovery,
	// and therefore injection, must not depend on the [table] header form.
	shapes := map[string]string{
		"dotted_keys": "model_providers.valaris.name = \"valaris\"\n" +
			"model_providers.valaris.base_url = \"https://proxy.example.test/v1\"\n" +
			"model_providers.valaris.env_key = \"OPENAI_API_KEY\"\n" +
			"model_provider = \"valaris\"\n",
		"inline_table": "model_providers = { valaris = { name = \"valaris\", base_url = \"https://proxy.example.test/v1\", env_key = \"OPENAI_API_KEY\" } }\n" +
			"model_provider = \"valaris\"\n",
		// Round 3: inline table spread over several lines.
		"multi_line_inline_table": "model_providers = {\n" +
			"  valaris = { name = \"valaris\", base_url = \"https://proxy.example.test/v1\", env_key = \"OPENAI_API_KEY\" },\n" +
			"}\n" +
			"model_provider = \"valaris\"\n",
	}
	for name, config := range shapes {
		t.Run("absent_from_env_"+name, func(t *testing.T) {
			cap := newCodexCapture(t)
			t.Setenv("CODEX_HOME", writeFakeRealCodexHome(t, config, `{"auth_mode":"apikey","OPENAI_API_KEY":"sk-from-auth-json"}`))
			t.Setenv("OPENAI_API_KEY", "")
			os.Unsetenv("OPENAI_API_KEY")

			cli := &CodexCLI{CodexBin: cap.fake}
			if _, err := cli.Execute(context.Background(), "p", Options{}); err != nil {
				t.Fatalf("execute: %v", err)
			}
			if got := envValueOf(t, cap, "OPENAI_API_KEY"); got != "sk-from-auth-json" {
				t.Errorf("%s: spawned codex must see OPENAI_API_KEY from auth.json, got %q", name, got)
			}
		})
	}

	// Round 3 (MAJOR): two providers in one inline table, the SECOND one
	// selected. Injection must follow model_provider, not whichever provider
	// the filter happened to record; the unselected provider's key must not
	// be injected at all.
	t.Run("multi_provider_inline_injects_selected_only", func(t *testing.T) {
		const config = "model_providers = { p = { name = \"p\", base_url = \"https://p.test/v1\", env_key = \"P_KEY\" }, q = { name = \"q\", base_url = \"https://q.test/v1\", env_key = \"Q_KEY\" } }\n" +
			"model_provider = \"q\"\n"
		cap := newCodexCapture(t)
		t.Setenv("CODEX_HOME", writeFakeRealCodexHome(t, config, `{"auth_mode":"apikey","P_KEY":"sk-p","Q_KEY":"sk-q"}`))
		for _, name := range []string{"P_KEY", "Q_KEY"} {
			t.Setenv(name, "")
			os.Unsetenv(name)
		}

		cli := &CodexCLI{CodexBin: cap.fake}
		if _, err := cli.Execute(context.Background(), "p", Options{}); err != nil {
			t.Fatalf("execute: %v", err)
		}
		if got := envValueOf(t, cap, "Q_KEY"); got != "sk-q" {
			t.Errorf("selected provider q: spawned codex must see Q_KEY from auth.json, got %q", got)
		}
		if got := envValueOf(t, cap, "P_KEY"); got != "" {
			t.Errorf("unselected provider p must not have its key injected, got P_KEY=%q", got)
		}
	})
}

// An unparsable real config.toml must fail the launch and name the file: a
// silent fallback would route a proxied host to api.openai.com with the
// wrong key, which is exactly the 401 this contract exists to prevent.
func TestCodexLaunchHome_MalformedRealConfigFailsLoudly(t *testing.T) {
	real := writeFakeRealCodexHome(t, "model = \"x\"\n[model_providers.valaris\nbase_url = = \"broken\n", `{"auth_mode":"apikey"}`)
	configPath := filepath.Join(real, "config.toml")

	cap := newCodexCapture(t)
	t.Setenv("CODEX_HOME", real)
	cli := &CodexCLI{CodexBin: cap.fake}
	_, err := cli.Execute(context.Background(), "p", Options{})
	if err == nil {
		t.Fatalf("Execute must fail on an unparsable real config.toml at %s (no silent fallback)", configPath)
	}
	if !strings.Contains(err.Error(), configPath) {
		t.Errorf("error must name the offending config path %s, got: %v", configPath, err)
	}
	if _, statErr := os.Stat(cap.argv); statErr == nil {
		t.Error("codex must not be spawned when the launch home could not be built")
	}
}

// ---------------------------------------------------------------------------
// Round 2 (adversarial review, HIGH): sessions must survive the launch home.
// Codex persists every thread as $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl
// and indexes it in $CODEX_HOME/session_index.jsonl (+ history.jsonl). The
// per-launch home is deleted at cleanup, but the workloop resumes by
// SessionID on a LATER launch (loop.go implement / implement_after_approval:
// opts.ResumeSessionID = l.sessions.Get(...)) — so with an isolated home on
// every launch, `codex exec resume <id>` can never find the rollout.
//
// Contract: codexLaunchHome shares the real home's session state —
// `sessions/` as a directory symlink to <real>/sessions (created in the real
// home if absent), and `session_index.jsonl` + `history.jsonl` as file
// symlinks (created empty, 0600, in the real home if absent).
//
// Windows/symlink seam (round-2 item 5): the implementer exposes a
// package-level `symlinkFile = os.Symlink` variable that every symlink in the
// launch home goes through; TestCodexLaunchHome_AuthFallsBackToCopyWhenSymlinkFails
// swaps it to inject a failure.
// ---------------------------------------------------------------------------

// writeFakeCodexWritingSession is a fake codex that behaves like the real
// one with respect to session persistence: it writes a rollout under
// $CODEX_HOME/sessions and appends to session_index.jsonl / history.jsonl,
// then records every rollout it can see (through symlinks) for the test.
func writeFakeCodexWritingSession(t *testing.T, rolloutName string) string {
	t.Helper()
	return writeFakeCodex(t, `#!/bin/sh
mkdir -p "$CODEX_HOME/sessions/2026/09/02"
echo '{"id":"th_persist"}' > "$CODEX_HOME/sessions/2026/09/02/`+rolloutName+`"
echo '{"id":"th_persist","thread_name":"probe"}' >> "$CODEX_HOME/session_index.jsonl"
echo '{"session_id":"th_persist","text":"p"}' >> "$CODEX_HOME/history.jsonl"
if [ -n "$CODEX_SESSIONS_SEEN_OUT" ]; then
  find -L "$CODEX_HOME/sessions" -type f | sed "s#.*/##" | sort > "$CODEX_SESSIONS_SEEN_OUT"
fi
printf '{"type":"thread.started","thread_id":"th_persist"}\n'
printf '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n'
printf '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n'
`)
}

func TestCodexLaunchHome_SessionsPersistInRealHome(t *testing.T) {
	real := writeFakeRealCodexHome(t, "", `{"auth_mode":"chatgpt"}`)
	t.Setenv("CODEX_HOME", real)
	seen := filepath.Join(t.TempDir(), "seen")
	t.Setenv("CODEX_SESSIONS_SEEN_OUT", seen)

	first := &CodexCLI{CodexBin: writeFakeCodexWritingSession(t, "rollout-first.jsonl")}
	if _, err := first.Execute(context.Background(), "p", Options{}); err != nil {
		t.Fatalf("first execute: %v", err)
	}

	// After Execute returned, the isolated home is gone; the rollout and the
	// index must live on in the REAL home.
	if _, err := os.Stat(filepath.Join(real, "sessions", "2026", "09", "02", "rollout-first.jsonl")); err != nil {
		t.Errorf("rollout must persist under <real>/sessions after cleanup: %v", err)
	}
	index, err := os.ReadFile(filepath.Join(real, "session_index.jsonl"))
	if err != nil || !strings.Contains(string(index), "th_persist") {
		t.Errorf("session_index.jsonl must persist in the real home (err=%v):\n%s", err, index)
	}
	if history, err := os.ReadFile(filepath.Join(real, "history.jsonl")); err != nil || !strings.Contains(string(history), "th_persist") {
		t.Errorf("history.jsonl must persist in the real home (err=%v):\n%s", err, history)
	}

	// A second launch gets a fresh isolated home and must still SEE the first
	// launch's rollout — that is what `codex exec resume <id>` needs.
	second := &CodexCLI{CodexBin: writeFakeCodexWritingSession(t, "rollout-second.jsonl")}
	if _, err := second.Execute(context.Background(), "p", Options{ResumeSessionID: "th_persist"}); err != nil {
		t.Fatalf("second execute: %v", err)
	}
	list, err := os.ReadFile(seen)
	if err != nil {
		t.Fatalf("fake codex did not record the sessions it saw: %v", err)
	}
	if !strings.Contains(string(list), "rollout-first.jsonl") {
		t.Errorf("second launch must see the first launch's rollout through $CODEX_HOME/sessions, saw:\n%s", list)
	}
}

func TestCodexLaunchHome_SessionsDirCreatedWhenRealHomeLacksIt(t *testing.T) {
	real := writeFakeRealCodexHome(t, "", `{"auth_mode":"chatgpt"}`)

	home, cleanup, err := codexLaunchHome(codexHomeSpec{RealCodexHome: real, DenyRules: renderCodexDenyRules(SafeToolDenyFloor)})
	if err != nil {
		t.Fatalf("codexLaunchHome: %v", err)
	}
	defer cleanup()

	if info, err := os.Stat(filepath.Join(real, "sessions")); err != nil || !info.IsDir() {
		t.Errorf("<real>/sessions must be created as a directory when absent (err=%v)", err)
	}
	for _, name := range []string{"sessions", "session_index.jsonl", "history.jsonl"} {
		linkInfo, err := os.Lstat(filepath.Join(home, name))
		if err != nil {
			t.Errorf("isolated home must carry %s: %v", name, err)
			continue
		}
		if linkInfo.Mode()&os.ModeSymlink == 0 {
			t.Errorf("isolated %s must be a symlink into the real home, mode=%v", name, linkInfo.Mode())
		}
		target, _ := os.Readlink(filepath.Join(home, name))
		if target != filepath.Join(real, name) {
			t.Errorf("isolated %s → %q, want %q", name, target, filepath.Join(real, name))
		}
	}
	for _, name := range []string{"session_index.jsonl", "history.jsonl"} {
		info, err := os.Stat(filepath.Join(real, name))
		if err != nil {
			t.Errorf("<real>/%s must be created (empty) when absent: %v", name, err)
			continue
		}
		if info.Mode().Perm() != 0o600 {
			t.Errorf("<real>/%s created with mode %v, want 0600", name, info.Mode().Perm())
		}
	}
}

// Windows (and some shared filesystems) refuse symlinks. auth.json must then
// be COPIED (0600) so the launch still authenticates, with ONE warning that
// the copy can go stale on a concurrent `codex login`; the launch proceeds.
func TestCodexLaunchHome_AuthFallsBackToCopyWhenSymlinkFails(t *testing.T) {
	const authContent = `{"auth_mode":"apikey","OPENAI_API_KEY":"sk-copied"}`
	real := writeFakeRealCodexHome(t, "", authContent)

	previousSymlink := symlinkFile
	symlinkFile = func(oldname, newname string) error {
		if filepath.Base(newname) == "auth.json" {
			return errors.New("injected: symlinks not permitted")
		}
		return previousSymlink(oldname, newname)
	}
	t.Cleanup(func() { symlinkFile = previousSymlink })

	var logs bytes.Buffer
	previousLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(previousLogger) })

	home, cleanup, err := codexLaunchHome(codexHomeSpec{RealCodexHome: real, DenyRules: renderCodexDenyRules(SafeToolDenyFloor)})
	if err != nil {
		t.Fatalf("launch must proceed on symlink failure, got: %v", err)
	}
	defer cleanup()

	authPath := filepath.Join(home, "auth.json")
	info, err := os.Lstat(authPath)
	if err != nil {
		t.Fatalf("isolated auth.json missing after symlink failure: %v", err)
	}
	if info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("isolated auth.json must be a regular COPY when symlinking fails, got a symlink")
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("copied auth.json mode %v, want 0600", info.Mode().Perm())
	}
	if got, _ := os.ReadFile(authPath); string(got) != authContent {
		t.Errorf("copied auth.json content = %q, want %q", got, authContent)
	}

	warnings := 0
	for _, line := range strings.Split(logs.String(), "\n") {
		if strings.Contains(line, "level=WARN") && strings.Contains(line, "auth.json") {
			warnings++
		}
	}
	if warnings != 1 {
		t.Errorf("want exactly one WARN about the auth.json copy fallback, got %d:\n%s", warnings, logs.String())
	}
}
