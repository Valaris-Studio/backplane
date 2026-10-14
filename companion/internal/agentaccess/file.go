// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package agentaccess keeps which bound folders let agents work on their
// board through Backplane's MCP, the agents' key that goes with it, and the
// agent configuration entries that point at the companion's launcher.
package agentaccess

import (
	"errors"
	"os"
	"path/filepath"
	"sort"

	"github.com/Valaris-Studio/backplane/companion/internal/mcplaunch"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

const (
	fileVersion  = 1
	maxFileBytes = 1 << 20
)

// MappingAccess is what the launcher needs to serve a mapping's board. It
// holds no secret: the key stays in the keyring.
type MappingAccess struct {
	Enabled       bool   `json:"enabled"`
	Root          string `json:"root"`
	WorkspaceSlug string `json:"workspace_slug"`
	WorkspaceName string `json:"workspace_name"`
	BoardID       string `json:"board_id"`
	BoardName     string `json:"board_name"`
	// Roots are every local folder of the mapping: a repository-bound
	// mapping may have several clones or worktrees. Root is the first.
	Roots []string `json:"roots,omitempty"`
}

// AllRoots is Roots, or Root for a file written before Roots existed.
func (a MappingAccess) AllRoots() []string {
	if len(a.Roots) > 0 {
		return a.Roots
	}
	if a.Root != "" {
		return []string{a.Root}
	}
	return []string{}
}

// Written records the entries the companion wrote, so they can be removed
// even after the mapping or the agent is gone.
type Written struct {
	ClaudeCode []string `json:"claude_code"`
	CodexCLI   bool     `json:"codex_cli"`
	PiCLI      bool     `json:"pi_cli"`
}

type File struct {
	Version             int                      `json:"version"`
	Endpoint            string                   `json:"endpoint"`
	Mappings            map[string]MappingAccess `json:"mappings"`
	Written             Written                  `json:"written"`
	PendingServerDelete bool                     `json:"pending_server_delete,omitempty"`
}

func Path(layout store.Layout) string { return filepath.Join(layout.Root, "agent_access.json") }

// Load returns an empty file when none exists; a file others can read is
// refused, since the launcher would act on it.
func Load(layout store.Layout) (File, error) {
	var file File
	err := store.ReadJSON(Path(layout), maxFileBytes, &file)
	if errors.Is(err, os.ErrNotExist) {
		err = nil
	}
	return file.normalized(), err
}

func Save(layout store.Layout, file File) error {
	file = file.normalized()
	file.Version = fileVersion
	return store.WriteJSON(Path(layout), file)
}

func (f File) normalized() File {
	if f.Mappings == nil {
		f.Mappings = map[string]MappingAccess{}
	}
	if f.Written.ClaudeCode == nil {
		f.Written.ClaudeCode = []string{}
	}
	return f
}

func (f File) LaunchMappings() []mcplaunch.Mapping {
	mappings := make([]mcplaunch.Mapping, 0, len(f.Mappings))
	// One launch mapping per folder, so a global entry started in any clone
	// resolves the mapping.
	for id, access := range f.Mappings {
		for _, root := range access.AllRoots() {
			mappings = append(mappings, mcplaunch.Mapping{
				ID: id, Enabled: access.Enabled, Root: root,
				WorkspaceSlug: access.WorkspaceSlug, WorkspaceName: access.WorkspaceName,
				BoardID: access.BoardID, BoardName: access.BoardName,
			})
		}
	}
	sort.SliceStable(mappings, func(i, j int) bool { return mappings[i].ID < mappings[j].ID })
	return mappings
}
