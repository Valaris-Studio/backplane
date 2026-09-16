// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// MCPLaunch describes how to start the Backplane MCP server.
type MCPLaunch struct {
	Command string
	Args    []string
}

// MCPLaunchUvx runs the published PyPI package, which is the path an operator
// with no source checkout takes. Requires uvx on PATH — see UvxAvailable.
func MCPLaunchUvx() MCPLaunch {
	// Never let an older published/cached package silently satisfy a runner
	// whose completion workflow requires the 0.8 tool surface.
	return MCPLaunch{Command: "uvx", Args: []string{"backplane-mcp==0.8.0"}}
}

// MCPLaunchCheckout runs the server straight out of a source tree, so a
// developer's local edits take effect without a release.
func MCPLaunchCheckout(mcpServerDir string) MCPLaunch {
	return MCPLaunch{Command: "uv", Args: []string{"--directory", mcpServerDir, "run", "valaris-mcp"}}
}

// MCPConfigSeed is everything the generated config needs. AgentEmail is
// optional; the rest are required.
type MCPConfigSeed struct {
	Launch     MCPLaunch
	APIURL     string
	APIKey     string
	AgentEmail string
}

// mcpServerEntry is the Claude mcpServers entry shape. internal/llm's
// readValarisMCPServerTemplate hard-requires the "valaris" key, so
// mcpServerKey is a contract, not a label.
type mcpServerEntry struct {
	Command string            `json:"command"`
	Args    []string          `json:"args"`
	Env     map[string]string `json:"env"`
}

type mcpConfigFile struct {
	MCPServers map[string]mcpServerEntry `json:"mcpServers"`
}

const mcpServerKey = "valaris"

// ErrMCPConfigExists is returned by WriteMCPConfig when path is already taken,
// mirroring SaveConfig's clobber guard: an operator's hand-tuned MCP config is
// never silently replaced.
var ErrMCPConfigExists = errors.New("mcp config file already exists")

// MarshalMCPConfig renders the config JSON without touching disk.
//
// The API key is written as a REAL VALUE, never as "${VALARIS_API_KEY}": the
// runner hands this file to the coding agent by path and only injects a tool
// allowlist env var — it never expands placeholders, so a placeholder would
// reach the MCP server verbatim and 401. File permissions (0600, see
// WriteMCPConfig) are the control here, not masking. Do not "fix" this back
// to a placeholder.
func MarshalMCPConfig(seed MCPConfigSeed) ([]byte, error) {
	if seed.Launch.Command == "" {
		return nil, fmt.Errorf("marshaling mcp config: launch command is empty")
	}
	if seed.APIURL == "" {
		return nil, fmt.Errorf("marshaling mcp config: api url is empty")
	}
	if seed.APIKey == "" {
		return nil, fmt.Errorf("marshaling mcp config: api key is empty")
	}

	env := map[string]string{
		"VALARIS_API_URL": seed.APIURL,
		"VALARIS_API_KEY": seed.APIKey,
		// The runner's template is full-surface: per-stage narrowing is the
		// allowlist. Every launch pins this key itself, but the loop
		// pre-flight spawns the server from this template verbatim, and the
		// server's interactive default hand omits the autonomous-operations
		// tools (enqueue_pr_for_merge, list_skills/get_skill, the approvals
		// tools) — so a template without it would show a clipped surface to
		// anything that spawns from it as written.
		"VALARIS_MCP_TOOLSETS": "all",
	}
	if seed.AgentEmail != "" {
		env["VALARIS_AGENT_EMAIL"] = seed.AgentEmail
	}

	args := seed.Launch.Args
	if args == nil {
		args = []string{}
	}
	file := mcpConfigFile{MCPServers: map[string]mcpServerEntry{
		mcpServerKey: {Command: seed.Launch.Command, Args: args, Env: env},
	}}

	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("marshaling mcp config: %w", err)
	}
	return append(data, '\n'), nil
}

// WriteMCPConfig writes the config to path with owner-only permissions,
// creating parent directories, and refuses to overwrite an existing file
// (ErrMCPConfigExists).
func WriteMCPConfig(path string, seed MCPConfigSeed) error {
	data, err := MarshalMCPConfig(seed)
	if err != nil {
		return err
	}
	if _, err := os.Stat(path); err == nil {
		return fmt.Errorf("%w: %s", ErrMCPConfigExists, path)
	} else if !os.IsNotExist(err) {
		return fmt.Errorf("checking %s: %w", path, err)
	}
	if dir := filepath.Dir(path); dir != "" {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("creating %s: %w", dir, err)
		}
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return fmt.Errorf("writing %s: %w", path, err)
	}
	return nil
}

// UvxAvailable reports whether the uvx launcher is on PATH, which decides
// whether MCPLaunchUvx is offerable at all.
func UvxAvailable() bool {
	_, err := exec.LookPath("uvx")
	return err == nil
}
