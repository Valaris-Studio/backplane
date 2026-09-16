// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import "testing"

func TestClaudeCLI_SkillsRelDir(t *testing.T) {
	locator, ok := any(NewClaudeCLI()).(SkillsLocator)
	if !ok {
		t.Fatal("ClaudeCLI does not implement SkillsLocator")
	}
	if got := locator.SkillsRelDir(); got != ".claude/skills" {
		t.Errorf("SkillsRelDir() = %q, want .claude/skills", got)
	}
}

func TestCodexCLI_SkillsRelDir(t *testing.T) {
	locator, ok := any(NewCodexCLI()).(SkillsLocator)
	if !ok {
		t.Fatal("CodexCLI does not implement SkillsLocator")
	}
	if got := locator.SkillsRelDir(); got != ".codex/skills" {
		t.Errorf("SkillsRelDir() = %q, want .codex/skills", got)
	}
}

func TestMockProvider_IsNotSkillsLocator(t *testing.T) {
	// A provider with no known discovery location must NOT satisfy the
	// interface — that absence is what makes the runner skip materialization
	// rather than guess a directory the agent never reads.
	if _, ok := any(&MockProvider{}).(SkillsLocator); ok {
		t.Error("MockProvider implements SkillsLocator, want it to opt out")
	}
}
