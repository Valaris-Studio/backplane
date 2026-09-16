// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// runCommandNever is a command runner that fails the test if doctor ever
// invokes it. Doctor is a diagnostic: the only processes it may start are the
// read-only probes each check declares, never an agent and never git mutation.
func runCommandNever(t *testing.T) commandRunner {
	t.Helper()
	return func(name string, args ...string) ([]byte, error) {
		t.Fatalf("doctor executed an unexpected command: %s %v", name, args)
		return nil, nil
	}
}

func detailFor(t *testing.T, items []checkResult, labelPrefix string) checkResult {
	t.Helper()
	for _, it := range items {
		if strings.HasPrefix(it.Label, labelPrefix) {
			return it
		}
	}
	t.Fatalf("no check labelled %q in %v", labelPrefix, items)
	return checkResult{}
}

// ---------------------------------------------------------------- agents --

func TestCheckCodingAgents_ReportsTheOnesOnPath(t *testing.T) {
	got := checkCodingAgents(fakeLookPath("codex"))

	if got.State != tui.StateOK {
		t.Errorf("one agent present must be OK, got %v (%s)", got.State, got.Detail)
	}
	// The resolvable agent is listed as present; the absent one is named too,
	// but on the "absent" side of the detail — an operator reads this to learn
	// what they could install, so it must never read as available.
	present, absent, found := strings.Cut(got.Detail, "absent:")
	if !found {
		t.Fatalf("detail should distinguish present from absent agents: %q", got.Detail)
	}
	if !strings.Contains(present, "codex") {
		t.Errorf("detail should list codex as present: %q", got.Detail)
	}
	if strings.Contains(present, "claude") {
		t.Errorf("an absent agent must not be reported as on PATH: %q", got.Detail)
	}
	if !strings.Contains(absent, "claude") {
		t.Errorf("detail should name claude as absent: %q", got.Detail)
	}
}

func TestCheckCodingAgents_FailsWhenNoneAreInstalled(t *testing.T) {
	got := checkCodingAgents(fakeLookPath())

	if got.State != tui.StateFail {
		t.Fatalf("no coding agent must FAIL, got %v", got.State)
	}
	if got.Fix == "" {
		t.Error("a failing check must carry an actionable fix hint")
	}
}

// The agent probe must read preflight's providerTools rather than carry its
// own copy, so adding a provider stays a one-place change.
func TestCheckCodingAgents_CoversEveryKnownProvider(t *testing.T) {
	got := checkCodingAgents(fakeLookPath("claude", "codex"))

	for _, pt := range providerTools {
		if !strings.Contains(got.Detail, pt.tool.bin) {
			t.Errorf("detail %q omits known provider binary %q", got.Detail, pt.tool.bin)
		}
	}
}

// ------------------------------------------------------------------- git --

func TestCheckGit_OKReportsTheVersion(t *testing.T) {
	run := func(name string, args ...string) ([]byte, error) {
		if name != "git" {
			t.Fatalf("unexpected command %q", name)
		}
		return []byte("git version 2.44.0\n"), nil
	}

	got := checkGit(fakeLookPath("git"), run)

	if got.State != tui.StateOK {
		t.Fatalf("git present must be OK, got %v (%s)", got.State, got.Detail)
	}
	if !strings.Contains(got.Detail, "2.44.0") {
		t.Errorf("detail should carry the version: %q", got.Detail)
	}
}

func TestCheckGit_FailsWhenMissing(t *testing.T) {
	got := checkGit(fakeLookPath(), runCommandNever(t))

	if got.State != tui.StateFail {
		t.Fatalf("missing git must FAIL, got %v", got.State)
	}
	if got.Fix == "" {
		t.Error("a failing git check must say how to fix it")
	}
}

// ------------------------------------------------------------------ forge --

func TestCheckForgeCLI_OKWhenAuthenticated(t *testing.T) {
	run := func(name string, args ...string) ([]byte, error) {
		return []byte("Logged in to github.com as octocat"), nil
	}

	got := checkForgeCLI(fakeLookPath("gh"), run)

	if got.State != tui.StateOK {
		t.Fatalf("authenticated gh must be OK, got %v (%s)", got.State, got.Detail)
	}
}

// An unauthenticated (or absent) gh is a WARN, never a FAIL: a gitea install
// never shells gh at all, so failing here would flunk a healthy machine.
func TestCheckForgeCLI_WarnsWhenUnauthenticated(t *testing.T) {
	run := func(name string, args ...string) ([]byte, error) {
		return []byte("You are not logged into any GitHub hosts"), errors.New("exit status 1")
	}

	got := checkForgeCLI(fakeLookPath("gh"), run)

	if got.State != tui.StateWarn {
		t.Fatalf("unauthenticated gh must WARN, got %v", got.State)
	}
	if !strings.Contains(got.Fix, "gh auth login") {
		t.Errorf("fix should name the login command: %q", got.Fix)
	}
}

func TestCheckForgeCLI_WarnsWhenAbsent(t *testing.T) {
	got := checkForgeCLI(fakeLookPath(), runCommandNever(t))

	if got.State != tui.StateWarn {
		t.Fatalf("missing gh must WARN (gitea needs no CLI), got %v", got.State)
	}
}

// ------------------------------------------------------------ credentials --

func TestCheckCredentials_OKAndNamesEachSource(t *testing.T) {
	creds := Credentials{
		APIKey: "vlr_supersecret", APIKeySource: credSourceEnv,
		APIURL: "http://localhost:8000", APIURLSource: credSourceFile,
		Workspace: "valaris", WorkspaceSource: credSourceFile,
	}

	got := checkCredentials(creds)

	if got.State != tui.StateOK {
		t.Fatalf("fully resolved credentials must be OK, got %v (%s)", got.State, got.Detail)
	}
	if !strings.Contains(got.Detail, "environment") || !strings.Contains(got.Detail, "config file") {
		t.Errorf("detail should name where each value came from: %q", got.Detail)
	}
}

// The whole point of a masked prefix is that the rest never reaches a terminal,
// a screenshot, or a pasted bug report.
func TestCheckCredentials_NeverLeaksTheKey(t *testing.T) {
	const secret = "vlr_supersecret"
	creds := Credentials{
		APIKey: secret, APIKeySource: credSourceEnv,
		APIURL:    "http://localhost:8000",
		Workspace: "valaris",
	}

	got := checkCredentials(creds)

	if strings.Contains(got.Detail+got.Fix+got.Label, secret) {
		t.Fatalf("the full key leaked into the rendered check: %+v", got)
	}
	if !strings.Contains(got.Detail, "vlr_") {
		t.Errorf("a masked prefix should still be shown for identification: %q", got.Detail)
	}
}

func TestMaskKey_ShowsAPrefixOnly(t *testing.T) {
	const secret = "vlr_abcdefghijklmnop"

	masked := maskKey(secret)

	if strings.Contains(masked, "defghijklmnop") {
		t.Fatalf("mask leaked the key body: %q", masked)
	}
	if !strings.HasPrefix(masked, "vlr_") {
		t.Errorf("mask should keep an identifying prefix: %q", masked)
	}
	if masked == secret {
		t.Errorf("mask returned the key unchanged: %q", masked)
	}
}

// A short key must not be echoed whole just because there is little to trim.
func TestMaskKey_HandlesShortAndEmptyKeys(t *testing.T) {
	if got := maskKey(""); strings.Contains(got, "…") {
		t.Errorf("an empty key should render as an absence, got %q", got)
	}
	if got := maskKey("abc"); strings.Contains(got, "abc") {
		t.Errorf("a short key must still be masked, got %q", got)
	}
}

func TestCheckCredentials_FailsWithoutAKey(t *testing.T) {
	got := checkCredentials(Credentials{APIURL: "http://localhost:8000", Workspace: "valaris"})

	if got.State != tui.StateFail {
		t.Fatalf("a missing API key must FAIL, got %v", got.State)
	}
	if !strings.Contains(got.Fix, "VALARIS_API_KEY") {
		t.Errorf("fix should name the env var: %q", got.Fix)
	}
}

func TestCheckCredentials_FailsWithoutAWorkspace(t *testing.T) {
	got := checkCredentials(Credentials{APIKey: "vlr_k", APIURL: "http://localhost:8000"})

	if got.State != tui.StateFail {
		t.Fatalf("a missing workspace must FAIL, got %v", got.State)
	}
	if !strings.Contains(got.Fix, "VALARIS_WORKSPACE") {
		t.Errorf("fix should name the env var: %q", got.Fix)
	}
}

// The defect: a user who had just run `VALARIS_API_KEY=...` in zsh WITHOUT
// export read "export VALARIS_API_KEY and VALARIS_WORKSPACE" as "you did not
// set these" — but `echo` showed the values. Doctor cannot see the parent
// shell, so the hint has to name the trap that produced the state it sees.
func TestCheckCredentials_FixNamesTheUnexportedShellTrap(t *testing.T) {
	got := checkCredentials(Credentials{APIURL: "http://localhost:8000"})

	if got.State != tui.StateFail {
		t.Fatalf("unresolved credentials must FAIL, got %v", got.State)
	}
	fix := strings.ToLower(got.Fix)
	for _, want := range []string{"export", "child process"} {
		if !strings.Contains(fix, want) {
			t.Errorf("fix must explain that an unexported assignment never reaches the runner (missing %q): %q", want, got.Fix)
		}
	}
	if !strings.Contains(got.Fix, "export VALARIS_API_KEY=") {
		t.Errorf("fix should show the correct form, not just the var name: %q", got.Fix)
	}
}

// ---------------------------------------------------------------- backend --

func TestCheckBackend_OKForAnActiveAgentKey(t *testing.T) {
	id := backendIdentity{
		UserID:    "u1",
		AgentName: "runner-1",
		IsAgent:   true,
		IsActive:  true,
		Budget:    "$8.00 of $10.00 remaining",
	}

	got := checkBackend(id, nil)

	if got.State != tui.StateOK {
		t.Fatalf("an active agent key must be OK, got %v (%s)", got.State, got.Detail)
	}
	if !strings.Contains(got.Detail, "runner-1") {
		t.Errorf("detail should name the agent: %q", got.Detail)
	}
	if !strings.Contains(got.Detail, "remaining") {
		t.Errorf("detail should carry the budget: %q", got.Detail)
	}
}

func TestCheckBackend_FailsWhenUnreachable(t *testing.T) {
	got := checkBackend(backendIdentity{}, errors.New("dial tcp: connection refused"))

	if got.State != tui.StateFail {
		t.Fatalf("an unreachable backend must FAIL, got %v", got.State)
	}
	if !strings.Contains(got.Detail, "connection refused") {
		t.Errorf("detail should carry the transport error: %q", got.Detail)
	}
}

// A plain user key authenticates fine and then silently records nothing — the
// exact failure mode validateLoopAgentID exists to prevent, so doctor must
// warn loudly rather than report a clean bill of health.
func TestCheckBackend_WarnsOnAPlainUserKey(t *testing.T) {
	got := checkBackend(backendIdentity{UserID: "u1", IsAgent: false}, nil)

	if got.State != tui.StateWarn {
		t.Fatalf("a user key must WARN, got %v", got.State)
	}
	if !strings.Contains(strings.ToLower(got.Detail+got.Fix), "agent key") {
		t.Errorf("the warning should name the agent-key remedy: %q / %q", got.Detail, got.Fix)
	}
}

// Without a key there is nothing to authenticate WITH, so the backend row must
// say it was skipped rather than blame the network — the credentials row is
// already carrying the real problem.
func TestCheckBackend_ReportsSkippedRatherThanUnreachableWithoutAKey(t *testing.T) {
	got := checkBackend(backendIdentity{}, errSkippedNoAPIKey)

	if got.State != tui.StateFail {
		t.Fatalf("an unverifiable backend must still FAIL, got %v", got.State)
	}
	if strings.Contains(strings.ToLower(got.Detail), "could not authenticate") {
		t.Errorf("a skipped check must not read as an auth failure: %q", got.Detail)
	}
	if !strings.Contains(strings.ToLower(got.Detail), "skipped") {
		t.Errorf("detail should say the check was skipped: %q", got.Detail)
	}
}

func TestCheckBackend_FailsOnADeactivatedAgent(t *testing.T) {
	got := checkBackend(backendIdentity{AgentName: "retired", IsAgent: true, IsActive: false}, nil)

	if got.State != tui.StateFail {
		t.Fatalf("a deactivated agent must FAIL, got %v", got.State)
	}
}

// resolveBackendIdentity is the only place doctor touches the network; it must
// translate a client into the flat struct the pure check consumes.
func TestResolveBackendIdentity_MapsAnAgentClient(t *testing.T) {
	budget := 10.0
	remaining := 8.0
	client := &valaris.Client{
		UserID: "u1",
		Agent:  &valaris.AgentConfig{ID: "a1", Name: "runner-1", IsActive: true},
	}

	id := backendIdentityFrom(client, &valaris.BudgetStatus{BudgetUSD: &budget, RemainingUSD: &remaining, SpentUSD: 2})

	if !id.IsAgent || !id.IsActive || id.AgentName != "runner-1" {
		t.Fatalf("agent client mapped wrong: %+v", id)
	}
	if !strings.Contains(id.Budget, "8.00") {
		t.Errorf("budget should render remaining: %q", id.Budget)
	}
}

func TestResolveBackendIdentity_MapsAUserClient(t *testing.T) {
	id := backendIdentityFrom(&valaris.Client{UserID: "u1"}, nil)

	if id.IsAgent {
		t.Fatalf("a client with no agent is not an agent key: %+v", id)
	}
	if id.Budget != "" {
		t.Errorf("no budget is reportable without an agent: %q", id.Budget)
	}
}

// -------------------------------------------------------------------- mcp --

func TestCheckMCPConfig_OKForParseableJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp-config.json")
	if err := os.WriteFile(path, []byte(`{"mcpServers":{"valaris":{"command":"backplane-mcp"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	got := checkMCPConfig(path)

	if got.State != tui.StateOK {
		t.Fatalf("a valid MCP config must be OK, got %v (%s)", got.State, got.Detail)
	}
	if !strings.Contains(got.Detail, path) {
		t.Errorf("detail should name the file in effect: %q", got.Detail)
	}
}

func TestCheckMCPConfig_FailsWhenUndiscovered(t *testing.T) {
	got := checkMCPConfig("")

	if got.State != tui.StateFail {
		t.Fatalf("no MCP config must FAIL — config.Load requires one, got %v", got.State)
	}
	if !strings.Contains(got.Fix, mcpConfigFilenames[0]) {
		t.Errorf("fix should name the file to create: %q", got.Fix)
	}
}

func TestCheckMCPConfig_FailsWhenAbsentFromDisk(t *testing.T) {
	got := checkMCPConfig(filepath.Join(t.TempDir(), "absent.json"))

	if got.State != tui.StateFail {
		t.Fatalf("a missing MCP config file must FAIL, got %v", got.State)
	}
}

func TestCheckMCPConfig_FailsOnMalformedJSON(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mcp-config.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}

	got := checkMCPConfig(path)

	if got.State != tui.StateFail {
		t.Fatalf("malformed JSON must FAIL, got %v", got.State)
	}
	if !strings.Contains(strings.ToLower(got.Detail), "json") {
		t.Errorf("detail should say the file does not parse: %q", got.Detail)
	}
}

// The defect: mcpConfigFilenames included the committed .example.json
// template, so discovery found it in EVERY checkout and doctor went green on a
// placeholder — then the runner failed at runtime against an unconfigured MCP
// server. A diagnostic that passes on a template is worse than one that fails.
func TestCheckMCPConfig_TemplateWarnsInsteadOfPassing(t *testing.T) {
	const realConfig = `{"mcpServers":{"valaris":{"command":"backplane-mcp"}}}`

	tests := []struct {
		name     string
		filename string
		want     tui.CheckState
	}{
		{"a real config passes", "mcp-config.json", tui.StateOK},
		{"only the template is a warning", "mcp-config.example.json", tui.StateWarn},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), tt.filename)
			if err := os.WriteFile(path, []byte(realConfig), 0o600); err != nil {
				t.Fatal(err)
			}

			got := checkMCPConfig(path)

			if got.State != tt.want {
				t.Fatalf("%s = %v, want %v (%s)", tt.filename, got.State, tt.want, got.Detail)
			}
		})
	}

	// Neither file present is the third arm of the table — the FAIL that
	// TestCheckMCPConfig_FailsWhenUndiscovered already pins.
	if got := checkMCPConfig(""); got.State != tui.StateFail {
		t.Errorf("no config at all must FAIL, got %v", got.State)
	}
}

// The template must never be reported as a working config, whatever it
// contains — its name alone disqualifies it.
func TestCheckMCPConfig_ExampleFilenameNeverYieldsOK(t *testing.T) {
	path := filepath.Join(t.TempDir(), mcpConfigTemplateFilename)
	if err := os.WriteFile(path, []byte(`{"mcpServers":{"valaris":{"command":"backplane-mcp"}}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	got := checkMCPConfig(path)

	if got.State == tui.StateOK {
		t.Fatalf("the example template must never pass, got OK (%s)", got.Detail)
	}
	if !strings.Contains(strings.ToLower(got.Detail), "template") {
		t.Errorf("detail must name it as a template, not just echo the path: %q", got.Detail)
	}
	if !strings.Contains(got.Fix, mcpConfigFilenames[0]) {
		t.Errorf("fix must tell the operator to copy it to %s: %q", mcpConfigFilenames[0], got.Fix)
	}
}

// A template left at its shipped placeholders is the common case, and saying so
// beats "this is a template" in the abstract.
func TestCheckMCPConfig_TemplateNamesItsUnfilledPlaceholders(t *testing.T) {
	path := filepath.Join(t.TempDir(), mcpConfigTemplateFilename)
	shipped := `{"mcpServers":{"valaris":{"command":"bash","args":["/path/to/backplane/mcp-server/run.sh"],` +
		`"env":{"VALARIS_API_KEY":"vlr_your_agent_key_here"}}}}`
	if err := os.WriteFile(path, []byte(shipped), 0o600); err != nil {
		t.Fatal(err)
	}

	got := checkMCPConfig(path)

	if got.State != tui.StateWarn {
		t.Fatalf("an unfilled template must WARN, got %v (%s)", got.State, got.Detail)
	}
	if !strings.Contains(strings.ToLower(got.Detail), "placeholder") {
		t.Errorf("detail should report the unfilled placeholders it found: %q", got.Detail)
	}
}

// --------------------------------------------------------------- base dir --

func TestCheckWorkDir_OKOutsideAnyWorktree(t *testing.T) {
	got := checkWorkDir(filepath.Join(t.TempDir(), "repos"))

	if got.State != tui.StateOK {
		t.Fatalf("a dir outside any worktree must be OK, got %v (%s)", got.State, got.Detail)
	}
}

// SAFETY-CRITICAL: a base_dir inside a worktree is how a runner once rewound
// the live repo and took 25 commits with it. Doctor must FAIL and say why.
func TestCheckWorkDir_FailsInsideAGitWorktree(t *testing.T) {
	worktree := t.TempDir()
	if out, err := exec.Command("git", "init", worktree).CombinedOutput(); err != nil {
		t.Skipf("git init unavailable: %v (%s)", err, out)
	}

	got := checkWorkDir(filepath.Join(worktree, "repos"))

	if got.State != tui.StateFail {
		t.Fatalf("a base_dir inside a worktree must FAIL, got %v (%s)", got.State, got.Detail)
	}
	if !strings.Contains(got.Detail, "worktree") {
		t.Errorf("detail must explain the worktree hazard: %q", got.Detail)
	}
}

func TestCheckWorkDir_FailsWhenEmpty(t *testing.T) {
	if got := checkWorkDir(""); got.State != tui.StateFail {
		t.Fatalf("an empty base_dir must FAIL, got %v", got.State)
	}
}

// Doctor is read-only: probing the work dir must not create it.
func TestCheckWorkDir_DoesNotCreateTheDirectory(t *testing.T) {
	path := filepath.Join(t.TempDir(), "repos")

	checkWorkDir(path)

	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("doctor created %s — it must be strictly read-only", path)
	}
}

// ------------------------------------------------------------- aggregate --

func TestDoctorExitCode_FailsOnAnyFail(t *testing.T) {
	results := []checkResult{
		{Label: "a", State: tui.StateOK},
		{Label: "b", State: tui.StateWarn},
		{Label: "c", State: tui.StateFail},
	}

	if got := doctorExitCode(results); got != 1 {
		t.Errorf("a FAIL must exit 1, got %d", got)
	}
}

func TestDoctorExitCode_ZeroWhenOnlyWarnings(t *testing.T) {
	results := []checkResult{
		{Label: "a", State: tui.StateOK},
		{Label: "b", State: tui.StateWarn},
	}

	if got := doctorExitCode(results); got != 0 {
		t.Errorf("warnings alone must exit 0, got %d", got)
	}
}

func TestSummarize_CountsEachState(t *testing.T) {
	results := []checkResult{
		{State: tui.StateOK}, {State: tui.StateOK},
		{State: tui.StateWarn},
		{State: tui.StateFail},
	}

	ok, warn, fail := summarize(results)

	if ok != 2 || warn != 1 || fail != 1 {
		t.Errorf("summarize = %d/%d/%d, want 2/1/1", ok, warn, fail)
	}
}

// runChecks is the whole diagnostic composed over injected deps. It must run
// every check even when the earlier ones fail — a broken machine is exactly
// when the operator needs the full picture.
func TestRunChecks_ReportsEveryCheckOnATotallyBrokenMachine(t *testing.T) {
	deps := doctorDeps{
		LookPath: fakeLookPath(),
		Run:      func(string, ...string) ([]byte, error) { return nil, errors.New("nope") },
		Creds:    Credentials{},
		BaseDir:  "",
		Identity: backendIdentity{},
		InitErr:  errors.New("connection refused"),
	}

	results := runChecks(deps)

	if len(results) < 7 {
		t.Fatalf("every check must report, got %d: %+v", len(results), results)
	}
	for _, r := range results {
		if r.Label == "" {
			t.Errorf("a check reported without a label: %+v", r)
		}
		if r.State != tui.StateOK && r.Fix == "" {
			t.Errorf("check %q is not-OK but carries no fix hint", r.Label)
		}
	}
	if doctorExitCode(results) != 1 {
		t.Error("a broken machine must exit non-zero")
	}
}

func TestRunChecks_HealthyMachinePasses(t *testing.T) {
	// A healthy machine's mcp-config carries a live agent key — the agent-key
	// probe rightly FAILs the empty `{"mcpServers":{}}` shell this fixture
	// used to hold.
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"id":"u-agent"}`)
	}))
	defer backend.Close()

	mcpPath := filepath.Join(t.TempDir(), "mcp-config.json")
	mcpConfig := fmt.Sprintf(
		`{"mcpServers":{"valaris":{"command":"uvx","args":["backplane-mcp"],"env":{"VALARIS_API_KEY":"vlr_agent_key","VALARIS_API_URL":%q}}}}`,
		backend.URL)
	if err := os.WriteFile(mcpPath, []byte(mcpConfig), 0o600); err != nil {
		t.Fatal(err)
	}

	deps := doctorDeps{
		LookPath: fakeLookPath("claude", "codex", "git", "gh"),
		Run:      func(string, ...string) ([]byte, error) { return []byte("git version 2.44.0"), nil },
		Creds: Credentials{
			APIKey: "vlr_key", APIKeySource: credSourceEnv,
			APIURL: "http://localhost:8000", APIURLSource: credSourceEnv,
			Workspace: "valaris", WorkspaceSource: credSourceEnv,
			MCPConfigPath: mcpPath,
		},
		BaseDir:  filepath.Join(t.TempDir(), "repos"),
		Identity: backendIdentity{UserID: "u1", AgentName: "runner-1", IsAgent: true, IsActive: true},
	}

	results := runChecks(deps)

	for _, r := range results {
		if r.State == tui.StateFail {
			t.Errorf("healthy machine reported a FAIL: %q — %s", r.Label, r.Detail)
		}
	}
	if got := doctorExitCode(results); got != 0 {
		t.Errorf("a healthy machine must exit 0, got %d", got)
	}
}

// Doctor must never spend money: no check may reach for a coding agent binary
// beyond resolving it on PATH.
func TestRunChecks_NeverExecutesACodingAgent(t *testing.T) {
	deps := doctorDeps{
		LookPath: fakeLookPath("claude", "codex", "git", "gh"),
		Run: func(name string, args ...string) ([]byte, error) {
			for _, pt := range providerTools {
				if name == pt.tool.bin {
					t.Fatalf("doctor executed the coding agent %q %v — it must never spend", name, args)
				}
			}
			return []byte("ok"), nil
		},
		Creds:    Credentials{APIKey: "vlr_k", Workspace: "ws", APIURL: "http://x"},
		BaseDir:  t.TempDir(),
		Identity: backendIdentity{IsAgent: true, IsActive: true, AgentName: "a"},
	}

	runChecks(deps)
}

// The rendered report must be printable text carrying every label, and must
// never contain the API key.
func TestRenderDoctorReport_ShowsEveryCheckAndNoSecret(t *testing.T) {
	defer tui.ForcePlain()()

	const secret = "vlr_supersecret"
	results := []checkResult{
		{Label: "coding agents", State: tui.StateOK, Detail: "claude, codex"},
		{Label: "credentials", State: tui.StateOK, Detail: "key " + maskKey(secret)},
		{Label: "work dir", State: tui.StateFail, Detail: "inside a worktree", Fix: "point it elsewhere"},
	}

	out := renderDoctorReport(results, 80)

	for _, r := range results {
		if !strings.Contains(out, r.Label) {
			t.Errorf("report omits %q:\n%s", r.Label, out)
		}
	}
	if !strings.Contains(out, "point it elsewhere") {
		t.Errorf("report omits the fix hint for a failing check:\n%s", out)
	}
	if strings.Contains(out, secret) {
		t.Fatalf("the report leaked the API key:\n%s", out)
	}
}

func TestRenderDoctorReport_StatesTheVerdictCounts(t *testing.T) {
	defer tui.ForcePlain()()

	out := renderDoctorReport([]checkResult{
		{Label: "a", State: tui.StateOK},
		{Label: "b", State: tui.StateWarn, Fix: "x"},
		{Label: "c", State: tui.StateFail, Fix: "y"},
	}, 80)

	for _, want := range []string{"1 ok", "1 warning", "1 failed"} {
		if !strings.Contains(out, want) {
			t.Errorf("verdict line should contain %q:\n%s", want, out)
		}
	}
}

func TestRenderFixes_HangsContinuationsUnderTheArrow(t *testing.T) {
	results := []checkResult{{
		Label: "credentials",
		State: tui.StateFail,
		Fix:   "export VALARIS_API_KEY and VALARIS_WORKSPACE, or set them in a runner.yaml the runner can find",
	}}

	lines := strings.Split(renderFixes(results, 40), "\n")
	if len(lines) < 2 {
		t.Fatalf("expected the fix to wrap, got %q", lines)
	}
	for _, l := range lines[1:] {
		if !strings.HasPrefix(l, fixHangingIndent) {
			t.Errorf("continuation %q should be indented:\n%s", l, strings.Join(lines, "\n"))
		}
	}
	for _, l := range lines {
		if lipgloss.Width(l) > 40 && len(strings.Fields(l)) > 1 {
			t.Errorf("line exceeds the wrap width: %q", l)
		}
	}
}

// -------------------------------------------------------------- dispatch --

// The defect this whole change closes: ModeDoctor fell into the default arm
// and started the pipeline, spending real money for someone who asked to
// CHECK their setup.
func TestModeAction_DoctorNeverReachesThePipeline(t *testing.T) {
	if got := modeAction(tui.ModeDoctor); got != actionDoctor {
		t.Fatalf("ModeDoctor routed to %v, want actionDoctor", got)
	}
	if modeAction(tui.ModeDoctor) == actionPipeline {
		t.Fatal("ModeDoctor must never start the pipeline")
	}
}

func TestModeAction_RoutesEveryKnownMode(t *testing.T) {
	tests := []struct {
		mode tui.Mode
		want modeActionKind
	}{
		{tui.ModeDiscovery, actionDiscovery},
		{tui.ModeLoop, actionLoop},
		{tui.ModePipeline, actionPipeline},
		{tui.ModeDoctor, actionDoctor},
	}

	for _, tt := range tests {
		if got := modeAction(tt.mode); got != tt.want {
			t.Errorf("modeAction(%q) = %v, want %v", tt.mode, got, tt.want)
		}
	}
}

// An unknown mode must be a loud error, never a silent fall-through into the
// mode that spends money.
func TestModeAction_UnknownModeIsNotAnExecutableAction(t *testing.T) {
	got := modeAction(tui.Mode("teleport"))

	if got != actionUnknown {
		t.Fatalf("an unknown mode routed to %v, want actionUnknown", got)
	}
}

// Doctor is the one mode that must still run when the config is unusable —
// diagnosing that is its entire job.
func TestModeActionNeedsValidConfig(t *testing.T) {
	if modeAction(tui.ModeDoctor).needsValidConfig() {
		t.Error("doctor must run without a valid config — that is what it diagnoses")
	}
	for _, m := range []tui.Mode{tui.ModeLoop, tui.ModePipeline, tui.ModeDiscovery} {
		if !modeAction(m).needsValidConfig() {
			t.Errorf("%q must not start without a valid config", m)
		}
	}
}

// ----------------------------------------------------- headless -doctor --

// A -doctor run given an explicit --config must report on THAT config, not on
// whatever runner.yaml happens to sit in the CWD.
func TestDoctorCredentials_PrefersTheLoadedConfig(t *testing.T) {
	t.Setenv("VALARIS_API_KEY", "")
	t.Setenv("VALARIS_API_URL", "")
	t.Setenv("VALARIS_WORKSPACE", "")

	cfg := config.Defaults()
	cfg.Valaris.APIKey = "vlr_fromconfig"
	cfg.Valaris.APIURL = "http://config-url"
	cfg.Valaris.WorkspaceSlug = "config-workspace"
	cfg.LLM.MCPConfigPath = "/tmp/from-config-mcp.json"

	got := doctorCredentials(cfg, "", t.TempDir(), t.TempDir())

	if got.APIKey != "vlr_fromconfig" || got.APIKeySource != credSourceFile {
		t.Errorf("api key = %q from %v, want the loaded config", got.APIKey, got.APIKeySource)
	}
	if got.Workspace != "config-workspace" {
		t.Errorf("workspace = %q, want the loaded config's", got.Workspace)
	}
	if got.MCPConfigPath != "/tmp/from-config-mcp.json" {
		t.Errorf("mcp path = %q, want the loaded config's", got.MCPConfigPath)
	}
}

// config.Load REJECTS a config whose base_dir sits inside a worktree — the
// exact defect doctor is supposed to name. Discarding the file's contents on
// that error would make doctor report the default work dir and no credentials,
// diagnosing a machine the operator never asked about.
func TestDoctorConfigForReport_FallsBackToTheRawFileWhenLoadRejectsIt(t *testing.T) {
	t.Setenv("VALARIS_API_KEY", "")
	t.Setenv("VALARIS_WORKSPACE", "")

	dir := t.TempDir()
	if out, err := exec.Command("git", "init", dir).CombinedOutput(); err != nil {
		t.Skipf("git init unavailable: %v (%s)", err, out)
	}
	path := filepath.Join(dir, "runner.yaml")
	if err := os.WriteFile(path, []byte(
		"valaris:\n  api_key: \"vlr_fromfile\"\n  workspace_slug: \"file-ws\"\nllm:\n  mcp_config_path: \"mcp-config.json\"\ngit:\n  base_dir: \"./repos\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	cfg := doctorConfigForReport(path)
	if cfg == nil {
		t.Fatal("a rejected config must still be reported on, got nil")
	}

	creds := doctorCredentials(cfg, path, t.TempDir(), t.TempDir())
	if creds.APIKey != "vlr_fromfile" || creds.Workspace != "file-ws" {
		t.Errorf("the operator's own config should supply the credentials: %+v", creds)
	}

	// And the work-dir check must name the worktree hazard rather than passing
	// on some unrelated default.
	got := checkWorkDir(cfg.Git.BaseDir)
	if got.State != tui.StateFail {
		t.Fatalf("the rejected base_dir must FAIL, got %v (%s)", got.State, got.Detail)
	}
	if !strings.Contains(got.Detail, "worktree") {
		t.Errorf("detail should name the worktree hazard: %q", got.Detail)
	}
}

// With no loadable config, doctor still reports on whatever the environment
// and the conventional paths yield — that is the machine's real state.
func TestDoctorCredentials_FallsBackToDiscoveryWithoutAConfig(t *testing.T) {
	t.Setenv("VALARIS_API_KEY", "vlr_fromenv")
	t.Setenv("VALARIS_WORKSPACE", "env-workspace")

	got := doctorCredentials(nil, "", t.TempDir(), t.TempDir())

	if got.APIKey != "vlr_fromenv" || got.APIKeySource != credSourceEnv {
		t.Errorf("api key = %q from %v, want the env", got.APIKey, got.APIKeySource)
	}
}

var _ = context.Background

// ------------------------------------------------------------ toolsets --
//
// The MCP server scopes its surface with VALARIS_MCP_TOOLSETS (unset = the
// interactive default hand, which omits the autonomous-operations tools:
// enqueue_pr_for_merge, list_skills/get_skill, the approvals tools). Runner
// launches pin it to "all" on the fly, but the loop pre-flight spawns the
// server from the static template's env verbatim, and anything else that
// spawns from the template gets the clipped hand — so a template left on the
// default hand under-reports the surface a launch actually gets. Doctor reads
// the template and reports the setting, statically, without spawning anything.

// writeMCPConfigWithEnv writes a real (non-template-named) mcp-config whose
// valaris entry carries exactly the given env block.
func writeMCPConfigWithEnv(t *testing.T, env string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "mcp-config.json")
	doc := `{"mcpServers":{"valaris":{"command":"uvx","args":["backplane-mcp"],"env":{` + env + `}}}}`
	if err := os.WriteFile(path, []byte(doc), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestCheckMCPToolsets_OKWhenTemplatePinsAll(t *testing.T) {
	path := writeMCPConfigWithEnv(t, `"VALARIS_API_KEY":"vlr_agent_key","VALARIS_MCP_TOOLSETS":"all"`)

	got := checkMCPToolsets(path)

	if !strings.Contains(strings.ToLower(got.Label), "toolsets") {
		t.Fatalf("the row must be legible as the toolsets check on its own, got label %q", got.Label)
	}
	if got.State != tui.StateOK {
		t.Fatalf("a template pinned to all must be OK, got %v (%s)", got.State, got.Detail)
	}
	if !strings.Contains(got.Detail, "all") {
		t.Errorf("detail should report the value in effect: %q", got.Detail)
	}
}

func TestCheckMCPToolsets_WarnsWhenUnset(t *testing.T) {
	path := writeMCPConfigWithEnv(t, `"VALARIS_API_KEY":"vlr_agent_key"`)

	got := checkMCPToolsets(path)

	if !strings.Contains(strings.ToLower(got.Label), "toolsets") {
		t.Fatalf("the row must be legible as the toolsets check on its own, got label %q", got.Label)
	}
	if got.State != tui.StateWarn {
		t.Fatalf("an unset toolsets key must WARN — the server falls back to the default hand, got %v (%s)", got.State, got.Detail)
	}
	detail := strings.ToLower(got.Detail)
	if !strings.Contains(detail, "default") {
		t.Errorf("detail must say the server will serve the default hand: %q", got.Detail)
	}
	if !strings.Contains(detail, "all") {
		t.Errorf("detail must say runner stages need all: %q", got.Detail)
	}
	// The consequence has to be legible in the row itself: the default hand
	// clips the autonomous-operations grants, not the loop's off-switch.
	if !strings.Contains(detail, "enqueue_pr_for_merge") {
		t.Errorf("detail must name what the default hand clips (e.g. enqueue_pr_for_merge): %q", got.Detail)
	}
	if !strings.Contains(got.Fix, "VALARIS_MCP_TOOLSETS") {
		t.Errorf("fix must name the env key to set: %q", got.Fix)
	}
}

// An explicit narrowing is a deliberate operator choice, but it still clips
// the loop pre-flight — so it is reported like unset, with the value named.
func TestCheckMCPToolsets_WarnsWhenNarrowed(t *testing.T) {
	path := writeMCPConfigWithEnv(t, `"VALARIS_API_KEY":"vlr_agent_key","VALARIS_MCP_TOOLSETS":"default"`)

	got := checkMCPToolsets(path)

	if got.State != tui.StateWarn {
		t.Fatalf("a template narrowed to the default hand must WARN, got %v (%s)", got.State, got.Detail)
	}
	if !strings.Contains(got.Detail, "default") {
		t.Errorf("detail should report the narrowed value: %q", got.Detail)
	}
	if got.Fix == "" {
		t.Error("a not-OK row must carry a fix hint")
	}
}

// With no readable config there is nothing to judge; the "mcp config" row
// already FAILs that. This row must still not go green, and must carry a fix
// like every other not-OK row (the runChecks invariant).
func TestCheckMCPToolsets_NotOKWithoutAConfig(t *testing.T) {
	for _, path := range []string{"", filepath.Join(t.TempDir(), "absent.json")} {
		got := checkMCPToolsets(path)
		if got.State == tui.StateOK {
			t.Errorf("path %q: no config to read must not be OK (%s)", path, got.Detail)
		}
		if got.Fix == "" {
			t.Errorf("path %q: a not-OK row must carry a fix hint", path)
		}
	}
}

// The row is part of the standard report, not an opt-in: an operator whose
// template silently serves the default hand finds out from doctor.
func TestRunChecks_ReportsMCPToolsetsRow(t *testing.T) {
	path := writeMCPConfigWithEnv(t, `"VALARIS_API_KEY":"vlr_agent_key","VALARIS_API_URL":"http://runner-own-backend.invalid"`)

	results := runChecks(mcpProbeDeps(t, path))

	var row *checkResult
	for i := range results {
		if strings.Contains(strings.ToLower(results[i].Label), "toolsets") {
			row = &results[i]
			break
		}
	}
	if row == nil {
		t.Fatalf("runChecks must report an mcp toolsets row, got %+v", results)
	}
	if row.State != tui.StateWarn {
		t.Errorf("template without VALARIS_MCP_TOOLSETS must WARN in the report, got %v (%s)", row.State, row.Detail)
	}
}
