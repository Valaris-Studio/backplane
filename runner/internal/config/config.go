// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Valaris   ValarisConfig   `yaml:"valaris"`
	LLM       LLMConfig       `yaml:"llm"`
	Git       GitConfig       `yaml:"git"`
	WorkLoop  WorkLoopConfig  `yaml:"work_loop"`
	LoopMode  LoopModeConfig  `yaml:"loop_mode"`
	Daemon    DaemonConfig    `yaml:"daemon"`
	WebSocket WebSocketConfig `yaml:"websocket"`
	Telemetry TelemetryConfig `yaml:"telemetry"`
	LogLevel  string          `yaml:"log_level"`
}

type TelemetryConfig struct {
	Enabled     bool    `yaml:"enabled"`
	Exporter    string  `yaml:"exporter"` // "otlp" | "stdout" | "none"
	Endpoint    string  `yaml:"endpoint"` // OTLP gRPC endpoint
	ServiceName string  `yaml:"service_name"`
	SampleRate  float64 `yaml:"sample_rate"` // 0.0-1.0
}

type DaemonConfig struct {
	DrainTimeout time.Duration `yaml:"drain_timeout"`
	HealthPort   int           `yaml:"health_port"`
	// HealthBind scopes the unauthenticated /healthz + /pollnow server.
	// Defaults to loopback; set "0.0.0.0" to deliberately expose it.
	HealthBind string `yaml:"health_bind"`
}

type WebSocketConfig struct {
	Enabled      bool          `yaml:"enabled"`
	ReconnectMin time.Duration `yaml:"reconnect_min"`
	ReconnectMax time.Duration `yaml:"reconnect_max"`
}

// ValarisConfig holds the minimum the agent needs to authenticate and know
// which workspace to operate in. Role dispatch is owned by the platform's
// pipeline_config (GET /api/agents/me/config) and is intentionally NOT part
// of the YAML config — the agent is not the source of truth for roles.
type ValarisConfig struct {
	// APIURL is the backend URL used ONLY for startup identity check (GET /api/me).
	// All other operations go through MCP tools via the LLM.
	APIURL string `yaml:"api_url"`

	// APIKey is the Bearer vlr_... token linked to an Agent record.
	// Used for identity check AND passed to the MCP server config.
	APIKey string `yaml:"api_key"`

	// WorkspaceSlug is passed to the LLM prompt so it knows which workspace to operate in.
	WorkspaceSlug string `yaml:"workspace_slug"`

	// BoardIDs to monitor. Each entry is an opaque identifier — either a board
	// slug ("my-board") or UUID. Backend /boards/{identifier} resolves either.
	// Empty = all boards in workspace.
	BoardIDs []string `yaml:"board_ids"`
}

// ModelSelection is a concrete provider/model pair selected for one process run.
// It does not alter the board or the persisted runner configuration.
type ModelSelection struct {
	Provider string
	Model    string
}

// Validate accepts custom model IDs without maintaining a provider model catalog.
func (s *ModelSelection) Validate() error {
	if s == nil {
		return nil
	}
	if s.Provider != "claude-cli" && s.Provider != "codex-cli" {
		return fmt.Errorf("run model override requires provider claude-cli or codex-cli, got %q", s.Provider)
	}
	model := strings.TrimSpace(s.Model)
	if model == "" {
		return fmt.Errorf("run model override requires a concrete model")
	}
	if model != s.Model {
		return fmt.Errorf("run model override model must not have leading or trailing whitespace")
	}
	// Execution telemetry stores the concrete model in a 100-character column.
	// Count Unicode characters, not UTF-8 bytes, matching the platform boundary.
	if !utf8.ValidString(model) || utf8.RuneCountInString(model) > 100 {
		return fmt.Errorf("run model override model must be valid UTF-8 and at most 100 characters")
	}
	switch strings.ToLower(model) {
	case "premium", "mid", "low":
		return fmt.Errorf("run model override requires a concrete model, not tier %q", s.Model)
	}
	for _, r := range s.Model {
		if unicode.IsControl(r) {
			return fmt.Errorf("run model override model must not contain control characters")
		}
	}
	return nil
}

type LLMConfig struct {
	// RunOverride is an explicit per-run choice, never read from or saved to YAML.
	RunOverride                *ModelSelection   `yaml:"-"`
	Provider                   string            `yaml:"provider"`
	Model                      string            `yaml:"model"`
	ModelOverrides             map[string]string `yaml:"model_overrides"` // phase -> model (e.g. "discover": "haiku")
	MaxBudgetUSD               float64           `yaml:"max_budget_usd"`
	MCPConfigPath              string            `yaml:"mcp_config_path"`
	PermissionMode             string            `yaml:"permission_mode"`
	DangerouslySkipPermissions bool              `yaml:"dangerously_skip_permissions"`
	SessionPersistence         bool              `yaml:"session_persistence"`
	ContextDirs                []string          `yaml:"context_dirs"`
	AnthropicAPIKey            string            `yaml:"anthropic_api_key"`

	// ExtraProviders lists additional coding-agent providers (beyond Provider)
	// the runner should build at startup, so a pipeline can mix agents per
	// stage — e.g. Provider=codex-cli for implementer while the ui_validator
	// stage declares claude-cli (it needs the Claude visual-testing skill). The
	// backend pipeline_config picks the per-stage provider; this only declares
	// which provider binaries the runner makes available + preflights. The
	// default Provider is always built; extras are opt-in.
	ExtraProviders []string `yaml:"extra_providers"`

	// TierProviders maps an abstract backend tier (premium/mid/low) to an
	// ordered preference list of local coding-agent providers. The backend
	// emits the tier as provider-agnostic INTENT (AssignmentLLM.Tier); the
	// runner owns the policy of which local agent serves it, picking the first
	// entry it actually built. This makes the backend model a suggestion: a host
	// with only claude-cli and one with codex-cli can serve the same board
	// without backend changes. An unmapped tier (or a stage with no tier) falls
	// back to the backend-resolved provider, then the default Provider.
	TierProviders map[string][]string `yaml:"tier_providers"`

	// BudgetSuspend tunes the Cluster I checkpoint-and-resume behavior on a
	// per-pass budget cutoff. Zero values fall back to documented safe defaults
	// (see SuspendThreshold / SuspendMaxPasses).
	BudgetSuspendThreshold float64 `yaml:"budget_suspend_threshold"`
	BudgetSuspendMaxPasses int     `yaml:"budget_suspend_max_passes"`
}

// SuspendThreshold returns the configured budget-cutoff threshold fraction, or
// the safe default (0.9) when unset/invalid. The fraction of the effective
// per-card budget an implement pass must reach before erroring to count as a
// cutoff (vs an ordinary early failure).
func (c *LLMConfig) SuspendThreshold() float64 {
	if c.BudgetSuspendThreshold > 0 {
		return c.BudgetSuspendThreshold
	}
	return 0.9
}

// SuspendMaxPasses returns the configured terminal-guard pass cap, or the safe
// default (5) when unset/invalid. Counts completed checkpoint-suspends before a
// card escalates to the normal failure path instead of suspending again.
func (c *LLMConfig) SuspendMaxPasses() int {
	if c.BudgetSuspendMaxPasses > 0 {
		return c.BudgetSuspendMaxPasses
	}
	return 5
}

// ProviderSet returns the distinct set of coding-agent providers the runner
// should build: default, per-run override, extras and tier preferences,
// deduped with empties dropped. Default and override precede extras in declared
// order; tier map order is unspecified. Used to build the per-stage provider registry and to preflight every
// provider the pipeline can name (not just the default).
func (c *LLMConfig) ProviderSet() []string {
	seen := make(map[string]bool)
	var out []string
	add := func(p string) {
		if p == "" || seen[p] {
			return
		}
		seen[p] = true
		out = append(out, p)
	}
	add(c.Provider)
	if c.RunOverride != nil {
		add(c.RunOverride.Provider)
	}
	for _, p := range c.ExtraProviders {
		add(p)
	}
	// A provider named only in a tier preference list must also be built, else
	// a tier remap could select an unbuilt provider. Map iteration order is
	// undefined, but the default-first invariant holds (added above).
	for _, list := range c.TierProviders {
		for _, p := range list {
			add(p)
		}
	}
	return out
}

// ProvidersForTier returns the runner's ordered provider preference list for an
// abstract tier, or nil when the tier is empty or unmapped. The caller picks
// the first entry it actually built.
func (c *LLMConfig) ProvidersForTier(tier string) []string {
	if tier == "" {
		return nil
	}
	return c.TierProviders[tier]
}

// ModelForPhase returns the model to use for a specific phase.
// Falls back to the default model if no override is configured.
func (c *LLMConfig) ModelForPhase(phase string) string {
	if m, ok := c.ModelOverrides[phase]; ok && m != "" {
		return m
	}
	return c.Model
}

type GitConfig struct {
	BaseDir       string `yaml:"base_dir"`
	DefaultRemote string `yaml:"default_remote"`
	BranchPrefix  string `yaml:"branch_prefix"`
	AutoPR        bool   `yaml:"auto_pr"`
	MergeStrategy string `yaml:"merge_strategy"`
	// Forge selects the forge driver the runner uses for PR/MR open/review/merge:
	// "github" (default — shells the `gh` CLI) or "gitea" (Gitea/Forgejo REST API).
	// This is the construction-time selector; the runner builds ONE forge driver at
	// startup. The platform-supplied GitRepo.Provider remains a per-repo guard (e.g.
	// skip branch protection for non-github), it does NOT swap the driver mid-run.
	Forge string `yaml:"forge"`
	// ForgeBaseURL/ForgeToken are required by non-CLI forge drivers (gitea) that
	// speak HTTP directly — the github driver infers everything from the local
	// clone's `gh` auth and ignores both. Token is a forge access token; it is
	// separate from git.tokens (those are per-role GH_TOKENs for the `gh` CLI).
	ForgeBaseURL   string `yaml:"forge_base_url"`
	ForgeToken     string `yaml:"forge_token"`
	ReviewOnGitHub bool   `yaml:"review_on_github"`
	ReviewMode     string `yaml:"review_mode"` // "platform" (comment-only, default — single-identity installs can't self-approve) or "github" (formal gh pr review, requires a second identity, e.g. GitHub App reviewer bot)
	ForceWithLease bool   `yaml:"force_with_lease"`
	// Cluster III: auto_merge / merge_trigger removed. The runner never arms
	// GitHub auto-merge; the reviewer's merge_pr after an approve verdict is
	// the only merge path. Old YAML keys parse harmlessly (non-strict unmarshal).
	Tokens map[string]string `yaml:"tokens"` // Per-role GH_TOKEN overrides, e.g. {"reviewer": "ghp_xxx"}
}

type SchedulingConfig struct {
	Strategy      string   `yaml:"strategy"`       // "priority" (only option for now)
	PriorityOrder []string `yaml:"priority_order"` // e.g. ["reviewer", "orchestrator", "documentator"]
	// Mode picks the runtime selection algorithm, overriding the platform
	// scheduling.mode when non-empty. Values: "priority" | "round_robin".
	Mode string `yaml:"mode"`

	// Deprecated: retained so old YAML files still parse cleanly. Runtime
	// ignores both; the consecutive + starvation guard was removed because it
	// overrode user priority intent.
	MaxConsecutive       int  `yaml:"max_consecutive_same_role"`
	StarvationPrevention bool `yaml:"starvation_prevention"`
}

// LoopModeConfig tunes -loop mode. Separate from WorkLoopConfig because loop
// mode shares none of the pipeline work loop's card/scheduler state — only the
// provider registry (see docs/loop-mode-contract.md).
type LoopModeConfig struct {
	// KeepAlive makes a loop-off a pause rather than an exit: the runner stays
	// connected, heartbeats, and resumes when an operator switches the loop
	// back on. Default false, so a runner launched before this field existed
	// keeps exiting on loop-off exactly as it did.
	KeepAlive bool `yaml:"keep_alive"`
}

type WorkLoopConfig struct {
	PollInterval time.Duration `yaml:"poll_interval"`
	// Deprecated: retained so old YAML files still parse cleanly. Runtime never
	// reads it — one Loop always runs one strategy tick at a time; see the
	// concurrency-model comment on Loop.scheduledTick.
	MaxConcurrent        int              `yaml:"max_concurrent"`
	CardTimeout          time.Duration    `yaml:"card_timeout"`
	IdleSleep            time.Duration    `yaml:"idle_sleep"`
	MaxIdleInterval      time.Duration    `yaml:"max_idle_interval"`
	Priorities           []string         `yaml:"priorities"`
	ApprovalPollInterval time.Duration    `yaml:"approval_poll_interval"`
	ApprovalMaxWait      time.Duration    `yaml:"approval_max_wait"`
	Scheduling           SchedulingConfig `yaml:"scheduling"`
}

// Defaults returns a fresh Config carrying the shipped defaults — the same
// starting point Load uses before a YAML file, env overrides, and validation
// are applied. Exported so the interactive wizard can build a config from
// scratch without inventing a second set of defaults.
func Defaults() *Config { return defaults() }

// ValidateBaseDir reports whether path is a safe git.base_dir. It is the
// worktree guard from validate(), exposed so a caller can check a candidate
// directory BEFORE committing to it. Rejecting a base_dir inside a git
// worktree is safety-critical: the runner hard-resets clones under this
// directory, and git walks up to the enclosing repository.
func ValidateBaseDir(path string) error {
	if path == "" {
		return fmt.Errorf("git.base_dir is empty")
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return fmt.Errorf("resolving git.base_dir: %w", err)
	}
	worktree, err := enclosingWorktree(abs)
	if err != nil {
		return err
	}
	if worktree != "" {
		return baseDirInsideWorktreeError(abs, worktree)
	}
	return nil
}

func baseDirInsideWorktreeError(baseDir, worktree string) error {
	return fmt.Errorf(
		"git.base_dir %q is inside the git worktree %q: the runner hard-resets clones under this "+
			"directory, and git would walk up and rewind that repository — point base_dir outside any "+
			"git worktree (e.g. /tmp/backplane-runner-repos)",
		baseDir, worktree)
}

func Load(path string) (*Config, error) {
	cfg := defaults()

	if path != "" {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("reading config file: %w", err)
		}
		if err := yaml.Unmarshal(data, cfg); err != nil {
			return nil, fmt.Errorf("parsing config file: %w", err)
		}
	}

	applyEnvOverrides(cfg)

	// Relative paths anchor to the config file's directory, so a runner's clone
	// root does not move with the process CWD. With no config file there is no
	// such anchor and CWD is the only base available.
	configDir := ""
	if path != "" {
		abs, err := filepath.Abs(path)
		if err != nil {
			return nil, fmt.Errorf("resolving config path: %w", err)
		}
		configDir = filepath.Dir(abs)
	}

	if err := validate(cfg, configDir); err != nil {
		return nil, fmt.Errorf("config validation: %w", err)
	}

	return cfg, nil
}

func defaults() *Config {
	return &Config{
		Valaris: ValarisConfig{
			APIURL: "http://localhost:8000",
		},
		LLM: LLMConfig{
			Provider:                   "claude-cli",
			Model:                      "sonnet",
			MaxBudgetUSD:               1.0,
			DangerouslySkipPermissions: true,
			SessionPersistence:         true,
		},
		Git: GitConfig{
			DefaultRemote:  "origin",
			BranchPrefix:   "runner/",
			AutoPR:         true,
			MergeStrategy:  "squash",
			Forge:          "github",
			ReviewOnGitHub: true,
			ReviewMode:     "platform",
			ForceWithLease: true,
		},
		WorkLoop: WorkLoopConfig{
			PollInterval:         2 * time.Minute,
			CardTimeout:          30 * time.Minute,
			IdleSleep:            5 * time.Minute,
			MaxIdleInterval:      16 * time.Minute,
			Priorities:           []string{"urgent", "high", "medium", "low"},
			ApprovalPollInterval: 30 * time.Second,
			ApprovalMaxWait:      1 * time.Hour,
			// Scheduling intentionally has no defaults — the platform's
			// pipeline_config.scheduling is authoritative. YAML may override
			// Mode; PriorityOrder must come from the platform.
			Scheduling: SchedulingConfig{
				Strategy: "priority",
			},
		},
		Daemon: DaemonConfig{
			DrainTimeout: 60 * time.Second,
			HealthPort:   0,
			HealthBind:   "127.0.0.1",
		},
		WebSocket: WebSocketConfig{
			Enabled:      true,
			ReconnectMin: 1 * time.Second,
			ReconnectMax: 30 * time.Second,
		},
		Telemetry: TelemetryConfig{
			Enabled:     false,
			Exporter:    "otlp",
			Endpoint:    "localhost:4317",
			ServiceName: "backplane-runner",
			SampleRate:  1.0,
		},
		LogLevel: "info",
	}
}

func applyEnvOverrides(cfg *Config) {
	if v := os.Getenv("VALARIS_API_URL"); v != "" {
		cfg.Valaris.APIURL = v
	}
	if v := os.Getenv("VALARIS_API_KEY"); v != "" {
		cfg.Valaris.APIKey = v
	}
	if v := os.Getenv("VALARIS_WORKSPACE"); v != "" {
		cfg.Valaris.WorkspaceSlug = v
	}
	// NOTE: ANTHROPIC_API_KEY is intentionally NOT read from env here.
	// The runner strips it from the subprocess env so claude -p uses
	// OAuth/subscription auth (Claude Code Max) by default. Users who
	// want API credits must set anthropic_api_key explicitly in the YAML.

	if v := os.Getenv("VALARIS_WS_ENABLED"); v == "false" || v == "0" {
		cfg.WebSocket.Enabled = false
	}
}

func validate(cfg *Config, configDir string) error {
	if cfg.Valaris.APIKey == "" {
		return fmt.Errorf("valaris.api_key is required (set via config or VALARIS_API_KEY env)")
	}
	if cfg.Valaris.WorkspaceSlug == "" {
		return fmt.Errorf("valaris.workspace_slug is required (set via config or VALARIS_WORKSPACE env)")
	}
	if cfg.LLM.MCPConfigPath == "" {
		return fmt.Errorf("llm.mcp_config_path is required (path to MCP server config for claude -p)")
	}
	// Resolve relative paths to absolute so they work when WorkingDir changes.
	// Both path fields anchor to the config file's directory: resolving siblings
	// against different bases is a trap for whoever reads the YAML next.
	mcpConfigPath, err := expandTilde(cfg.LLM.MCPConfigPath)
	if err != nil {
		return fmt.Errorf("resolving mcp_config_path: %w", err)
	}
	if !filepath.IsAbs(mcpConfigPath) {
		mcpConfigPath, err = resolveAgainst(configDir, mcpConfigPath)
		if err != nil {
			return fmt.Errorf("resolving mcp_config_path: %w", err)
		}
	}
	cfg.LLM.MCPConfigPath = mcpConfigPath

	// An empty base_dir is the shipped default and makes filepath.Join("", name)
	// CWD-relative, so it needs the same anchoring as an explicit relative path.
	baseDir, err := expandTilde(cfg.Git.BaseDir)
	if err != nil {
		return fmt.Errorf("resolving git.base_dir: %w", err)
	}
	if !filepath.IsAbs(baseDir) {
		baseDir, err = resolveAgainst(configDir, baseDir)
		if err != nil {
			return fmt.Errorf("resolving git.base_dir: %w", err)
		}
	}
	cfg.Git.BaseDir = baseDir
	if worktree, err := enclosingWorktree(cfg.Git.BaseDir); err != nil {
		return err
	} else if worktree != "" {
		return baseDirInsideWorktreeError(cfg.Git.BaseDir, worktree)
	}
	return nil
}

// resolveAgainst turns a relative path into an absolute one anchored at base,
// falling back to the process CWD when no anchor is available.
func resolveAgainst(base, path string) (string, error) {
	if base == "" {
		return filepath.Abs(path)
	}
	return filepath.Join(base, path), nil
}

// expandTilde rewrites a leading ~/ (or a bare ~) to the user's home directory.
// The platform's agent-config export emits ~-prefixed paths, so this is the
// shape operators paste in; left literal it becomes a "~" directory under the
// config dir and fails at clone time rather than at startup. Only a leading ~
// path segment is a home reference — "./repos~backup" is an ordinary name, and
// "~other/x" is another user's home, which we do not resolve.
func expandTilde(path string) (string, error) {
	if path != "~" && !strings.HasPrefix(path, "~"+string(filepath.Separator)) {
		return path, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("expanding %q: %w", path, err)
	}
	if path == "~" {
		return home, nil
	}
	return filepath.Join(home, path[2:]), nil
}

// enclosingWorktree returns the nearest ancestor of dir (dir included) that is a
// git worktree, or "" if there is none. Intermediate directories need not exist
// yet — the runner creates its clone root lazily, so the walk is purely lexical
// above the deepest existing path.
//
// Symlinks on the existing prefix are resolved first: git resolves them before
// looking for .git, so a lexical-only walk would climb a symlinked base_dir's
// own parents and miss the worktree its target actually sits in.
func enclosingWorktree(dir string) (string, error) {
	start, err := resolveExistingPrefix(filepath.Clean(dir))
	if err != nil {
		return "", err
	}
	for cur := start; ; {
		info, err := os.Stat(filepath.Join(cur, ".git"))
		if err == nil && (info.IsDir() || info.Mode().IsRegular()) {
			return cur, nil
		}
		if err != nil && !os.IsNotExist(err) {
			return "", fmt.Errorf("checking for a git worktree at %s: %w", cur, err)
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return "", nil
		}
		cur = parent
	}
}

// resolveExistingPrefix expands symlinks over the longest existing prefix of
// path, re-joining the not-yet-created remainder. EvalSymlinks fails outright on
// a missing leaf, so it cannot be called on the clone root directly.
func resolveExistingPrefix(path string) (string, error) {
	for probe, rest := path, ""; ; {
		resolved, err := filepath.EvalSymlinks(probe)
		if err == nil {
			return filepath.Join(resolved, rest), nil
		}
		if !os.IsNotExist(err) {
			return "", fmt.Errorf("resolving symlinks under %s: %w", probe, err)
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			return path, nil
		}
		rest = filepath.Join(filepath.Base(probe), rest)
		probe = parent
	}
}
