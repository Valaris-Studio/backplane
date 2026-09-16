// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package registry constructs the configured forge.Provider from runner config.
// It mirrors the createProvider() switch for LLM drivers in cmd/backplane-runner/main.go:
// the YAML field (git.forge) selects the driver at startup, and an unknown forge
// is a loud error rather than a silent github fallback. It lives in its own
// package (not the base forge package) because it imports the concrete drivers,
// which import forge — putting the switch in forge would cycle.
package registry

import (
	"fmt"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/forge"
	"github.com/Valaris-Studio/backplane/runner/internal/forge/gitea"
	"github.com/Valaris-Studio/backplane/runner/internal/forge/github"
	"github.com/Valaris-Studio/backplane/runner/internal/git"
)

// New builds the forge.Provider named by cfg.Git.Forge. An empty value defaults
// to "github" for back-compat (the pre-config-select behavior). The github
// driver wraps the supplied git.Manager's `gh` methods; the gitea driver speaks
// HTTP and requires forge_base_url + forge_token. An unknown forge errors.
func New(cfg *config.Config, gitMgr *git.Manager) (forge.Provider, error) {
	kind := cfg.Git.Forge
	if kind == "" {
		kind = "github"
	}
	switch kind {
	case "github":
		return github.New(gitMgr), nil
	case "gitea":
		if cfg.Git.ForgeBaseURL == "" {
			return nil, fmt.Errorf("git.forge=gitea requires git.forge_base_url (the Gitea instance root)")
		}
		if cfg.Git.ForgeToken == "" {
			return nil, fmt.Errorf("git.forge=gitea requires git.forge_token (a Gitea access token)")
		}
		return gitea.New(cfg.Git.ForgeBaseURL, cfg.Git.ForgeToken), nil
	default:
		return nil, fmt.Errorf("unknown git.forge %q (supported: github, gitea)", kind)
	}
}
