// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

const stderrTailCap = 64 << 10 // 64 KiB

// tailBuffer captures the last cap bytes of writes; older bytes are dropped.
// The trailing-tail heuristic matches what error logs need: the most recent
// lines before process exit usually carry the failure, not the setup noise.
type tailBuffer struct {
	cap     int
	buf     []byte
	dropped bool
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if n > t.cap {
		t.buf = append(t.buf[:0], p[n-t.cap:]...)
		t.dropped = true
		return n, nil
	}
	if len(t.buf)+n > t.cap {
		drop := len(t.buf) + n - t.cap
		t.buf = append(t.buf[:0], t.buf[drop:]...)
		t.dropped = true
	}
	t.buf = append(t.buf, p...)
	return n, nil
}

func (t *tailBuffer) String() string {
	if t.dropped {
		return "[stderr truncated to " + strconv.Itoa(t.cap) + " bytes]\n" + string(t.buf)
	}
	return string(t.buf)
}

// Compile-time interface checks
var (
	_ Provider           = (*ClaudeCLI)(nil)
	_ SessionProvider    = (*ClaudeCLI)(nil)
	_ CostProvider       = (*ClaudeCLI)(nil)
	_ ToolProvider       = (*ClaudeCLI)(nil)
	_ CapabilityProvider = (*ClaudeCLI)(nil)
)

// ClaudeCLI implements Provider by shelling out to `claude -p`.
// Each call spawns a new claude process with the given MCP config.
type ClaudeCLI struct {
	// ClaudeBin is the path to the claude binary. Defaults to "claude".
	ClaudeBin string
}

// NewClaudeCLI creates a provider that uses the claude CLI.
func NewClaudeCLI() *ClaudeCLI {
	return &ClaudeCLI{ClaudeBin: "claude"}
}

func (c *ClaudeCLI) Name() string {
	return "claude-cli"
}

func (c *ClaudeCLI) CanEnforceBudget(opts Options) bool {
	return opts.AnthropicAPIKey != ""
}

func (c *ClaudeCLI) Execute(ctx context.Context, prompt string, opts Options) (*Result, error) {
	// Materialize a per-launch MCP config whenever a template is configured,
	// so the spawned MCP server boots with VALARIS_MCP_TOOLSETS=all and — for a
	// non-empty grant — VALARIS_MCP_ALLOWLIST in its env and can enforce the
	// allowlist server-side. Server-side enforcement is the authoritative gate
	// for mcp__valaris__* tools (the --allowedTools list is advisory). See
	// design doc §2. An EMPTY grant is the full surface and gets no allowlist,
	// but still needs the toolsets pin: without it a template lacking the key
	// would hand the session the server's clipped default hand. The dangerous
	// Bash/gh surface is constrained separately via the --disallowedTools
	// deny-list in buildArgs.
	if opts.MCPConfigPath != "" {
		dynamicPath, cleanup, err := writeDynamicMCPConfig(opts.MCPConfigPath, opts.AllowedTools, opts.SourceExecutionID)
		if err != nil {
			return nil, fmt.Errorf("mcp-config materialize: %w", err)
		}
		defer cleanup()
		opts.MCPConfigPath = dynamicPath
	}

	args := c.buildArgs(prompt, opts)

	bin := c.ClaudeBin
	if bin == "" {
		bin = "claude"
	}

	slog.Info("claude -p starting",
		"model", opts.Model,
		"working_dir", opts.WorkingDir,
		"mcp_config", opts.MCPConfigPath,
	)

	cmd := exec.CommandContext(ctx, bin, args...)

	// Card 40424fb3 — put claude in its own process group so a runner crash
	// doesn't orphan the whole subtree. The runner can clean up by signalling
	// the negative pgid on shutdown.
	setProcessGroup(cmd)

	// Build explicit env: inherit parent env but strip ANTHROPIC_API_KEY,
	// then only set it if explicitly configured. This ensures claude -p
	// falls back to OAuth/subscription auth (Claude Code Max) by default.
	cmd.Env = filterEnv(filterEnv(os.Environ(), "ANTHROPIC_API_KEY"), SourceExecutionEnvKey)
	if opts.AnthropicAPIKey != "" {
		cmd.Env = append(cmd.Env, "ANTHROPIC_API_KEY="+opts.AnthropicAPIKey)
	}

	if opts.WorkingDir != "" {
		cmd.Dir = opts.WorkingDir
	}

	var stdout bytes.Buffer
	stderr := &tailBuffer{cap: stderrTailCap}
	cmd.Stdout = &stdout
	cmd.Stderr = stderr

	start := time.Now()
	err := cmd.Run()
	duration := time.Since(start)

	result := &Result{
		Duration: duration,
	}

	// Parse stream-json output for cost/session metadata.
	text, meta := parseStreamJSON(stdout.String())
	result.Output = text
	if meta != nil {
		result.SessionID = meta.SessionID
		result.InputTokens = meta.InputTokens
		result.OutputTokens = meta.OutputTokens
		result.CacheCreationTokens = meta.CacheCreationTokens
		result.CacheReadTokens = meta.CacheReadTokens
		result.CostUSD = meta.CostUSD
		result.NumTurns = meta.NumTurns
		result.StructuredOutput = meta.StructuredOutput
	}

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
			result.Error = fmt.Errorf("claude exited with code %d: %s", result.ExitCode, stderr.String())
		} else {
			result.Error = fmt.Errorf("failed to run claude: %w", err)
		}
		// A subprocess that crashes mid-stream may have emitted a partial
		// structured_output frame. Callers (e.g. the reviewer) parse that
		// payload as authoritative; trusting it on non-zero exit risks
		// acting on a half-written or aborted decision. Force callers
		// onto the free-text fallback by discarding the payload here.
		result.StructuredOutput = nil
	}

	slog.Info("claude -p completed",
		"duration", duration.Round(time.Second),
		"exit_code", result.ExitCode,
		"output_len", len(result.Output),
		"cost_usd", result.CostUSD,
		"tokens_in", result.InputTokens,
		"tokens_out", result.OutputTokens,
		"session_id", result.SessionID,
	)

	return result, result.Error
}

func (c *ClaudeCLI) buildArgs(prompt string, opts Options) []string {
	// Prompt must immediately follow -p as its positional argument.
	args := []string{"-p", prompt, "--verbose"}

	// Always use stream-json for cost/session tracking. The parser extracts
	// the text output from the structured events.
	args = append(args, "--output-format", "stream-json")

	if opts.MCPConfigPath != "" {
		args = append(args, "--mcp-config", opts.MCPConfigPath, "--strict-mcp-config")
	}

	if opts.Model != "" {
		args = append(args, "--model", opts.Model)
	}

	if opts.SystemPrompt != "" {
		args = append(args, "--system-prompt", opts.SystemPrompt)
	}

	if opts.MaxBudgetUSD > 0 {
		args = append(args, "--max-budget-usd", fmt.Sprintf("%.2f", opts.MaxBudgetUSD))
	}

	if opts.OutputSchema != "" {
		args = append(args, "--json-schema", opts.OutputSchema)
	}

	// Autonomous code-writing stages run headless with full tool access
	// (Write/Edit/Read/Bash/MCP) via --permission-mode bypassPermissions, then
	// constrain only the dangerous surface with a deny-list passed to
	// --disallowedTools. Deny rules always win regardless of permission mode, so
	// the implementer still cannot `gh pr merge` its own PR or push to main
	// (card 7f1d289d). The earlier dontAsk + --settings allow-list was wrong:
	// under dontAsk any tool not allow-listed is auto-denied, so Write/Edit/Read
	// were all blocked and every implement card failed instantly.
	if opts.DangerouslySkipPermissions {
		args = append(args, "--permission-mode", "bypassPermissions")
	} else if opts.PermissionMode != "" {
		args = append(args, "--permission-mode", opts.PermissionMode)
	}

	// SafeToolDenyFloor rides on EVERY session, not only bypassPermissions
	// (card 1e315263): a loop session with skip-permissions false previously
	// launched with no --disallowedTools at all, leaving `gh pr merge`
	// governed by nothing — the MCP allowlist and permission mode don't reach
	// shell. A backend-supplied deny-list (opts.DisallowedTools, from the
	// assignment's llm.tool_policy.deny) EXTENDS the floor, never replaces it.
	deny := mergeDenyFloor(opts.DisallowedTools)
	source := "merged"
	if len(opts.DisallowedTools) == 0 {
		source = "floor-backstop"
	}
	args = append(args, "--disallowedTools")
	args = append(args, deny...)
	slog.Info("claude session deny-list (review-gate protection)",
		"skip_permissions", opts.DangerouslySkipPermissions,
		"deny", deny,
		"deny_source", source,
	)

	for _, tool := range opts.AllowedTools {
		args = append(args, "--allowedTools", tool)
	}

	if opts.ResumeSessionID != "" {
		args = append(args, "--resume", opts.ResumeSessionID)
	}

	for _, dir := range opts.ContextDirs {
		args = append(args, "--add-dir", dir)
	}

	return args
}

// SupportsResume returns true — Claude CLI supports --resume.
func (c *ClaudeCLI) SupportsResume() bool { return true }

// ResumeSession resumes an existing session via --resume flag.
func (c *ClaudeCLI) ResumeSession(ctx context.Context, sessionID string, prompt string, opts Options) (*Result, error) {
	opts.ResumeSessionID = sessionID
	return c.Execute(ctx, prompt, opts)
}

// SupportsCostTracking returns true — Claude CLI reports cost via stream-json.
func (c *ClaudeCLI) SupportsCostTracking() bool { return true }

// SupportsToolConfig returns true — Claude CLI supports MCP config.
func (c *ClaudeCLI) SupportsToolConfig() bool { return true }

// Capabilities reports the Claude CLI feature set. It must stay consistent with
// the legacy Supports* methods above (asserted in capabilities_test.go).
func (c *ClaudeCLI) Capabilities() Capabilities {
	return Capabilities{
		StructuredOutput: true,  // --json-schema
		CostUSD:          true,  // stream-json total_cost_usd
		Tokens:           true,  // stream-json usage
		SessionResume:    true,  // --resume
		NativeMCP:        true,  // --mcp-config
		AutoCommits:      false, // the runner's git layer commits, not claude
		BudgetCap:        true,  // --max-budget-usd (API-billed sessions only)
		// --disallowedTools takes Bash(cmd:*) prefix rules and built-in tool
		// names verbatim; nested shells escape the prefix match.
		EnforcesShellDeny:  true,
		ShellDenyMechanism: "disallowed-tools",
	}
}

// filterEnv returns env without entries starting with the given key name.
func filterEnv(env []string, key string) []string {
	prefix := key + "="
	filtered := make([]string, 0, len(env))
	for _, e := range env {
		if !strings.HasPrefix(e, prefix) {
			filtered = append(filtered, e)
		}
	}
	return filtered
}

func (c *ClaudeCLI) Executable() string { return c.ClaudeBin }
