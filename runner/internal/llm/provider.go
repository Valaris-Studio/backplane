// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"context"
	"time"
)

// Result holds the output from an LLM execution.
type Result struct {
	Output   string
	ExitCode int
	Duration time.Duration
	Error    error

	// Populated from stream-json output when available.
	SessionID           string
	InputTokens         int
	OutputTokens        int
	CacheCreationTokens int
	CacheReadTokens     int
	CostUSD             float64
	NumTurns            int

	// StructuredOutput holds the raw JSON object emitted via the
	// StructuredOutput tool when Options.OutputSchema is set. Empty
	// otherwise. Callers unmarshal into a typed struct.
	StructuredOutput []byte

	// UnenforcedDeny lists the Options.DisallowedTools entries this provider
	// had no channel to enforce (Codex: Claude built-ins such as WebFetch).
	// nil when every entry was applied.
	UnenforcedDeny []string
}

// Options configures an LLM execution.
// Universal fields are supported by all providers.
// Provider-specific options use either the dedicated fields (Claude CLI)
// or the Extra map (future providers).
type Options struct {
	// SourceExecutionID binds source-completion MCP calls to the execution
	// created by the harness. Empty for independent review and other launches.
	SourceExecutionID string

	// Universal options — all providers must support these
	SystemPrompt string
	Model        string
	MaxBudgetUSD float64
	WorkingDir   string   // CWD for the LLM process (e.g., git repo dir)
	AllowedTools []string // Tool restrictions (empty = all)
	OutputFormat string   // "text", "json", "stream-json"
	OutputSchema string   // JSON Schema for structured output (Claude CLI: --json-schema). Empty = freeform text.

	// Claude CLI specific — future providers use Extra for their own needs
	MCPConfigPath              string   // Path to MCP server config
	PermissionMode             string   // "auto", "bypassPermissions" — requires trusted .claude.json
	DangerouslySkipPermissions bool     // headless-autonomous launch: --permission-mode bypassPermissions + DisallowedTools deny-list
	DisallowedTools            []string // Backend-supplied per-stage tool deny-list; every driver merges in SafeToolDenyFloor (Claude: --disallowedTools; Codex: execpolicy rules in an isolated CODEX_HOME)
	ResumeSessionID            string   // Resumes an existing claude session via --resume
	ContextDirs                []string // Additional directories passed via --add-dir for prompt context injection
	AnthropicAPIKey            string   // Explicitly passed to the claude process; empty = OAuth/subscription auth

	// Provider-specific extensibility — future providers put custom options here
	Extra map[string]any
}

// SafeToolDenyFloor is the minimal security floor applied to headless-autonomous
// code-writing stages when the backend ships no per-stage deny-list. It is a
// deny-only list (the deny rule always wins regardless of permission mode, even
// under bypassPermissions), passed to the CLI via --disallowedTools.
//
// It exists because the reviewer is the only quality gate (free-plan GitHub org,
// no branch protection): without it the implementer LLM could `gh pr merge` its
// own PR or push straight to main, defeating review entirely (card 7f1d289d).
// The backend per-stage tool_policy.deny is authoritative (principle 3); this
// floor is only a fallback for an old/misconfigured backend and a buildArgs
// defense-in-depth backstop — bypassPermissions must NEVER launch with no deny.
//
// The runner's OWN force-push (git.Manager.ForceWithLeasePush) runs in a
// separate Go-controlled subprocess, NOT inside the claude session, so denying
// the LLM's force-push does not break branch recovery.
var SafeToolDenyFloor = []string{
	"Bash(gh pr merge:*)",
	"Bash(gh pr review:*)",
	"Bash(gh pr close:*)",
	"Bash(git push --force:*)",
	"Bash(git push --force-with-lease:*)",
	"Bash(git push origin main:*)",
	"Bash(git push origin master:*)",
	"Bash(git reset --hard:*)",
}

// mergeDenyFloor returns deny ∪ SafeToolDenyFloor: caller entries first
// (verbatim order), missing floor entries appended, duplicates dropped. A
// backend deny-list may EXTEND the floor, never weaken it.
func mergeDenyFloor(deny []string) []string {
	seen := make(map[string]bool, len(deny)+len(SafeToolDenyFloor))
	merged := make([]string, 0, len(deny)+len(SafeToolDenyFloor))
	for _, d := range deny {
		if !seen[d] {
			seen[d] = true
			merged = append(merged, d)
		}
	}
	for _, f := range SafeToolDenyFloor {
		if !seen[f] {
			seen[f] = true
			merged = append(merged, f)
		}
	}
	return merged
}

// Provider is the abstraction layer for LLM backends.
// v1 implements claude -p only. Future providers: direct Anthropic API,
// OpenAI API, Gemini API, local models, etc.
type Provider interface {
	// Execute sends a prompt to the LLM and returns the result.
	Execute(ctx context.Context, prompt string, opts Options) (*Result, error)

	// Name returns the provider identifier (e.g., "claude-cli", "anthropic-api").
	Name() string
}

// SessionProvider extends Provider with session resume capability.
// Providers that support resuming conversations implement this.
type SessionProvider interface {
	Provider
	SupportsResume() bool
	ResumeSession(ctx context.Context, sessionID string, prompt string, opts Options) (*Result, error)
}

// CostProvider extends Provider with cost tracking capability.
// Providers that report token usage and cost implement this.
type CostProvider interface {
	Provider
	SupportsCostTracking() bool
}

// ToolProvider extends Provider with tool/MCP configuration capability.
type ToolProvider interface {
	Provider
	SupportsToolConfig() bool
}

// Capabilities declares what a coding-agent backend can actually do, so the
// runner adapts instead of assuming the Claude feature set. A provider that
// reports !CostUSD but Tokens lets the loop fall back to a token×price-map
// estimate; !StructuredOutput (e.g. Aider) forces reliance on git-after-run;
// AutoCommits flips capture from staging-then-diff to reading the agent's own
// commits. The flags collapse the per-provider capability matrix surfaced by
// the 2026 coding-agent survey into one struct the loop can branch on.
type Capabilities struct {
	StructuredOutput bool // emits a machine-parseable structured payload (Claude --json-schema, Codex --output-schema)
	CostUSD          bool // reports dollar cost natively
	Tokens           bool // reports token counts (lets the loop estimate cost when !CostUSD)
	SessionResume    bool // supports resuming a prior session/thread
	NativeMCP        bool // can be handed an MCP server config
	AutoCommits      bool // commits its own changes (capture reads commits, not the staged diff)
	// BudgetCap: the CLI accepts a per-session dollar ceiling and aborts on it
	// (Claude --max-budget-usd; Codex has no equivalent). Caveat even when
	// true: Claude's flag meters API-billed dollars only — under
	// subscription/OAuth auth the CLI's cost counter stays 0 and the cap
	// cannot bind (field-verified: a $31 estimated session under a $10 cap).
	BudgetCap bool
	// EnforcesShellDeny: the driver applies the shell deny-floor
	// (SafeToolDenyFloor + backend deny) to the coding agent's shell, and
	// ShellDenyMechanism names how ("disallowed-tools" for Claude,
	// "execpolicy-rules" for Codex) so the launch log can tell an operator
	// how the floor is held on this host. Both share the nested-shell
	// limitation: `bash -lc "gh pr merge 1"` escapes a literal prefix match.
	EnforcesShellDeny  bool
	ShellDenyMechanism string
}

// ShellDenyReporter lets the workloop ask a provider, BEFORE launch, which
// deny entries it cannot enforce so the launch log can warn. A provider that
// does not implement it enforces every entry it is handed (Claude).
type ShellDenyReporter interface {
	UnenforceableDeny(deny []string) []string
}

// CapabilityProvider is the unified, forward-looking replacement for the
// per-capability sub-interfaces (SessionProvider/CostProvider/ToolProvider).
// New providers implement this; the legacy sub-interfaces remain for existing
// call sites and must stay consistent with Capabilities (see ClaudeCLI).
type CapabilityProvider interface {
	Provider
	Capabilities() Capabilities
}

// BudgetEnforcementProvider distinguishes a supported cap flag from a cap
// that can bind with this invocation's authentication. Missing means advisory.
type BudgetEnforcementProvider interface {
	CanEnforceBudget(Options) bool
}

// ExecutableProvider exposes a local prerequisite without invoking the model.
type ExecutableProvider interface {
	Executable() string
}
