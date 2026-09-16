// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package registry

import (
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/forge/gitea"
	"github.com/Valaris-Studio/backplane/runner/internal/forge/github"
	"github.com/Valaris-Studio/backplane/runner/internal/git"
)

func TestNew_DefaultsToGitHub(t *testing.T) {
	// An empty forge string is the back-compat default: github, byte-identical
	// to the pre-config-select behavior.
	cfg := &config.Config{}
	got, err := New(cfg, &git.Manager{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := got.(*github.Driver); !ok {
		t.Fatalf("empty forge: got %T, want *github.Driver", got)
	}
	if got.Kind() != "github" {
		t.Fatalf("Kind() = %q, want github", got.Kind())
	}
}

func TestNew_GitHubExplicit(t *testing.T) {
	cfg := &config.Config{}
	cfg.Git.Forge = "github"
	got, err := New(cfg, &git.Manager{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := got.(*github.Driver); !ok {
		t.Fatalf("got %T, want *github.Driver", got)
	}
}

func TestNew_Gitea(t *testing.T) {
	cfg := &config.Config{}
	cfg.Git.Forge = "gitea"
	cfg.Git.ForgeBaseURL = "https://gitea.example.com"
	cfg.Git.ForgeToken = "tok"
	got, err := New(cfg, &git.Manager{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if _, ok := got.(*gitea.Driver); !ok {
		t.Fatalf("got %T, want *gitea.Driver", got)
	}
	if got.Kind() != "gitea" {
		t.Fatalf("Kind() = %q, want gitea", got.Kind())
	}
}

func TestNew_GiteaRequiresBaseURL(t *testing.T) {
	cfg := &config.Config{}
	cfg.Git.Forge = "gitea"
	cfg.Git.ForgeToken = "tok" // base URL missing
	_, err := New(cfg, &git.Manager{})
	if err == nil {
		t.Fatal("expected error when gitea base URL is missing")
	}
	if !strings.Contains(err.Error(), "forge_base_url") {
		t.Fatalf("error should name the missing field, got: %v", err)
	}
}

func TestNew_GiteaRequiresToken(t *testing.T) {
	cfg := &config.Config{}
	cfg.Git.Forge = "gitea"
	cfg.Git.ForgeBaseURL = "https://gitea.example.com" // token missing
	_, err := New(cfg, &git.Manager{})
	if err == nil {
		t.Fatal("expected error when gitea token is missing")
	}
	if !strings.Contains(err.Error(), "forge_token") {
		t.Fatalf("error should name the missing field, got: %v", err)
	}
}

func TestNew_UnknownForgeErrors(t *testing.T) {
	cfg := &config.Config{}
	cfg.Git.Forge = "bitbucket"
	_, err := New(cfg, &git.Manager{})
	if err == nil {
		t.Fatal("expected error for an unknown forge")
	}
	if !strings.Contains(err.Error(), "bitbucket") {
		t.Fatalf("error should name the unknown forge, got: %v", err)
	}
}
