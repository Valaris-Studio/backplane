// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"os"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/tui"
)

// The wizard's whole promise is "type this once". Every mode must honor it —
// doctor and discovery never reach the review screen, so a save gated on
// SaveConfig meant those operators retyped their key on every launch.
func TestRememberCredentials_PersistsForEveryMode(t *testing.T) {
	modes := []tui.Mode{tui.ModeDoctor, tui.ModeDiscovery, tui.ModeLoop, tui.ModePipeline}
	for _, mode := range modes {
		t.Run(string(mode), func(t *testing.T) {
			isolateCredentialsHome(t)
			creds := Credentials{
				APIKey:    "vlr_typed_by_hand",
				APIURL:    "https://backplane.example.com",
				Workspace: "valaris",
			}

			path, err := rememberCredentials("", creds)
			if err != nil {
				t.Fatalf("rememberCredentials: %v", err)
			}
			if path == "" {
				t.Fatal("rememberCredentials reported no path")
			}

			info, err := os.Stat(path)
			if err != nil {
				t.Fatalf("stat %s: %v", path, err)
			}
			if perm := info.Mode().Perm(); perm != 0o600 {
				t.Errorf("remembered credentials mode = %04o, want 0600", perm)
			}

			got := resolveCredentials("", nil)
			if got.APIKey != creds.APIKey {
				t.Errorf("key did not survive %s: %q", mode, got.APIKey)
			}
			if got.APIURL != creds.APIURL {
				t.Errorf("host did not survive %s: %q", mode, got.APIURL)
			}
			if got.Workspace != creds.Workspace {
				t.Errorf("workspace did not survive %s: %q", mode, got.Workspace)
			}
		})
	}
}

// SaveConfig governs the heavier runner.yaml artifact only. The credentials the
// operator just authenticated with are cheap to store and expensive to retype.
func TestRememberCredentials_IgnoresTheSaveConfigToggle(t *testing.T) {
	isolateCredentialsHome(t)
	creds := Credentials{APIKey: "vlr_key", APIURL: "http://localhost:8000", Workspace: "ws"}

	if _, err := rememberCredentials("", creds); err != nil {
		t.Fatal(err)
	}

	// tui.Result{SaveConfig:false} is the default a doctor/discovery run carries.
	if got := resolveCredentials("", nil); got.APIKey != "vlr_key" {
		t.Errorf("persistence must not depend on SaveConfig, got %q", got.APIKey)
	}
}

// A run that never got a key has nothing worth remembering — writing a file
// with an empty key would shadow nothing and confuse the next launch.
func TestRememberCredentials_SkipsWhenThereIsNoKey(t *testing.T) {
	isolateCredentialsHome(t)

	path, err := rememberCredentials("", Credentials{APIURL: "http://localhost:8000", Workspace: "ws"})
	if err != nil {
		t.Fatalf("a keyless run must not be an error: %v", err)
	}
	if path != "" {
		t.Errorf("nothing should have been written, got %q", path)
	}
}

// The next launch must prefill everything, so the operator continues with one
// keypress rather than retyping a host and a key.
func TestRememberedSession_PrefillsTheNextLaunch(t *testing.T) {
	isolateCredentialsHome(t)
	if _, err := rememberCredentials("", Credentials{
		APIKey:    "vlr_remembered",
		APIURL:    "https://backplane.example.com",
		Workspace: "valaris",
	}); err != nil {
		t.Fatal(err)
	}

	seed := credentialSeed(resolveCredentials("", nil))

	if seed.APIKey != "vlr_remembered" || seed.Host != "https://backplane.example.com" || seed.Workspace != "valaris" {
		t.Fatalf("the wizard would not prefill a remembered session: %+v", seed)
	}
	for _, source := range []string{seed.APIKeySource, seed.HostSource, seed.WorkspaceSource} {
		if source != credSourceCredentialsFile.String() {
			t.Errorf("each prefilled field should be attributed to the credentials file, got %q", source)
		}
	}
}

// Precedence is unchanged for the non-secrets too: an exported env var is how
// an operator overrides a remembered session for one run.
func TestResolveCredentials_EnvBeatsRememberedHostAndWorkspace(t *testing.T) {
	isolateCredentialsHome(t)
	if _, err := rememberCredentials("", Credentials{
		APIKey:    "vlr_file",
		APIURL:    "http://file-host",
		Workspace: "file-workspace",
	}); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VALARIS_API_URL", "http://env-host")
	t.Setenv("VALARIS_WORKSPACE", "env-workspace")

	got := resolveCredentials("", nil)

	if got.APIURL != "http://env-host" || got.APIURLSource != credSourceEnv {
		t.Errorf("env must win for the host: %q from %v", got.APIURL, got.APIURLSource)
	}
	if got.Workspace != "env-workspace" || got.WorkspaceSource != credSourceEnv {
		t.Errorf("env must win for the workspace: %q from %v", got.Workspace, got.WorkspaceSource)
	}
}

// The remembered session outranks a stale runner.yaml the same way the key
// already did — it is the more recently confirmed truth.
func TestResolveCredentials_RememberedHostBeatsRunnerYAML(t *testing.T) {
	isolateCredentialsHome(t)
	if _, err := rememberCredentials("", Credentials{
		APIKey:    "vlr_file",
		APIURL:    "http://remembered-host",
		Workspace: "remembered-workspace",
	}); err != nil {
		t.Fatal(err)
	}
	yamlPath := t.TempDir() + "/runner.yaml"
	writeCredFile(t, yamlPath, "vlr_yaml", "http://yaml-host", "yaml-workspace")

	got := resolveCredentials("", []string{yamlPath})

	if got.APIURL != "http://remembered-host" || got.APIURLSource != credSourceCredentialsFile {
		t.Errorf("host = %q from %v, want the remembered one", got.APIURL, got.APIURLSource)
	}
	if got.Workspace != "remembered-workspace" || got.WorkspaceSource != credSourceCredentialsFile {
		t.Errorf("workspace = %q from %v, want the remembered one", got.Workspace, got.WorkspaceSource)
	}
}

// The key must never reach runner.yaml, whatever else the file now carries.
func TestRememberCredentials_KeepsTheKeyOutOfTheYAML(t *testing.T) {
	isolateCredentialsHome(t)
	if _, err := rememberCredentials("", Credentials{
		APIKey:    "vlr_supersecret123",
		APIURL:    "https://backplane.example.com",
		Workspace: "valaris",
	}); err != nil {
		t.Fatal(err)
	}

	cfg, err := interactiveConfig(tui.Result{}, resolveCredentials("", nil))
	if err == nil {
		data, marshalErr := tui.MarshalConfigYAML(cfg)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		if strings.Contains(string(data), "vlr_supersecret123") {
			t.Fatalf("the remembered key reached the saved config:\n%s", data)
		}
	}
}

// The file documents itself for the operator who finds it months later.
func TestRememberedSession_DocumentsEveryFieldItCarries(t *testing.T) {
	isolateCredentialsHome(t)
	path, err := rememberCredentials("", Credentials{APIKey: "k", APIURL: "u", Workspace: "w"})
	if err != nil {
		t.Fatal(err)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	body := string(data)
	for _, want := range []string{credentialsAPIKeyName, credentialsAPIURLName, credentialsWorkspaceName} {
		if !strings.Contains(body, want) {
			t.Errorf("the credentials file should carry %q:\n%s", want, body)
		}
	}
	// The header must mention the non-secrets it now stores, or the file reads
	// as key-only to anyone who opens it.
	header := body[:strings.Index(body, credentialsAPIKeyName+"=")]
	for _, want := range []string{"host", "workspace"} {
		if !strings.Contains(strings.ToLower(header), want) {
			t.Errorf("the header should document %q:\n%s", want, header)
		}
	}
}
