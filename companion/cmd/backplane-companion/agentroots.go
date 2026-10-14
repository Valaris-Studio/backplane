// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"path/filepath"
	"slices"
	"sort"

	"github.com/Valaris-Studio/backplane/companion/internal/agent/claudecode"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/mcpentry"
	"github.com/Valaris-Studio/backplane/companion/internal/daemon"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/scope"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// mappingRoots are the local folders of mapping. A root mapping has its own;
// a mapping bound by repository has as many as the clones and worktrees this
// device has seen. A folder counts only when capture would attribute its
// sessions to mapping, whether or not the folder is otherwise known as bound.
func (a *app) mappingRoots(layout store.Layout, cached policy.Cached, mapping policy.Mapping) []string {
	if mapping.RootPath != "" && filepath.IsAbs(mapping.RootPath) {
		return []string{scope.CanonicalOrClean(mapping.RootPath)}
	}
	if mapping.RepoURLNormalized == "" {
		return []string{}
	}
	installation, _ := state.Load[state.Installation](layout.Installation())
	base, err := daemon.ScopeInput(layout, installation.ID, a.home, a.tempDirs, a.now())
	if err != nil {
		return []string{}
	}
	if base.Policy == nil {
		base.Policy = &cached
	}
	roots := []string{}
	for _, candidate := range a.knownFolders(layout) {
		if root, attributed := a.attributedRoot(base, mapping, candidate); attributed && !slices.Contains(roots, root) {
			roots = append(roots, root)
		}
	}
	sort.Strings(roots)
	return roots
}

// knownFolders are the folders this device has seen agents run in: those
// capture attributed to a mapping, the threads Codex's hooks named, the
// unbound projects it discovered, and Claude Code's own project list, which
// also covers sessions captured before capture recorded its attributions.
func (a *app) knownFolders(layout store.Layout) []string {
	folders := []string{}
	if mapped, err := state.Load[state.MappedRoots](layout.MappedRoots()); err == nil {
		for root := range mapped.Roots {
			folders = append(folders, root)
		}
	}
	if threads, err := state.Load[state.Threads](layout.Threads()); err == nil {
		for _, thread := range threads.Threads {
			folders = append(folders, thread.Cwd)
		}
	}
	if discovered, err := state.Load[state.Discovered](layout.Discovered()); err == nil {
		for _, project := range discovered.Projects {
			folders = append(folders, project.Root)
		}
	}
	if config, err := mcpentry.ReadJSON(claudecode.MCPConfigPath(a.agentEnv())); err == nil {
		projects, _ := config["projects"].(map[string]any)
		for folder := range projects {
			folders = append(folders, folder)
		}
	}
	return folders
}

// attributedRoot decides candidate exactly as capture resolves a session's
// directory, with capture's own input: exclude globs, never-capture folders,
// refused repositories, home and temp folders all still refuse it. Only the
// switches about recording sessions, not about where a folder belongs, are
// set aside below.
func (a *app) attributedRoot(base scope.Input, mapping policy.Mapping, candidate string) (string, bool) {
	if !filepath.IsAbs(candidate) || base.Policy == nil {
		return "", false
	}
	cached := *base.Policy
	installation := cached.Policy.Installation
	// Pausing capture (locally or from the server) stops recording sessions;
	// it does not take agents' access to the board away.
	base.LocalPaused, installation.Paused = false, false
	// Agent access applies each agent's capture switch itself, per agent.
	installation.EnabledAgents = nil
	cached.Policy.Installation = installation
	// The cached policy is the newest this device has; staleness guards
	// uploads, not where a folder belongs.
	cached.RefreshedAt = base.Now
	cached.Policy.Mappings = make([]policy.Mapping, 0, len(base.Policy.Policy.Mappings))
	for _, known := range base.Policy.Policy.Mappings {
		// A mapping whose capture is off still owns its folders.
		known.Enabled = known.Enabled || known.ID == mapping.ID
		cached.Policy.Mappings = append(cached.Policy.Mappings, known)
	}
	base.Policy, base.Cwd, base.AgentID = &cached, candidate, "agent_access"
	decision := scope.Decide(base)
	if !decision.InScope || decision.MappingID != mapping.ID || len(decision.Place.Roots) == 0 {
		return "", false
	}
	return decision.Place.Roots[0], true
}
