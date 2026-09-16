// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

	tea "github.com/charmbracelet/bubbletea"
	"gopkg.in/yaml.v3"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/profile"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
	"github.com/Valaris-Studio/backplane/runner/internal/version"
)

// interactiveFlagName is the one flag that can force the wizard on when other
// flags are present. It is matched textually below because the decision has to
// be made from the raw argv, before flag.Parse can be trusted to have run.
const interactiveFlagName = "interactive"

// shouldRunInteractive decides whether to show the wizard instead of today's
// config-file path. It is deliberately conservative: the wizard appears ONLY
// on a bare invocation from a real terminal, or when -interactive is explicit.
//
// Both TTY checks are absolute — not even an explicit -interactive overrides
// them, because a CI job or systemd unit that passes the flag would otherwise
// block forever on a prompt nobody can answer. Every existing Docker, systemd,
// CI and piped invocation therefore falls through to the exact code path it
// uses today, including today's exact error when config is missing.
func shouldRunInteractive(args []string, stdinIsTTY, stdoutIsTTY bool) bool {
	if !stdinIsTTY || !stdoutIsTTY {
		return false
	}
	if explicit, ok := interactiveFlagValue(args); ok {
		return explicit
	}
	return len(args) == 0
}

// interactiveFlagValue scans raw argv for -interactive/--interactive and its
// =value form, returning the requested value and whether it was named at all.
func interactiveFlagValue(args []string) (value bool, present bool) {
	for _, arg := range args {
		name, val, hasVal := strings.Cut(strings.TrimLeft(arg, "-"), "=")
		if name != interactiveFlagName || arg == strings.TrimLeft(arg, "-") {
			continue
		}
		if !hasVal {
			return true, true
		}
		// A malformed -interactive=maybe is treated as "off": the safe side of
		// a guard whose whole job is to not surprise a non-interactive caller.
		return val == "true" || val == "1", true
	}
	return false, false
}

// The wizard owns its selection flow; named CLI configs use the noninteractive path.
func validateInteractiveSelectionFlags(interactive, configPassed, profilePassed bool) error {
	if interactive && (configPassed || profilePassed) {
		return fmt.Errorf("-interactive cannot be combined with -config or -profile; choose a saved profile in the wizard, or omit -interactive to run the exact -config/-profile selection")
	}
	return nil
}

func wizardDoctorCredentials(result tui.Result, startup Credentials) Credentials {
	creds := startup.overriddenBy(result)
	creds.MCPConfigPath = effectiveMCPConfigPath(result, startup)
	if creds.MCPConfigPath != "" {
		creds.MCPConfigPath = absoluteMCPPath(creds.MCPConfigPath, "")
	}
	if result.MCPConfigOrigin != "" {
		creds.MCPConfigOrigin = result.MCPConfigOrigin
	}
	return creds
}

// runInteractive drives the wizard and then dispatches into the SAME entry
// points the flags reach: the wizard chooses a config and a mode, it never
// implements one. A cancelled wizard exits 0 — the operator backed out, which
// is not an error.
func runInteractive(verbose, noSupervisor bool) {
	homeDir, _ := os.UserHomeDir()
	workDir, _ := os.Getwd()
	creds := resolveCredentials(homeDir, configCandidatePaths(homeDir, workDir))

	result, err := runWizard(newWizardDeps(creds, homeDir, workDir, version.Version))
	if err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
	if result.Cancelled {
		return
	}

	action := modeAction(result.Mode)
	if action == actionUnknown {
		fmt.Fprintf(os.Stderr, "error: unknown mode %q — refusing to guess what to run\n", result.Mode)
		os.Exit(1)
	}

	// The wizard's credentials step is authoritative over whatever was resolved
	// at startup: correcting a wrong host there is the whole point of the step.
	creds = creds.overriddenBy(result)

	// The MCP step's intent runs before anything reads creds.MCPConfigPath —
	// this write is what turns a green review into a runnable setup.
	var mcpErr error
	creds, mcpErr = applyWizardMCP(result, creds)
	if mcpErr != nil {
		if action.needsValidConfig() {
			fmt.Fprintf(os.Stderr, "error: could not select MCP config %s: %v — setup stopped before model invocation\n", result.MCPConfigPath, mcpErr)
			os.Exit(1)
		}
		fmt.Fprintf(os.Stderr, "warning: could not write %s: %v\n", result.MCPConfigPath, mcpErr)
	}

	// Persist BEFORE dispatching, because doctor and every other mode exit from
	// inside their own branch. Gating this on result.SaveConfig — a toggle that
	// only exists on the review screen doctor and discovery never reach — is
	// what made the wizard ask for the host and key on every single launch.
	announceRememberedCredentials(rememberCredentials(homeDir, creds))

	cfg, err := interactiveConfig(result, creds)
	if err != nil {
		// Doctor exists to diagnose exactly this state, so a config it cannot
		// assemble is its input, not a reason to bail. Every other mode would
		// be starting work on a config the runner has already rejected.
		if action.needsValidConfig() {
			fmt.Fprintf(os.Stderr, "error: %v\n", err)
			os.Exit(1)
		}
		os.Exit(runInteractiveDoctor(context.Background(), nil, creds))
	}

	// Doctor runs before authentication and before any provider is built: it
	// reports on a machine that cannot connect, which is when it matters most.
	if action == actionDoctor {
		setupLogger(cfg.LogLevel, verbose)
		os.Exit(runInteractiveDoctor(context.Background(), cfg, creds))
	}

	// SaveConfig governs only the heavier runner.yaml — the credentials are
	// already remembered above. The key is deliberately NOT in that yaml: it
	// carries the env placeholder, so the config stays safe to copy and commit.
	if result.SaveConfig && result.ConfigPath != "" {
		if err := saveWizardConfig(result.ConfigPath, cfg); err != nil {
			// A config the operator can rebuild in 30 seconds is not worth
			// aborting a run they already committed to.
			fmt.Fprintf(os.Stderr, "warning: could not save %s: %v\n", result.ConfigPath, err)
		} else {
			fmt.Fprintf(os.Stderr, "saved %s\n", result.ConfigPath)
		}
	}

	// The save-as-profile intent executes here, mirroring applyWizardMCP: the
	// wizard pinned the name (and any confirmed overwrite), the caller writes
	// the profile's three files through the store. Same severity as the config
	// save above — a failed write must not abort a run already committed to.
	if result.ProfileName != "" {
		if err := applyWizardProfile(result, cfg, profile.NewStore(profile.DefaultRoot())); err != nil {
			fmt.Fprintf(os.Stderr, "warning: could not save profile %q: %v\n", result.ProfileName, err)
		} else {
			fmt.Fprintf(os.Stderr, "saved profile %q\n", result.ProfileName)
		}
	}

	setupLogger(cfg.LogLevel, verbose)

	if err := preflight(cfg); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}

	ctx := context.Background()
	client := valaris.NewClient(cfg.Valaris.APIURL, cfg.Valaris.APIKey)
	if err := client.Init(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "error: failed to authenticate: %v\n", err)
		os.Exit(1)
	}

	providers, defaultProvider := buildProviders(cfg)

	// Every mode is dispatched by name. There is deliberately no catch-all arm
	// that falls into the pipeline: an unhandled mode used to land there and
	// start autonomous agents on real money for an operator who asked for
	// something else entirely.
	switch action {
	case actionDiscovery:
		runDiscovery(ctx, cfg, defaultProvider)
	case actionLoop:
		runLoopMode(ctx, cfg, client, providers, defaultProvider, result.BoardID)
	case actionPipeline:
		runPipelineMode(ctx, cfg, client, providers, defaultProvider, noSupervisor)
	default:
		fmt.Fprintf(os.Stderr, "error: mode %q has no dispatch — refusing to start work\n", result.Mode)
		os.Exit(1)
	}
}

// rememberCredentials persists the host, key and workspace the operator just
// authenticated with, returning the file it wrote (or "" when there was nothing
// worth remembering). It is deliberately independent of the mode and of the
// review screen's save toggle: the key is the expensive thing to retype, and by
// this point the wizard has already proven it works.
func rememberCredentials(homeDir string, creds Credentials) (path string, err error) {
	if creds.APIKey == "" {
		return "", nil
	}
	path = credentialsFilePath(homeDir)
	if path == "" {
		return "", nil
	}
	if err := saveCredentialsFile(path, RememberedSession{
		APIKey:    creds.APIKey,
		APIURL:    creds.APIURL,
		Workspace: creds.Workspace,
	}); err != nil {
		return "", err
	}
	return path, nil
}

// announceRememberedCredentials tells the operator the wizard will not ask
// again. Silence here is what produces the "did it save?" doubt that sent a
// real user back through the whole flow. A failure to write is a warning, never
// fatal — the run they asked for still works, it just will not be remembered.
func announceRememberedCredentials(path string, err error) {
	switch {
	case err != nil:
		fmt.Fprintf(os.Stderr, "warning: could not remember your credentials: %v\n", err)
	case path != "":
		fmt.Fprintf(os.Stderr, "remembered host + key + workspace in %s (owner-only) — next launch prefills them\n", path)
	}
}

// modeActionKind is what the wizard's chosen mode actually dispatches to. It
// exists so the mapping is a pure function a test can assert on, rather than a
// switch buried in a func that starts long-running work as a side effect.
type modeActionKind int

const (
	actionUnknown modeActionKind = iota
	actionDiscovery
	actionLoop
	actionPipeline
	actionDoctor
)

// modeAction maps a wizard mode onto its dispatch. An unrecognized mode maps
// to actionUnknown, never to a mode that spends.
func modeAction(mode tui.Mode) modeActionKind {
	switch mode {
	case tui.ModeDiscovery:
		return actionDiscovery
	case tui.ModeLoop:
		return actionLoop
	case tui.ModePipeline:
		return actionPipeline
	case tui.ModeDoctor:
		return actionDoctor
	}
	return actionUnknown
}

// needsValidConfig reports whether the action must not start without a config
// the runner would accept. Doctor is the sole exception: diagnosing an
// unusable config is its purpose.
func (a modeActionKind) needsValidConfig() bool {
	return a != actionDoctor
}

// runWizard runs the wizard model to completion on the real terminal and
// returns what the operator chose.
func runWizard(deps tui.WizardDeps) (tui.Result, error) {
	final, err := tea.NewProgram(tui.NewWizard(deps), tea.WithAltScreen()).Run()
	if err != nil {
		return tui.Result{}, err
	}
	wizard, ok := final.(tui.Wizard)
	if !ok {
		return tui.Result{}, fmt.Errorf("wizard returned an unexpected model %T", final)
	}
	return wizard.Result(), nil
}

// validateLaunchResult is the review screen's pre-flight: it rejects exactly
// the states interactiveConfig would refuse AFTER the TUI is gone, so the
// operator hears about them while every answer is still one esc away. It must
// stay read-only — the MCP write and the config save belong to the dispatch.
func validateLaunchResult(result tui.Result, creds Credentials) error {
	if err := validateWizardRunOverride(result); err != nil {
		return err
	}
	path := effectiveMCPConfigPath(result, creds)
	if path == "" {
		return fmt.Errorf("no MCP server config — the runner reaches the platform through MCP tools. Step back to the MCP screen and pick \"Write one for me\" or point at a checkout")
	}
	// A pending write to that path makes the template complaint moot: launching
	// is what replaces it.
	if isMCPConfigTemplate(path) && !result.MCPWrite {
		return fmt.Errorf("%s is the shipped template, not a working MCP config — a run would fail on its first platform call. Step back to the MCP screen and have the wizard write a real one", path)
	}
	if result.MCPWrite {
		if err := validateMCPWritePath(path); err != nil {
			return err
		}
	} else if err := validateMCPConfig(path); err != nil {
		return err
	}
	if result.WorkDir != "" {
		if err := config.ValidateBaseDir(result.WorkDir); err != nil {
			return err
		}
	}
	return nil
}

// effectiveMCPConfigPath is the config a launch would end up using: the
// wizard's own intent when it has one, else whatever discovery found — the
// same order applyWizardMCP resolves in.
func effectiveMCPConfigPath(result tui.Result, creds Credentials) string {
	if result.MCPConfigSkipped {
		return ""
	}
	if result.MCPConfigSelected || result.LoadedProfileName != "" {
		return result.MCPConfigPath
	}
	if result.MCPConfigPath != "" {
		return result.MCPConfigPath
	}
	return creds.MCPConfigPath
}

// interactiveConfig turns the wizard's answers into a config that satisfies
// the same validation config.Load enforces — the wizard must not be a way to
// start a runner in a state a config file could not express.
func interactiveConfig(result tui.Result, creds Credentials) (*config.Config, error) {
	if err := validateWizardRunOverride(result); err != nil {
		return nil, err
	}
	base := config.Defaults()
	if result.LoadedProfileName != "" {
		base = profileRunBaseConfig(result.LoadedProfileName)
	}
	cfg := result.Apply(base)
	cfg.Valaris.APIKey = creds.APIKey
	cfg.Valaris.APIURL = creds.APIURL
	cfg.Valaris.WorkspaceSlug = creds.Workspace
	cfg.LLM.MCPConfigPath = effectiveMCPConfigPath(result, creds)
	if cfg.LLM.MCPConfigPath != "" {
		cfg.LLM.MCPConfigPath = absoluteMCPPath(cfg.LLM.MCPConfigPath, "")
	}

	if cfg.LLM.MCPConfigPath == "" {
		return nil, fmt.Errorf("no MCP server config found — the runner reaches the platform through MCP tools. Create %s (see configs/%s) and rerun", mcpConfigFilenames[0], mcpConfigTemplateFilename)
	}
	// Starting a real run against the template would authenticate the coding
	// agent with `vlr_your_agent_key_here` and fail on the first MCP call —
	// after the wizard promised a working setup and the run began spending.
	// Refusing here costs the operator one `cp`; proceeding costs a run.
	if isMCPConfigTemplate(cfg.LLM.MCPConfigPath) {
		return nil, fmt.Errorf("%s is the shipped template, not a working MCP config — the runner would fail on its first platform call. Copy it to %s, fill in the command and key, and rerun",
			cfg.LLM.MCPConfigPath, mcpConfigFilenames[0])
	}
	if err := config.ValidateBaseDir(cfg.Git.BaseDir); err != nil {
		return nil, err
	}
	return cfg, nil
}

// saveWizardConfig writes the config, asking nothing: the wizard already
// obtained consent for this path, so an existing file there is a genuine
// conflict the operator should hear about rather than lose silently.
func saveWizardConfig(path string, cfg *config.Config) error {
	return tui.SaveConfig(path, cfg)
}

// credSource records where a resolved credential actually came from, so the
// wizard can tell the operator rather than leaving them guessing which of
// three places is in effect.
type credSource int

const (
	credSourceNone credSource = iota
	credSourceEnv
	credSourceCredentialsFile
	credSourceFile
	// credSourceWizard is a value the operator typed into the setup wizard this
	// run. It outranks every discovered source by construction — there is no
	// file or env var to attribute it to yet.
	credSourceWizard
)

func (s credSource) String() string {
	switch s {
	case credSourceEnv:
		return "environment"
	case credSourceCredentialsFile:
		return "credentials file"
	case credSourceFile:
		return "config file"
	case credSourceWizard:
		return "entered here"
	}
	return "not set"
}

// defaultAPIURL mirrors the config package's shipped default. Unlike the key
// and workspace, a missing URL is never a blocker.
const defaultAPIURL = "http://localhost:8000"

// Credentials is what the wizard needs before it can connect, plus the
// provenance of each field.
type Credentials struct {
	APIKey    string
	APIURL    string
	Workspace string

	APIKeySource    credSource
	APIURLSource    credSource
	WorkspaceSource credSource

	// ConfigPath is the discovered file that supplied at least one value, or
	// "" when none was found. The wizard offers it as the save target.
	ConfigPath string

	// MCPConfigPath is a discovered MCP server config, or the one the wizard's
	// MCP step synthesized this run (see applyWizardMCP).
	MCPConfigPath   string
	MCPConfigOrigin string
}

// overriddenBy folds the wizard's answers back over the resolved credentials.
// Each field the operator settled in the UI wins, and its source becomes the
// interactive one — doctor and the save step both report on what will actually
// be used, not on what happened to be lying around at startup.
func (c Credentials) overriddenBy(result tui.Result) Credentials {
	if result.APIURL != "" && result.APIURL != c.APIURL {
		c.APIURL, c.APIURLSource = result.APIURL, credSourceWizard
	}
	if result.APIKey != "" && result.APIKey != c.APIKey {
		c.APIKey, c.APIKeySource = result.APIKey, credSourceWizard
	}
	if result.Workspace != "" && result.Workspace != c.Workspace {
		c.Workspace, c.WorkspaceSource = result.Workspace, credSourceWizard
	}
	return c
}

// Missing names the env vars the wizard still has to prompt for. The API URL
// is absent by design — it has a working default.
func (c Credentials) Missing() []string {
	var missing []string
	if c.APIKey == "" {
		missing = append(missing, "VALARIS_API_KEY")
	}
	if c.Workspace == "" {
		missing = append(missing, "VALARIS_WORKSPACE")
	}
	return missing
}

// mcpConfigTemplateFilename is the committed placeholder that ships in every
// checkout. It names a command and a key nobody's install actually has, so
// finding it means the operator has NOT configured MCP yet — the opposite of
// what its presence would otherwise suggest.
const mcpConfigTemplateFilename = "mcp-config.example.json"

// mcpConfigFilenames are the conventional names of an MCP server config,
// searched beside every candidate runner config. The plain name is the one
// README's quickstart tells operators to create; the template follows it so
// doctor can find it and say what it is, and is ranked last so a real config
// beside it always wins.
var mcpConfigFilenames = []string{"mcp-config.json", mcpConfigTemplateFilename}

// isMCPConfigTemplate reports whether a discovered path is the shipped
// template rather than a config someone filled in.
func isMCPConfigTemplate(path string) bool {
	return filepath.Base(path) == mcpConfigTemplateFilename
}

// discoverMCPConfig finds an MCP server config next to a candidate runner
// config, and in the configs/ subdirectory of the working directory. The
// template counts as a find so callers can distinguish "nothing here" from
// "here is the placeholder you still have to fill in" — every caller then
// decides for itself whether that is usable.
func discoverMCPConfig(candidatePaths []string) string {
	candidates := discoverMCPConfigs(candidatePaths, nil)
	if len(candidates) > 0 {
		return candidates[0].Path
	}
	return ""
}

// resolveCredentials fills each field from the first source that has it, in
// precedence order: env → the wizard-written credentials file → the first
// candidate config file that parses. Resolution is per-field, so a file
// supplying only a workspace does not mask an env key. Unreadable or malformed
// candidates are skipped rather than fatal — a broken file elsewhere on disk
// must not block a newcomer's first run.
//
// Every location it reads is injected: homeDir locates the credentials file the
// same way candidatePaths locates the configs. Reaching for the ambient home
// instead made resolution depend on machine state no caller could control — the
// developer's own remembered session bled into anything that resolved.
func resolveCredentials(homeDir string, candidatePaths []string) Credentials {
	creds := Credentials{
		APIKey:    strings.TrimSpace(os.Getenv("VALARIS_API_KEY")),
		APIURL:    strings.TrimSpace(os.Getenv("VALARIS_API_URL")),
		Workspace: strings.TrimSpace(os.Getenv("VALARIS_WORKSPACE")),
	}
	if creds.APIKey != "" {
		creds.APIKeySource = credSourceEnv
	}

	if creds.APIURL != "" {
		creds.APIURLSource = credSourceEnv
	}
	if creds.Workspace != "" {
		creds.WorkspaceSource = credSourceEnv
	}

	// The credentials file is the last successful wizard run, remembered whole:
	// it outranks any runner.yaml lying around because it is the more recently
	// confirmed truth, and it is per-field so an exported env var still wins.
	remembered := readCredentialsFile(credentialsFilePath(homeDir))
	if creds.APIKey == "" && remembered.APIKey != "" {
		creds.APIKey, creds.APIKeySource = remembered.APIKey, credSourceCredentialsFile
	}
	if creds.APIURL == "" && remembered.APIURL != "" {
		creds.APIURL, creds.APIURLSource = remembered.APIURL, credSourceCredentialsFile
	}
	if creds.Workspace == "" && remembered.Workspace != "" {
		creds.Workspace, creds.WorkspaceSource = remembered.Workspace, credSourceCredentialsFile
	}

	for _, path := range candidatePaths {
		if creds.APIKey != "" && creds.APIURL != "" && creds.Workspace != "" {
			break
		}
		fileCreds, ok := readFileCredentials(path)
		if !ok {
			continue
		}
		used := false
		if creds.APIKey == "" && fileCreds.APIKey != "" {
			creds.APIKey, creds.APIKeySource, used = fileCreds.APIKey, credSourceFile, true
		}
		if creds.APIURL == "" && fileCreds.APIURL != "" {
			creds.APIURL, creds.APIURLSource, used = fileCreds.APIURL, credSourceFile, true
		}
		if creds.Workspace == "" && fileCreds.Workspace != "" {
			creds.Workspace, creds.WorkspaceSource, used = fileCreds.Workspace, credSourceFile, true
		}
		if used && creds.ConfigPath == "" {
			creds.ConfigPath = path
		}
	}

	if creds.APIURL == "" {
		creds.APIURL = defaultAPIURL
	}
	if candidates := discoverMCPConfigs(candidatePaths, nil); len(candidates) > 0 {
		creds.MCPConfigPath = candidates[0].Path
		creds.MCPConfigOrigin = candidates[0].Origin
	}
	return creds
}

// readFileCredentials parses just the valaris block of a candidate config.
// It uses a narrow struct rather than config.Load because Load validates (and
// rejects) exactly the incomplete files the wizard exists to complete.
func readFileCredentials(path string) (Credentials, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Credentials{}, false
	}
	var doc struct {
		Valaris struct {
			APIKey        string `yaml:"api_key"`
			APIURL        string `yaml:"api_url"`
			WorkspaceSlug string `yaml:"workspace_slug"`
		} `yaml:"valaris"`
	}
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return Credentials{}, false
	}
	return Credentials{
		APIKey:    usableCredential(doc.Valaris.APIKey),
		APIURL:    usableCredential(doc.Valaris.APIURL),
		Workspace: usableCredential(doc.Valaris.WorkspaceSlug),
	}, true
}

// usableCredential drops values that are only env placeholders. The shipped
// example config writes "${VALARIS_API_KEY}" literally, and the runner never
// expands it — treating that as a credential guarantees a 401.
func usableCredential(v string) string {
	v = strings.TrimSpace(v)
	if strings.HasPrefix(v, "${") && strings.HasSuffix(v, "}") {
		return ""
	}
	return v
}

// configCandidatePaths lists where a runner config conventionally lives, most
// specific first: the working directory, then the user's XDG config home.
func configCandidatePaths(homeDir, workDir string) []string {
	var paths []string
	if workDir != "" {
		paths = append(paths,
			filepath.Join(workDir, "runner.yaml"),
			filepath.Join(workDir, "configs", "runner.yaml"),
		)
	}
	if configHome := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); configHome != "" {
		paths = append(paths, filepath.Join(configHome, "backplane", "runner.yaml"))
	} else if homeDir != "" {
		paths = append(paths, filepath.Join(homeDir, ".config", "backplane", "runner.yaml"))
	}

	abs := paths[:0]
	for _, p := range paths {
		if filepath.IsAbs(p) {
			abs = append(abs, p)
		}
	}
	return abs
}

// defaultConfigPath is where the wizard offers to save. It sits in the user's
// config home rather than the CWD so a saved config is not left inside
// whatever repo the operator happened to be standing in.
func defaultConfigPath(homeDir string) string {
	if configHome := strings.TrimSpace(os.Getenv("XDG_CONFIG_HOME")); configHome != "" {
		return filepath.Join(configHome, "backplane", "runner.yaml")
	}
	if homeDir == "" {
		return ""
	}
	return filepath.Join(homeDir, ".config", "backplane", "runner.yaml")
}

// validateWorkDir gates a candidate clone root on the config package's
// worktree guard. SAFETY-CRITICAL: the runner hard-resets clones under this
// directory, so a base_dir inside a git worktree lets git walk up and rewind
// the enclosing repository — which is exactly how 25 commits were once lost.
func validateWorkDir(path string) error {
	return config.ValidateBaseDir(path)
}

// execLookPath is the real PATH probe, matching preflight's injection seam.
var execLookPath = exec.LookPath

// availableProviders reports the wizard-facing labels of the coding agents
// whose binaries actually resolve on PATH, in providerTools order. Offering a
// provider the host cannot run would only move the failure to the first card.
func availableProviders(lookPath func(string) (string, error)) []string {
	var available []string
	for _, pt := range providerTools {
		if _, err := lookPath(pt.tool.bin); err == nil {
			available = append(available, pt.tool.bin)
		}
	}
	return available
}

// boardEnrichmentConcurrency bounds the per-board fan-out in loadBoards. Each
// board costs three REST round-trips; unbounded fan-out on a large workspace
// would hammer the backend's per-agent rate limit for no latency win.
const boardEnrichmentConcurrency = 6

// wizardBackend owns the one mutable thing the wizard's effects share: the
// authenticated client. The credentials step can retarget it mid-flow, so a
// corrected host or key reaches the very next connect attempt — the wizard
// model itself still performs no I/O and holds no client.
type wizardBackend struct {
	client *valaris.Client
}

// retarget points every subsequent effect at a new host/key pair. Identity is
// deliberately dropped with the old client: it belonged to the old credentials.
func (b *wizardBackend) retarget(apiURL, apiKey string) {
	b.client = valaris.NewClient(apiURL, apiKey)
}

// newWizardDeps wires the wizard to the live backend, PATH and filesystem.
// Every effect reads backend.client at call time rather than closing over one
// instance, which is what lets the credentials step fix a wrong host without a
// restart.
func newWizardDeps(creds Credentials, homeDir, workDir string, versionString string) tui.WizardDeps {
	backend := &wizardBackend{client: valaris.NewClient(creds.APIURL, creds.APIKey)}

	configPath := creds.ConfigPath
	if configPath == "" {
		configPath = defaultConfigPath(homeDir)
	}

	// Same target the doctor's -fix would pick, so the wizard and doctor never
	// disagree about where a synthesized config belongs.
	mcpWriteTo := mcpFixTargetPath(mcpFixDeps{
		WorkDir:       workDir,
		Creds:         creds,
		MCPConfigPath: creds.MCPConfigPath,
	})

	return tui.WizardDeps{
		Connect: func(ctx context.Context) (tui.Identity, error) {
			return connectIdentity(ctx, backend.client)
		},
		Retarget: backend.retarget,
		LoadWorkspaces: func(ctx context.Context) ([]tui.WorkspaceChoice, error) {
			return loadWorkspaces(ctx, backend.client)
		},
		LoadBoards: func(ctx context.Context, workspaceSlug string) ([]tui.BoardChoice, error) {
			return loadBoards(ctx, backend.client, workspaceSlug)
		},
		LoadCompletionRequirements: func(ctx context.Context, workspace, board string) (*valaris.CompletionRequirements, error) {
			return backend.client.GetCompletionRequirements(ctx, workspace, board)
		},
		LoadCompletionWork: func(ctx context.Context, workspace, board string) (*valaris.CompletionWorkStatus, error) {
			return backend.client.GetCompletionWork(ctx, workspace, board)
		},
		ValidateWorkDir: validateWorkDir,
		RunDoctorForResult: func(ctx context.Context, result tui.Result) tui.DoctorReport {
			dcreds := wizardDoctorCredentials(result, creds)
			_, _ = rememberCredentials(homeDir, dcreds)
			return wizardDoctorReport(ctx, dcreds)
		},
		ValidateLaunch: func(result tui.Result) error {
			return validateLaunchResult(result, creds)
		},
		MCPStatus: func() tui.MCPConfigStatus {
			return tui.MCPConfigStatus{
				Path:       creds.MCPConfigPath,
				Origin:     creds.MCPConfigOrigin,
				Issue:      mcpConfigIssue(creds.MCPConfigPath),
				IsTemplate: isMCPConfigTemplate(creds.MCPConfigPath),
				WriteTo:    mcpWriteTo,
			}
		},
		DiscoverMCPConfigs: func() []tui.MCPConfigCandidate {
			return discoverMCPConfigs(configCandidatePaths(homeDir, workDir), profile.NewStore(profile.DefaultRoot()))
		},
		ValidateMCPConfig:    validateMCPConfig,
		ValidateMCPWritePath: validateMCPWritePath,
		UvxAvailable:         tui.UvxAvailable,
		ValidateMCPServerDir: validateMCPServerDir,
		Profiles:             profile.NewStore(profile.DefaultRoot()),
		Credentials:          credentialSeed(creds),
		Providers:            availableProviders(execLookPath),
		DefaultWorkDir:       defaultWorkDir(homeDir),
		DefaultModel:         config.Defaults().LLM.Model,
		DefaultBudget:        config.Defaults().LLM.MaxBudgetUSD,
		ConfigPath:           configPath,
		Version:              versionString,
	}
}

// applyWizardMCP applies explicit selection without falling back on collision or skip.
func applyWizardMCP(result tui.Result, creds Credentials) (Credentials, error) {
	if result.MCPConfigSkipped {
		creds.MCPConfigPath, creds.MCPConfigOrigin = "", "skipped"
		return creds, nil
	}
	path := effectiveMCPConfigPath(result, creds)
	if path == "" {
		if result.MCPConfigSelected {
			creds.MCPConfigPath, creds.MCPConfigOrigin = "", result.MCPConfigOrigin
			return creds, fmt.Errorf("Select an MCP config before launching")
		}
		if result.LoadedProfileName != "" {
			creds.MCPConfigPath, creds.MCPConfigOrigin = "", "profile"
		}
		return creds, nil
	}
	path = absoluteMCPPath(path, "")
	if result.MCPWrite {
		if err := tui.WriteMCPConfig(path, tui.MCPConfigSeed{
			Launch: result.MCPLaunch, APIURL: creds.APIURL, APIKey: creds.APIKey,
		}); err != nil {
			return creds, err
		}
	} else {
		creds.MCPConfigPath = path
		if result.MCPConfigOrigin != "" {
			creds.MCPConfigOrigin = result.MCPConfigOrigin
		}
		if err := validateMCPConfig(path); err != nil {
			return creds, err
		}
	}
	creds.MCPConfigPath = path
	if result.MCPConfigOrigin != "" {
		creds.MCPConfigOrigin = result.MCPConfigOrigin
	}
	return creds, nil
}

// validateMCPServerDir accepts a directory only when it holds the project
// MCPLaunchCheckout will actually run: a pyproject.toml defining the
// valaris-mcp entry point. Rejecting here beats telling the operator setup is
// done and failing on the coding agent's first platform call.
func validateMCPServerDir(dir string) error {
	pyproject := filepath.Join(dir, "pyproject.toml")
	body, err := os.ReadFile(pyproject)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("%s has no pyproject.toml — point at the mcp-server directory of a backplane checkout", dir)
		}
		return fmt.Errorf("reading %s: %w", pyproject, err)
	}
	if !strings.Contains(string(body), "valaris-mcp") {
		return fmt.Errorf("%s is not the backplane mcp-server — its pyproject.toml does not define valaris-mcp", dir)
	}
	return nil
}

// credentialSeed prefills the credentials step and names each value's origin,
// so an operator sees which of env/credentials-file/config-file is in effect
// before they change anything.
func credentialSeed(creds Credentials) tui.CredentialSeed {
	seed := tui.CredentialSeed{
		Host:      creds.APIURL,
		APIKey:    creds.APIKey,
		Workspace: creds.Workspace,
	}
	if creds.APIKeySource != credSourceNone {
		seed.APIKeySource = creds.APIKeySource.String()
	}
	if creds.APIURLSource != credSourceNone {
		seed.HostSource = creds.APIURLSource.String()
	}
	if creds.WorkspaceSource != credSourceNone {
		seed.WorkspaceSource = creds.WorkspaceSource.String()
	}
	return seed
}

// loadWorkspaces lists what the key's user can see. The agent's own
// allowed_workspaces is a SEPARATE, possibly narrower list, threaded to the
// picker so it can mark the difference instead of failing later.
func loadWorkspaces(ctx context.Context, client *valaris.Client) ([]tui.WorkspaceChoice, error) {
	workspaces, err := client.ListWorkspaces(ctx)
	if err != nil {
		return nil, err
	}
	choices := make([]tui.WorkspaceChoice, 0, len(workspaces))
	for _, ws := range workspaces {
		choices = append(choices, tui.WorkspaceChoice{ID: ws.ID, Name: ws.Name, Slug: ws.Slug})
	}
	return choices, nil
}

// defaultWorkDir proposes a clone root outside any checkout — see
// validateWorkDir for why "./repos" is not an option.
func defaultWorkDir(homeDir string) string {
	if homeDir == "" {
		return "/tmp/backplane-runner-repos"
	}
	return filepath.Join(homeDir, "backplane-runner", "repos")
}

// connectIdentity authenticates the API key and renders the result as the
// display-ready Identity the wizard shows.
func connectIdentity(ctx context.Context, client *valaris.Client) (tui.Identity, error) {
	if err := client.Init(ctx); err != nil {
		return tui.Identity{}, err
	}

	identity := tui.Identity{User: client.UserID}
	if client.Agent != nil {
		identity.AgentName = client.Agent.Name
		identity.AllowedWorkspaces = client.Agent.AllowedWorkspaces
		if tm := client.Agent.TeamMembership; tm != nil {
			identity.TeamName = tm.TeamName
			identity.TeamRole = tm.Role
		}
		if !client.Agent.IsActive {
			return identity, fmt.Errorf("agent %q is deactivated on the platform", client.Agent.Name)
		}
	}
	identity.BudgetNote = budgetNote(ctx, client)
	return identity, nil
}

// budgetNote renders the agent's remaining platform budget, or "" when the
// backend does not report one. A budget lookup failure is never fatal — it is
// informational chrome on a screen whose job is to prove auth works.
func budgetNote(ctx context.Context, client *valaris.Client) string {
	status, err := client.GetBudgetStatus(ctx)
	if err != nil || status == nil {
		return ""
	}
	if status.RemainingUSD != nil {
		return fmt.Sprintf("$%.2f of $%.2f remaining", *status.RemainingUSD, deref(status.BudgetUSD))
	}
	return fmt.Sprintf("$%.2f spent", status.SpentUSD)
}

func deref(v *float64) float64 {
	if v == nil {
		return 0
	}
	return *v
}

// loadBoards lists the workspace's boards and enriches each with the loop
// state, readiness counts and repo binding that tell an operator whether
// pointing a runner at it would accomplish anything.
//
// Enrichment is bounded-concurrent and every per-board call is best-effort: a
// board whose loop is unconfigured, or a backend too old to serve the loop
// endpoints, must render as "not set up" rather than failing the whole picker.
func loadBoards(ctx context.Context, client *valaris.Client, workspaceSlug string) ([]tui.BoardChoice, error) {
	boards, err := client.ListBoards(ctx, workspaceSlug)
	if err != nil {
		return nil, err
	}

	choices := make([]tui.BoardChoice, len(boards))
	sem := make(chan struct{}, boardEnrichmentConcurrency)
	var wg sync.WaitGroup

	for i, board := range boards {
		choices[i] = tui.BoardChoice{ID: board.ID, Name: board.Name, Slug: board.Slug}
		wg.Add(1)
		go func(i int, boardID string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			enrichBoardChoice(ctx, client, workspaceSlug, boardID, &choices[i])
		}(i, board.ID)
	}
	wg.Wait()

	return choices, nil
}

// enrichBoardChoice fills the loop/readiness/repo fields of one board in
// place. Every per-call failure is swallowed by design — an unconfigured loop
// (ErrBoardLoopNotConfigured), a backend too old to serve the endpoint
// (ErrLoopEndpointUnsupported / ErrLoopReadinessUnsupported), and a transport
// error all leave the honest zero value — an empty LoopState sends StateNote
// back to deriving the phrase from the config, and an unset config reports
// "not set up". One unreachable board must never fail the whole picker.
func enrichBoardChoice(ctx context.Context, client *valaris.Client, workspaceSlug, boardID string, choice *tui.BoardChoice) {
	if loop, err := client.GetBoardLoop(ctx, workspaceSlug, boardID); err == nil && loop != nil {
		choice.LoopConfigured = true
		choice.LoopEnabled = loop.Enabled
		choice.LoopProvider = loop.Provider
		choice.LoopModel = loop.Model
		choice.LoopBudgetLimitUSD = loop.BudgetUSD
		choice.LoopBudgetUSD = 0
		choice.BudgetHistory = nil
		choice.BudgetHistoryError = "Spending history unavailable; restore backend access before launching."
		if history, err := client.GetLoopHistory(ctx, workspaceSlug, boardID); err == nil && history != nil {
			choice.LoopBudgetUSD = max(loop.BudgetUSD-history.SpentUSD, 0)
			choice.BudgetHistory = history
			choice.BudgetHistoryError = ""
		}
	}

	// The truth layer resolves the state word the web chip shows; reading it
	// here is what keeps the two surfaces from inventing separate dialects.
	if status, err := client.GetLoopStatus(ctx, workspaceSlug, boardID); err == nil && status != nil {
		choice.LoopState = status.State
	}

	if readiness, err := client.GetLoopReadiness(ctx, workspaceSlug, boardID); err == nil && readiness != nil {
		choice.ReadyCount = readiness.ReadyCount
		choice.BlockedCount = readiness.BlockedCount
		choice.ExplicitlyBlockedCount = readiness.ExplicitlyBlockedCount
		choice.Actionable = readiness.Actionable
	}

	if repos, err := client.ListGitRepos(ctx, workspaceSlug, boardID); err == nil {
		choice.RepoCount = len(repos)
	}

	// Typed columns are what let the scheduler hand this board's cards to a
	// runner — the pipeline-mode analogue of "is the loop set up".
	if columns, err := client.GetBoard(ctx, workspaceSlug, boardID); err == nil {
		for _, col := range columns {
			if col.ColumnType != "" {
				choice.PipelineConfigured = true
				break
			}
		}
	}

	choice.StateNote = tui.StateNoteFor(
		choice.LoopState, choice.LoopEnabled, choice.LoopConfigured, choice.Actionable,
		choice.ReadyCount, choice.BlockedCount, choice.RepoCount,
	)
	choice.PipelineNote = tui.PipelineStateNoteFor(
		choice.PipelineConfigured, choice.ReadyCount, choice.BlockedCount, choice.RepoCount,
	)
}
