// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
)

// fakeLookPath returns a lookPath stub: binaries in `present` resolve, all
// others report "not found".
func fakeLookPath(present ...string) func(string) (string, error) {
	set := make(map[string]bool, len(present))
	for _, p := range present {
		set[p] = true
	}
	return func(name string) (string, error) {
		if set[name] {
			return "/usr/local/bin/" + name, nil
		}
		return "", &lookPathErr{name}
	}
}

type lookPathErr struct{ name string }

func (e *lookPathErr) Error() string { return "exec: " + e.name + ": not found" }

func cfgWith(provider, forge string) *config.Config {
	c := &config.Config{}
	c.LLM.Provider = provider
	c.Git.Forge = forge
	return c
}

func TestPreflightTools_ClaudeAndGitHubPresent(t *testing.T) {
	err := preflightTools(cfgWith("claude-cli", "github"), fakeLookPath("claude", "gh"))
	if err != nil {
		t.Fatalf("all tools present should pass: %v", err)
	}
}

func TestPreflightTools_CodexMissing(t *testing.T) {
	err := preflightTools(cfgWith("codex-cli", "github"), fakeLookPath("gh"))
	if err == nil {
		t.Fatal("missing codex should fail preflight")
	}
	if !strings.Contains(err.Error(), "codex") {
		t.Fatalf("error should name the missing codex binary: %v", err)
	}
}

func TestPreflightTools_CodexPresent(t *testing.T) {
	err := preflightTools(cfgWith("codex-cli", "github"), fakeLookPath("codex", "gh"))
	if err != nil {
		t.Fatalf("codex present should pass: %v", err)
	}
}

func TestPreflightTools_ClaudeMissing(t *testing.T) {
	err := preflightTools(cfgWith("claude-cli", "github"), fakeLookPath("gh"))
	if err == nil {
		t.Fatal("missing claude should fail preflight")
	}
	if !strings.Contains(err.Error(), "claude") {
		t.Fatalf("error should name the missing claude binary: %v", err)
	}
}

func TestPreflightTools_GitHubMissingGh(t *testing.T) {
	err := preflightTools(cfgWith("claude-cli", "github"), fakeLookPath("claude"))
	if err == nil {
		t.Fatal("missing gh with forge=github should fail preflight")
	}
	if !strings.Contains(err.Error(), "gh") {
		t.Fatalf("error should name the missing gh binary: %v", err)
	}
}

func TestPreflightTools_EmptyForgeDefaultsToGitHubCheck(t *testing.T) {
	// Empty forge == github default, so gh is still required.
	err := preflightTools(cfgWith("claude-cli", ""), fakeLookPath("claude"))
	if err == nil {
		t.Fatal("empty forge defaults to github and should require gh")
	}
	if !strings.Contains(err.Error(), "gh") {
		t.Fatalf("error should name gh: %v", err)
	}
}

func TestPreflightTools_GiteaNeedsNoBinary(t *testing.T) {
	// Gitea speaks HTTP — no forge CLI is required, so only the LLM binary is
	// checked. claude present, gh absent → still passes.
	err := preflightTools(cfgWith("claude-cli", "gitea"), fakeLookPath("claude"))
	if err != nil {
		t.Fatalf("gitea forge needs no CLI binary: %v", err)
	}
}

func TestPreflightTools_MixedProvidersRequireAllBinaries(t *testing.T) {
	// A pipeline mixing codex-cli (default) + claude-cli (extra, for
	// ui_validator) must have BOTH binaries on PATH. Missing claude fails even
	// though the default codex is present.
	cfg := cfgWith("codex-cli", "gitea") // gitea forge => no gh needed; isolate LLM check
	cfg.LLM.ExtraProviders = []string{"claude-cli"}

	if err := preflightTools(cfg, fakeLookPath("codex")); err == nil {
		t.Fatal("missing claude (an extra provider) should fail preflight")
	} else if !strings.Contains(err.Error(), "claude") {
		t.Fatalf("error should name the missing claude binary: %v", err)
	}

	// Both present => pass.
	if err := preflightTools(cfg, fakeLookPath("codex", "claude")); err != nil {
		t.Fatalf("both providers present should pass: %v", err)
	}
}
