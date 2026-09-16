// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// codexMCPHome materializes an isolated CODEX_HOME for one launch: a
// config.toml wiring the valaris MCP server (read from the same static
// template Claude uses) plus a symlink to the real CODEX_HOME's auth.json so
// login/API-key auth still resolves. Returns the temp dir to set as
// CODEX_HOME on the subprocess env, plus an idempotent cleanup function.
//
// This exists because `-c mcp_servers.valaris.env.VALARIS_API_KEY=...` would
// otherwise put the API key in argv — world-readable via ps/procfs on shared
// hosts. Claude's driver never has this problem: --mcp-config takes a FILE.
// Codex has no such flag, but it does honor $CODEX_HOME/config.toml (verified
// against codex-cli 0.144.1: `codex mcp list`/`codex mcp get` under a
// redirected CODEX_HOME correctly read the isolated config, and `codex login
// status` under the same redirected home still reports the real login when
// auth.json is present there), so a real 0600 file plays the same role
// --mcp-config's temp file plays for Claude.
//
// realCodexHome is the CODEX_HOME to source auth.json from — empty means the
// default (~/.codex, which codex itself falls back to when CODEX_HOME is
// unset), matching codex's own resolution so a runner host with a custom
// CODEX_HOME still authenticates correctly.
//
// codexMCPHome is the MCP-only composition of codexLaunchHome; Execute builds
// the full launch home (MCP wiring + the deny-floor rules file) directly.
func codexMCPHome(templatePath string, allowedTools []string, realCodexHome string) (home string, cleanup func(), err error) {
	return codexLaunchHome(codexHomeSpec{
		RealCodexHome:   realCodexHome,
		MCPTemplatePath: templatePath,
		AllowedTools:    allowedTools,
	})
}

// codexHomeSpec describes one launch's isolated CODEX_HOME.
type codexHomeSpec struct {
	SourceExecutionID string
	RealCodexHome     string   // source of auth.json; "" = codex's own ~/.codex default
	MCPTemplatePath   string   // static MCP template to wire as [mcp_servers.valaris]; "" = no MCP server
	AllowedTools      []string // the stage's grant as handed to the driver; empty = full surface (no allowlist key)
	MCPDeny           []string // mcp__valaris__* deny entries subtracted from a non-empty AllowedTools
	DenyRules         string   // rendered execpolicy rules file (renderCodexDenyRules); "" = none
}

// codexDenyRulesRelPath is where codex loads user-scope execpolicy rules from
// ($CODEX_HOME/rules/*.rules — verified codex-cli 0.144.1; default.rules at
// the home root is NOT read).
const codexDenyRulesRelPath = "rules/backplane-deny.rules"

// codexLaunchHome materializes the isolated CODEX_HOME for one launch and
// returns the dir plus an idempotent cleanup. Every artifact is 0600/0700:
// the config carries the valaris API key and the rules file is the launch's
// security policy, both on a possibly shared host. Cleanup removes the
// launch home only — the auth.json and session-state entries are symlinks,
// so their targets in the real home are never touched.
func codexLaunchHome(spec codexHomeSpec) (home string, cleanup func(), err error) {
	dir, err := os.MkdirTemp("", "codex-home-*")
	if err != nil {
		return "", nil, fmt.Errorf("create codex home: %w", err)
	}
	cleanupFn := func() { _ = os.RemoveAll(dir) }
	fail := func(err error) (string, func(), error) {
		cleanupFn()
		return "", nil, err
	}

	realCodexHome := resolveRealCodexHome(spec.RealCodexHome)
	linkCodexAuth(dir, realCodexHome)
	shareCodexSessionState(dir, realCodexHome)

	// The isolated config.toml = the real config's routing slice (model,
	// model_provider, [model_providers.*], [projects.*] — see
	// codex_routing_config.go) followed by the runner's own MCP server block.
	routing, err := loadCodexRoutingConfig(realCodexHome)
	if err != nil {
		return fail(err)
	}
	configTOML := routing.TOML
	if spec.MCPTemplatePath != "" {
		encoded, err := renderValarisMCPServerTOML(spec.MCPTemplatePath, spec.AllowedTools, spec.MCPDeny, spec.SourceExecutionID)
		if err != nil {
			return fail(err)
		}
		if configTOML != "" {
			configTOML += "\n"
		}
		configTOML += encoded
	}
	if configTOML != "" {
		if err := os.WriteFile(filepath.Join(dir, "config.toml"), []byte(configTOML), 0o600); err != nil {
			return fail(fmt.Errorf("write codex config.toml: %w", err))
		}
	}

	if spec.DenyRules != "" {
		rulesPath := filepath.Join(dir, filepath.FromSlash(codexDenyRulesRelPath))
		if err := os.MkdirAll(filepath.Dir(rulesPath), 0o700); err != nil {
			return fail(fmt.Errorf("create codex rules dir: %w", err))
		}
		if err := os.WriteFile(rulesPath, []byte(spec.DenyRules), 0o600); err != nil {
			return fail(fmt.Errorf("write codex deny rules: %w", err))
		}
	}

	return dir, cleanupFn, nil
}

// symlinkFile is the seam every link in the launch home goes through, so the
// Windows / shared-filesystem "symlinks not permitted" path can be exercised
// (tests inject a failure here).
var symlinkFile = os.Symlink

var (
	authCopyFallbackWarnOnce   sync.Once
	sessionsLinkFailedWarnOnce sync.Once
)

// linkCodexAuth links the real CODEX_HOME's auth.json into dir so login /
// API-key auth still resolves under the redirected home. realCodexHome is
// already resolved (resolveRealCodexHome); "" means no known home to link.
//
// Symlink, not copy: auth.json can be refreshed by a concurrent `codex login`
// mid-lifetime of a long-running runner; a copy would go stale. Where
// symlinks are refused (Windows without developer mode, some shared
// filesystems) a 0600 copy keeps the launch authenticating, with one warning
// per process about the staleness trade-off. A host with no auth.json at all
// (CODEX_API_KEY-only auth via the runner's own env injection) is a valid,
// supported mode, not an error.
func linkCodexAuth(dir, realCodexHome string) {
	if realCodexHome == "" {
		return
	}
	isolatedAuth := filepath.Join(dir, "auth.json")
	err := symlinkFile(filepath.Join(realCodexHome, "auth.json"), isolatedAuth)
	if err == nil {
		return
	}
	content, readErr := os.ReadFile(filepath.Join(realCodexHome, "auth.json"))
	if readErr != nil {
		return
	}
	if writeErr := os.WriteFile(isolatedAuth, content, 0o600); writeErr != nil {
		return
	}
	authCopyFallbackWarnOnce.Do(func() {
		slog.Warn("codex auth.json could not be symlinked into the launch home — copied instead; the copy goes stale if `codex login` runs while the runner is up",
			"error", err)
	})
}

// shareCodexSessionState links the real home's session state into the
// launch home. Codex persists every thread as
// $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl and indexes it in
// $CODEX_HOME/session_index.jsonl (+ history.jsonl); the launch home is
// deleted at cleanup, but the workloop resumes by SessionID on a LATER launch
// (`codex exec resume <id>` fails "no rollout found for thread id" from a
// fresh home). Sharing these three by symlink keeps rollouts in the real
// home. Targets are created there when absent (dir 0700, files 0600) so the
// links never dangle. Copying is not an option — writes must land in the
// real home — so a refused symlink only warns (once per process) that resume
// will not persist on this host; the launch itself proceeds.
func shareCodexSessionState(dir, realCodexHome string) {
	if realCodexHome == "" {
		return
	}
	sessionsDir := filepath.Join(realCodexHome, "sessions")
	if err := os.MkdirAll(sessionsDir, 0o700); err != nil {
		warnSessionsNotShared(err)
		return
	}
	if err := symlinkFile(sessionsDir, filepath.Join(dir, "sessions")); err != nil {
		warnSessionsNotShared(err)
		return
	}
	for _, name := range []string{"session_index.jsonl", "history.jsonl"} {
		target := filepath.Join(realCodexHome, name)
		if err := ensureFile(target, 0o600); err != nil {
			warnSessionsNotShared(err)
			return
		}
		if err := symlinkFile(target, filepath.Join(dir, name)); err != nil {
			warnSessionsNotShared(err)
			return
		}
	}
}

func warnSessionsNotShared(err error) {
	sessionsLinkFailedWarnOnce.Do(func() {
		slog.Warn("codex session state could not be linked into the launch home — `codex exec resume` will not find earlier threads on this host",
			"error", err)
	})
}

// ensureFile creates an empty file with the given mode when absent; an
// existing file is left untouched.
func ensureFile(path string, mode os.FileMode) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	return f.Close()
}

// renderValarisMCPServerTOML reads the static MCP template and renders the
// [mcp_servers.valaris] table with the launch's env keys injected — the same
// grant semantics as writeDynamicMCPConfig: toolsets always pinned to all; an
// allowlist only for a non-empty grant, and there the deny is subtracted
// first. The subtraction lives here, after the empty-grant decision, so a
// grant the deny empties out stays a deny-all (the sentinel) instead of
// reading as the full surface.
func renderValarisMCPServerTOML(templatePath string, allowedTools, mcpDeny []string, sourceExecutionID ...string) (string, error) {
	_, valaris, err := ReadValarisMCPServerTemplate(templatePath)
	if err != nil {
		return "", err
	}

	env, _ := valaris["env"].(map[string]any)
	envOut := make(map[string]string, len(env)+2)
	for k, v := range env {
		s, _ := v.(string)
		envOut[k] = s
	}
	if len(allowedTools) > 0 {
		envOut[allowlistEnvKey] = valarisAllowlist(subtractTools(allowedTools, mcpDeny))
	}
	envOut[toolsetsEnvKey] = toolsetsAll
	delete(envOut, SourceExecutionEnvKey)
	if len(sourceExecutionID) > 0 && sourceExecutionID[0] != "" {
		envOut[SourceExecutionEnvKey] = sourceExecutionID[0]
	}

	cmd, _ := valaris["command"].(string)
	var argsOut []string
	if rawArgs, ok := valaris["args"].([]any); ok {
		argsOut = make([]string, 0, len(rawArgs))
		for _, a := range rawArgs {
			s, _ := a.(string)
			argsOut = append(argsOut, s)
		}
	}
	return encodeValarisMCPServerTOML(cmd, argsOut, envOut), nil
}

// encodeValarisMCPServerTOML renders the [mcp_servers.valaris] table Codex
// expects. Hand-rolled rather than pulling in a TOML dependency: the shape is
// fixed and narrow (one string, one string array, one string-only env table),
// unlike the general documents a real TOML library would need to round-trip.
func encodeValarisMCPServerTOML(command string, args []string, env map[string]string) string {
	var b strings.Builder
	b.WriteString("[mcp_servers.valaris]\n")
	fmt.Fprintf(&b, "command = %s\n", tomlString(command))
	b.WriteString("args = [")
	for i, a := range args {
		if i > 0 {
			b.WriteString(", ")
		}
		b.WriteString(tomlString(a))
	}
	b.WriteString("]\n")

	if len(env) > 0 {
		b.WriteString("\n[mcp_servers.valaris.env]\n")
		// Sorted for deterministic output — stable diffs if ever inspected, and
		// deterministic test assertions.
		keys := make([]string, 0, len(env))
		for k := range env {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fmt.Fprintf(&b, "%s = %s\n", k, tomlString(env[k]))
		}
	}
	return b.String()
}

// tomlString quotes a value as a TOML basic string. The template's values are
// operator-authored config (URLs, shell commands, agent emails) and the
// allowlist (comma-joined tool names) — never arbitrary user input — so a
// basic escape of backslash/quote/control characters is sufficient; this is
// not parsing untrusted text.
func tomlString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"', '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		case '\n':
			b.WriteString(`\n`)
		case '\t':
			b.WriteString(`\t`)
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}
