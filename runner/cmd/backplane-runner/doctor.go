// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
	"github.com/Valaris-Studio/backplane/runner/internal/workloop"
)

// Doctor answers one question — "would a runner work on this machine?" — and
// answers it WITHOUT becoming one. It is strictly read-only: it resolves
// binaries on PATH, reads two files, and makes the same identity/budget GETs
// the wizard's connect step already makes. It never clones, never mutates a
// repository, and never executes a coding agent, because the operator who
// picked it asked to check their setup, not to spend money.

// checkResult is one diagnostic row. Fix is the actionable remedy, required on
// anything that is not OK — a diagnostic that only says "broken" wastes the
// trip.
type checkResult struct {
	Label  string
	Detail string
	Fix    string
	State  tui.CheckState
}

// commandRunner runs a read-only probe and returns its combined output. Every
// doctor probe is injected through this seam so tests drive each branch with
// zero real process execution.
type commandRunner func(name string, args ...string) ([]byte, error)

// doctorDeps is the whole outside world doctor touches, gathered up front so
// the checks themselves stay pure. Identity/InitErr are resolved before the
// checks run because that is the only network call in the set.
type doctorDeps struct {
	LookPath func(string) (string, error)
	Run      commandRunner
	Creds    Credentials
	BaseDir  string
	Identity backendIdentity
	InitErr  error
	// StageGrants are the workspace pipeline's per-stage MCP tool grants and
	// ServedMCP the catalog the configured MCP server answered tools/list
	// with; nil ServedMCP means the server was not (or could not be) probed.
	StageGrants []stageGrant
	ServedMCP   []workloop.ServedMCPTool
}

// stageGrant is one pipeline stage's MCP tool names: its llm.tools allowlist
// plus every `mcp_call` lifecycle step's tool. Both are stored config that
// outlives a server upgrade, which is why the doctor reads them.
type stageGrant struct {
	Role  string
	Tools []string
}

// stageGrantsFrom flattens the platform config's pipeline stages; nil when
// the workspace has no pipeline config to read.
func stageGrantsFrom(platform *valaris.PlatformConfig) []stageGrant {
	if platform == nil || platform.WorkspaceConfig.PipelineConfig == nil {
		return nil
	}
	var grants []stageGrant
	for _, stage := range platform.WorkspaceConfig.PipelineConfig.Stages {
		tools := append([]string(nil), stage.LLM.Tools...)
		for _, step := range stage.Lifecycle {
			if step.Kind != "mcp_call" {
				continue
			}
			if tool, _ := step.Params["tool"].(string); tool != "" {
				tools = append(tools, tool)
			}
		}
		grants = append(grants, stageGrant{Role: stage.Role, Tools: tools})
	}
	return grants
}

// backendIdentity is the flattened answer to "who is this API key?", so the
// check that judges it needs no live client.
type backendIdentity struct {
	UserID    string
	AgentName string
	IsAgent   bool
	IsActive  bool
	Budget    string
}

// errSkippedNoAPIKey marks the backend check as unrun rather than failed:
// there was no credential to attempt it with.
var errSkippedNoAPIKey = errors.New("no API key resolved")

// runDoctor gathers the machine's state and renders the verdict. It returns an
// exit code rather than calling os.Exit so both the wizard and the -doctor flag
// can decide what to do with it.
func runDoctor(ctx context.Context, cfg *config.Config, creds Credentials) int {
	code, _ := runDoctorChecks(ctx, cfg, creds)
	return code
}

// runDoctorChecks is runDoctor with the results handed back, so a caller that
// wants to say more about them (the wizard's next-step line) does not have to
// re-run every probe to find out what they were.
func runDoctorChecks(ctx context.Context, cfg *config.Config, creds Credentials) (int, []checkResult) {
	return runDoctorChecksWithOverride(ctx, cfg, creds, nil)
}

// runDoctorChecksWithOverride is runDoctorChecks with one row replaced by a
// result the caller already computed. -fix uses it so the report shows the
// remedy that accounts for its write attempt, rather than the generic one a
// second, fix-unaware re-check would produce.
func runDoctorChecksWithOverride(ctx context.Context, cfg *config.Config, creds Credentials, override *checkResult) (int, []checkResult) {
	results := replaceCheck(gatherDoctorChecks(ctx, cfg, creds), override)
	fmt.Println(renderDoctorReport(results, doctorReportWidth))
	return doctorExitCode(results), results
}

// gatherDoctorChecks runs every probe and returns the raw rows without
// printing anything — the seam that lets the wizard render the same diagnosis
// inside its own screen instead of on a torn-down terminal.
func gatherDoctorChecks(ctx context.Context, cfg *config.Config, creds Credentials) []checkResult {
	deps := doctorDeps{
		LookPath: execLookPath,
		Run:      combinedOutput,
		Creds:    creds,
		BaseDir:  doctorBaseDir(cfg),
	}
	// A config broken enough to have no key still gets a full report — the
	// credentials check is the thing that names the problem.
	if creds.APIKey != "" {
		client := valaris.NewClient(creds.APIURL, creds.APIKey)
		if err := client.Init(ctx); err != nil {
			deps.InitErr = err
		} else {
			budget, _ := client.GetBudgetStatus(ctx)
			deps.Identity = backendIdentityFrom(client, budget)
			// Best-effort: a workspace without a pipeline config, or a key
			// that cannot read it, simply yields no grants to judge.
			if platform, err := client.GetPlatformConfig(ctx, creds.Workspace); err == nil {
				deps.StageGrants = stageGrantsFrom(platform)
			}
		}
	} else {
		deps.InitErr = errSkippedNoAPIKey
	}
	// The served catalog is only worth a spawn when there are grants to hold
	// against it; an unprobed server produces no row (see checkMCPDeprecatedGrants).
	if len(deps.StageGrants) > 0 && creds.MCPConfigPath != "" {
		if served, err := workloop.ServedMCPCatalog(ctx, creds.MCPConfigPath); err == nil {
			deps.ServedMCP = served
		}
	}
	results := runChecks(deps)
	return append(results, checkCompletionResume(ctx, cfg, creds), checkCompletionWorkflow(ctx, cfg, creds, deps.LookPath, workloop.PreflightCompletionMCP))
}

// wizardDoctorReport shapes the diagnosis for the wizard's in-TUI doctor
// screen: same checks, same verdict wording, no printing.
func wizardDoctorReport(ctx context.Context, creds Credentials) tui.DoctorReport {
	results := gatherDoctorChecks(ctx, nil, creds)
	_, warn, fail := summarize(results)
	report := tui.DoctorReport{Verdict: doctorVerdict(results), Failed: fail, Warned: warn}
	for _, r := range results {
		report.Checks = append(report.Checks, tui.DoctorCheck{
			Label: r.Label, Detail: r.Detail, Fix: r.Fix, State: r.State,
		})
	}
	return report
}

// replaceCheck swaps in the caller's result for the row with the same label,
// leaving check ORDER intact so the report reads the same either way.
func replaceCheck(results []checkResult, override *checkResult) []checkResult {
	if override == nil {
		return results
	}
	for i, r := range results {
		if r.Label == override.Label {
			results[i] = *override
			break
		}
	}
	return results
}

// doctorConfigForReport resolves the config the report should describe.
//
// config.Load VALIDATES, and the states it rejects — a base_dir inside a
// worktree, a missing key — are precisely what doctor is asked to name.
// Returning nil on that error would silently swap the operator's config for
// the built-in defaults and diagnose a machine nobody asked about, so a
// rejected file is re-read unvalidated instead. Only a file that cannot be
// read or parsed at all yields nil.
func doctorConfigForReport(configPath string) *config.Config {
	if cfg, err := config.Load(configPath); err == nil {
		return cfg
	}
	if configPath == "" {
		return nil
	}

	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil
	}
	cfg := config.Defaults()
	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil
	}
	// Load would have anchored relative paths against the config's directory;
	// the checks compare real paths, so do the same anchoring here.
	configDir := filepath.Dir(configPath)
	cfg.Git.BaseDir = resolveDoctorPath(configDir, cfg.Git.BaseDir)
	cfg.LLM.MCPConfigPath = resolveDoctorPath(configDir, cfg.LLM.MCPConfigPath)
	return cfg
}

// resolveDoctorPath anchors a config-relative path against the config's own
// directory, matching config.Load, so the runner's clone root does not move
// with the process CWD.
func resolveDoctorPath(configDir, path string) string {
	if path == "" || filepath.IsAbs(path) {
		return path
	}
	return filepath.Join(configDir, path)
}

// doctorCredentials picks what the report describes. A config the operator
// named on the command line is authoritative — reporting on a stray runner.yaml
// in the CWD instead would diagnose a machine they did not ask about. Without
// a loadable config, discovery over env + conventional paths is the honest
// picture of what a bare invocation would find.
func doctorCredentials(cfg *config.Config, configPath, homeDir, workDir string) Credentials {
	discovered := resolveCredentials(homeDir, configCandidatePaths(homeDir, workDir))
	// Discovery attributes a config file only when it supplied a credential,
	// so env-exported creds leave ConfigPath empty — and the drift check loses
	// the profile directory it keys off. The operator's -config yaml is known
	// the whole time; carry it regardless of where the credentials came from.
	if configPath != "" {
		discovered.ConfigPath = configPath
	}
	if cfg == nil {
		return discovered
	}

	creds := Credentials{
		APIKey:        cfg.Valaris.APIKey,
		APIURL:        cfg.Valaris.APIURL,
		Workspace:     cfg.Valaris.WorkspaceSlug,
		MCPConfigPath: cfg.LLM.MCPConfigPath,
		ConfigPath:    discovered.ConfigPath,
	}
	// config.Load already merged env over file, so the surviving value's origin
	// is whichever of the two supplied it.
	creds.APIKeySource = sourceOf(creds.APIKey, discovered.APIKey, discovered.APIKeySource)
	creds.APIURLSource = sourceOf(creds.APIURL, discovered.APIURL, discovered.APIURLSource)
	creds.WorkspaceSource = sourceOf(creds.Workspace, discovered.Workspace, discovered.WorkspaceSource)
	if creds.MCPConfigPath == "" {
		creds.MCPConfigPath = discovered.MCPConfigPath
	}
	return creds
}

// sourceOf attributes a config-supplied value: it came from the environment
// when discovery found the same value there, otherwise from the config file.
func sourceOf(value, discoveredValue string, discoveredSource credSource) credSource {
	switch {
	case value == "":
		return credSourceNone
	case value == discoveredValue && discoveredSource == credSourceEnv:
		return credSourceEnv
	}
	return credSourceFile
}

// doctorReportWidth is the fixed render width. Doctor prints a report and
// exits rather than owning the terminal, so there is no WindowSizeMsg to size
// against.
const doctorReportWidth = 76

// doctorBaseDir picks the clone root to validate: the loaded config's when
// there is one, else the default the wizard would propose — so a machine with
// no config at all is still told whether its default work dir is safe.
func doctorBaseDir(cfg *config.Config) string {
	if cfg != nil && cfg.Git.BaseDir != "" {
		return cfg.Git.BaseDir
	}
	homeDir, _ := os.UserHomeDir()
	return defaultWorkDir(homeDir)
}

// probeTimeout bounds every external probe. `gh auth status` talks to the
// network and can hang on a wedged keychain or proxy — a diagnostic that
// hangs is worse than the problem it diagnoses.
const probeTimeout = 15 * time.Second

// combinedOutput is the real probe runner. Output is returned even on a
// non-zero exit because the checks read it either way — `gh auth status` says
// what is wrong on the stream it exits 1 with.
func combinedOutput(name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

// runChecks runs every check regardless of what earlier ones found. A machine
// with three problems must hear about all three in one pass, not one per
// re-run.
func runChecks(deps doctorDeps) []checkResult {
	results := []checkResult{
		checkCodingAgents(deps.LookPath),
		checkGit(deps.LookPath, deps.Run),
		checkForgeCLI(deps.LookPath, deps.Run),
		checkCredentials(deps.Creds),
		checkBackend(deps.Identity, deps.InitErr),
		checkMCPConfig(deps.Creds.MCPConfigPath),
		checkMCPToolsets(deps.Creds.MCPConfigPath),
		checkAgentMCPKey(deps.Creds.MCPConfigPath),
		checkWorkDir(deps.BaseDir),
	}
	// Drift and --from only report when there is something to say: most
	// machines have no profile copy and no --from launch, and an OK row for a
	// comparison that could not even be made would be noise.
	if drift, found := checkMCPConfigCopyDrift(deps.Creds.ConfigPath, deps.Creds.MCPConfigPath); found {
		results = append(results, drift)
	}
	if warn, found := checkWorkingTreeFrom(deps.Creds.MCPConfigPath); found {
		results = append(results, warn)
	}
	if row, found := checkMCPDeprecatedGrants(deps); found {
		results = append(results, row)
	}
	return results
}

const (
	mcpDeprecatedGrantsLabel = "mcp deprecated grants"
	mcpDeprecatedGrantsFix   = "move the named stages to the replacement tools (update_workspace_config, or the pipeline builder) before upgrading backplane-mcp past the removal version"
)

// checkMCPDeprecatedGrants holds the pipeline's stored grants against the
// catalog the configured MCP server serves: a grant naming a tool served only
// as a deprecated alias works today and breaks on the next backplane-mcp
// minor. Reports only when the server was actually probed — an unprobed
// server says nothing about deprecations, and a row for a comparison that
// could not be made would be noise.
func checkMCPDeprecatedGrants(deps doctorDeps) (checkResult, bool) {
	if deps.ServedMCP == nil {
		return checkResult{}, false
	}
	var details []string
	for _, stage := range deps.StageGrants {
		for _, finding := range workloop.DeprecatedGrants(stage.Tools, deps.ServedMCP) {
			details = append(details, fmt.Sprintf("%s: %s → %s (removed in %s)",
				stage.Role, finding.Tool, finding.Replacement, finding.RemovedIn))
		}
	}
	if len(details) == 0 {
		return checkResult{Label: mcpDeprecatedGrantsLabel, Detail: "no pipeline stage grants a deprecated tool", State: tui.StateOK}, true
	}
	return checkResult{
		Label:  mcpDeprecatedGrantsLabel,
		Detail: strings.Join(details, "; "),
		Fix:    mcpDeprecatedGrantsFix,
		State:  tui.StateWarn,
	}, true
}

// checkCodingAgents reports which coding-agent binaries resolve on PATH. It
// reads preflight's providerTools so a new provider is registered in exactly
// one place. No agent is a hard FAIL: a runner with no agent to drive has
// nothing to run.
func checkCodingAgents(lookPath func(string) (string, error)) checkResult {
	var found, missing []string
	for _, pt := range providerTools {
		if _, err := lookPath(pt.tool.bin); err == nil {
			found = append(found, pt.tool.bin)
		} else {
			missing = append(missing, pt.tool.bin)
		}
	}

	if len(found) == 0 {
		return checkResult{
			Label:  "coding agents",
			Detail: "none of " + strings.Join(missing, ", ") + " resolve on PATH",
			Fix:    providerFixHints(),
			State:  tui.StateFail,
		}
	}

	detail := "on PATH: " + strings.Join(found, ", ")
	if len(missing) > 0 {
		detail += " · absent: " + strings.Join(missing, ", ")
	}
	return checkResult{Label: "coding agents", Detail: detail, State: tui.StateOK}
}

// providerFixHints joins every provider's install hint, since with none
// present the operator has a choice to make rather than one thing to fix.
func providerFixHints() string {
	hints := make([]string, 0, len(providerTools))
	for _, pt := range providerTools {
		hints = append(hints, pt.tool.fix)
	}
	return strings.Join(hints, "; or ")
}

// checkGit gates the binary every clone, branch and commit goes through.
func checkGit(lookPath func(string) (string, error), run commandRunner) checkResult {
	if _, err := lookPath("git"); err != nil {
		return checkResult{
			Label:  "git",
			Detail: "no `git` binary on PATH",
			Fix:    "install git (e.g. `brew install git` or your distro's package)",
			State:  tui.StateFail,
		}
	}

	out, err := run("git", "--version")
	if err != nil {
		return checkResult{
			Label:  "git",
			Detail: "`git --version` failed: " + errSummary(err),
			Fix:    "reinstall git — the binary resolves but will not run",
			State:  tui.StateFail,
		}
	}
	return checkResult{Label: "git", Detail: firstLine(string(out)), State: tui.StateOK}
}

// checkForgeCLI probes the GitHub CLI. Everything here is a WARN, never a
// FAIL: a gitea install speaks HTTP and needs no forge binary at all, so
// flunking on gh would flunk a perfectly healthy machine.
func checkForgeCLI(lookPath func(string) (string, error), run commandRunner) checkResult {
	if _, err := lookPath("gh"); err != nil {
		return checkResult{
			Label:  "forge cli",
			Detail: "no `gh` binary on PATH",
			Fix:    "install the GitHub CLI and run `gh auth login` — not needed if git.forge is gitea",
			State:  tui.StateWarn,
		}
	}

	if out, err := run("gh", "auth", "status"); err != nil {
		return checkResult{
			Label:  "forge cli",
			Detail: "gh is installed but not authenticated: " + firstLine(string(out)),
			Fix:    "run `gh auth login` — not needed if git.forge is gitea",
			State:  tui.StateWarn,
		}
	}
	return checkResult{Label: "forge cli", Detail: "gh authenticated", State: tui.StateOK}
}

// checkCredentials reports what resolved and from where, so an operator
// debugging the wrong workspace can see that a stale config file is beating
// the env var they just exported. The key itself is never printed.
func checkCredentials(creds Credentials) checkResult {
	if missing := creds.Missing(); len(missing) > 0 {
		// The overwhelmingly common cause is a shell assignment WITHOUT export:
		// `echo` shows the value, but a child process never receives it. Doctor
		// cannot see the parent shell, so a hint that only says "set these"
		// reads as a lie to the operator who just did.
		return checkResult{
			Label:  "credentials",
			Detail: "unresolved: " + strings.Join(missing, ", "),
			Fix: "run `backplane-runner -interactive` and enter them once (the key is saved to a 0600 " +
				credentialsFilename + " file, the rest to runner.yaml) — or export each of " + strings.Join(missing, ", ") +
				" yourself, remembering that a bare `VAR=value` is not inherited by the child process " +
				"(e.g. `export VALARIS_API_KEY=vlr_...`)",
			State: tui.StateFail,
		}
	}

	detail := fmt.Sprintf("key %s (%s) · workspace %s (%s) · url %s (%s)",
		maskKey(creds.APIKey), creds.APIKeySource,
		creds.Workspace, creds.WorkspaceSource,
		creds.APIURL, creds.APIURLSource)
	return checkResult{Label: "credentials", Detail: detail, State: tui.StateOK}
}

// maskKeyPrefixLen is how much of an API key survives masking: enough to tell
// two keys apart in a bug report, far too little to use.
const maskKeyPrefixLen = 4

// maskKey renders an identifying prefix and nothing else. A key shorter than
// the prefix is masked whole rather than echoed — brevity is not consent.
func maskKey(key string) string {
	if key == "" {
		return "(not set)"
	}
	if len(key) <= maskKeyPrefixLen {
		return "…"
	}
	return key[:maskKeyPrefixLen] + "…"
}

// backendIdentityFrom flattens an initialized client (plus its optional budget)
// into the value checkBackend judges.
func backendIdentityFrom(client *valaris.Client, budget *valaris.BudgetStatus) backendIdentity {
	id := backendIdentity{UserID: client.UserID}
	if client.Agent != nil {
		id.IsAgent = true
		id.AgentName = client.Agent.Name
		id.IsActive = client.Agent.IsActive
		id.Budget = formatBudget(budget)
	}
	return id
}

// formatBudget renders the platform budget the same way the wizard's connect
// step does. A backend that reports none is not an error.
func formatBudget(status *valaris.BudgetStatus) string {
	if status == nil {
		return ""
	}
	if status.RemainingUSD != nil {
		return fmt.Sprintf("$%.2f of $%.2f remaining", *status.RemainingUSD, deref(status.BudgetUSD))
	}
	return fmt.Sprintf("$%.2f spent", status.SpentUSD)
}

// checkBackend judges reachability AND what the key turned out to be. A plain
// user key is the dangerous case: it authenticates cleanly and then records no
// executions server-side, so it warns loudly rather than passing quietly.
func checkBackend(id backendIdentity, initErr error) checkResult {
	// No key means there was nothing to authenticate with — blaming the network
	// here would send the operator debugging the wrong thing, since the
	// credentials row already names the real problem.
	if errors.Is(initErr, errSkippedNoAPIKey) {
		return checkResult{
			Label:  "backend",
			Detail: "skipped — no API key to authenticate with",
			Fix:    "resolve the credentials above, then rerun to verify the backend",
			State:  tui.StateFail,
		}
	}
	if initErr != nil {
		return checkResult{
			Label:  "backend",
			Detail: "could not authenticate: " + errSummary(initErr),
			Fix:    "check valaris.api_url reachability and that the API key is valid and not revoked",
			State:  tui.StateFail,
		}
	}

	if !id.IsAgent {
		return checkResult{
			Label:  "backend",
			Detail: "reachable, but the key resolved no agent — a plain user key cannot record executions",
			Fix:    "mint an AGENT key on the platform and set it as valaris.api_key (VALARIS_API_KEY)",
			State:  tui.StateWarn,
		}
	}
	if !id.IsActive {
		return checkResult{
			Label:  "backend",
			Detail: fmt.Sprintf("agent %q is deactivated on the platform", id.AgentName),
			Fix:    "reactivate the agent on the platform, or mint a new agent key",
			State:  tui.StateFail,
		}
	}

	detail := "agent " + id.AgentName
	if id.Budget != "" {
		detail += " · " + id.Budget
	}
	return checkResult{Label: "backend", Detail: detail, State: tui.StateOK}
}

// mcpConfigFix names the two ways forward rather than the placeholders to
// hand-edit: both paths write the file for the operator, and an operator told
// only "fill in the real command and key" has to go find out what the real
// command is.
var mcpConfigFix = fmt.Sprintf(
	"run `backplane-runner` with no arguments — the wizard configures MCP interactively; or run `backplane-runner -doctor -fix` to write %s now",
	mcpConfigFilenames[0])

// checkMCPConfig gates the file the runner reaches the platform through.
// config.Load hard-requires it, so anything short of a parseable JSON file is
// a FAIL — the runner could not start with it in this state.
func checkMCPConfig(path string) checkResult {
	fix := mcpConfigFix

	if path == "" {
		return checkResult{
			Label:  "mcp config",
			Detail: "no MCP server config found — the runner reaches the platform through MCP tools",
			Fix:    fix,
			State:  tui.StateFail,
		}
	}

	data, err := os.ReadFile(path)
	if err != nil {
		// config.Load anchors a relative mcp_config_path against the PROCESS
		// CWD (unlike git.base_dir, which anchors against the config's own
		// directory), so the same config works from one directory and not
		// another. Naming the resolved path is what makes that debuggable.
		return checkResult{
			Label:  "mcp config",
			Detail: "cannot read " + path + ": " + errSummary(err),
			Fix:    "set llm.mcp_config_path to an ABSOLUTE path (a relative one resolves against the current directory, not the config's), or " + fix,
			State:  tui.StateFail,
		}
	}
	if !json.Valid(data) {
		return checkResult{
			Label:  "mcp config",
			Detail: path + " is not valid JSON",
			Fix:    "fix the JSON syntax — the coding agent parses this file verbatim",
			State:  tui.StateFail,
		}
	}
	// The template parses as JSON and exists in every checkout, so every check
	// above it passes on a machine where MCP was never configured at all.
	// Passing here is the false green that sends a runner off to fail on its
	// first platform call.
	if isMCPConfigTemplate(path) {
		detail := path + " is the shipped template, not a configured MCP server"
		if placeholders := unfilledPlaceholders(data); len(placeholders) > 0 {
			detail += " — still holds placeholder " + strings.Join(placeholders, ", ")
		}
		// Naming the consequence is the difference between a warning an operator
		// acts on and one they scroll past: a run started here authenticates the
		// coding agent with a dummy key and dies on its first platform call.
		detail += "; a run would fail on its first platform call"
		return checkResult{
			Label:  "mcp config",
			Detail: detail,
			Fix:    fix,
			State:  tui.StateWarn,
		}
	}
	return checkResult{Label: "mcp config", Detail: path, State: tui.StateOK}
}

// mcpConfigPlaceholders are the shipped template's own dummy values, ordered so
// the row does not reshuffle between runs. Finding one means the file was
// copied but never filled in — worth naming, because "it is a template" alone
// does not tell an operator which line to edit.
var mcpConfigPlaceholders = []struct{ marker, names string }{
	{"/path/to/", "command path"},
	{"vlr_your_agent_key_here", "agent key"},
}

// unfilledPlaceholders names which shipped placeholders survive in the file.
func unfilledPlaceholders(data []byte) []string {
	var found []string
	for _, p := range mcpConfigPlaceholders {
		if strings.Contains(string(data), p.marker) {
			found = append(found, p.names)
		}
	}
	return found
}

// agentMCPKeyLabel keeps "agent … key" legible in the report on its own —
// folding this verdict into the "backend" or "mcp config" rows is how a stale
// agent key stayed invisible through three recurrences.
const agentMCPKeyLabel = "agent mcp key"

// mcpServerEntry is the slice of an MCP config doctor reads: the launch args
// (for the --from check) and the env block carrying the coding agent's own
// credentials.
type mcpServerEntry struct {
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
}

// readAgentMCPServer extracts the hard-required "valaris" server entry — the
// one the wizard writes and the runner hands to the coding agent by path.
func readAgentMCPServer(path string) (mcpServerEntry, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return mcpServerEntry{}, err
	}
	var parsed struct {
		Servers map[string]mcpServerEntry `json:"mcpServers"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		return mcpServerEntry{}, err
	}
	entry, ok := parsed.Servers["valaris"]
	if !ok {
		return mcpServerEntry{}, errors.New(`no "valaris" server entry`)
	}
	return entry, nil
}

const (
	mcpToolsetsLabel  = "mcp toolsets"
	mcpToolsetsEnvKey = "VALARIS_MCP_TOOLSETS"
	mcpToolsetsFix    = "set " + mcpToolsetsEnvKey + "=all in the valaris server's env in the MCP config, or rerun the wizard to rewrite the file"
)

// checkMCPToolsets reads the template's VALARIS_MCP_TOOLSETS. Unset, the MCP
// server serves its interactive default hand, which omits the
// autonomous-operations tools runner stages are granted (enqueue_pr_for_merge,
// list_skills/get_skill, the approvals tools). Launches pin the key themselves,
// but the loop pre-flight spawns the server from this template verbatim and so
// would anything else that reuses it. Static check on purpose: it never
// spawns the server.
func checkMCPToolsets(path string) checkResult {
	if path == "" {
		return checkResult{
			Label:  mcpToolsetsLabel,
			Detail: "no MCP config to read " + mcpToolsetsEnvKey + " from",
			Fix:    mcpConfigFix,
			State:  tui.StateFail,
		}
	}
	entry, err := readAgentMCPServer(path)
	if err != nil {
		return checkResult{
			Label:  mcpToolsetsLabel,
			Detail: "cannot read " + mcpToolsetsEnvKey + " in " + path + ": " + errSummary(err),
			Fix:    mcpConfigFix,
			State:  tui.StateFail,
		}
	}
	value, set := entry.Env[mcpToolsetsEnvKey]
	switch {
	case !set || value == "":
		return checkResult{
			Label:  mcpToolsetsLabel,
			Detail: mcpToolsetsEnvKey + " unset — the server will load the default interactive hand, which clips autonomous-operations grants (enqueue_pr_for_merge, list_skills/get_skill, approvals); runner stages need all",
			Fix:    mcpToolsetsFix,
			State:  tui.StateWarn,
		}
	case value != "all":
		return checkResult{
			Label:  mcpToolsetsLabel,
			Detail: mcpToolsetsEnvKey + "=" + value + " narrows the surface; runner stages need all (the stage allowlist is the only narrowing)",
			Fix:    mcpToolsetsFix,
			State:  tui.StateWarn,
		}
	}
	return checkResult{Label: mcpToolsetsLabel, Detail: value, State: tui.StateOK}
}

// checkAgentMCPKey verifies the key INSIDE the mcp-config against the URL
// inside the mcp-config — the credential the coding agent will actually
// authenticate with. checkBackend proves the RUNNER's key; the two are
// distinct identities, and a green doctor over a dead agent key has already
// burned a paid run (card d3857c4c, third recurrence). A config with no key
// is a FAIL in its own right, never a silent skip.
func checkAgentMCPKey(path string) checkResult {
	if path == "" {
		return checkResult{
			Label:  agentMCPKeyLabel,
			Detail: "no MCP config to read the agent's VALARIS_API_KEY from",
			Fix:    mcpConfigFix,
			State:  tui.StateFail,
		}
	}
	entry, err := readAgentMCPServer(path)
	if err != nil {
		return checkResult{
			Label:  agentMCPKeyLabel,
			Detail: "cannot read the agent credentials in " + path + ": " + errSummary(err),
			Fix:    mcpConfigFix,
			State:  tui.StateFail,
		}
	}
	if entry.Env["VALARIS_API_KEY"] == "" {
		return checkResult{
			Label:  agentMCPKeyLabel,
			Detail: path + " hands the coding agent no VALARIS_API_KEY — it would start unauthenticated",
			Fix:    "set VALARIS_API_KEY in the valaris server's env to an AGENT key, or rerun the wizard to rewrite the file",
			State:  tui.StateFail,
		}
	}
	apiURL := entry.Env["VALARIS_API_URL"]
	if apiURL == "" {
		return checkResult{
			Label:  agentMCPKeyLabel,
			Detail: path + " names no VALARIS_API_URL to verify its key against",
			Fix:    "set VALARIS_API_URL in the valaris server's env to the platform URL",
			State:  tui.StateFail,
		}
	}

	status, err := probeAgentKey(apiURL, entry.Env["VALARIS_API_KEY"])
	if err != nil {
		return checkResult{
			Label:  agentMCPKeyLabel,
			Detail: "could not reach " + apiURL + " (VALARIS_API_URL in " + path + "): " + errSummary(err),
			Fix:    "check that VALARIS_API_URL in the mcp-config points at a reachable platform",
			State:  tui.StateFail,
		}
	}
	switch {
	case status == http.StatusUnauthorized || status == http.StatusForbidden:
		return checkResult{
			Label:  agentMCPKeyLabel,
			Detail: fmt.Sprintf("%s rejected the agent key in %s (HTTP %d) — a run would die on its first platform call", apiURL, path, status),
			Fix:    "mint a fresh AGENT key on the platform and update VALARIS_API_KEY in " + path,
			State:  tui.StateFail,
		}
	case status >= 400:
		return checkResult{
			Label:  agentMCPKeyLabel,
			Detail: fmt.Sprintf("%s answered HTTP %d to the agent-key probe (config %s)", apiURL, status, path),
			Fix:    "check that the platform at that URL is healthy, then rerun",
			State:  tui.StateFail,
		}
	case status >= 300:
		// A redirect means something in FRONT of the API answered — an SSO
		// gate, a bare-domain redirector — and the platform never judged the
		// key at all.
		return checkResult{
			Label:  agentMCPKeyLabel,
			Detail: fmt.Sprintf("%s answered the agent-key probe with a redirect (HTTP %d) — the platform never saw the key", apiURL, status),
			Fix:    "point VALARIS_API_URL in " + path + " directly at the platform API, not at a redirector or SSO front",
			State:  tui.StateFail,
		}
	}
	return checkResult{Label: agentMCPKeyLabel, Detail: "key in " + path + " accepted by " + apiURL, State: tui.StateOK}
}

// probeAgentKey makes the same cheap identity GET checkBackend's client does,
// but authenticated as the coding agent. It deliberately builds a raw request
// rather than reusing valaris.Client: reaching this backend through anything
// holding runner credentials is exactly the blind spot this check closes.
func probeAgentKey(apiURL, apiKey string) (int, error) {
	req, err := http.NewRequest(http.MethodGet, strings.TrimSuffix(apiURL, "/")+"/api/me", nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	// A 302 to an SSO login page is a broken agent credential, not a success —
	// judge the raw status rather than following it to some 200 login screen.
	client := &http.Client{
		Timeout:       probeTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	resp, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	resp.Body.Close()
	return resp.StatusCode, nil
}

// checkMCPConfigCopyDrift compares the resolved mcp-config against the copy a
// profile keeps beside its runner.yaml. A save refreshes one and not the
// other, and the operator edits whichever they find first — when the two
// disagree, doctor names BOTH so "which file is live?" stops being
// archaeology. Bytes, not parsed JSON: even formatting drift means someone
// edited one copy by hand, which is exactly the divergence worth surfacing.
func checkMCPConfigCopyDrift(configPath, mcpConfigPath string) (checkResult, bool) {
	if configPath == "" || mcpConfigPath == "" {
		return checkResult{}, false
	}
	profileCopy := filepath.Join(filepath.Dir(configPath), mcpConfigFilenames[0])
	if profileCopy == mcpConfigPath {
		return checkResult{}, false
	}
	copyData, err := os.ReadFile(profileCopy)
	if err != nil {
		return checkResult{}, false
	}
	targetData, err := os.ReadFile(mcpConfigPath)
	if err != nil {
		return checkResult{}, false
	}
	if bytes.Equal(copyData, targetData) {
		return checkResult{}, false
	}
	return checkResult{
		Label:  "mcp config copy",
		Detail: profileCopy + " differs from " + mcpConfigPath + " — the run uses the latter; edits to the other never take effect",
		Fix:    "copy the intended file over the other so they match (the run reads " + mcpConfigPath + "), then rerun doctor",
		State:  tui.StateFail,
	}, true
}

// checkWorkingTreeFrom warns when the config launches the MCP server `--from`
// a directory inside a git working tree: the tree serves whatever state it is
// in mid-edit, and uvx caches a stale wheel besides (Loop #6's
// stop-the-line). A WARN, not a FAIL — the setup does run, it just rots.
func checkWorkingTreeFrom(mcpConfigPath string) (checkResult, bool) {
	entry, err := readAgentMCPServer(mcpConfigPath)
	if err != nil {
		return checkResult{}, false
	}
	fromPath := ""
	for i, arg := range entry.Args {
		if arg == "--from" && i+1 < len(entry.Args) {
			fromPath = entry.Args[i+1]
		} else if rest, ok := strings.CutPrefix(arg, "--from="); ok {
			fromPath = rest
		}
	}
	if fromPath == "" {
		return checkResult{}, false
	}
	// ValidateBaseDir is the existing "inside a git worktree?" ancestor walk —
	// a different hazard here (staleness, not a hard reset), same question.
	if config.ValidateBaseDir(fromPath) == nil {
		return checkResult{}, false
	}
	return checkResult{
		Label:  "mcp launch",
		Detail: "--from " + fromPath + " is inside a git working tree — the served code shifts with every edit and uvx caches stale builds",
		Fix:    "serve a snapshot instead: `git archive` the mcp-server directory to a path outside any worktree and point --from there",
		State:  tui.StateWarn,
	}, true
}

// checkWorkDir gates the clone root on the config package's worktree guard.
// SAFETY-CRITICAL: the runner hard-resets clones under this directory, so a
// base_dir inside a git worktree lets git walk up and rewind the enclosing
// repository — which is exactly how 25 commits were once lost. The check is
// read-only by construction: ValidateBaseDir stats, it never creates.
func checkWorkDir(path string) checkResult {
	if err := config.ValidateBaseDir(path); err != nil {
		return checkResult{
			Label:  "work dir",
			Detail: err.Error(),
			Fix:    "point git.base_dir outside any git worktree (e.g. /tmp/backplane-runner-repos)",
			State:  tui.StateFail,
		}
	}
	return checkResult{Label: "work dir", Detail: path + " (outside any git worktree)", State: tui.StateOK}
}

// renderDoctorReport composes the checklist, the fix hints for everything that
// is not OK, and the verdict line into the printable report.
func renderDoctorReport(results []checkResult, width int) string {
	items := make([]tui.ChecklistItem, 0, len(results))
	for _, r := range results {
		items = append(items, tui.ChecklistItem{Label: r.Label, State: r.State, Detail: r.Detail})
	}

	// Panel would wrap a long row back to the left margin, where it reads as a
	// new check. Pre-wrapping to the panel's own body width, with a hanging
	// indent, keeps a long detail visually owned by the row it belongs to.
	inner := tui.PanelBodyWidth(width)
	body := tui.ChecklistWrapped(items, inner)
	if fixes := renderFixes(results, inner); fixes != "" {
		body += "\n\n" + fixes
	}

	_, warn, fail := summarize(results)
	verdict := tui.StatusLine(verdictIcon(fail, warn), "verdict", doctorVerdict(results))

	return tui.Banner(width) + "\n\n" +
		tui.Panel("doctor — this machine", body, width) + "\n" +
		verdict
}

// doctorVerdict states the OUTCOME first and the counts second. A line that
// only counted ("5 ok · 2 warning(s) · 0 failed") left a real operator unable to
// tell whether they had passed — warnings look like failures when nothing says
// otherwise.
func doctorVerdict(results []checkResult) string {
	ok, warn, fail := summarize(results)
	counts := fmt.Sprintf("%d ok · %d warning(s) · %d failed", ok, warn, fail)

	switch {
	case fail > 0:
		return "the runner will not run — " + counts + "; fix the failed checks above"
	case warn > 0:
		return "ready, with caveats — " + counts + "; the warnings above are usable but limited"
	}
	return "ready — " + counts
}

// interactiveDoctorNextStep closes the loop for an operator who reached doctor
// through the wizard: they walked a whole setup flow and doctor exiting on a
// report reads as a dead end. The headless -doctor path deliberately does not
// print this — a CI gate parsing the report gains nothing from a launch hint.
func interactiveDoctorNextStep(results []checkResult) string {
	if _, _, fail := summarize(results); fail > 0 {
		return "next: fix the checks above, then rerun `backplane-runner` to check again and launch"
	}
	return "next: rerun `backplane-runner` and pick a mode — setup is checked, nothing else to configure"
}

// runInteractiveDoctor is the wizard's entry into doctor: the same report, plus
// the one line that tells the operator where to go from here.
func runInteractiveDoctor(ctx context.Context, cfg *config.Config, creds Credentials) int {
	code, results := runDoctorChecks(ctx, cfg, creds)
	fmt.Println(interactiveDoctorNextStep(results))
	return code
}

// fixBullet leads each remedy.
const fixBullet = "→ "

// fixHangingIndent aligns a wrapped fix under its bullet rather than at the
// left margin, where it would read as another fix.
const fixHangingIndent = "  "

// renderFixes lists the remedy for every not-OK check, in check order, each
// wrapped to width with its continuations hanging under the bullet.
func renderFixes(results []checkResult, width int) string {
	var lines []string
	for _, r := range results {
		if r.State != tui.StateOK && r.Fix != "" {
			lines = append(lines, tui.WrapHanging(fixBullet+r.Label+": "+r.Fix, width, fixHangingIndent))
		}
	}
	return strings.Join(lines, "\n")
}

func verdictIcon(fail, warn int) string {
	switch {
	case fail > 0:
		return "✗"
	case warn > 0:
		return "!"
	}
	return "✓"
}

func summarize(results []checkResult) (ok, warn, fail int) {
	for _, r := range results {
		switch r.State {
		case tui.StateOK:
			ok++
		case tui.StateWarn:
			warn++
		case tui.StateFail:
			fail++
		}
	}
	return ok, warn, fail
}

// doctorExitCode is 1 when anything FAILed. Warnings deliberately exit 0 so a
// CI gate does not break on a machine that merely has no gh.
func doctorExitCode(results []checkResult) int {
	if _, _, fail := summarize(results); fail > 0 {
		return 1
	}
	return 0
}

// firstLine trims a probe's output to the one line worth showing in a row.
func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return strings.TrimSpace(s[:i])
	}
	return s
}

func errSummary(err error) string {
	if err == nil {
		return ""
	}
	return firstLine(err.Error())
}
