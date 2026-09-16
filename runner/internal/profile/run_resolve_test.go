// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package profile

import (
	"errors"
	"path/filepath"
	"strings"
	"testing"
)

func TestResolveProfileConfigPathReturnsProfileRunnerYAML(t *testing.T) {
	root := t.TempDir()
	seedProfileDir(t, root, "alpha", testCreds)

	got, err := ResolveProfileConfigPath(root, "alpha")
	if err != nil {
		t.Fatalf("ResolveProfileConfigPath() error = %v", err)
	}
	if want := filepath.Join(root, "profiles", "alpha", "runner.yaml"); got != want {
		t.Errorf("ResolveProfileConfigPath() = %q, want %q", got, want)
	}
}

func TestResolveProfileConfigPathMissingProfile(t *testing.T) {
	_, err := ResolveProfileConfigPath(t.TempDir(), "ghost")
	if !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("ResolveProfileConfigPath() error = %v, want ErrProfileNotFound", err)
	}
}

func TestResolveRunConfigPath(t *testing.T) {
	root := t.TempDir()
	seedProfileDir(t, root, "alpha", testCreds)
	profileYAML := filepath.Join(root, "profiles", "alpha", "runner.yaml")

	tests := []struct {
		name        string
		configFlag  string
		profileFlag string
		want        string
		wantErr     error
	}{
		{"profile flag resolves through the store", "", "alpha", profileYAML, nil},
		{"config flag passes through verbatim", "/etc/bp/runner.yaml", "", "/etc/bp/runner.yaml", nil},
		{"neither flag yields empty for discovery fallback", "", "", "", nil},
		{"both flags conflict", "/etc/bp/runner.yaml", "alpha", "", ErrConflictingFlags},
		{"unknown profile", "", "ghost", "", ErrProfileNotFound},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ResolveRunConfigPath(root, tt.configFlag, tt.profileFlag)
			if tt.wantErr != nil {
				if !errors.Is(err, tt.wantErr) {
					t.Fatalf("error = %v, want %v", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("error = %v", err)
			}
			if got != tt.want {
				t.Errorf("path = %q, want %q", got, tt.want)
			}
		})
	}
}

// clearValarisEnv pins every VALARIS_* credential var to a known state so
// LoadForRun tests are isolated from the ambient environment.
func clearValarisEnv(t *testing.T) {
	t.Helper()
	t.Setenv("VALARIS_API_KEY", "")
	t.Setenv("VALARIS_API_URL", "")
	t.Setenv("VALARIS_WORKSPACE", "")
}

func TestLoadForRunProfileBeatsConflictingEnvWithWarnings(t *testing.T) {
	root := t.TempDir()
	seedProfileDir(t, root, "alpha", testCreds)
	clearValarisEnv(t)
	t.Setenv("VALARIS_API_KEY", "vlr_key_from_env")
	t.Setenv("VALARIS_WORKSPACE", "env-ws")

	p, warnings, err := LoadForRun(root, "alpha")
	if err != nil {
		t.Fatalf("LoadForRun() error = %v", err)
	}
	if p.Credentials != testCreds {
		t.Errorf("Credentials = %+v, want the PROFILE's values %+v", p.Credentials, testCreds)
	}
	if len(warnings) != 2 {
		t.Fatalf("warnings = %v, want exactly 2 (one per conflicting env var)", warnings)
	}
	joined := strings.Join(warnings, "\n")
	for _, envVar := range []string{"VALARIS_API_KEY", "VALARIS_WORKSPACE"} {
		if !strings.Contains(joined, envVar) {
			t.Errorf("warnings %v missing the overridden env var name %s", warnings, envVar)
		}
	}
	// VALARIS_API_URL was not set — warning about it would be noise.
	if strings.Contains(joined, "VALARIS_API_URL") {
		t.Errorf("warnings %v name VALARIS_API_URL, which was never set", warnings)
	}
}

func TestLoadForRunNoWarningsWhenEnvUnset(t *testing.T) {
	root := t.TempDir()
	seedProfileDir(t, root, "alpha", testCreds)
	clearValarisEnv(t)

	p, warnings, err := LoadForRun(root, "alpha")
	if err != nil {
		t.Fatalf("LoadForRun() error = %v", err)
	}
	if p.Credentials != testCreds {
		t.Errorf("Credentials = %+v, want %+v", p.Credentials, testCreds)
	}
	if len(warnings) != 0 {
		t.Errorf("warnings = %v, want none", warnings)
	}
}

func TestLoadForRunNoWarningsWhenEnvAgreesWithProfile(t *testing.T) {
	root := t.TempDir()
	seedProfileDir(t, root, "alpha", testCreds)
	clearValarisEnv(t)
	t.Setenv("VALARIS_API_KEY", testCreds.APIKey)
	t.Setenv("VALARIS_API_URL", testCreds.APIURL)
	t.Setenv("VALARIS_WORKSPACE", testCreds.Workspace)

	_, warnings, err := LoadForRun(root, "alpha")
	if err != nil {
		t.Fatalf("LoadForRun() error = %v", err)
	}
	if len(warnings) != 0 {
		t.Errorf("warnings = %v, want none when env matches the profile", warnings)
	}
}

func TestLoadForRunMissingProfile(t *testing.T) {
	clearValarisEnv(t)
	_, _, err := LoadForRun(t.TempDir(), "ghost")
	if !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("LoadForRun() error = %v, want ErrProfileNotFound", err)
	}
}
