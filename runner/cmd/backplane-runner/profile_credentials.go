// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"fmt"
	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/profile"
)

// Explicit profiles pin the same stored identity for diagnostics and launch.
func pinProfileCredentials(cfg *config.Config, root, name string) ([]string, error) {
	if name == "" {
		return nil, nil
	}
	if cfg == nil {
		return nil, fmt.Errorf("cannot read the selected profile runner configuration")
	}
	selected, warnings, err := profile.LoadForRun(root, name)
	if err != nil {
		return nil, err
	}
	if selected.Credentials.APIKey != "" {
		cfg.Valaris.APIKey = selected.Credentials.APIKey
	}
	if selected.Credentials.APIURL != "" {
		cfg.Valaris.APIURL = selected.Credentials.APIURL
	}
	if selected.Credentials.Workspace != "" {
		cfg.Valaris.WorkspaceSlug = selected.Credentials.Workspace
	}
	return warnings, nil
}
