// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"time"
)

// Compile-time interface checks
var (
	_ Provider           = (*CodexCLI)(nil)
	_ SessionProvider    = (*CodexCLI)(nil)
	_ CapabilityProvider = (*CodexCLI)(nil)
)

// CodexCLI implements Provider by shelling out to `codex exec --json` (OpenAI
// Codex CLI, non-interactive mode). It is the second concrete coding-agent
// backend behind the Provider seam, proving the abstraction is provider-
// agnostic. Built to the public Codex contract; see codex_stream.go for the
// event schema.
//
// Every launch runs in a per-launch isolated CODEX_HOME (codex_cli_mcp.go)
// that carries the shell deny-floor as execpolicy rules, the real home's
// model routing and session state, and — when the stage holds valaris tools —
// the MCP server wiring. Verified live against codex-cli 0.144.1 on
// 2026-09-02 (codex_execpolicy_live_integration_test.go: rules honored on
// exec and resume, RunnerPath* probes through this driver); the JSONL
// contract is pinned by fixtures and a fake binary in codex_cli_test.go.
type CodexCLI struct {
	// CodexBin is the path to the codex binary. Defaults to "codex".
	CodexBin string
}

// NewCodexCLI creates a provider that uses the codex CLI.
func NewCodexCLI() *CodexCLI {
	return &CodexCLI{CodexBin: "codex"}
}

func (c *CodexCLI) Name() string { return "codex-cli" }

// Capabilities reports the Codex feature set. Unlike Claude, Codex does NOT
// report dollar cost (tokens only → the loop estimates), and its structured
// output is file-based (--output-schema) rather than inline in the stream.
func (c *CodexCLI) Capabilities() Capabilities {
	return Capabilities{
		StructuredOutput: true,
		CostUSD:          false,
		Tokens:           true,
		SessionResume:    true,
		NativeMCP:        true,
		AutoCommits:      false,
		// codex-cli 0.144.1 has NO per-session dollar cap flag (verified
		// against `codex exec --help`) — Options.MaxBudgetUSD is advisory
		// here; callers must rely on their own cumulative rails.
		BudgetCap: false,
		// The shell deny-floor rides as execpolicy rules in the isolated
		// CODEX_HOME (see codex_deny_rules.go) — same prefix semantics and
		// same nested-shell limitation as Claude's --disallowedTools.
		EnforcesShellDeny:  true,
		ShellDenyMechanism: "execpolicy-rules",
	}
}

// UnenforceableDeny reports the deny entries Codex has no channel for (Claude
// built-ins such as WebFetch, malformed Bash entries), so the workloop can
// warn at launch time rather than after the fact.
func (c *CodexCLI) UnenforceableDeny(deny []string) []string {
	return translateCodexDeny(deny).Unenforced
}

func (c *CodexCLI) Execute(ctx context.Context, prompt string, opts Options) (*Result, error) {
	// Codex structured output is file-based: --output-schema takes a JSON Schema
	// FILE (unlike Claude's inline --json-schema). Materialize opts.OutputSchema
	// to a temp file so Codex actually ENFORCES the shape, rather than relying on
	// the model voluntarily emitting JSON + prose extraction (the gap that let a
	// non-string `findings` through). An explicit Extra path, if a caller set one,
	// wins. The temp file is removed after the run.
	if opts.OutputSchema != "" {
		if _, ok := opts.Extra["output_schema_path"].(string); !ok {
			path, cleanup, err := writeSchemaFile(opts.OutputSchema)
			if err != nil {
				return nil, fmt.Errorf("codex: materialize output schema: %w", err)
			}
			defer cleanup()
			// Copy Extra so we never mutate the caller's shared map.
			merged := make(map[string]any, len(opts.Extra)+1)
			for k, v := range opts.Extra {
				merged[k] = v
			}
			merged["output_schema_path"] = path
			opts.Extra = merged
		}
	}

	// Every launch runs in a fresh isolated CODEX_HOME (card 0ac035df). It
	// carries two things:
	//   - rules/backplane-deny.rules: the shell deny-floor as execpolicy rules.
	//     SafeToolDenyFloor rides on EVERY session, mirroring the Claude driver
	//     (card 1e315263); a backend deny-list (opts.DisallowedTools) EXTENDS
	//     the floor, never replaces it. mcp__valaris__* deny entries are
	//     enforced through the only channel Codex has for MCP tools — they are
	//     subtracted from the allowlist — and entries with no Codex equivalent
	//     surface on Result.UnenforcedDeny rather than vanishing.
	//   - config.toml: Codex has no --mcp-config flag, so the valaris MCP server
	//     is wired via $CODEX_HOME/config.toml from the same static template
	//     Claude reads. A 0600 file (rather than `-c mcp_servers...` argv
	//     overrides) keeps the API key out of ps/procfs-visible argv. Wired
	//     whenever a template is configured, the EMPTY grant included: that
	//     grant is the full platform surface, and the launch still has to pin
	//     VALARIS_MCP_TOOLSETS=all or a template without the key hands the
	//     session the server's clipped default hand. No allowlist key is
	//     written for it — and with no allowlist there is nothing to subtract
	//     an MCP deny entry from, so those entries are reported unenforced.
	deny := mergeDenyFloor(opts.DisallowedTools)
	translation := translateCodexDeny(deny)
	homeSpec := codexHomeSpec{
		SourceExecutionID: opts.SourceExecutionID,
		RealCodexHome:     os.Getenv("CODEX_HOME"),
		AllowedTools:      opts.AllowedTools,
		MCPDeny:           translation.MCPDeny,
		DenyRules:         renderCodexDenyRules(deny),
	}
	if opts.MCPConfigPath != "" {
		homeSpec.MCPTemplatePath = opts.MCPConfigPath
		if len(opts.AllowedTools) == 0 {
			translation.Unenforced = append(translation.Unenforced, translation.MCPDeny...)
		}
	}
	codexHome, cleanupHome, err := codexLaunchHome(homeSpec)
	if err != nil {
		return nil, fmt.Errorf("codex: launch home materialize: %w", err)
	}
	defer cleanupHome()
	denySource := "merged"
	if len(opts.DisallowedTools) == 0 {
		denySource = "floor-backstop"
	}
	slog.Info("codex session deny-list (review-gate protection)",
		"deny", deny,
		"deny_source", denySource,
		"unenforced_deny", translation.Unenforced,
	)

	args := c.buildArgs(prompt, opts)

	bin := c.CodexBin
	if bin == "" {
		bin = "codex"
	}

	slog.Info("codex exec starting", "model", opts.Model, "working_dir", opts.WorkingDir)

	cmd := exec.CommandContext(ctx, bin, args...)
	setProcessGroup(cmd)

	// Strip any inherited CODEX_API_KEY, then set it only when explicitly
	// configured — mirrors the Claude provider's posture so `codex exec` falls
	// back to its own logged-in (ChatGPT) auth by default. Codex exec reads
	// CODEX_API_KEY specifically (per OpenAI docs), not OPENAI_API_KEY.
	cmd.Env = filterEnv(os.Environ(), "CODEX_API_KEY")
	if key := codexAPIKey(opts); key != "" {
		cmd.Env = append(cmd.Env, "CODEX_API_KEY="+key)
	}
	// Point this one launch at the isolated CODEX_HOME built above; the
	// inherited one only served as the auth.json + routing source.
	cmd.Env = filterEnv(cmd.Env, "CODEX_HOME")
	cmd.Env = append(cmd.Env, "CODEX_HOME="+codexHome)
	// A custom model_provider's credential lives in auth.json but codex reads
	// it only from the provider's env_key variable; bridge it unless the
	// process env already carries it (see codexProviderKeyFromAuth).
	if name, secret, ok := codexProviderKeyFromAuth(resolveRealCodexHome(os.Getenv("CODEX_HOME")), os.Getenv); ok {
		cmd.Env = filterEnv(cmd.Env, name)
		cmd.Env = append(cmd.Env, name+"="+secret)
	}

	cmd.Env = filterEnv(cmd.Env, SourceExecutionEnvKey)
	if opts.WorkingDir != "" {
		cmd.Dir = opts.WorkingDir
	}

	// Hand codex an empty, already-at-EOF stdin. The prompt is passed as a
	// positional arg, and stock `codex exec` otherwise BLOCKS reading stdin —
	// inheriting the runner's stdin (a pipe/TTY) would hang the stage
	// indefinitely (proven live 2026-06-16 on 0.140.0; the driver still hands
	// 0.144.1 the same closed stdin). An empty reader gives immediate EOF.
	cmd.Stdin = bytes.NewReader(nil)

	var stdout bytes.Buffer
	stderr := &tailBuffer{cap: stderrTailCap}
	cmd.Stdout = &stdout
	cmd.Stderr = stderr

	start := time.Now()
	err = cmd.Run()
	duration := time.Since(start)

	result := &Result{Duration: duration, UnenforcedDeny: translation.Unenforced}

	text, meta := parseCodexJSON(stdout.String())
	result.Output = text
	if meta != nil {
		result.SessionID = meta.SessionID
		result.InputTokens = meta.InputTokens
		result.OutputTokens = meta.OutputTokens
		result.CacheCreationTokens = meta.CacheCreationTokens
		result.CacheReadTokens = meta.CacheReadTokens
		// Codex reports no dollar cost; CostUSD stays 0 → loop estimates.
		result.StructuredOutput = meta.StructuredOutput
	}
	// With --output-schema, Codex constrains its FINAL agent_message to the
	// schema — there is no separate structured channel (unlike Claude), so the
	// conforming JSON arrives as the agent_message text. Surface it on the
	// StructuredOutput channel when it is in fact valid JSON, so decodeLLMEnvelope
	// prefers it over prose extraction. Non-JSON text leaves StructuredOutput nil
	// and the prose-extraction fallback still applies.
	if opts.OutputSchema != "" && len(result.StructuredOutput) == 0 && json.Valid([]byte(text)) {
		result.StructuredOutput = []byte(text)
	}

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			result.ExitCode = exitErr.ExitCode()
			result.Error = fmt.Errorf("codex exited with code %d: %s", result.ExitCode, stderr.String())
		} else {
			result.Error = fmt.Errorf("failed to run codex: %w", err)
		}
		// Same rationale as the Claude provider: a crashed run may have emitted
		// a partial structured payload; never let callers act on it.
		result.StructuredOutput = nil
	}

	slog.Info("codex exec completed",
		"duration", duration.Round(time.Second),
		"exit_code", result.ExitCode,
		"output_len", len(result.Output),
		"tokens_in", result.InputTokens,
		"tokens_out", result.OutputTokens,
		"session_id", result.SessionID,
	)

	return result, result.Error
}

// buildArgs constructs the `codex exec` argument vector. The prompt is always
// the final positional argument. MCP wiring is NOT an arg here — it travels
// via the CODEX_HOME env var Execute sets on cmd.Env (see codexMCPHome),
// never argv, so a valaris API key never appears in a `ps`/procfs-visible
// command line.
func (c *CodexCLI) buildArgs(prompt string, opts Options) []string {
	// Resume routes through `codex exec resume <thread-id>`; a fresh run is
	// just `codex exec`. The --json flag makes Codex stream NDJSON events.
	resuming := opts.ResumeSessionID != ""
	args := []string{"exec"}
	if resuming {
		args = append(args, "resume", opts.ResumeSessionID)
	}
	args = append(args, "--json")

	if opts.Model != "" {
		args = append(args, "--model", opts.Model)
	}
	// --cd is a PLAIN-exec-only flag. Verified against codex-cli 0.140.0 and
	// re-checked on 0.144.1 (2026-09-02): `codex exec --help` lists
	// `-C, --cd <DIR>` but `codex exec resume --help` does NOT — passing it to
	// resume errors `unexpected argument '--cd' found`
	// (exit 2, 0 tokens), which wedged every implement attempt and tripped the
	// empty-LLM breaker. Execute() already sets the process CWD via cmd.Dir, and
	// a resumed session carries its original working root, so resume needs no
	// --cd. (Flags shared by both subcommands — --json, --model, --output-schema,
	// --skip-git-repo-check, --dangerously-bypass-approvals-and-sandbox — stay.)
	if opts.WorkingDir != "" && !resuming {
		args = append(args, "--cd", opts.WorkingDir)
	}
	// Non-git working dirs are valid for some stages; don't let Codex refuse.
	args = append(args, "--skip-git-repo-check")

	// File-based structured output: callers that set OutputSchema must also have
	// materialized it to a path in Extra["output_schema_path"]; the schema flag
	// takes a file, not inline JSON (unlike Claude's --json-schema).
	if path, ok := opts.Extra["output_schema_path"].(string); ok && path != "" {
		args = append(args, "--output-schema", path)
	}

	// Headless-autonomous launch: Codex's own bypass flag, NOT a Claude flag.
	// The shell deny-floor is independent of this sandbox posture — it rides
	// as execpolicy rules in the isolated CODEX_HOME (Execute), and codex-cli
	// 0.144.1 was probed live (2026-09-02) to still reject `gh pr merge` under
	// --dangerously-bypass-approvals-and-sandbox. Sandboxing by default was
	// measured and rejected: `-c sandbox_mode="workspace-write"` blocks writes
	// to $GOCACHE and ~/.cache ("Operation not permitted"), breaking
	// go/pnpm/pip caches for every Codex stage. Never emit --ignore-rules: it
	// is the only switch that drops the floor.
	if opts.DangerouslySkipPermissions {
		args = append(args, "--dangerously-bypass-approvals-and-sandbox")
	}

	args = append(args, prompt)
	return args
}

// writeSchemaFile materializes a JSON Schema string to a temp file for
// `codex exec --output-schema <FILE>` and returns the path plus a cleanup func.
// Codex takes the schema as a file, not inline (unlike Claude's --json-schema).
func writeSchemaFile(schema string) (path string, cleanup func(), err error) {
	f, err := os.CreateTemp("", "codex-schema-*.json")
	if err != nil {
		return "", func() {}, err
	}
	if _, err := f.WriteString(schema); err != nil {
		f.Close()
		os.Remove(f.Name())
		return "", func() {}, err
	}
	if err := f.Close(); err != nil {
		os.Remove(f.Name())
		return "", func() {}, err
	}
	return f.Name(), func() { os.Remove(f.Name()) }, nil
}

// SupportsResume returns true — codex exec resume.
func (c *CodexCLI) SupportsResume() bool { return true }

// ResumeSession resumes an existing Codex thread via `exec resume`.
func (c *CodexCLI) ResumeSession(ctx context.Context, sessionID string, prompt string, opts Options) (*Result, error) {
	opts.ResumeSessionID = sessionID
	return c.Execute(ctx, prompt, opts)
}

// codexAPIKey resolves the Codex API key from Options. It is carried in Extra
// (the core Options struct stays provider-neutral; only Claude has a dedicated
// AnthropicAPIKey field for historical reasons).
func codexAPIKey(opts Options) string {
	if v, ok := opts.Extra["codex_api_key"].(string); ok {
		return v
	}
	return ""
}

func (c *CodexCLI) Executable() string { return c.CodexBin }
