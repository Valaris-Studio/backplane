// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"fmt"
	"strings"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
	"github.com/Valaris-Studio/backplane/runner/internal/workloop"
)

func checkCompletionWorkflow(ctx context.Context, cfg *config.Config, creds Credentials, lookPath func(string) (string, error), probe func(context.Context, string, string, string, *valaris.BoardLoopConfig) (workloop.MCPLaunchReport, error)) checkResult {
	row := checkResult{Label: "completion workflow", State: tui.StateWarn, Detail: "Unverified: select a board to check its complete workflow.", Fix: "run -doctor -loop-board BOARD with the same config/profile and source override intended for launch"}
	if cfg == nil {
		return row
	}
	fail := func(detail string) checkResult { row.State = tui.StateFail; row.Detail = detail; return row }
	if len(cfg.Valaris.BoardIDs) != 1 {
		reports, err := preflightConfiguredRuntime(ctx, cfg, lookPath)
		if err != nil {
			return fail(redactDoctorWorkflow(err.Error(), cfg, creds))
		}
		for _, report := range reports {
			row.Detail += " " + redactDoctorWorkflow(report.String(), cfg, creds)
		}
		return row
	}
	if creds.APIKey == "" {
		return fail("Cannot read completion policy without workspace credentials.")
	}
	if err := preflightTools(cfg, lookPath); err != nil {
		return fail(redactDoctorWorkflow(err.Error(), cfg, creds))
	}
	client := valaris.NewClient(creds.APIURL, creds.APIKey)
	board := cfg.Valaris.BoardIDs[0]
	policy, err := client.GetBoardLoop(ctx, creds.Workspace, board)
	if err != nil {
		return fail("Cannot read the selected board's completion policy; verify board access and backend compatibility.")
	}
	providers := map[string]llm.Provider{}
	for _, name := range launchProviderSet(cfg) {
		provider := providerByName(name)
		if provider == nil {
			return fail(fmt.Sprintf("Unknown configured provider %q; correct the runner configuration.", name))
		}
		providers[name] = provider
	}
	effective := *policy
	if cfg.LLM.RunOverride != nil {
		effective.Provider = cfg.LLM.RunOverride.Provider
	}
	report, err := workloop.PreflightCompletionWorkflow(ctx, client, creds.Workspace, board, &effective, providers, providers[launchDefaultProvider(cfg)], lookPath)
	if err != nil {
		return fail(redactDoctorWorkflow(err.Error(), cfg, creds))
	}
	if policy.CompletionPolicy == nil {
		row.Detail = "Selected board has no explicit completion workflow. " + redactDoctorWorkflow(strings.Join(append(report.Assignments, report.Unverified...), " "), cfg, creds)
		row.Fix = "Local diagnostics do not verify provider account/model access."
		return row
	}
	mcp, err := probe(ctx, creds.MCPConfigPath, creds.Workspace, board, policy)
	if err != nil {
		return fail(redactDoctorWorkflow(err.Error(), cfg, creds))
	}
	readiness, err := workloop.PreflightCompletionReadiness(ctx, client, creds.Workspace, board, policy)
	if err != nil {
		return fail(redactDoctorWorkflow(err.Error(), cfg, creds))
	}
	details := append([]string{fmt.Sprintf("MCP config %s; executable %s; version %s.", mcp.ConfigPath, mcp.Executable, mcp.Version)}, report.Assignments...)
	sourceProvider, sourceModel := cfg.LLM.Provider, cfg.LLM.Model
	if cfg.LLM.RunOverride != nil {
		sourceProvider, sourceModel = cfg.LLM.RunOverride.Provider, cfg.LLM.RunOverride.Model
	} else if policy.Provider != "" {
		sourceProvider, sourceModel = policy.Provider, policy.Model
	}
	details = append(details, fmt.Sprintf("Source selection: %s / %s.", sourceProvider, sourceModel))
	details = append(details, report.Unverified...)
	details = append(details, readiness.Verified...)
	details = append(details, readiness.Unverified...)
	row.Detail = redactDoctorWorkflow(strings.Join(details, " "), cfg, creds)
	row.Fix = "Complete operational verification of the listed unverified prerequisites; launch repeats these configuration checks before paid work."
	return row
}

func redactDoctorWorkflow(value string, cfg *config.Config, creds Credentials) string {
	secrets := []string{creds.APIKey, cfg.Valaris.APIKey, cfg.LLM.AnthropicAPIKey, cfg.Git.ForgeToken}
	for _, token := range cfg.Git.Tokens {
		secrets = append(secrets, token)
	}
	for _, secret := range secrets {
		if secret != "" {
			value = strings.ReplaceAll(value, secret, "[redacted]")
		}
	}
	return value
}
