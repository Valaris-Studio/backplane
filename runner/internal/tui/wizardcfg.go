// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/profile"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// Mode is what the operator chose to do with the runner: it maps one-to-one
// onto the flags the non-interactive CLI already exposes, so the wizard never
// unlocks a code path a flag cannot reach.
type Mode string

const (
	ModeLoop      Mode = "loop"
	ModePipeline  Mode = "pipeline"
	ModeDiscovery Mode = "discovery"
	ModeDoctor    Mode = "doctor"
)

// BoardChoice is one row in the wizard's board picker: platform identity plus
// the enrichment that tells an operator whether pointing a runner at it would
// actually accomplish anything.
type BoardChoice struct {
	ID             string
	Name           string
	Slug           string
	LoopEnabled    bool
	LoopConfigured bool
	// LoopState is the platform's resolved loop state (off/running/parked/
	// waiting/unattended). Empty when the backend predates /loop/status, which
	// sends StateNoteFor back to deriving the phrase from the config.
	LoopState string
	// LoopProvider/LoopModel/LoopBudgetUSD mirror the board's loop config: at
	// runtime the board's provider+model win over local answers, so the wizard
	// must display them rather than re-ask. Zero values mean the board pins
	// nothing and the provider step stays fully editable.
	LoopProvider       string
	LoopModel          string
	LoopBudgetUSD      float64
	LoopBudgetLimitUSD float64
	BudgetHistory      *valaris.LoopHistory
	BudgetHistoryError string

	ReadyCount             int
	BlockedCount           int
	ExplicitlyBlockedCount int
	Actionable             bool
	RepoCount              int
	StateNote              string // loop-mode phrase, e.g. "loop off · 3 ready"
	// PipelineConfigured reports whether the board has typed columns — the
	// gate that decides if the scheduler can hand its cards to a runner.
	PipelineConfigured bool
	PipelineNote       string // pipeline-mode phrase, e.g. "pipeline ready · 3 ready"
}

// WorkspaceChoice is one row in the wizard's workspace picker. Allowed is
// resolved against the agent key's allowed_workspaces, so the picker can show
// a workspace the USER can see but this KEY cannot operate in — the difference
// that otherwise only surfaces as a run-time authorization failure.
type WorkspaceChoice struct {
	ID   string
	Name string
	Slug string
}

// CredentialSeed prefills the credentials step from whatever env and config
// files already resolved. The *Source fields are display-only prose ("environment",
// "config file") — the wizard renders them, it never parses them.
type CredentialSeed struct {
	Host       string
	HostSource string

	APIKey       string
	APIKeySource string

	Workspace       string
	WorkspaceSource string
}

// Identity is who the API key turned out to be, as the wizard's connect step
// displays it. Every field is presentation-ready: the caller does the
// formatting, the UI just renders. An empty AgentName means the key resolved
// no agent record — a personal key, which loop mode refuses.
type Identity struct {
	AgentName string
	User      string
	// AllowedWorkspaces is the agent key's allowed_workspaces, learned only once
	// the key authenticates — which is why it arrives here rather than in
	// WizardDeps. EMPTY MEANS UNRESTRICTED, matching the backend's semantics.
	AllowedWorkspaces []string
	BudgetNote        string
	// TeamName and TeamRole are the agent's team membership, when it has one.
	// The pipeline scheduler hands out work by team role, so the board picker
	// surfaces them in pipeline mode.
	TeamName string
	TeamRole string
}

// Result is the wizard's whole output: a mode plus the handful of local
// choices the backend does not own.
type Result struct {
	Mode      Mode
	BoardID   string
	BoardName string
	// APIURL, APIKey and Workspace are what the credentials and workspace steps
	// settled on. They override whatever the caller resolved before launching:
	// the whole point of those steps is that the operator can correct them.
	APIURL                       string
	APIKey                       string
	Workspace                    string
	WorkDir                      string
	Provider                     string
	Model                        string
	ExtraProviders               []string
	CompletionProvidersConfirmed bool
	// RunOverride is ephemeral and must never replace saved LLM defaults.
	RunOverride *config.ModelSelection
	BudgetUSD   float64
	// KeepAlive is loop mode's "what happens when the loop is switched off":
	// false exits, true waits for an operator to re-enable it. Meaningless in
	// pipeline mode, and Apply drops it there rather than writing a key that
	// mode never reads.
	KeepAlive bool
	// MCP* is the MCP step's intent, never its execution: the wizard records
	// where a config should go and how the server should launch, and the caller
	// does the writing. MCPConfigPath is the existing config when MCPWrite is
	// false, the destination when it is true, and empty when the operator skipped.
	MCPConfigSelected bool
	MCPConfigSkipped  bool
	MCPConfigOrigin   string
	MCPConfigPath     string
	MCPWrite          bool
	MCPLaunch         MCPLaunch
	SaveConfig        bool
	ConfigPath        string
	// ProfileName is the wizard's save-as-profile intent, never its execution:
	// the name selected on the picker, accepted at the post-connect
	// registration offer, or edited on the review screen. Empty means no
	// profile save. The caller does the writing, like MCP* and SaveConfig.
	ProfileName string
	// ProfileOverwrite records that the operator explicitly confirmed
	// replacing an existing profile of that name — without it the caller must
	// refuse to clobber.
	ProfileOverwrite bool
	// LoadedProfileName is which profile seeded this run (USE/EDIT on the
	// picker, or a credentials match), independent of any save intent: the
	// caller uses it to build the run config on the profile's own YAML
	// instead of the shipped defaults.
	LoadedProfileName string
	Cancelled         bool
}

// WizardDeps is everything the wizard UI needs from the outside world. Every
// field is injected so the screens are testable without a backend, a PATH, or
// a filesystem.
type WizardDeps struct {
	// Connect authenticates whatever the credentials step last committed. The
	// wizard passes nothing: the caller closes over the same mutable client the
	// credentials step retargets, so a corrected host reaches the next attempt.
	Connect func(context.Context) (Identity, error)
	// Retarget hands the credentials step's committed host and key to the
	// caller's client before each connect attempt. It is the ONE seam through
	// which an edited credential reaches the network layer — the model itself
	// still constructs nothing and calls nothing.
	Retarget       func(apiURL, apiKey string)
	LoadWorkspaces func(context.Context) ([]WorkspaceChoice, error)
	// LoadBoards takes the workspace the operator SELECTED, not a globally
	// resolved slug — picking a workspace and then listing another one's boards
	// is the bug this signature exists to prevent.
	LoadBoards                 func(ctx context.Context, workspaceSlug string) ([]BoardChoice, error)
	LoadCompletionRequirements func(context.Context, string, string) (*valaris.CompletionRequirements, error)
	LoadCompletionWork         func(context.Context, string, string) (*valaris.CompletionWorkStatus, error)
	ValidateWorkDir            func(path string) error
	// RunDoctor runs the machine diagnostics against the credentials the wizard
	// has committed so far and returns a presentation-ready report. It is
	// synchronous and read-only; the wizard runs it off the update loop.
	RunDoctor func(ctx context.Context, host, apiKey, workspace string) DoctorReport
	// RunDoctorForResult diagnoses the current profile and MCP selection when wired.
	RunDoctorForResult func(context.Context, Result) DoctorReport
	// ValidateLaunch is the caller's pre-flight over a finished Result: it must
	// reject exactly what the post-wizard dispatch would refuse to run, so the
	// operator hears about it on the review screen — where every answer is
	// still one esc away from editable — instead of after the TUI is gone.
	ValidateLaunch func(result Result) error
	// MCPStatus reports the discovered MCP config situation. Injected so the
	// wizard performs zero I/O and stays hermetically testable.
	MCPStatus            func() MCPConfigStatus
	DiscoverMCPConfigs   func() []MCPConfigCandidate
	ValidateMCPConfig    func(string) error
	ValidateMCPWritePath func(string) error
	// UvxAvailable reports whether the uvx launcher is on PATH. Injected rather
	// than probed so a test decides what the machine looks like.
	UvxAvailable func() bool
	// ValidateMCPServerDir checks that a typed path really is an mcp-server
	// directory, before the operator is told the setup is done.
	ValidateMCPServerDir func(dir string) error
	// Profiles is the store of saved runner profiles the wizard picks from,
	// registers new credentials into, and saves through. Nil disables every
	// profile surface, preserving the pre-profile flow exactly.
	Profiles *profile.Store
	// AllowedWorkspaces mirrors the agent key's allowed_workspaces. EMPTY MEANS
	// UNRESTRICTED, matching the backend's own semantics — reading it as "none
	// allowed" would lock every unrestricted agent out of its own picker.
	AllowedWorkspaces []string
	Credentials       CredentialSeed
	Providers         []string
	DefaultWorkDir    string
	DefaultModel      string
	DefaultBudget     float64
	ConfigPath        string
	Version           string
}

// Apply overlays the wizard's choices onto base, returning a new config so the
// wizard can re-apply as the operator walks back through the steps. A nil base
// starts from the shipped defaults. Zero-valued choices are left alone rather
// than clobbering a sane default with "".
func (r Result) Apply(base *config.Config) *config.Config {
	cfg := config.Defaults()
	if base != nil {
		clone := *base
		cfg = &clone
	}

	if r.APIURL != "" {
		cfg.Valaris.APIURL = r.APIURL
	}
	if r.APIKey != "" {
		cfg.Valaris.APIKey = r.APIKey
	}
	if r.Workspace != "" {
		cfg.Valaris.WorkspaceSlug = r.Workspace
	}
	if r.WorkDir != "" {
		cfg.Git.BaseDir = r.WorkDir
	}
	if r.Provider != "" && r.RunOverride == nil {
		cfg.LLM.Provider = NormalizeProvider(r.Provider)
	}
	if r.Model != "" && r.RunOverride == nil {
		cfg.LLM.Model = r.Model
	}
	if r.Mode == ModeLoop && r.CompletionProvidersConfirmed {
		providers := append([]string(nil), cfg.LLM.ExtraProviders...)
		seen := map[string]bool{cfg.LLM.Provider: true}
		for _, name := range providers {
			seen[name] = true
		}
		for _, name := range r.ExtraProviders {
			name = NormalizeProvider(name)
			if name != "" && !seen[name] {
				providers = append(providers, name)
				seen[name] = true
			}
		}
		cfg.LLM.ExtraProviders = providers
	}
	cfg.LLM.RunOverride = nil
	if r.Mode == ModeLoop && r.RunOverride != nil {
		selection := *r.RunOverride
		selection.Provider = NormalizeProvider(selection.Provider)
		cfg.LLM.RunOverride = &selection
	}
	if r.MCPConfigSelected || r.MCPConfigSkipped {
		cfg.LLM.MCPConfigPath = r.MCPConfigPath
		if r.MCPConfigSkipped {
			cfg.LLM.MCPConfigPath = ""
		}
	}
	if r.BudgetUSD > 0 {
		cfg.LLM.MaxBudgetUSD = r.BudgetUSD
	}
	// Only loop mode binds a single board. For the pipeline work loop
	// board_ids means "boards to monitor", where empty is the whole workspace
	// — pinning one there would silently narrow the runner's scope.
	if r.Mode == ModeLoop && r.BoardID != "" {
		cfg.Valaris.BoardIDs = []string{r.BoardID}
	}
	// Loop-mode-only, like BoardIDs above: pipeline mode never reads a board's
	// loop config, so persisting the key there would promise behaviour the
	// runner does not implement.
	if r.Mode == ModeLoop {
		cfg.LoopMode.KeepAlive = r.KeepAlive
	}
	return cfg
}

// NormalizeProvider maps a wizard-facing provider label to the config's
// provider id. The picker lists binaries the operator recognizes ("claude",
// "codex"); config.LLMConfig.Provider speaks "claude-cli"/"codex-cli", and
// buildProviders exits loudly on anything else. An already-normalized or
// unknown value passes through so a future provider needs no change here.
func NormalizeProvider(label string) string {
	switch label {
	case "claude":
		return "claude-cli"
	case "codex":
		return "codex-cli"
	}
	return label
}

// StateNoteFor renders the one-line board state phrase shown in the picker.
// It answers "would a runner do anything here?" before it answers anything
// else, because that is the question a newcomer actually has.
//
// serverState is the platform's resolved loop state (GET .../loop/status) and
// is authoritative: the picker prints it verbatim so a board never reads one
// word here and a different one in the web chip. Empty means the backend does
// not serve the truth layer (ErrLoopEndpointUnsupported), and the picker falls
// back to deriving the phrase from the loop config as it always did.
func StateNoteFor(serverState string, loopEnabled, loopConfigured, actionable bool, ready, blocked, repos int) string {
	var parts []string

	// Backends that predate server-resolved parking answer `waiting` without
	// knowing a runner is asleep. The readiness inference stands in for that
	// missing fact, so — exactly like resolveLoopChipState in the web chip —
	// it may only ever upgrade `waiting`, never contradict a resolved state.
	if serverState == "waiting" && !actionable {
		serverState = "parked"
	}

	stateKnown := serverState != ""
	switch {
	case stateKnown:
		parts = append(parts, serverState)
	case !loopConfigured:
		parts = append(parts, "loop not set up")
	case loopEnabled:
		parts = append(parts, "loop on")
	default:
		parts = append(parts, "loop off")
	}

	if stateKnown || loopConfigured {
		if actionable && ready > 0 {
			parts = append(parts, fmt.Sprintf("%d ready", ready))
		} else {
			parts = append(parts, "nothing ready")
		}
		if blocked > 0 {
			parts = append(parts, fmt.Sprintf("%d blocked", blocked))
		}
	}

	// A board with no repo cannot be worked at all — worth saying even when
	// the loop config is otherwise fine.
	if repos == 0 {
		parts = append(parts, "no repo linked")
	}

	return strings.Join(parts, " · ")
}

// PipelineStateNoteFor renders the board phrase for PIPELINE mode. Loop state
// is deliberately absent: the pipeline takes assignments from the platform
// scheduler and never reads the loop config, so "loop off" here would only
// scare an operator away from a perfectly runnable board.
func PipelineStateNoteFor(pipelineConfigured bool, ready, blocked, repos int) string {
	var parts []string

	if !pipelineConfigured {
		parts = append(parts, "pipeline not set up")
	} else if ready > 0 {
		parts = append(parts, fmt.Sprintf("%d ready", ready))
	} else {
		parts = append(parts, "nothing ready")
	}
	if pipelineConfigured && blocked > 0 {
		parts = append(parts, fmt.Sprintf("%d blocked", blocked))
	}

	// A board with no repo cannot be worked at all — worth saying even when
	// the columns are otherwise fine.
	if repos == 0 {
		parts = append(parts, "no repo linked")
	}

	return strings.Join(parts, " · ")
}

// APIKeyPlaceholder is what a saved config carries in place of the real key:
// the shipped configs/runner.example.yaml convention, resolved at load time
// from the VALARIS_API_KEY env override. Writing the literal key would leave a
// long-lived credential in a file the operator is invited to keep.
const APIKeyPlaceholder = "${VALARIS_API_KEY}"

// ErrConfigExists is returned by SaveConfig when path is already taken. The
// wizard surfaces it as a confirm prompt rather than silently replacing a
// config the operator may have hand-tuned.
var ErrConfigExists = errors.New("config file already exists")

// MarshalConfigYAML serializes cfg for saving to disk, with every credential
// elided: the platform key becomes the env placeholder, and the provider/forge
// secrets are dropped entirely (there is no placeholder convention for them,
// and a saved file must never be the thing that leaks one).
func MarshalConfigYAML(cfg *config.Config) ([]byte, error) {
	if cfg == nil {
		return nil, fmt.Errorf("marshaling config: nil config")
	}
	redacted := *cfg
	redacted.Valaris.APIKey = APIKeyPlaceholder
	redacted.LLM.AnthropicAPIKey = ""
	redacted.Git.ForgeToken = ""
	redacted.Git.Tokens = nil

	data, err := yaml.Marshal(&redacted)
	if err != nil {
		return nil, fmt.Errorf("marshaling config: %w", err)
	}
	return append([]byte(configFileHeader), data...), nil
}

const configFileHeader = "# Written by `backplane-runner` interactive setup.\n" +
	"# The API key is deliberately NOT stored here — it is read from the\n" +
	"# VALARIS_API_KEY environment variable at startup.\n"

// SaveConfig writes cfg to path with owner-only permissions, creating parent
// directories, and refuses to overwrite an existing file (ErrConfigExists).
func SaveConfig(path string, cfg *config.Config) error {
	if _, err := os.Stat(path); err == nil {
		return fmt.Errorf("%w: %s", ErrConfigExists, path)
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("checking %s: %w", path, err)
	}
	return SaveConfigOverwrite(path, cfg)
}

// SaveConfigOverwrite is SaveConfig without the clobber guard, for the path
// where the operator explicitly confirmed the replacement.
func SaveConfigOverwrite(path string, cfg *config.Config) error {
	data, err := MarshalConfigYAML(cfg)
	if err != nil {
		return err
	}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("creating %s: %w", dir, err)
		}
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("writing %s: %w", path, err)
	}
	// WriteFile leaves an existing file's mode untouched, so an overwrite of a
	// world-readable file would silently stay world-readable.
	if err := os.Chmod(path, 0o600); err != nil {
		return fmt.Errorf("securing %s: %w", path, err)
	}
	return nil
}
