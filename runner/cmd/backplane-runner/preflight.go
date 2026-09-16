// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"fmt"
	"log/slog"
	"os/exec"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// requiredTool is an external binary the runner shells out to, plus an
// actionable hint for when it's missing on PATH.
type requiredTool struct {
	bin string
	why string
	fix string
}

// providerTools is the single mapping from a coding-agent provider id to the
// binary it shells out to. Both the startup preflight and the interactive
// wizard's provider probe read it, so a new provider is added in one place.
// Order is the wizard's presentation order, hence a slice rather than a map.
var providerTools = []struct {
	provider string
	tool     requiredTool
}{
	{"claude-cli", requiredTool{
		bin: "claude",
		why: "llm.provider=claude-cli",
		fix: "install Claude Code so a `claude` binary is on PATH",
	}},
	{"codex-cli", requiredTool{
		bin: "codex",
		why: "llm.provider=codex-cli",
		fix: "install a stock `codex` (e.g. `brew install --cask codex`) and run `codex login` or set CODEX_API_KEY",
	}},
}

// toolForProvider returns the binary a provider needs, and whether the
// provider is one the runner knows how to build.
func toolForProvider(provider string) (requiredTool, bool) {
	for _, pt := range providerTools {
		if pt.provider == provider {
			return pt.tool, true
		}
	}
	return requiredTool{}, false
}

// preflightTools checks that the external binaries the SELECTED providers shell
// out to are resolvable on PATH, failing loudly with an actionable message
// rather than letting the first card die with an opaque exec error mid-run.
// lookPath is injected (exec.LookPath in prod) so the gate is testable. Drivers
// that speak HTTP (gitea forge) need no binary and contribute nothing to check.
func preflightTools(cfg *config.Config, lookPath func(string) (string, error)) error {
	var required []requiredTool

	// Check the effective source and explicit additional capabilities. A replaced
	// default is checked later if the board requires it for completion work.
	for _, provider := range launchPreflightProviderSet(cfg) {
		if tool, known := toolForProvider(provider); known {
			required = append(required, tool)
		}
	}

	// Empty forge defaults to github (see registry.New), which shells `gh`.
	forge := cfg.Git.Forge
	if forge == "" {
		forge = "github"
	}
	if forge == "github" {
		required = append(required, requiredTool{
			bin: "gh",
			why: "git.forge=github",
			fix: "install the GitHub CLI and run `gh auth login`",
		})
	}

	for _, t := range required {
		if _, err := lookPath(t.bin); err != nil {
			return fmt.Errorf("%s requires a %q binary on PATH but it was not found — %s", t.why, t.bin, t.fix)
		}
	}
	return nil
}

// preflight runs the tool checks against the real PATH.
func preflight(cfg *config.Config) error {
	if err := preflightTools(cfg, exec.LookPath); err != nil {
		return err
	}
	reports, err := preflightConfiguredRuntime(context.Background(), cfg, exec.LookPath)
	if err != nil {
		return err
	}
	for _, report := range reports {
		slog.Info("Provider runtime diagnostics", "detail", report.String())
	}
	return nil
}

func preflightConfiguredRuntime(ctx context.Context, cfg *config.Config, lookPath func(string) (string, error)) ([]llm.RuntimeHealthReport, error) {
	var reports []llm.RuntimeHealthReport
	for _, name := range launchPreflightProviderSet(cfg) {
		provider := providerByName(name)
		if provider == nil {
			return reports, fmt.Errorf("unknown configured provider %q; correct runner configuration", name)
		}
		report, err := llm.CheckRuntimeHealth(ctx, provider, lookPath)
		if err != nil {
			return reports, err
		}
		reports = append(reports, report)
	}
	return reports, nil
}
