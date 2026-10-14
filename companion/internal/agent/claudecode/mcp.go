// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package claudecode

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/mcpentry"
)

// Claude Code keeps local-scope MCP servers, which need no approval and are
// private to the user, in ~/.claude.json under projects[<project key>].

// MCPConfigPath follows CLAUDE_CONFIG_DIR, which moves .claude.json with it.
func MCPConfigPath(env agent.Env) string {
	if dir := env.Lookup("CLAUDE_CONFIG_DIR"); dir != "" && filepath.IsAbs(dir) {
		return filepath.Join(filepath.Clean(dir), ".claude.json")
	}
	return filepath.Join(env.Home, ".claude.json")
}

// MCPProjectKey is the project Claude Code files a folder's local servers
// under: the repository's main working tree for any folder inside it or
// inside a linked worktree, otherwise the folder itself (CLI 2.1.285).
func MCPProjectKey(root string) string {
	key, _ := MCPProjectKeyTrusted(root)
	return key
}

// MCPProjectKeyTrusted is MCPProjectKey that also reports false when the
// folder claims to be a linked worktree git does not confirm: the key then
// falls back to the folder's own working tree.
func MCPProjectKeyTrusted(root string) (string, bool) {
	resolved := filepath.Clean(root)
	if real, err := filepath.EvalSymlinks(root); err == nil {
		resolved = real
	}
	for current := resolved; ; {
		marker := filepath.Join(current, ".git")
		if info, err := os.Stat(marker); err == nil {
			main, link := mainWorktree(marker, info)
			switch link {
			case linkConfirmed:
				return main, true
			case linkRefused:
				return current, false
			}
			return current, true
		}
		parent := filepath.Dir(current)
		if parent == current {
			return resolved, true
		}
		current = parent
	}
}

type worktreeLink int

const (
	notLinked worktreeLink = iota
	linkConfirmed
	linkRefused
)

// mainWorktree follows a linked worktree's .git file to the repository
// whose git directory it shares. The .git file and the commondir it leads to
// are the folder's own content, which a cloned repository controls, so the
// redirect is taken only when git's own records confirm it: the worktree's
// git directory sits in <common dir>/worktrees/ and its gitdir file points
// back at this .git file.
func mainWorktree(marker string, info os.FileInfo) (string, worktreeLink) {
	if info.IsDir() {
		return "", notLinked
	}
	content, err := os.ReadFile(marker)
	if err != nil {
		return "", notLinked
	}
	gitDir, found := strings.CutPrefix(strings.TrimSpace(string(content)), "gitdir:")
	if !found {
		return "", notLinked
	}
	gitDir = absoluteFrom(filepath.Dir(marker), strings.TrimSpace(gitDir))
	common, err := os.ReadFile(filepath.Join(gitDir, "commondir"))
	if err != nil {
		// A submodule's .git file names a git directory of its own.
		return "", notLinked
	}
	commonDir, err := filepath.EvalSymlinks(absoluteFrom(gitDir, strings.TrimSpace(string(common))))
	if err != nil || filepath.Base(commonDir) != ".git" {
		return "", linkRefused
	}
	if info, err := os.Stat(commonDir); err != nil || !info.IsDir() {
		return "", linkRefused
	}
	realGitDir, err := filepath.EvalSymlinks(gitDir)
	if err != nil || filepath.Dir(realGitDir) != filepath.Join(commonDir, "worktrees") {
		return "", linkRefused
	}
	backLink, err := os.ReadFile(filepath.Join(realGitDir, "gitdir"))
	if err != nil {
		return "", linkRefused
	}
	linked, err := filepath.EvalSymlinks(absoluteFrom(realGitDir, strings.TrimSpace(string(backLink))))
	self, selfErr := filepath.EvalSymlinks(marker)
	if err != nil || selfErr != nil || linked != self {
		return "", linkRefused
	}
	return filepath.Dir(commonDir), linkConfirmed
}

func absoluteFrom(base, path string) string {
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	return filepath.Join(base, path)
}

// ErrOtherMapping means the folder's project already holds our entry for
// another mapping (two bound folders in one repository); it is left alone.
var ErrOtherMapping = errors.New("folder_bound_to_other_mapping")

// pinnedMapping is the mapping an owned entry's --mapping names, or "".
func pinnedMapping(entry any) string {
	fields, _ := entry.(map[string]any)
	args, _ := fields["args"].([]any)
	if len(args) == 3 && args[1] == "--mapping" {
		id, _ := args[2].(string)
		return id
	}
	return ""
}

func mcpEntry(executable, mappingID string) (map[string]any, error) {
	if !filepath.IsAbs(executable) || strings.ContainsAny(executable, "\x00\r\n") {
		return nil, fmt.Errorf("%w: companion path must be absolute", agent.ErrConfigInvalid)
	}
	return map[string]any{
		"type":    "stdio",
		"command": executable,
		"args":    []any{"mcp", "--mapping", mappingID},
		"env":     map[string]any{},
	}, nil
}

// projectMCPFiles are the folder's shared .mcp.json files, read only.
func projectMCPFiles(root string) []string {
	key := MCPProjectKey(root)
	files := []string{filepath.Join(key, ".mcp.json")}
	if resolved := filepath.Clean(root); resolved != key {
		files = append(files, filepath.Join(resolved, ".mcp.json"))
	}
	return files
}

// localServers is the folder's local-scope server map, or nil.
func localServers(config map[string]any, key string) map[string]any {
	projects, _ := config["projects"].(map[string]any)
	project, _ := projects[key].(map[string]any)
	servers, _ := project["mcpServers"].(map[string]any)
	return servers
}

func ensureLocalServers(config map[string]any, key string) (map[string]any, error) {
	projects, err := mcpentry.Servers(config, "projects")
	if err != nil {
		return nil, err
	}
	project, err := mcpentry.Servers(projects, key)
	if err != nil {
		return nil, err
	}
	return mcpentry.Servers(project, "mcpServers")
}

// foreignNameIn reports a foreign "backplane" in a scope that would clash
// with ours for this folder.
func foreignNameIn(servers map[string]any) bool {
	entry, present := servers[mcpentry.Name]
	return present && !mcpentry.IsOwned(entry)
}

// WriteMCP adds the folder's local-scope entry, which runs the companion's
// launcher pinned to mappingID. It writes nothing, with ErrNameTaken, when
// any scope Claude Code merges for the folder has a foreign "backplane".
func WriteMCP(env agent.Env, root, mappingID string) (bool, error) {
	entry, err := mcpEntry(env.Executable, mappingID)
	if err != nil {
		return false, err
	}
	for _, path := range projectMCPFiles(root) {
		shared, err := mcpentry.ReadJSON(path)
		if err == nil {
			servers, _ := shared["mcpServers"].(map[string]any)
			if foreignNameIn(servers) {
				return false, mcpentry.ErrNameTaken
			}
		}
	}
	key := MCPProjectKey(root)
	changed := false
	err = mcpentry.EditJSON(MCPConfigPath(env), true, func(config map[string]any) (bool, error) {
		user, _ := config["mcpServers"].(map[string]any)
		if foreignNameIn(user) {
			return false, mcpentry.ErrNameTaken
		}
		servers, err := ensureLocalServers(config, key)
		if err != nil {
			return false, err
		}
		if existing := servers[mcpentry.Name]; mcpentry.IsOwned(existing) && pinnedMapping(existing) != "" && pinnedMapping(existing) != mappingID {
			return false, ErrOtherMapping
		}
		changed, err = mcpentry.Put(servers, entry)
		return changed, err
	})
	return changed && err == nil, err
}

// RemoveMCP drops the folder's entry if it is ours and pinned to one of
// mappingIDs; nil removes whichever owned entry is there (disconnect). It
// never creates the file.
func RemoveMCP(env agent.Env, root string, mappingIDs []string) (bool, error) {
	key := MCPProjectKey(root)
	changed := false
	err := mcpentry.EditJSON(MCPConfigPath(env), false, func(config map[string]any) (bool, error) {
		servers := localServers(config, key)
		if mappingIDs != nil && !slices.Contains(mappingIDs, pinnedMapping(servers[mcpentry.Name])) {
			return false, nil
		}
		changed = mcpentry.Remove(servers)
		return changed, nil
	})
	return changed && err == nil, err
}

// RepairMCP repoints every owned entry at the current executable.
func RepairMCP(env agent.Env) (bool, error) {
	if !filepath.IsAbs(env.Executable) {
		return false, fmt.Errorf("%w: companion path must be absolute", agent.ErrConfigInvalid)
	}
	changed := false
	err := mcpentry.EditJSON(MCPConfigPath(env), false, func(config map[string]any) (bool, error) {
		projects, _ := config["projects"].(map[string]any)
		for key := range projects {
			if mcpentry.Repoint(localServers(config, key), env.Executable) {
				changed = true
			}
		}
		return changed, nil
	})
	return changed && err == nil, err
}

// MCPFindings names the other Backplane entries Claude Code loads for the
// folder: user scope, its local scope and its shared .mcp.json.
func MCPFindings(env agent.Env, root, endpoint string) ([]mcpentry.Finding, error) {
	findings := []mcpentry.Finding{}
	config, err := mcpentry.ReadJSON(MCPConfigPath(env))
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return findings, err
	}
	scopes := []map[string]any{}
	if config != nil {
		user, _ := config["mcpServers"].(map[string]any)
		scopes = append(scopes, user, localServers(config, MCPProjectKey(root)))
	}
	for _, path := range projectMCPFiles(root) {
		if shared, err := mcpentry.ReadJSON(path); err == nil {
			servers, _ := shared["mcpServers"].(map[string]any)
			scopes = append(scopes, servers)
		}
	}
	seen := map[mcpentry.Finding]bool{}
	for _, servers := range scopes {
		for _, finding := range mcpentry.Scan(servers, endpoint) {
			if !seen[finding] {
				seen[finding] = true
				findings = append(findings, finding)
			}
		}
	}
	return findings, nil
}
