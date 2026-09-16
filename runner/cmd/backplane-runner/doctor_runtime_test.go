// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
	"github.com/Valaris-Studio/backplane/runner/internal/workloop"
)

func runtimeDoctorLookPath(t *testing.T, present ...string) func(string) (string, error) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("POSIX diagnostic fixture")
	}
	root := t.TempDir()
	for _, name := range present {
		version := "codex-cli 0.144.1"
		if name == "claude" {
			version = "2.1.0 (Claude Code)"
		}
		if name != "claude" && name != "codex" {
			continue
		}
		if err := os.WriteFile(filepath.Join(root, name), []byte("#!/bin/sh\n[ \"$*\" = '--version' ] || exit 99\nprintf '%s\\n' '"+version+"'\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	lookup := fakeLookPath(present...)
	return func(name string) (string, error) {
		path, err := lookup(name)
		if err == nil && (name == "claude" || name == "codex") {
			path = filepath.Join(root, name)
		}
		return path, err
	}
}

func TestRuntimeHealthDoctorRejectsBrokenMixedProviderBeforeMCP(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX runtime fixture")
	}
	root := t.TempDir()
	resources := filepath.Join(root, "Fixture.app", "Contents", "Resources")
	bin := filepath.Join(root, "bin")
	for _, dir := range []string{resources, bin} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	for _, file := range []struct{ path, body string }{
		{filepath.Join(resources, "codex"), "#!/bin/sh\n[ \"$*\" = '--version' ] || exit 99\nprintf 'codex-cli 0.144.1\\n'\n"},
		{filepath.Join(resources, "codex-code-mode-host"), "#!/bin/sh\n[ \"$*\" = '--help' ] || exit 99\n"},
		{filepath.Join(bin, "claude"), "#!/bin/sh\n[ \"$*\" = '--version' ] || exit 99\nprintf '2.1.0 (Claude Code)\\n'\n"},
	} {
		if err := os.WriteFile(file.path, []byte(file.body), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(filepath.Join(resources, "codex"), filepath.Join(bin, "codex")); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/loop"):
			_, _ = w.Write([]byte(`{"provider":"claude-cli","model":"fable","completion_policy":{"version":1,"source_review":"independent","review_role":"custom-auditor"},"completion_policy_hash":"policy-1","completion_context":"policy"}`))
		case strings.HasSuffix(r.URL.Path, "/completion/requirements"):
			_, _ = w.Write([]byte(`{"policy_hash":"policy-1","requirements":[{"kind":"review","role":"custom-auditor","provider":"codex-cli","model":"operator-review-model","checks":[]}]}`))
		default:
			t.Errorf("runtime failure should precede later network checks: %s", r.URL.Path)
			w.WriteHeader(http.StatusServiceUnavailable)
		}
	}))
	defer server.Close()
	cfg := &config.Config{}
	cfg.Git.Forge = "gitea"
	cfg.LLM.Provider = "claude-cli"
	cfg.LLM.RunOverride = &config.ModelSelection{Provider: "claude-cli", Model: "fable"}
	cfg.LLM.ExtraProviders = []string{"codex-cli"}
	cfg.Valaris.BoardIDs = []string{"board-1"}
	mcpCalls := 0
	row := checkCompletionWorkflow(context.Background(), cfg, Credentials{APIURL: server.URL, APIKey: "vlr_fixture", Workspace: "acme"}, func(name string) (string, error) {
		if name == "git" {
			return "/fixture/git", nil
		}
		if name == "claude" || name == "codex" {
			return filepath.Join(bin, name), nil
		}
		return "", fmt.Errorf("unexpected executable %q", name)
	}, func(context.Context, string, string, string, *valaris.BoardLoopConfig) (workloop.MCPLaunchReport, error) {
		mcpCalls++
		return workloop.MCPLaunchReport{}, nil
	})
	if row.State != tui.StateFail || !strings.Contains(row.Detail, "codex-code-mode-host") || mcpCalls != 0 {
		t.Fatalf("doctor missed broken reviewer runtime: row=%+v mcp_calls=%d", row, mcpCalls)
	}
}
