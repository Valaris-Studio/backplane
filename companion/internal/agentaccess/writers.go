// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package agentaccess

import (
	"slices"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/claudecode"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/codex"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/mcpentry"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/pi"
)

const (
	scopeFolder = "folder"
	scopeGlobal = "global"
)

// writer adapts one agent's MCP configuration. A folder writer keeps one
// entry per bound folder; a global writer keeps one entry whose launcher
// resolves the folder from its working directory.
type writer struct {
	agentID string
	scope   string
	agent   agent.Agent
	// unsupported names why the agent cannot take an entry at all.
	unsupported func(env agent.Env) string
	write       func(env agent.Env, root, mappingID string) (bool, error)
	// remove takes the mappings whose entry may go; nil allows any owned one.
	remove   func(env agent.Env, root string, mappingIDs []string) (bool, error)
	repair   func(env agent.Env) (bool, error)
	findings func(env agent.Env, root, endpoint string) ([]mcpentry.Finding, error)
	// advisory names what the user still has to do after a write.
	advisory func(env agent.Env, root string) string
}

func (w writer) present(env agent.Env) bool { return w.agent.Discover(env).Installed }

func defaultWriters() []writer {
	none := func(agent.Env) string { return "" }
	noAdvice := func(agent.Env, string) string { return "" }
	return []writer{
		{
			agentID: claudecode.ID, scope: scopeFolder, agent: claudecode.New(),
			unsupported: none,
			// A folder claiming to be a linked worktree git does not confirm
			// keeps its entry under its own root.
			advisory: func(_ agent.Env, root string) string {
				if _, trusted := claudecode.MCPProjectKeyTrusted(root); !trusted {
					return problemWorktreeLinkUntrusted
				}
				return ""
			},
			write:    claudecode.WriteMCP,
			remove:   claudecode.RemoveMCP,
			repair:   claudecode.RepairMCP,
			findings: claudecode.MCPFindings,
		},
		{
			agentID: codex.ID, scope: scopeGlobal, agent: codex.New(),
			unsupported: none,
			write:       func(env agent.Env, _, _ string) (bool, error) { return codex.WriteMCP(env) },
			remove:      func(env agent.Env, _ string, _ []string) (bool, error) { return codex.RemoveMCP(env) },
			repair:      codex.RepairMCP,
			findings: func(env agent.Env, _, endpoint string) ([]mcpentry.Finding, error) {
				return codex.MCPFindings(env, endpoint)
			},
			// Codex's desktop app-server loads config.toml only when it starts.
			advisory: func(env agent.Env, _ string) string {
				if slices.Contains(codex.New().Status(env).Problems, agent.ProblemRestartRequired) {
					return agent.ProblemRestartRequired
				}
				return ""
			},
		},
		{
			agentID: pi.ID, scope: scopeGlobal, agent: pi.New(), advisory: noAdvice,
			unsupported: func(env agent.Env) string {
				if !pi.MCPAdapterInstalled(env) {
					return pi.ErrMCPAdapterMissing.Error()
				}
				return ""
			},
			write:  func(env agent.Env, _, _ string) (bool, error) { return pi.WriteMCP(env) },
			remove: func(env agent.Env, _ string, _ []string) (bool, error) { return pi.RemoveMCP(env) },
			repair: pi.RepairMCP,
			findings: func(env agent.Env, _, endpoint string) ([]mcpentry.Finding, error) {
				return pi.MCPFindings(env, endpoint)
			},
		},
	}
}
