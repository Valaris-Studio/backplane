// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// writeFakeCodex writes an executable POSIX shell script standing in for the
// codex binary and returns its path. Skips the whole test on Windows.
func writeFakeCodex(t *testing.T, script string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("shell fake binary is POSIX only")
	}
	fake := filepath.Join(t.TempDir(), "fake-codex.sh")
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake codex: %v", err)
	}
	return fake
}

func TestCodexCLI_Name(t *testing.T) {
	if got := NewCodexCLI().Name(); got != "codex-cli" {
		t.Errorf("Name() = %q, want codex-cli", got)
	}
}

// Codex reports tokens + session resume + MCP, but NOT native dollar cost and
// NOT structured-output-via-stream (its schema goes to a file). AutoCommits is
// false — the runner's git layer owns commits.
func TestCodexCLI_Capabilities(t *testing.T) {
	var p Provider = NewCodexCLI()
	cp, ok := p.(CapabilityProvider)
	if !ok {
		t.Fatal("CodexCLI must implement CapabilityProvider")
	}
	got := cp.Capabilities()
	want := Capabilities{
		StructuredOutput: true, // --output-schema + --output-last-message
		CostUSD:          false,
		Tokens:           true,
		SessionResume:    true,
		NativeMCP:        true,
		AutoCommits:      false,
		// Card 0ac035df: the shell deny-floor is enforced by execpolicy
		// `.rules` files in an isolated CODEX_HOME (same prefix semantics and
		// same nested-shell limitation as Claude's --disallowedTools).
		EnforcesShellDeny:  true,
		ShellDenyMechanism: "execpolicy-rules",
	}
	if got != want {
		t.Errorf("Capabilities() = %+v, want %+v", got, want)
	}
}

// ---------------------------------------------------------------------------
// Card 0ac035df — Codex shell deny-floor parity (mechanism A: execpolicy rules).
// Live probes (codex_execpolicy_live_integration_test.go) proved codex-cli
// 0.144.1 honors $CODEX_HOME/rules/*.rules on exec AND resume, that
// `forbidden` beats a project-scope `allow`, that the rules still reject under
// --dangerously-bypass-approvals-and-sandbox, and that `--ignore-rules` is the
// only off switch. The driver therefore always launches in an isolated
// CODEX_HOME carrying rules/backplane-deny.rules rendered from
// mergeDenyFloor(opts.DisallowedTools), and never emits --ignore-rules.
//
// The sandbox posture is deliberately UNCHANGED by the card: parity is the
// rules file, not a sandbox flip. `-c sandbox_mode="workspace-write"` was
// measured to block writes to $GOCACHE and ~/.cache ("Operation not
// permitted"), which would break go/pnpm/pip caches for every Codex stage, so
// DangerouslySkipPermissions still maps to the bypass flag and nothing else
// emits sandbox overrides.
// ---------------------------------------------------------------------------

const codexBypassFlag = "--dangerously-bypass-approvals-and-sandbox"

// assertNeverIgnoreRules is the one invariant every BuildArgs test shares:
// --ignore-rules disables user AND project execpolicy files, which would
// silently drop the whole floor. No option combination may ever emit it.
func assertNeverIgnoreRules(t *testing.T, argv []string) {
	t.Helper()
	for _, a := range argv {
		if a == "--ignore-rules" {
			t.Fatalf("--ignore-rules must NEVER be emitted (it disables the deny-floor), argv=%v", argv)
		}
	}
}

// assertNoSandboxOverrides pins the sandbox posture: no `-c` override of
// sandbox_mode / approval_policy / sandbox_workspace_write.* and no
// -s/--sandbox flag may appear on any launch.
func assertNoSandboxOverrides(t *testing.T, argv []string) {
	t.Helper()
	for i, a := range argv {
		if a == "-s" || a == "--sandbox" {
			t.Errorf("sandbox flag %q must not be emitted, argv=%v", a, argv)
		}
		if a != "-c" || i+1 >= len(argv) {
			continue
		}
		value := argv[i+1]
		for _, forbiddenKey := range []string{"sandbox_mode", "approval_policy", "sandbox_workspace_write"} {
			if strings.HasPrefix(value, forbiddenKey) {
				t.Errorf("sandbox override -c %s must not be emitted (it breaks go/pnpm/pip caches), argv=%v", value, argv)
			}
		}
	}
}

// The sandbox posture is exactly what it was before the card, on both the
// exec and resume paths, with and without skip-permissions.
func TestCodexCLI_BuildArgs_NoSandboxOverrides(t *testing.T) {
	cases := map[string]Options{
		"exec":                    {WorkingDir: "/repo"},
		"exec_skip_permissions":   {WorkingDir: "/repo", DangerouslySkipPermissions: true},
		"resume":                  {WorkingDir: "/repo", ResumeSessionID: "thread-1"},
		"resume_skip_permissions": {WorkingDir: "/repo", ResumeSessionID: "thread-1", DangerouslySkipPermissions: true},
	}
	for name, opts := range cases {
		t.Run(name, func(t *testing.T) {
			args := NewCodexCLI().buildArgs("p", opts)
			assertNoSandboxOverrides(t, args)
			assertNeverIgnoreRules(t, args)
			if opts.DangerouslySkipPermissions {
				assertContains(t, args, codexBypassFlag)
			} else {
				assertNotContains(t, args, codexBypassFlag)
			}
		})
	}
}

func TestCodexCLI_BuildArgs_Minimal(t *testing.T) {
	args := NewCodexCLI().buildArgs("do the thing", Options{})
	// exec subcommand + JSONL stream + the prompt as final positional.
	assertContains(t, args, "exec")
	assertContains(t, args, "--json")
	if args[len(args)-1] != "do the thing" {
		t.Errorf("prompt must be the final positional arg, got %v", args)
	}
	assertNeverIgnoreRules(t, args)
}

// Plain exec (no resume): --cd is valid and tells the agent its working root.
// Grounded on `codex exec --help` (codex-cli 0.140.0): plain exec lists
// `-C, --cd <DIR>`.
func TestCodexCLI_BuildArgs_PlainExecPassesCd(t *testing.T) {
	args := NewCodexCLI().buildArgs("p", Options{
		Model:      "gpt-5-codex",
		WorkingDir: "/repo",
	})
	assertContains(t, args, "exec")
	assertContains(t, args, "--model")
	assertContains(t, args, "gpt-5-codex")
	assertContains(t, args, "--cd")
	assertContains(t, args, "/repo")
	assertNotContains(t, args, "resume")
	assertNeverIgnoreRules(t, args)
}

// Resume: `codex exec resume` does NOT accept --cd (verified: it errors
// `unexpected argument '--cd' found`, exit 2 — the live implement-stage wedge).
// The process CWD is set via cmd.Dir in Execute(), and the resumed session
// already carries its working root, so --cd must be OMITTED on this path.
// Grounded on `codex exec resume --help` (codex-cli 0.140.0): no --cd listed.
func TestCodexCLI_BuildArgs_ResumeOmitsCd(t *testing.T) {
	args := NewCodexCLI().buildArgs("p", Options{
		Model:           "gpt-5-codex",
		WorkingDir:      "/repo",
		ResumeSessionID: "thread-123",
	})
	assertContains(t, args, "resume")
	assertContains(t, args, "thread-123")
	assertContains(t, args, "--model")
	assertContains(t, args, "gpt-5-codex")
	// The bug: --cd here makes `codex exec resume` exit 2. It must not appear.
	assertNotContains(t, args, "--cd")
	// --cd's value must not leak as a bare positional either (it would be parsed
	// as the prompt/session arg).
	for i, a := range args {
		if a == "/repo" {
			t.Errorf("WorkingDir leaked into resume args at %d: %v", i, args)
		}
	}
	assertNeverIgnoreRules(t, args)
}

// A materialized schema path (set by Execute from opts.OutputSchema) must
// become `--output-schema <FILE>`. Grounded on `codex exec --help`: structured
// output is FILE-based, not inline.
func TestCodexCLI_BuildArgs_OutputSchemaFile(t *testing.T) {
	args := NewCodexCLI().buildArgs("p", Options{
		Extra: map[string]any{"output_schema_path": "/tmp/schema.json"},
	})
	assertContains(t, args, "--output-schema")
	assertContains(t, args, "/tmp/schema.json")
	assertNeverIgnoreRules(t, args)
}

// Execute must materialize opts.OutputSchema to a real file and pass it through
// (the inline string alone is silently dropped by Codex — the structured-output
// gap behind the non-string findings bug). Verified via the fake-binary path.
func TestCodexCLI_Execute_MaterializesOutputSchema(t *testing.T) {
	// A fake codex that records its argv and emits a minimal valid NDJSON turn.
	fake := writeFakeCodex(t, `#!/bin/sh
echo "$@" > "$CODEX_ARGV_OUT"
printf '{"type":"thread.started","thread_id":"t"}\n'
printf '{"type":"item.completed","item":{"type":"agent_message","text":"{\\"decision\\":\\"approve\\"}"}}\n'
printf '{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}\n'
`)
	argvOut := filepath.Join(t.TempDir(), "argv")
	t.Setenv("CODEX_ARGV_OUT", argvOut)

	scratchCodexHome(t)
	cli := &CodexCLI{CodexBin: fake}
	res, err := cli.Execute(context.Background(), "review it", Options{
		OutputSchema: `{"type":"object","properties":{"decision":{"type":"string"}}}`,
	})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	argv, _ := os.ReadFile(argvOut)
	if !strings.Contains(string(argv), "--output-schema") {
		t.Fatalf("Execute must pass --output-schema to codex, argv=%q", argv)
	}
	// The schema-conforming agent_message must surface on the StructuredOutput
	// channel so decodeLLMEnvelope prefers it over prose extraction.
	if string(res.StructuredOutput) != `{"decision":"approve"}` {
		t.Errorf("StructuredOutput = %q, want the conforming JSON", res.StructuredOutput)
	}
}

// writeFakeCodexRecordingEnv is writeFakeCodex plus an env dump, a copy of
// $CODEX_HOME/config.toml (if any), the concatenated $CODEX_HOME/rules/*.rules
// and an `ls -l` of that rules dir (for the 0600 pin) — used by the
// MCP-secret-placement and deny-floor tests below, which must inspect argv
// (must NOT carry the API key), the env var CODEX_HOME, and the files it
// points at. The copies have to happen INSIDE the fake binary: Execute's own
// cleanup() removes the real CODEX_HOME the moment Execute returns, before the
// test could read it from the outside. Each capture is guarded on its target
// env var so tests only opt into what they inspect.
func writeFakeCodexRecordingEnv(t *testing.T) string {
	t.Helper()
	return writeFakeCodex(t, `#!/bin/sh
echo "$@" > "$CODEX_ARGV_OUT"
env > "$CODEX_ENV_OUT"
if [ -n "$CODEX_CONFIG_TOML_OUT" ] && [ -n "$CODEX_HOME" ] && [ -f "$CODEX_HOME/config.toml" ]; then
  cp "$CODEX_HOME/config.toml" "$CODEX_CONFIG_TOML_OUT"
fi
if [ -n "$CODEX_RULES_OUT" ] && [ -n "$CODEX_HOME" ] && [ -d "$CODEX_HOME/rules" ]; then
  cat "$CODEX_HOME"/rules/*.rules > "$CODEX_RULES_OUT" 2>/dev/null
  ls -l "$CODEX_HOME/rules" > "$CODEX_RULES_LS_OUT"
fi
printf '{"type":"thread.started","thread_id":"t"}\n'
printf '{"type":"item.completed","item":{"type":"agent_message","text":"done"}}\n'
printf '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n'
`)
}

// codexCapture wires the fake binary's capture files for one Execute call.
type codexCapture struct {
	fake, argv, env, configTOML, rules, rulesLS string
}

func newCodexCapture(t *testing.T) codexCapture {
	t.Helper()
	scratchCodexHome(t) // never let an Execute under test resolve ~/.codex
	dir := t.TempDir()
	c := codexCapture{
		fake:       writeFakeCodexRecordingEnv(t),
		argv:       filepath.Join(dir, "argv"),
		env:        filepath.Join(dir, "env"),
		configTOML: filepath.Join(dir, "config.toml"),
		rules:      filepath.Join(dir, "rules"),
		rulesLS:    filepath.Join(dir, "rules-ls"),
	}
	t.Setenv("CODEX_ARGV_OUT", c.argv)
	t.Setenv("CODEX_ENV_OUT", c.env)
	t.Setenv("CODEX_CONFIG_TOML_OUT", c.configTOML)
	t.Setenv("CODEX_RULES_OUT", c.rules)
	t.Setenv("CODEX_RULES_LS_OUT", c.rulesLS)
	return c
}

func (c codexCapture) read(t *testing.T, path, what string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("fake codex did not capture %s: %v", what, err)
	}
	return string(b)
}

func (c codexCapture) rulesText(t *testing.T) string {
	t.Helper()
	return c.read(t, c.rules, "$CODEX_HOME/rules/*.rules (Execute must write rules/backplane-deny.rules in an isolated CODEX_HOME)")
}

// codexHomeFromEnv extracts the CODEX_HOME the fake binary saw.
func (c codexCapture) codexHomeFromEnv(t *testing.T) string {
	t.Helper()
	for _, line := range strings.Split(c.read(t, c.env, "env"), "\n") {
		if strings.HasPrefix(line, "CODEX_HOME=") {
			return strings.TrimPrefix(line, "CODEX_HOME=")
		}
	}
	return ""
}

func countPrefixRules(text string) int {
	n := 0
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "prefix_rule(") {
			n++
		}
	}
	return n
}

// Execute must wire the valaris MCP server via an isolated CODEX_HOME when
// both MCPConfigPath and AllowedTools are set — the only way to hand Codex an
// MCP server, since it has no --mcp-config flag. Critically, the secret-
// bearing env values (VALARIS_API_KEY) must land ONLY in the CODEX_HOME
// config file, never in argv: process argv is world-readable via ps/procfs on
// shared hosts, unlike a 0600 file (see codexMCPHome's doc comment). Verified
// via the fake-binary path so this covers the Execute -> buildArgs -> cmd.Env
// integration, not just codexMCPHome in isolation (codex_cli_mcp_test.go).
func TestCodexCLI_Execute_WiresMCPConfigViaCodexHome_NotArgv(t *testing.T) {
	fake := writeFakeCodexRecordingEnv(t)
	argvOut := filepath.Join(t.TempDir(), "argv")
	envOut := filepath.Join(t.TempDir(), "env")
	configOut := filepath.Join(t.TempDir(), "config.toml")
	t.Setenv("CODEX_ARGV_OUT", argvOut)
	t.Setenv("CODEX_ENV_OUT", envOut)
	t.Setenv("CODEX_CONFIG_TOML_OUT", configOut)

	template := writeStaticTemplate(t) // carries VALARIS_API_KEY=vlr_test_key
	scratchCodexHome(t)
	cli := &CodexCLI{CodexBin: fake}
	_, err := cli.Execute(context.Background(), "implement it", Options{
		MCPConfigPath: template,
		AllowedTools:  []string{"mcp__valaris__get_card"},
	})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}

	argv, _ := os.ReadFile(argvOut)
	if strings.Contains(string(argv), "vlr_test_key") {
		t.Fatalf("API key must never appear in argv (ps/procfs-visible), argv=%q", argv)
	}
	if strings.Contains(string(argv), "mcp_servers") {
		t.Fatalf("MCP wiring must not be argv-based at all, argv=%q", argv)
	}

	envDump, err := os.ReadFile(envOut)
	if err != nil {
		t.Fatalf("reading recorded env: %v", err)
	}
	if !strings.Contains(string(envDump), "CODEX_HOME=") {
		t.Fatalf("Execute must set CODEX_HOME on the subprocess env, got env:\n%s", envDump)
	}

	toml, err := os.ReadFile(configOut)
	if err != nil {
		t.Fatalf("fake codex did not find CODEX_HOME/config.toml: %v", err)
	}
	if !strings.Contains(string(toml), `VALARIS_API_KEY = "vlr_test_key"`) {
		t.Errorf("the API key must land in CODEX_HOME/config.toml instead, got:\n%s", toml)
	}
	if !strings.Contains(string(toml), `VALARIS_MCP_ALLOWLIST = "get_card"`) {
		t.Errorf("config.toml missing the stripped allowlist, got:\n%s", toml)
	}
}

// Replaces TestCodexCLI_Execute_NoAllowedTools_SkipsMCPWiring (card 0ac035df):
// the isolated CODEX_HOME is no longer an MCP-only concern — it is where the
// deny-floor lives, so EVERY launch gets a fresh one, even a pure-shell stage
// with no AllowedTools and no MCPConfigPath. What that stage still must not
// pay for is the MCP server: config.toml carries no [mcp_servers.valaris].
func TestCodexCLI_Execute_AlwaysIsolatesCodexHome(t *testing.T) {
	cap := newCodexCapture(t)
	t.Setenv("CODEX_HOME", "/inherited/codex/home")

	cli := &CodexCLI{CodexBin: cap.fake}
	if _, err := cli.Execute(context.Background(), "implement it", Options{}); err != nil {
		t.Fatalf("execute: %v", err)
	}

	home := cap.codexHomeFromEnv(t)
	if home == "" || home == "/inherited/codex/home" {
		t.Fatalf("Execute must set a fresh isolated CODEX_HOME on every launch, got %q", home)
	}
	rules := cap.rulesText(t)
	if !strings.Contains(rules, `prefix_rule(pattern=["gh", "pr", "merge"]`) {
		t.Errorf("isolated CODEX_HOME must carry rules/backplane-deny.rules with the floor, got:\n%s", rules)
	}
	if toml, err := os.ReadFile(cap.configTOML); err == nil && strings.Contains(string(toml), "[mcp_servers.valaris]") {
		t.Errorf("no MCPConfigPath → config.toml must not wire the valaris MCP server, got:\n%s", toml)
	}
}

// The EMPTY grant is the loop contract's full platform surface (tools: []).
// It must still get the valaris server wired with toolsets pinned to all —
// otherwise a template without VALARIS_MCP_TOOLSETS hands the session the
// server's interactive default hand — and NO allowlist key: an empty grant
// is not a deny-all. (Before this pin, an empty grant wired no server at
// all for Codex, so a codex loop had no valaris tools whatsoever.)
func TestCodexCLI_Execute_EmptyGrant_WiresFullSurface(t *testing.T) {
	cap := newCodexCapture(t)
	cli := &CodexCLI{CodexBin: cap.fake}
	_, err := cli.Execute(context.Background(), "p", Options{
		MCPConfigPath: writeStaticTemplate(t),
		AllowedTools:  []string{},
	})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	toml := cap.read(t, cap.configTOML, "config.toml")
	if !strings.Contains(toml, "[mcp_servers.valaris]") {
		t.Fatalf("empty grant + MCPConfigPath must wire the valaris MCP server, got:\n%s", toml)
	}
	if !strings.Contains(toml, `VALARIS_MCP_TOOLSETS = "all"`) {
		t.Errorf("config.toml missing VALARIS_MCP_TOOLSETS = \"all\", got:\n%s", toml)
	}
	if strings.Contains(toml, "VALARIS_MCP_ALLOWLIST") {
		t.Errorf("the empty grant must carry no allowlist key (full surface, never __none__), got:\n%s", toml)
	}
}

// A NON-empty grant that the deny-list empties out is a deny-all, never the
// full surface: the sentinel must stay, or a deny would ESCALATE a one-tool
// stage to every valaris tool.
func TestCodexCLI_Execute_MCPDenyEmptiesGrant_StaysDenyAll(t *testing.T) {
	cap := newCodexCapture(t)
	cli := &CodexCLI{CodexBin: cap.fake}
	_, err := cli.Execute(context.Background(), "p", Options{
		MCPConfigPath:   writeStaticTemplate(t),
		AllowedTools:    []string{"mcp__valaris__update_card"},
		DisallowedTools: []string{"mcp__valaris__update_card"},
	})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	toml := cap.read(t, cap.configTOML, "config.toml")
	if !strings.Contains(toml, `VALARIS_MCP_ALLOWLIST = "__none__"`) {
		t.Errorf("a grant fully subtracted by the deny-list must stay a deny-all (want __none__), got:\n%s", toml)
	}
}

// With the full surface there is no allowlist to subtract an MCP deny entry
// from, and Codex has no other channel for MCP tools — so the entry must be
// REPORTED as unenforced, never silently dropped.
func TestCodexCLI_Execute_EmptyGrant_MCPDenyIsReportedUnenforced(t *testing.T) {
	cap := newCodexCapture(t)
	cli := &CodexCLI{CodexBin: cap.fake}
	res, err := cli.Execute(context.Background(), "p", Options{
		MCPConfigPath:   writeStaticTemplate(t),
		AllowedTools:    nil,
		DisallowedTools: []string{"mcp__valaris__enqueue_pr_for_merge"},
	})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !slicesContains(res.UnenforcedDeny, "mcp__valaris__enqueue_pr_for_merge") {
		t.Errorf("an MCP deny entry over the full surface must be reported on Result.UnenforcedDeny, got %v", res.UnenforcedDeny)
	}
}

// Headless-autonomous launch must lower DangerouslySkipPermissions to Codex's
// own bypass flag (the pre-card production posture — the deny-floor rides
// as rules, which the live probes proved still reject under that flag),
// never to a Claude flag.
func TestCodexCLI_BuildArgs_Autonomous(t *testing.T) {
	args := NewCodexCLI().buildArgs("p", Options{DangerouslySkipPermissions: true})
	assertContains(t, args, codexBypassFlag)
	for _, a := range args {
		if a == "--permission-mode" || a == "bypassPermissions" || a == "--disallowedTools" {
			t.Errorf("must not emit Claude permission flags, got %v", args)
		}
	}
	assertNeverIgnoreRules(t, args)
}

// Empty backend deny → the rules file is exactly the rendered floor.
func TestCodexCLI_Execute_RulesFileCarriesFloorWhenBackendEmpty(t *testing.T) {
	cap := newCodexCapture(t)
	cli := &CodexCLI{CodexBin: cap.fake}
	if _, err := cli.Execute(context.Background(), "p", Options{DisallowedTools: nil}); err != nil {
		t.Fatalf("execute: %v", err)
	}
	if got, want := cap.rulesText(t), renderCodexDenyRules(SafeToolDenyFloor); got != want {
		t.Errorf("rules file with empty backend deny must equal the rendered floor.\n got:\n%s\nwant:\n%s", got, want)
	}
}

// A backend deny EXTENDS the floor (mergeDenyFloor semantics: caller entries
// first, missing floor entries appended). floor + npm publish → 9 rules with
// npm publish last; a backend list missing every floor entry still yields
// all 8 floor rules.
func TestCodexCLI_Execute_RulesFileMergesBackendDeny(t *testing.T) {
	t.Run("floor_plus_backend_entry", func(t *testing.T) {
		cap := newCodexCapture(t)
		deny := append(append([]string{}, SafeToolDenyFloor...), "Bash(npm publish:*)")
		cli := &CodexCLI{CodexBin: cap.fake}
		if _, err := cli.Execute(context.Background(), "p", Options{DisallowedTools: deny}); err != nil {
			t.Fatalf("execute: %v", err)
		}
		rules := cap.rulesText(t)
		if n := countPrefixRules(rules); n != 9 {
			t.Errorf("want 9 prefix rules (8 floor + npm publish), got %d:\n%s", n, rules)
		}
		lines := strings.Split(strings.TrimSpace(rules), "\n")
		if last := lines[len(lines)-1]; !strings.HasPrefix(last, `prefix_rule(pattern=["npm", "publish"]`) {
			t.Errorf("backend entry must render LAST (floor first), last line = %q", last)
		}
		if firstRule := firstPrefixRuleLine(rules); !strings.HasPrefix(firstRule, `prefix_rule(pattern=["gh", "pr", "merge"]`) {
			t.Errorf("floor must render first, first rule = %q", firstRule)
		}
	})

	t.Run("backend_missing_floor_entries", func(t *testing.T) {
		cap := newCodexCapture(t)
		cli := &CodexCLI{CodexBin: cap.fake}
		if _, err := cli.Execute(context.Background(), "p", Options{DisallowedTools: []string{"Bash(npm publish:*)"}}); err != nil {
			t.Fatalf("execute: %v", err)
		}
		rules := cap.rulesText(t)
		if n := countPrefixRules(rules); n != 9 {
			t.Errorf("a backend list missing the floor must still yield all 8 floor rules + its own (9), got %d:\n%s", n, rules)
		}
		for _, floorPrefix := range [][]string{
			{"gh", "pr", "merge"}, {"gh", "pr", "review"}, {"gh", "pr", "close"},
			{"git", "push", "--force"}, {"git", "push", "--force-with-lease"},
			{"git", "push", "origin", "main"}, {"git", "push", "origin", "master"},
			{"git", "reset", "--hard"},
		} {
			want := `prefix_rule(pattern=[` + quoteJoin(floorPrefix) + `]`
			if !strings.Contains(rules, want) {
				t.Errorf("rules file missing floor rule %s:\n%s", want, rules)
			}
		}
	})
}

func firstPrefixRuleLine(text string) string {
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "prefix_rule(") {
			return line
		}
	}
	return ""
}

func quoteJoin(tokens []string) string {
	quoted := make([]string, len(tokens))
	for i, tok := range tokens {
		quoted[i] = `"` + tok + `"`
	}
	return strings.Join(quoted, ", ")
}

// An MCP tool in the deny-list is enforced through the only channel Codex
// has for MCP tools: it is SUBTRACTED from the VALARIS_MCP_ALLOWLIST the
// isolated config.toml hands the server. Deny wins over allow, as with Claude.
func TestCodexCLI_Execute_MCPDenySubtractsFromAllowlist(t *testing.T) {
	cap := newCodexCapture(t)
	cli := &CodexCLI{CodexBin: cap.fake}
	_, err := cli.Execute(context.Background(), "p", Options{
		MCPConfigPath:   writeStaticTemplate(t),
		AllowedTools:    []string{"mcp__valaris__get_card", "mcp__valaris__update_card"},
		DisallowedTools: []string{"mcp__valaris__update_card"},
	})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	toml := cap.read(t, cap.configTOML, "config.toml")
	if !strings.Contains(toml, `VALARIS_MCP_ALLOWLIST = "get_card"`) {
		t.Errorf("denied MCP tool must be subtracted from the allowlist (want exactly get_card), got:\n%s", toml)
	}
	if strings.Contains(toml, "update_card") {
		t.Errorf("denied mcp__valaris__update_card must not reach the allowlist, got:\n%s", toml)
	}
}

// Deny entries that are neither Bash(...) nor mcp__valaris__* (e.g. WebFetch,
// a Claude built-in) have no Codex equivalent. They must be REPORTED on the
// Result — never silently dropped — and must not pollute the rules file.
func TestCodexCLI_Execute_UnenforceableDenyIsReported(t *testing.T) {
	cap := newCodexCapture(t)
	cli := &CodexCLI{CodexBin: cap.fake}
	res, err := cli.Execute(context.Background(), "p", Options{
		DisallowedTools: []string{"WebFetch", "Bash(npm publish:*)"},
	})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	if !slicesContains(res.UnenforcedDeny, "WebFetch") {
		t.Errorf("Result.UnenforcedDeny must list WebFetch, got %v", res.UnenforcedDeny)
	}
	if slicesContains(res.UnenforcedDeny, "Bash(npm publish:*)") {
		t.Errorf("an enforceable Bash entry must not be reported as unenforced, got %v", res.UnenforcedDeny)
	}
	rules := cap.rulesText(t)
	if strings.Contains(rules, "WebFetch") {
		t.Errorf("unenforceable entry must not leak into the rules file:\n%s", rules)
	}
	if n := countPrefixRules(rules); n != 9 {
		t.Errorf("rules file must still carry floor + npm publish (9), got %d", n)
	}
}

// The rules file must be 0600: it is the launch's security policy and lives
// in a temp dir on a possibly shared host.
func TestCodexCLI_Execute_RulesFileMode0600(t *testing.T) {
	cap := newCodexCapture(t)
	cli := &CodexCLI{CodexBin: cap.fake}
	if _, err := cli.Execute(context.Background(), "p", Options{}); err != nil {
		t.Fatalf("execute: %v", err)
	}
	ls := cap.read(t, cap.rulesLS, "ls -l of $CODEX_HOME/rules")
	var found bool
	for _, line := range strings.Split(ls, "\n") {
		if !strings.HasSuffix(line, "backplane-deny.rules") {
			continue
		}
		found = true
		if !strings.HasPrefix(line, "-rw-------") {
			t.Errorf("rules/backplane-deny.rules must be mode 0600, ls -l shows: %s", line)
		}
	}
	if !found {
		t.Fatalf("rules/backplane-deny.rules not found in $CODEX_HOME/rules, ls -l:\n%s", ls)
	}
}

// Resume must go through the same isolated CODEX_HOME + rules file: a
// multi-turn stage is exactly where an agent would try the merge later.
func TestCodexCLI_Execute_ResumeAlsoWritesRules(t *testing.T) {
	cap := newCodexCapture(t)
	cli := &CodexCLI{CodexBin: cap.fake}
	if _, err := cli.ResumeSession(context.Background(), "thread-1", "p", Options{}); err != nil {
		t.Fatalf("resume: %v", err)
	}
	argv := cap.read(t, cap.argv, "argv")
	if !strings.Contains(argv, "resume thread-1") {
		t.Fatalf("expected a resume launch, argv=%q", argv)
	}
	if got, want := cap.rulesText(t), renderCodexDenyRules(SafeToolDenyFloor); got != want {
		t.Errorf("resume must write the same floor rules file.\n got:\n%s\nwant:\n%s", got, want)
	}
}

// The runner's real production path is DangerouslySkipPermissions=true →
// bypass flag. The rules file must be written on exactly that launch: the
// floor is the rules, not the sandbox.
func TestCodexCLI_Execute_RulesFileWrittenUnderSkipPermissions(t *testing.T) {
	cap := newCodexCapture(t)
	cli := &CodexCLI{CodexBin: cap.fake}
	_, err := cli.Execute(context.Background(), "p", Options{DangerouslySkipPermissions: true})
	if err != nil {
		t.Fatalf("execute: %v", err)
	}
	argv := cap.read(t, cap.argv, "argv")
	if !strings.Contains(argv, codexBypassFlag) {
		t.Errorf("skip-permissions launch must emit %s, argv=%q", codexBypassFlag, argv)
	}
	if strings.Contains(argv, "--ignore-rules") {
		t.Errorf("--ignore-rules must never be emitted, argv=%q", argv)
	}
	if got, want := cap.rulesText(t), renderCodexDenyRules(SafeToolDenyFloor); got != want {
		t.Errorf("skip-permissions launch must write the floor rules file.\n got:\n%s\nwant:\n%s", got, want)
	}
}

func TestParseCodexJSON_AgentMessageAndUsage(t *testing.T) {
	raw := `{"type":"thread.started","thread_id":"th_abc"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"i1","type":"command_execution"}}
{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"Here is the change."}}
{"type":"turn.completed","usage":{"input_tokens":1000,"cached_input_tokens":200,"output_tokens":50,"reasoning_output_tokens":10}}`

	text, meta := parseCodexJSON(raw)
	if text != "Here is the change." {
		t.Errorf("text = %q, want the agent_message text", text)
	}
	if meta.SessionID != "th_abc" {
		t.Errorf("SessionID = %q, want th_abc", meta.SessionID)
	}
	// reasoning_output_tokens (10) are billed as output, so they fold into the
	// output count: 50 + 10 = 60. This keeps the token-based cost estimate honest.
	if meta.InputTokens != 1000 || meta.OutputTokens != 60 {
		t.Errorf("tokens = in %d/out %d, want 1000/60 (output incl. reasoning)", meta.InputTokens, meta.OutputTokens)
	}
	// Codex's cached_input_tokens maps onto our cache-read column.
	if meta.CacheReadTokens != 200 {
		t.Errorf("CacheReadTokens = %d, want 200", meta.CacheReadTokens)
	}
	if meta.IsError {
		t.Error("IsError must be false on a clean turn.completed")
	}
}

// The LAST agent_message wins (multi-turn), mirroring the stream-json parser's
// "prefer the final result" behavior.
func TestParseCodexJSON_LastAgentMessageWins(t *testing.T) {
	raw := `{"type":"item.completed","item":{"type":"agent_message","text":"first"}}
{"type":"item.completed","item":{"type":"agent_message","text":"final"}}
{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}`
	text, _ := parseCodexJSON(raw)
	if text != "final" {
		t.Errorf("text = %q, want final", text)
	}
}

func TestParseCodexJSON_TurnFailedIsError(t *testing.T) {
	raw := `{"type":"thread.started","thread_id":"th"}
{"type":"turn.failed","error":{"message":"model overloaded"}}`
	_, meta := parseCodexJSON(raw)
	if !meta.IsError {
		t.Error("turn.failed must set IsError")
	}
}

func TestParseCodexJSON_TopLevelErrorIsError(t *testing.T) {
	raw := `{"type":"error","message":"auth failed"}`
	_, meta := parseCodexJSON(raw)
	if !meta.IsError {
		t.Error("a top-level error event must set IsError")
	}
}

// Non-JSON / empty lines are skipped; a stream with no agent_message returns
// empty text but still surfaces usage.
func TestParseCodexJSON_GarbageLinesSkipped(t *testing.T) {
	raw := `not json

{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}`
	text, meta := parseCodexJSON(raw)
	if text != "" {
		t.Errorf("text = %q, want empty (no agent_message)", text)
	}
	if meta.InputTokens != 5 {
		t.Errorf("InputTokens = %d, want 5", meta.InputTokens)
	}
}

// Execute must NOT let codex inherit stdin: stock `codex exec` (0.140.0) blocks
// reading stdin when the prompt is a positional arg, which would hang the runner
// (proven live 2026-06-16). The driver must hand it an empty, already-closed
// stdin so a `cat` of stdin returns immediately with no data.
func TestCodexCLI_Execute_ClosesStdin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fake binary is POSIX only")
	}
	dir := t.TempDir()
	fake := filepath.Join(dir, "fake-codex-stdin.sh")
	// The fake reads ALL of stdin first. If stdin were an open terminal/pipe
	// with no writer, this `cat` would block forever and the test would time
	// out. With an empty closed stdin it returns instantly. It then echoes a
	// marker proving how many bytes of stdin it saw.
	script := `#!/bin/sh
stdin_bytes=$(cat | wc -c | tr -d ' ')
cat <<EOF
{"type":"thread.started","thread_id":"th_stdin_${stdin_bytes}"}
{"type":"item.completed","item":{"type":"agent_message","text":"ok"}}
{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}
EOF
`
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake: %v", err)
	}
	scratchCodexHome(t)
	cli := &CodexCLI{CodexBin: fake}
	res, err := cli.Execute(context.Background(), "prompt", Options{})
	if err != nil {
		t.Fatalf("Execute: %v (a hang here means stdin was left open)", err)
	}
	// Empty stdin → the fake saw 0 bytes.
	if res.SessionID != "th_stdin_0" {
		t.Errorf("SessionID = %q, want th_stdin_0 (stdin must be empty/closed)", res.SessionID)
	}
}

// End-to-end through a fake `codex` binary: Execute must spawn it, parse the
// JSONL, and populate Result.
func TestCodexCLI_Execute_FakeBinary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fake binary is POSIX only")
	}
	dir := t.TempDir()
	fake := filepath.Join(dir, "fake-codex.sh")
	script := `#!/bin/sh
cat <<'EOF'
{"type":"thread.started","thread_id":"th_e2e"}
{"type":"item.completed","item":{"type":"agent_message","text":"done"}}
{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":3}}
EOF
`
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake: %v", err)
	}
	scratchCodexHome(t)
	cli := &CodexCLI{CodexBin: fake}
	res, err := cli.Execute(context.Background(), "prompt", Options{})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if res.Output != "done" {
		t.Errorf("Output = %q, want done", res.Output)
	}
	if res.SessionID != "th_e2e" {
		t.Errorf("SessionID = %q, want th_e2e", res.SessionID)
	}
	if res.InputTokens != 7 || res.OutputTokens != 3 {
		t.Errorf("tokens = %d/%d, want 7/3", res.InputTokens, res.OutputTokens)
	}
}

func TestCodexCLI_Execute_NonZeroExit(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fake binary is POSIX only")
	}
	dir := t.TempDir()
	fake := filepath.Join(dir, "fake-codex-fail.sh")
	script := `#!/bin/sh
echo '{"type":"error","message":"boom"}'
exit 7
`
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake: %v", err)
	}
	scratchCodexHome(t)
	cli := &CodexCLI{CodexBin: fake}
	res, err := cli.Execute(context.Background(), "p", Options{})
	if err == nil {
		t.Fatal("expected error on non-zero exit")
	}
	if res.ExitCode != 7 {
		t.Errorf("ExitCode = %d, want 7", res.ExitCode)
	}
}
