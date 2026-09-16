// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readRunnerDoc(t *testing.T, parts ...string) string {
	t.Helper()
	path := filepath.Join(append([]string{"..", ".."}, parts...)...)
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(body)
}

func TestRunnerREADMEContractsCurrentOperatorSurface(t *testing.T) {
	readme := strings.Join(strings.Fields(readRunnerDoc(t, "README.md")), " ")

	for _, flag := range []string{
		"-config", "-profile", "-discover", "-doctor", "-fix",
		"-loop", "-loop-board", "-keep-alive", "-version", "-run-provider", "-run-model",
		"-no-supervisor", "-verbose", "-interactive",
	} {
		if !strings.Contains(readme, "`"+flag) {
			t.Errorf("runner README does not document %s", flag)
		}
	}

	for _, required := range []string{
		"REST control plane",
		"MCP agent plane",
		"profiles/<name>",
		"idle_waiting",
		"server for read-only compatibility checks",
		"It never starts a coding agent",
		"workflow compatibility remains unverified",
		"does not expand placeholders inside that JSON",
		"API-key-only Codex auth is therefore not wired",
		"not runnable as shipped",
	} {
		if !strings.Contains(readme, required) {
			t.Errorf("runner README is missing operator contract %q", required)
		}
	}
}

func TestRunnerConfigReferenceDoesNotClaimRESTIsStartupOnly(t *testing.T) {
	configReference := readRunnerDoc(t, "configs", "runner.example.yaml")
	for _, stale := range []string{
		"Used ONLY for startup identity check",
		"All other operations go through MCP tools",
		"ALL Valaris operations",
		"This key is also injected into the MCP server config",
	} {
		if strings.Contains(configReference, stale) {
			t.Errorf("runner config reference still carries stale transport claim %q", stale)
		}
	}
	if !strings.Contains(configReference, "runner control-plane REST calls") {
		t.Error("runner config reference does not explain the REST control-plane use")
	}
	if !strings.Contains(configReference, "does not expand ${VAR} placeholders") {
		t.Error("runner config reference does not warn that MCP JSON placeholders remain literal")
	}
}

func TestProviderGuideSeparatesRunnerAndPlatformCredentials(t *testing.T) {
	providers := readRunnerDoc(t, "docs", "providers.md")
	for _, required := range []string{
		"Runner process credentials",
		"Platform merge-queue credentials",
		"never sends workspace Git Connections to the runner",
		"Plain git does not interpret `GH_TOKEN`",
		"setting only `CODEX_API_KEY` on the runner process is not sufficient",
		"merge_via_queue",
	} {
		if !strings.Contains(providers, required) {
			t.Errorf("provider guide is missing credential/lifecycle contract %q", required)
		}
	}
}
