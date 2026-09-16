// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

// SkillsLocator is the optional capability of naming where, inside its working
// directory, a coding agent discovers skills. The runner copies published skill
// files there and lets the agent find them on its own — it never reads a skill
// body or injects one into a prompt.
//
// The path must be INSIDE the working dir: Codex ignores ContextDirs entirely,
// so an out-of-tree location would be invisible to it. A provider with no
// documented discovery convention simply does not implement this, and the
// runner skips materialization rather than writing files nothing will read.
type SkillsLocator interface {
	Provider
	SkillsRelDir() string
}

// SkillsRelDir reports Claude Code's project-scoped skills directory.
func (c *ClaudeCLI) SkillsRelDir() string { return ".claude/skills" }

// SkillsRelDir reports Codex's project-scoped skills directory. Verified
// against codex-cli 0.144.1, which discovers <project>/.codex/skills/<name>/
// SKILL.md even when the project is untrusted.
func (c *CodexCLI) SkillsRelDir() string { return ".codex/skills" }

var (
	_ SkillsLocator = (*ClaudeCLI)(nil)
	_ SkillsLocator = (*CodexCLI)(nil)
)
