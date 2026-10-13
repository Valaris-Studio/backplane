// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"fmt"
	"os"

	"github.com/Valaris-Studio/backplane/companion/internal/agentaccess"
	"github.com/Valaris-Studio/backplane/companion/internal/buildinfo"
	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/mcplaunch"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// mcp is the stdio MCP server agents' configurations run. It only reads the
// daemon's state: it never creates the data directory or writes to it.
func (a *app) mcp(ctx context.Context, args []string) error {
	flags := newFlags("mcp")
	pinned := flags.String("mapping", "", "")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 {
		return fmt.Errorf("%w: mcp [--mapping <id>]", errUsage)
	}
	root, err := a.dataRoot()
	if err != nil {
		return err
	}
	layout := store.Layout{Root: root}
	installation, _ := state.Load[state.Installation](layout.Installation())
	admission, _ := state.Load[state.Admission](layout.Admission())
	access, accessErr := agentaccess.Load(layout)
	apiURL, apiSource := agentAPI(layout, installation)
	fallback := ""
	if apiSource != policy.APIBaseAdvertised {
		fallback = "api_base_" + string(apiSource)
	}
	cwd, _ := os.Getwd()
	config := mcplaunch.Config{
		Connected:       installation.ID != "" && installation.Endpoint != "" && !admission.RevokedFor(installation.ID),
		StateUnreadable: accessErr != nil,
		APIURL:          apiURL,
		APIURLFallback:  fallback,
		Mappings:        access.LaunchMappings(),
		PinnedMappingID: *pinned,
		Cwd:             cwd,
		LoadKey:         func() (string, error) { return a.keyring.Load(credentials.AgentKeyAccount(installation.ID)) },
		FindUvx:         func() (string, bool) { return mcplaunch.FindUvx(a.getenv, a.home, a.goos) },
		Env:             os.Environ(),
		Version:         buildinfo.Current(a.goos, a.goarch).Version,
		Stdin:           a.stdin,
		Stdout:          a.stdout,
		Stderr:          a.stderr,
	}
	return mcplaunch.Run(ctx, config)
}

// agentAPI is the API agents' backplane-mcp calls. The policy cache is read
// each time, so a launch follows the latest refresh (a stale cache still
// names the right API), and only a policy for this installation counts: a
// refresh that landed after a re-pair must never send this installation's
// agent key to the previous server.
func agentAPI(layout store.Layout, installation state.Installation) (string, policy.APIBaseSource) {
	cached, _ := policy.Load(layout.Policy())
	if cached.Policy.Installation.ID != installation.ID {
		cached = policy.Cached{}
	}
	return cached.Policy.AgentAPIBase(installation.Endpoint)
}
