// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/tui"
)

// shouldRunInteractive is the single guard protecting every existing
// deployment: Docker, systemd, CI and every piped invocation must fall through
// to today's exact code path. The table is deliberately exhaustive.
func TestShouldRunInteractive(t *testing.T) {
	tests := []struct {
		name   string
		args   []string
		stdin  bool
		stdout bool
		want   bool
	}{
		{name: "bare invocation on a full TTY", args: nil, stdin: true, stdout: true, want: true},
		{name: "empty args slice on a full TTY", args: []string{}, stdin: true, stdout: true, want: true},

		{name: "bare invocation with no stdin TTY", args: nil, stdin: false, stdout: true},
		{name: "bare invocation with no stdout TTY", args: nil, stdin: true, stdout: false},
		{name: "bare invocation with neither a TTY", args: nil},

		{name: "-config suppresses the wizard", args: []string{"-config", "runner.yaml"}, stdin: true, stdout: true},
		{name: "--config suppresses the wizard", args: []string{"--config", "runner.yaml"}, stdin: true, stdout: true},
		{name: "-config= form suppresses the wizard", args: []string{"-config=runner.yaml"}, stdin: true, stdout: true},
		{name: "-loop suppresses the wizard", args: []string{"-loop"}, stdin: true, stdout: true},
		{name: "-loop-board suppresses the wizard", args: []string{"-loop-board", "b1"}, stdin: true, stdout: true},
		{name: "-discover suppresses the wizard", args: []string{"-discover"}, stdin: true, stdout: true},
		{name: "-version suppresses the wizard", args: []string{"-version"}, stdin: true, stdout: true},
		{name: "-verbose suppresses the wizard", args: []string{"-verbose"}, stdin: true, stdout: true},
		{name: "-no-supervisor suppresses the wizard", args: []string{"-no-supervisor"}, stdin: true, stdout: true},
		{name: "an unknown flag suppresses the wizard", args: []string{"-whatever"}, stdin: true, stdout: true},
		{name: "a bare positional arg suppresses the wizard", args: []string{"doctor"}, stdin: true, stdout: true},

		{name: "explicit -interactive on a full TTY", args: []string{"-interactive"}, stdin: true, stdout: true, want: true},
		{name: "explicit --interactive on a full TTY", args: []string{"--interactive"}, stdin: true, stdout: true, want: true},
		{name: "-interactive=true on a full TTY", args: []string{"-interactive=true"}, stdin: true, stdout: true, want: true},
		{name: "-interactive alongside other flags still wins", args: []string{"-verbose", "-interactive"}, stdin: true, stdout: true, want: true},
		{name: "-interactive with -config still wins", args: []string{"-config", "runner.yaml", "-interactive"}, stdin: true, stdout: true, want: true},

		// The TTY requirement is absolute — an explicit -interactive cannot
		// override it, or a CI job passing the flag would hang forever on a
		// prompt nobody can answer.
		{name: "-interactive without a stdin TTY", args: []string{"-interactive"}, stdin: false, stdout: true},
		{name: "-interactive without a stdout TTY", args: []string{"-interactive"}, stdin: true, stdout: false},
		{name: "-interactive with neither a TTY", args: []string{"-interactive"}},

		// Explicitly disabling must be honored even on a bare TTY invocation.
		{name: "-interactive=false on a bare TTY invocation", args: []string{"-interactive=false"}, stdin: true, stdout: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shouldRunInteractive(tt.args, tt.stdin, tt.stdout); got != tt.want {
				t.Errorf("shouldRunInteractive(%q, stdin=%v, stdout=%v) = %v, want %v",
					tt.args, tt.stdin, tt.stdout, got, tt.want)
			}
		})
	}
}

func TestResolveCredentials_EnvWins(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "runner.yaml")
	writeCredFile(t, path, "file-key", "http://file-url", "file-workspace")

	home := isolateCredentialsHome(t)
	t.Setenv("VALARIS_API_KEY", "env-key")
	t.Setenv("VALARIS_API_URL", "http://env-url")
	t.Setenv("VALARIS_WORKSPACE", "env-workspace")

	got := resolveCredentials(home, []string{path})

	if got.APIKey != "env-key" || got.APIKeySource != credSourceEnv {
		t.Errorf("api key = %q from %v, want env-key from env", got.APIKey, got.APIKeySource)
	}
	if got.APIURL != "http://env-url" || got.APIURLSource != credSourceEnv {
		t.Errorf("api url = %q from %v", got.APIURL, got.APIURLSource)
	}
	if got.Workspace != "env-workspace" || got.WorkspaceSource != credSourceEnv {
		t.Errorf("workspace = %q from %v", got.Workspace, got.WorkspaceSource)
	}
	if len(got.Missing()) != 0 {
		t.Errorf("nothing should be missing: %v", got.Missing())
	}
}

func TestResolveCredentials_FallsBackToAConfigFile(t *testing.T) {
	home := isolateCredentialsHome(t)

	path := filepath.Join(t.TempDir(), "runner.yaml")
	writeCredFile(t, path, "file-key", "http://file-url", "file-workspace")

	got := resolveCredentials(home, []string{path})

	if got.APIKey != "file-key" || got.APIKeySource != credSourceFile {
		t.Errorf("api key = %q from %v, want file-key from file", got.APIKey, got.APIKeySource)
	}
	if got.Workspace != "file-workspace" || got.WorkspaceSource != credSourceFile {
		t.Errorf("workspace = %q from %v", got.Workspace, got.WorkspaceSource)
	}
	if got.ConfigPath != path {
		t.Errorf("ConfigPath = %q, want %q", got.ConfigPath, path)
	}
}

// A file that carries only some values must not mask the env's, and each
// field's source is tracked independently so the UI can be honest about it.
func TestResolveCredentials_MixesSourcesPerField(t *testing.T) {
	home := isolateCredentialsHome(t)
	t.Setenv("VALARIS_API_KEY", "env-key")

	path := filepath.Join(t.TempDir(), "runner.yaml")
	writeCredFile(t, path, "file-key", "http://file-url", "")

	got := resolveCredentials(home, []string{path})

	if got.APIKey != "env-key" || got.APIKeySource != credSourceEnv {
		t.Errorf("env must win for the key: %q from %v", got.APIKey, got.APIKeySource)
	}
	if got.APIURL != "http://file-url" || got.APIURLSource != credSourceFile {
		t.Errorf("file must supply the url: %q from %v", got.APIURL, got.APIURLSource)
	}
	if got.Workspace != "" || got.WorkspaceSource != credSourceNone {
		t.Errorf("workspace should be unresolved: %q from %v", got.Workspace, got.WorkspaceSource)
	}
}

// The example config ships "${VALARIS_API_KEY}" as its api_key — a literal
// placeholder, never a usable credential. Treating it as one would send the
// runner into a guaranteed 401.
func TestResolveCredentials_IgnoresTheEnvPlaceholder(t *testing.T) {
	home := isolateCredentialsHome(t)
	path := filepath.Join(t.TempDir(), "runner.yaml")
	writeCredFile(t, path, "${VALARIS_API_KEY}", "http://file-url", "ws")

	got := resolveCredentials(home, []string{path})

	if got.APIKey != "" || got.APIKeySource != credSourceNone {
		t.Errorf("placeholder must not count as a key: %q from %v", got.APIKey, got.APIKeySource)
	}
	if !contains(got.Missing(), "VALARIS_API_KEY") {
		t.Errorf("missing should name the key: %v", got.Missing())
	}
}

func TestResolveCredentials_ReportsWhatIsMissing(t *testing.T) {
	home := isolateCredentialsHome(t)

	got := resolveCredentials(home, []string{filepath.Join(t.TempDir(), "absent.yaml")})

	missing := got.Missing()
	if !contains(missing, "VALARIS_API_KEY") || !contains(missing, "VALARIS_WORKSPACE") {
		t.Errorf("missing = %v, want both the key and the workspace", missing)
	}
	// The API URL has a shipped default, so it is never "missing".
	if contains(missing, "VALARIS_API_URL") {
		t.Errorf("api url has a default and must not be reported missing: %v", missing)
	}
	if got.APIURL != defaultAPIURL {
		t.Errorf("api url = %q, want the shipped default %q", got.APIURL, defaultAPIURL)
	}
}

func TestResolveCredentials_SkipsUnreadableCandidates(t *testing.T) {
	home := isolateCredentialsHome(t)

	dir := t.TempDir()
	broken := filepath.Join(dir, "broken.yaml")
	if err := os.WriteFile(broken, []byte("valaris: [not-a-mapping\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	good := filepath.Join(dir, "good.yaml")
	writeCredFile(t, good, "file-key", "", "file-workspace")

	got := resolveCredentials(home, []string{filepath.Join(dir, "absent.yaml"), broken, good})

	if got.APIKey != "file-key" {
		t.Errorf("a malformed candidate must not stop the search: %q", got.APIKey)
	}
	if got.ConfigPath != good {
		t.Errorf("ConfigPath = %q, want %q", got.ConfigPath, good)
	}
}

func TestValidateWorkDir_RejectsAGitWorktree(t *testing.T) {
	worktree := t.TempDir()
	if err := os.Mkdir(filepath.Join(worktree, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}

	if err := validateWorkDir(filepath.Join(worktree, "repos")); err == nil {
		t.Fatal("a work dir inside a git worktree must be rejected")
	}
	if err := validateWorkDir(t.TempDir()); err != nil {
		t.Fatalf("a dir outside any worktree must be accepted: %v", err)
	}
}

func TestAvailableProviders_OnlyReportsResolvableBinaries(t *testing.T) {
	lookPath := func(bin string) (string, error) {
		if bin == "codex" {
			return "/usr/local/bin/codex", nil
		}
		return "", errors.New("not found")
	}

	got := availableProviders(lookPath)

	if len(got) != 1 || got[0] != "codex" {
		t.Errorf("availableProviders = %v, want [codex]", got)
	}
}

func TestAvailableProviders_EmptyWhenNoAgentIsInstalled(t *testing.T) {
	none := func(string) (string, error) { return "", errors.New("not found") }
	if got := availableProviders(none); len(got) != 0 {
		t.Errorf("availableProviders = %v, want empty", got)
	}
}

// Order is the picker's preselection, so it must be deterministic rather than
// map-iteration order.
func TestAvailableProviders_IsDeterministicallyOrdered(t *testing.T) {
	all := func(string) (string, error) { return "/bin/x", nil }
	first := availableProviders(all)
	for i := 0; i < 20; i++ {
		if got := availableProviders(all); !equalStrings(got, first) {
			t.Fatalf("order drifted: %v then %v", first, got)
		}
	}
	if !contains(first, "claude") || !contains(first, "codex") {
		t.Errorf("want both providers, got %v", first)
	}
}

func TestConfigCandidatePaths_PrefersTheMostSpecific(t *testing.T) {
	paths := configCandidatePaths("/home/seba", "/work")
	if len(paths) == 0 {
		t.Fatal("no candidate paths")
	}
	if !strings.HasPrefix(paths[0], "/work") {
		t.Errorf("the working directory should be searched first, got %v", paths)
	}
	for _, p := range paths {
		if !filepath.IsAbs(p) {
			t.Errorf("candidate %q is not absolute", p)
		}
	}
}

// A real config beside the template must win, so an operator who did the copy
// is never diagnosed against the placeholder they left behind.
func TestDiscoverMCPConfig_PrefersARealConfigOverTheTemplate(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"mcp-config.json", mcpConfigTemplateFilename} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("{}"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	got := discoverMCPConfig([]string{filepath.Join(dir, "runner.yaml")})

	if filepath.Base(got) != "mcp-config.json" {
		t.Errorf("discovery picked %q over the real config", got)
	}
}

// The wizard must not launch a run against the shipped template: it names a
// command and a key nobody has, so the first MCP call fails after the operator
// was told the setup was good — and after the run started spending.
func TestInteractiveConfig_RefusesToLaunchOnTheTemplate(t *testing.T) {
	creds := Credentials{
		APIKey:        "vlr_key",
		APIURL:        "http://localhost:8000",
		Workspace:     "valaris",
		MCPConfigPath: filepath.Join(t.TempDir(), mcpConfigTemplateFilename),
	}

	_, err := interactiveConfig(tui.Result{}, creds)

	if err == nil {
		t.Fatal("the wizard accepted the example template as a working MCP config")
	}
	if !strings.Contains(err.Error(), mcpConfigFilenames[0]) {
		t.Errorf("the error must name the file to copy it to: %v", err)
	}
}

// validateLaunchResult is the review screen's pre-flight — it must reject the
// same states interactiveConfig refuses, while the operator can still fix them.
func TestValidateLaunchResult(t *testing.T) {
	realConfig := filepath.Join(t.TempDir(), "mcp-config.json")
	if err := os.WriteFile(realConfig, []byte(`{"mcpServers":{"valaris":{"command":"fixture-mcp"}}}`), 0600); err != nil {
		t.Fatal(err)
	}
	template := filepath.Join(t.TempDir(), mcpConfigTemplateFilename)

	tests := []struct {
		name    string
		result  tui.Result
		creds   Credentials
		wantErr string // "" means the launch may proceed
	}{
		{
			name:    "no MCP config anywhere blocks the launch",
			wantErr: "MCP",
		},
		{
			name:    "wizard-skipped MCP falls back to the discovered template and blocks",
			creds:   Credentials{MCPConfigPath: template},
			wantErr: "template",
		},
		{
			name:   "a discovered real config launches",
			creds:  Credentials{MCPConfigPath: realConfig},
			result: tui.Result{MCPConfigPath: realConfig},
		},
		{
			name:   "a pending wizard write launches before the file exists",
			result: tui.Result{MCPConfigPath: filepath.Join(t.TempDir(), "new-mcp.json"), MCPWrite: true},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := validateLaunchResult(tc.result, tc.creds)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("expected the launch to pass, got %v", err)
				}
				return
			}
			if err == nil {
				t.Fatal("expected the launch to be blocked")
			}
			if !strings.Contains(err.Error(), tc.wantErr) {
				t.Errorf("rejection should mention %q, got: %v", tc.wantErr, err)
			}
		})
	}
}

func writeCredFile(t *testing.T, path, key, url, workspace string) {
	t.Helper()
	var b strings.Builder
	b.WriteString("valaris:\n")
	if key != "" {
		b.WriteString("  api_key: \"" + key + "\"\n")
	}
	if url != "" {
		b.WriteString("  api_url: \"" + url + "\"\n")
	}
	if workspace != "" {
		b.WriteString("  workspace_slug: \"" + workspace + "\"\n")
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
