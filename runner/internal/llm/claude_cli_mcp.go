// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// valarisToolPrefix is added by claude-cli when it surfaces MCP tools to the
// LLM. Backend pipeline_config entries use the prefixed form, but the MCP
// server's call_tool receives unprefixed names. Strip once at the wire so the
// allowlist env var matches what the server sees. See design doc §3.5.
const valarisToolPrefix = "mcp__valaris__"

// allowlistEnvKey is the env var the MCP server reads at startup to learn
// which tools the current claude-cli launch may call. Defined in
// docs/pipeline-design/05-mcp-allowlist-enforcement.md §2.4.
const allowlistEnvKey = "VALARIS_MCP_ALLOWLIST"

// SourceExecutionEnvKey is runner-controlled per-launch attribution, never
// inherited from a saved template, the host environment, or model input.
const SourceExecutionEnvKey = "BACKPLANE_SOURCE_EXECUTION_ID"

// toolsetsEnvKey is the MCP server's interactive scoping knob: unset, the
// server loads its default hand, a subset of the surface that omits the
// autonomous-operations tools (enqueue_pr_for_merge, list_skills/get_skill,
// the approvals tools). The runner's stage allowlist is the only narrowing a
// launch applies — a template that loads the interactive default hand (or any
// narrower toolset) would clip the grant a second time and hide tools the
// stage was explicitly granted — so every launch, the empty full-surface
// grant included, pins toolsets to all, overriding whatever the template
// carries.
const toolsetsEnvKey = "VALARIS_MCP_TOOLSETS"

// toolsetsAll is the value that loads the server's full surface.
const toolsetsAll = "all"

// ReadValarisMCPServerTemplate reads the static MCP config template (Claude's
// mcpServers.json shape — {"mcpServers": {"valaris": {"command", "args",
// "env"}}}) and returns the valaris server entry plus the full decoded
// document (so callers that rewrite the whole file, like
// writeDynamicMCPConfig, preserve any fields they don't model explicitly).
// This shape is provider-neutral: Codex's TOML mcp_servers.<name> table
// carries the identical command/args/env fields, just serialized differently
// (see codex_cli_mcp.go).
//
// Exported because the loop-mode off-switch surface pre-flight spawns this
// same server entry to ask what it serves: the probe must read the template
// the SESSION gets, and a second parser would be free to disagree with this
// one about the shape.
func ReadValarisMCPServerTemplate(templatePath string) (doc, valaris map[string]any, err error) {
	raw, err := os.ReadFile(templatePath)
	if err != nil {
		return nil, nil, fmt.Errorf("read mcp template: %w", err)
	}

	// Decode into a generic map so we preserve any fields the static config
	// carries that we don't model explicitly (forward-compat).
	if err := json.Unmarshal(raw, &doc); err != nil {
		return nil, nil, fmt.Errorf("parse mcp template: %w", err)
	}

	servers, _ := doc["mcpServers"].(map[string]any)
	if servers == nil {
		return nil, nil, fmt.Errorf("mcp template missing mcpServers")
	}
	valaris, _ = servers["valaris"].(map[string]any)
	if valaris == nil {
		return nil, nil, fmt.Errorf("mcp template missing mcpServers.valaris")
	}
	return doc, valaris, nil
}

// writeDynamicMCPConfig reads the static MCP config template, pins the
// launch's env keys into the valaris server entry, and writes the result to a
// temp file. Returns the temp path plus an idempotent cleanup function the
// caller must invoke (typically via defer) to remove it.
//
// Callers invoke this on EVERY launch that has a templatePath, whatever the
// grant: toolsets are always pinned to all. The allowlist key depends on the
// grant. A non-empty allowedTools embeds valarisAllowlist's output — the
// valaris MCP tools in it, or the deny-all sentinel when it carries none
// (built-ins only), never the unrestricted empty string. An EMPTY grant (nil
// or zero-length alike) is the loop contract's full platform surface, so no
// allowlist key is added at all — writing the sentinel there would turn
// "everything" into "nothing".
func writeDynamicMCPConfig(templatePath string, allowedTools []string, sourceExecutionID ...string) (string, func(), error) {
	return PrepareMCPConfig(templatePath, allowedTools, sourceExecutionID...)
}

// PrepareMCPConfig materializes the same environment for startup verification
// and agent execution. The caller owns the returned file and cleanup function.
func PrepareMCPConfig(templatePath string, allowedTools []string, sourceExecutionID ...string) (string, func(), error) {
	doc, valaris, err := ReadValarisMCPServerTemplate(templatePath)
	if err != nil {
		return "", nil, err
	}

	env, _ := valaris["env"].(map[string]any)
	if env == nil {
		env = map[string]any{}
		valaris["env"] = env
	}

	if len(allowedTools) > 0 {
		env[allowlistEnvKey] = valarisAllowlist(allowedTools)
	}
	env[toolsetsEnvKey] = toolsetsAll
	delete(env, SourceExecutionEnvKey)
	if len(sourceExecutionID) > 0 && sourceExecutionID[0] != "" {
		env[SourceExecutionEnvKey] = sourceExecutionID[0]
	}

	encoded, err := json.MarshalIndent(doc, "", "  ")
	if err != nil {
		return "", nil, fmt.Errorf("encode dynamic mcp config: %w", err)
	}

	f, err := os.CreateTemp("", "valaris-mcp-config-*.json")
	if err != nil {
		return "", nil, fmt.Errorf("create temp mcp config: %w", err)
	}
	path := f.Name()
	if _, err := f.Write(encoded); err != nil {
		f.Close()
		os.Remove(path)
		return "", nil, fmt.Errorf("write temp mcp config: %w", err)
	}
	if err := f.Close(); err != nil {
		os.Remove(path)
		return "", nil, fmt.Errorf("close temp mcp config: %w", err)
	}

	cleanup := func() {
		// Idempotent: ignore "already gone" errors so callers may safely
		// invoke cleanup more than once (defer + explicit, or multiple
		// error paths).
		_ = os.Remove(path)
	}
	return path, cleanup, nil
}

// denyAllSentinel is emitted when a stage grants zero valaris MCP tools. An
// empty allowlist means "no restriction" server-side (design doc §3.1), so a
// zero-valaris grant would otherwise escalate to full valaris access. This
// token passes the server's tool-name regex (^[a-z_][a-z0-9_]*$) but matches
// no registered valaris tool, yielding deny-all-valaris.
const denyAllSentinel = "__none__"

// valarisAllowlist selects only the valaris MCP tools (those carrying the
// mcp__valaris__ prefix), strips that prefix, and comma-joins them in input
// order — the canonical wire form the MCP server splits on. Built-ins and any
// other non-valaris tools are dropped: they reach the LLM via --allowedTools,
// but they are NOT valaris MCP tools and must not pollute the server's
// allowlist env var (an uppercase built-in like Bash would fail the server's
// tool-name regex and crash its startup). An empty result maps to the
// deny-all sentinel rather than the unrestricted empty string.
func valarisAllowlist(tools []string) string {
	stripped := make([]string, 0, len(tools))
	for _, t := range tools {
		if strings.HasPrefix(t, valarisToolPrefix) {
			stripped = append(stripped, strings.TrimPrefix(t, valarisToolPrefix))
		}
	}
	if len(stripped) == 0 {
		return denyAllSentinel
	}
	return strings.Join(stripped, ",")
}
