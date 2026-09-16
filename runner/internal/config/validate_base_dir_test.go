// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package config

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateBaseDir_AcceptsDirOutsideAnyWorktree(t *testing.T) {
	if err := ValidateBaseDir(t.TempDir()); err != nil {
		t.Fatalf("a plain temp dir should be a valid base_dir: %v", err)
	}
}

// The guard must also accept a not-yet-created clone root — the runner makes
// it lazily, so the walk above the deepest existing path is purely lexical.
func TestValidateBaseDir_AcceptsNonexistentDirOutsideAnyWorktree(t *testing.T) {
	path := filepath.Join(t.TempDir(), "repos", "not", "created", "yet")
	if err := ValidateBaseDir(path); err != nil {
		t.Fatalf("a nonexistent path outside a worktree should be valid: %v", err)
	}
}

func TestValidateBaseDir_RejectsDirInsideAWorktree(t *testing.T) {
	worktree := t.TempDir()
	if err := os.Mkdir(filepath.Join(worktree, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	inside := filepath.Join(worktree, "repos")

	err := ValidateBaseDir(inside)
	if err == nil {
		t.Fatal("a base_dir inside a git worktree must be rejected")
	}
	if !strings.Contains(err.Error(), "git worktree") {
		t.Errorf("error should name the worktree hazard, got: %v", err)
	}
}

// The worktree root itself is the worst case — reject it too.
func TestValidateBaseDir_RejectsTheWorktreeRootItself(t *testing.T) {
	worktree := t.TempDir()
	if err := os.Mkdir(filepath.Join(worktree, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := ValidateBaseDir(worktree); err == nil {
		t.Fatal("the worktree root itself must be rejected")
	}
}

func TestValidateBaseDir_RejectsEmptyPath(t *testing.T) {
	if err := ValidateBaseDir(""); err == nil {
		t.Fatal("an empty base_dir must be rejected")
	}
}

func TestDefaults_MatchesLoadWithoutAFile(t *testing.T) {
	d := Defaults()
	if d.LLM.Provider != "claude-cli" || d.LLM.Model != "sonnet" {
		t.Errorf("Defaults() drifted from the shipped LLM defaults: %+v", d.LLM)
	}
	if d.Valaris.APIURL != "http://localhost:8000" {
		t.Errorf("Defaults() drifted from the shipped API URL: %q", d.Valaris.APIURL)
	}
	// Each call must hand back an independent value — the wizard mutates it.
	d.LLM.Provider = "codex-cli"
	if Defaults().LLM.Provider != "claude-cli" {
		t.Error("Defaults() returns a shared value; mutations leak between callers")
	}
}
