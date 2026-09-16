// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/tui"
)

func TestInteractiveSelectionFlagsNeverSilentlyIgnoreExplicitConfig(t *testing.T) {
	for _, tc := range []struct{ interactive, config, profile, reject bool }{
		{true, true, false, true}, {true, false, true, true}, {true, true, true, true},
		{true, false, false, false}, {false, true, false, false}, {false, false, true, false},
	} {
		err := validateInteractiveSelectionFlags(tc.interactive, tc.config, tc.profile)
		if (err != nil) != tc.reject {
			t.Fatalf("interactive=%v config=%v profile=%v: %v", tc.interactive, tc.config, tc.profile, err)
		}
		if err != nil && (!strings.Contains(err.Error(), "omit -interactive") || !strings.Contains(err.Error(), "profile")) {
			t.Fatalf("missing corrective action: %v", err)
		}
	}
}

func TestWizardDoctorCredentialsUseProfileSelectionInsteadOfCWD(t *testing.T) {
	startup := Credentials{APIKey: "startup", APIURL: "https://startup.test", Workspace: "startup", MCPConfigPath: "/cwd/mcp.json"}
	for _, path := range []string{"/profile/chosen.config", "/profile/missing.config", ""} {
		result := tui.Result{LoadedProfileName: "chosen", MCPConfigSelected: true, MCPConfigPath: path, MCPConfigOrigin: "profile chosen", APIKey: "profile", APIURL: "https://profile.test", Workspace: "chosen"}
		got := wizardDoctorCredentials(result, startup)
		if got.MCPConfigPath != path || got.APIKey != "profile" || got.Workspace != "chosen" {
			t.Fatal("doctor must use exact selected profile and credentials, even when MCP is missing")
		}
	}
	result := tui.Result{MCPConfigSkipped: true}
	if got := wizardDoctorCredentials(result, startup); got.MCPConfigPath != "" {
		t.Fatal("doctor restored skipped config")
	}
}
