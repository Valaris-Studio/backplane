// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
)

// isolateCredentialsHome points the credentials file at a temp dir and clears
// every env override, so a test never reads — or writes — the developer's own.
func isolateCredentialsHome(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("VALARIS_API_KEY", "")
	t.Setenv("VALARIS_API_URL", "")
	t.Setenv("VALARIS_WORKSPACE", "")
	return dir
}

func TestSaveCredentialsFile_IsOwnerOnlyAndRoundTrips(t *testing.T) {
	dir := isolateCredentialsHome(t)
	path := credentialsFilePath("")

	if err := saveCredentialsFile(path, RememberedSession{APIKey: "vlr_written_key"}); err != nil {
		t.Fatalf("saveCredentialsFile: %v", err)
	}

	if !strings.HasPrefix(path, dir) {
		t.Fatalf("credentials path %q should live under XDG_CONFIG_HOME %q", path, dir)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("credentials file mode = %04o, want 0600 — a key must never be world-readable", perm)
	}

	got := resolveCredentials("", nil)
	if got.APIKey != "vlr_written_key" {
		t.Errorf("the saved key should resolve back, got %q", got.APIKey)
	}
	if got.APIKeySource != credSourceCredentialsFile {
		t.Errorf("the key's source should be the credentials file, got %v", got.APIKeySource)
	}
}

// The header is the file's own documentation — an operator who finds it must be
// able to tell what it is and what reads it, without the repo in front of them.
func TestSaveCredentialsFile_DocumentsItselfInAHeader(t *testing.T) {
	isolateCredentialsHome(t)
	path := credentialsFilePath("")

	if err := saveCredentialsFile(path, RememberedSession{APIKey: "vlr_written_key"}); err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	header := string(data)
	for _, want := range []string{"#", "backplane-runner", credentialsAPIKeyName} {
		if !strings.Contains(header, want) {
			t.Errorf("the credentials file should document itself (missing %q):\n%s", want, header)
		}
	}
}

func TestSaveCredentialsFile_OverwriteStaysOwnerOnly(t *testing.T) {
	isolateCredentialsHome(t)
	path := credentialsFilePath("")

	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("VALARIS_API_KEY=old\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := saveCredentialsFile(path, RememberedSession{APIKey: "vlr_new_key"}); err != nil {
		t.Fatal(err)
	}

	info, _ := os.Stat(path)
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Errorf("overwriting a world-readable credentials file must tighten it, got %04o", perm)
	}
	if got := resolveCredentials("", nil).APIKey; got != "vlr_new_key" {
		t.Errorf("overwrite should replace the key, got %q", got)
	}
}

// Precedence: env → credentials file → runner.yaml. Env winning is what every
// existing deployment relies on.
func TestResolveCredentials_EnvBeatsTheCredentialsFile(t *testing.T) {
	isolateCredentialsHome(t)
	if err := saveCredentialsFile(credentialsFilePath(""), RememberedSession{APIKey: "vlr_file_key"}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VALARIS_API_KEY", "vlr_env_key")

	got := resolveCredentials("", nil)

	if got.APIKey != "vlr_env_key" || got.APIKeySource != credSourceEnv {
		t.Errorf("env must win: %q from %v", got.APIKey, got.APIKeySource)
	}
}

func TestResolveCredentials_CredentialsFileBeatsRunnerYAML(t *testing.T) {
	isolateCredentialsHome(t)
	if err := saveCredentialsFile(credentialsFilePath(""), RememberedSession{APIKey: "vlr_creds_key"}); err != nil {
		t.Fatal(err)
	}
	yamlPath := filepath.Join(t.TempDir(), "runner.yaml")
	writeCredFile(t, yamlPath, "vlr_yaml_key", "http://yaml-url", "yaml-workspace")

	got := resolveCredentials("", []string{yamlPath})

	if got.APIKey != "vlr_creds_key" || got.APIKeySource != credSourceCredentialsFile {
		t.Errorf("the credentials file must outrank runner.yaml: %q from %v", got.APIKey, got.APIKeySource)
	}
	// Resolution is per-field: a credentials file that remembers only a key
	// must not mask the host and workspace a runner.yaml still supplies.
	if got.APIURL != "http://yaml-url" || got.Workspace != "yaml-workspace" {
		t.Errorf("runner.yaml must still supply the non-secrets: %+v", got)
	}
}

func TestResolveCredentials_MissingCredentialsFileIsNotAnError(t *testing.T) {
	isolateCredentialsHome(t)

	got := resolveCredentials("", nil)

	if got.APIKey != "" || got.APIKeySource != credSourceNone {
		t.Errorf("no credentials file means no key: %q from %v", got.APIKey, got.APIKeySource)
	}
}

func TestResolveCredentials_IgnoresAMalformedCredentialsFile(t *testing.T) {
	isolateCredentialsHome(t)
	path := credentialsFilePath("")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("this is not a key=value file\n\n=\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	got := resolveCredentials("", nil)

	if got.APIKey != "" {
		t.Errorf("garbage must not be mistaken for a key, got %q", got.APIKey)
	}
}

// The product decision: the saved runner.yaml keeps the env placeholder; the
// real key lives only in the 0600 credentials file.
func TestSavedConfigCarriesThePlaceholderNotTheKey(t *testing.T) {
	isolateCredentialsHome(t)

	cfg := config.Defaults()
	cfg.Valaris.APIKey = "vlr_supersecret123"
	cfg.Valaris.APIURL = "https://backplane.example.com"
	cfg.Valaris.WorkspaceSlug = "valaris"

	data, err := tui.MarshalConfigYAML(cfg)
	if err != nil {
		t.Fatal(err)
	}

	yaml := string(data)
	if strings.Contains(yaml, "vlr_supersecret123") {
		t.Fatalf("the raw key reached the saved config:\n%s", yaml)
	}
	if !strings.Contains(yaml, tui.APIKeyPlaceholder) {
		t.Errorf("the saved config should keep the env placeholder:\n%s", yaml)
	}
	// api_url and workspace_slug are not secrets and must be written normally.
	for _, want := range []string{"https://backplane.example.com", "valaris"} {
		if !strings.Contains(yaml, want) {
			t.Errorf("the saved config should carry %q:\n%s", want, yaml)
		}
	}
}

// Resolution must depend only on what the caller injects. Before homeDir was a
// parameter, resolveCredentials read the ambient $HOME: the developer's own
// remembered session leaked into every test that resolved anything, and no
// caller could point resolution anywhere else.
func TestResolveCredentials_ReadsOnlyTheInjectedHome(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("VALARIS_API_KEY", "")
	t.Setenv("VALARIS_API_URL", "")
	t.Setenv("VALARIS_WORKSPACE", "")

	occupied := t.TempDir()
	if err := saveCredentialsFile(credentialsFilePath(occupied), RememberedSession{
		APIKey:    "vlr_should_stay_put",
		APIURL:    "https://backplane.example.com",
		Workspace: "elsewhere",
	}); err != nil {
		t.Fatal(err)
	}

	got := resolveCredentials(t.TempDir(), nil)

	if got.APIKey != "" {
		t.Errorf("a credentials file under another home must not be read, got %q", got.APIKey)
	}
	if got.Workspace != "" {
		t.Errorf("workspace leaked across homes: %q", got.Workspace)
	}
	if got.APIURL != defaultAPIURL {
		t.Errorf("api url = %q, want the shipped default %q", got.APIURL, defaultAPIURL)
	}

	// The same file IS found when resolution is pointed at the home holding it —
	// otherwise this test would pass on a resolver that reads nothing at all.
	if reread := resolveCredentials(occupied, nil); reread.APIKey != "vlr_should_stay_put" {
		t.Errorf("the injected home should still be read, got %q", reread.APIKey)
	}
}

func TestCredentialsFilePath_FallsBackToHomeConfig(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", "")

	got := credentialsFilePath("/home/seba")

	want := filepath.Join("/home/seba", ".config", "backplane", credentialsFilename)
	if got != want {
		t.Errorf("credentialsFilePath = %q, want %q", got, want)
	}
}
