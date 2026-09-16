// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package profile

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var testCreds = Credentials{
	APIKey:    "vlr_key_alpha",
	APIURL:    "https://intern.example.com",
	Workspace: "internal-projects",
}

// seedProfileDir writes a profile by hand in the documented on-disk format,
// so Load/List/Match tests pin the FORMAT itself rather than a Save/Load
// round-trip that could agree on the wrong bytes.
func seedProfileDir(t *testing.T, root, name string, c Credentials) string {
	t.Helper()
	dir := filepath.Join(root, "profiles", name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	var body strings.Builder
	body.WriteString("# test fixture credentials\n")
	for _, field := range []struct{ name, value string }{
		{"VALARIS_API_KEY", c.APIKey},
		{"VALARIS_API_URL", c.APIURL},
		{"VALARIS_WORKSPACE", c.Workspace},
	} {
		if field.value != "" {
			body.WriteString(field.name + "=" + field.value + "\n")
		}
	}
	for file, content := range map[string]string{
		"credentials":     body.String(),
		"runner.yaml":     "log_level: info\n",
		"mcp-config.json": "{}\n",
	} {
		if err := os.WriteFile(filepath.Join(dir, file), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestSaveCreatesProfileWithAllThreeFiles(t *testing.T) {
	root := t.TempDir()
	s := NewStore(root)

	runnerYAML := []byte("log_level: debug\n")
	mcpConfig := []byte(`{"mcpServers":{}}`)
	if err := s.Save("alpha", testCreds, runnerYAML, mcpConfig); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	dir := filepath.Join(root, "profiles", "alpha")
	gotYAML, err := os.ReadFile(filepath.Join(dir, "runner.yaml"))
	if err != nil {
		t.Fatalf("runner.yaml not written: %v", err)
	}
	if string(gotYAML) != string(runnerYAML) {
		t.Errorf("runner.yaml = %q, want %q", gotYAML, runnerYAML)
	}
	gotMCP, err := os.ReadFile(filepath.Join(dir, "mcp-config.json"))
	if err != nil {
		t.Fatalf("mcp-config.json not written: %v", err)
	}
	if string(gotMCP) != string(mcpConfig) {
		t.Errorf("mcp-config.json = %q, want %q", gotMCP, mcpConfig)
	}
	if _, err := os.Stat(filepath.Join(dir, "credentials")); err != nil {
		t.Fatalf("credentials not written: %v", err)
	}
}

func TestSaveCredentialsRoundTripThroughLoad(t *testing.T) {
	root := t.TempDir()
	s := NewStore(root)

	if err := s.Save("alpha", testCreds, []byte("log_level: info\n"), []byte("{}")); err != nil {
		t.Fatalf("Save() error = %v", err)
	}

	p, err := s.Load("alpha")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if p.Name != "alpha" {
		t.Errorf("Name = %q, want %q", p.Name, "alpha")
	}
	if want := filepath.Join(root, "profiles", "alpha"); p.Dir != want {
		t.Errorf("Dir = %q, want %q", p.Dir, want)
	}
	if p.Credentials != testCreds {
		t.Errorf("Credentials = %+v, want %+v", p.Credentials, testCreds)
	}
}

// The per-profile credentials file DOES store the real key — unlike
// runner.yaml's ${VALARIS_API_KEY} placeholder convention.
func TestSaveStoresRealKeyInCredentialsFile(t *testing.T) {
	root := t.TempDir()
	s := NewStore(root)

	if err := s.Save("alpha", testCreds, []byte("y\n"), []byte("{}")); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	data, err := os.ReadFile(filepath.Join(root, "profiles", "alpha", "credentials"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "VALARIS_API_KEY="+testCreds.APIKey) {
		t.Errorf("credentials file missing real key line; content:\n%s", data)
	}
}

func TestSaveSecretFilesAreOwnerOnly(t *testing.T) {
	root := t.TempDir()
	s := NewStore(root)

	if err := s.Save("alpha", testCreds, []byte("y\n"), []byte("{}")); err != nil {
		t.Fatalf("Save() error = %v", err)
	}
	for _, file := range []string{"credentials", "mcp-config.json"} {
		info, err := os.Stat(filepath.Join(root, "profiles", "alpha", file))
		if err != nil {
			t.Fatalf("stat %s: %v", file, err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Errorf("%s perm = %o, want 0600", file, perm)
		}
	}
}

func TestSaveExistingProfileReturnsErrProfileExists(t *testing.T) {
	root := t.TempDir()
	s := NewStore(root)
	seedProfileDir(t, root, "alpha", testCreds)

	err := s.Save("alpha", testCreds, []byte("y\n"), []byte("{}"))
	if !errors.Is(err, ErrProfileExists) {
		t.Fatalf("Save() error = %v, want ErrProfileExists", err)
	}
}

func TestSaveOverwriteReplacesFilesAndResecuresPerms(t *testing.T) {
	root := t.TempDir()
	s := NewStore(root)
	dir := seedProfileDir(t, root, "alpha", testCreds)

	// A prior credentials file with loose perms must come back 0600 — plain
	// WriteFile leaves an existing file's mode untouched.
	for _, file := range []string{"credentials", "mcp-config.json"} {
		if err := os.Chmod(filepath.Join(dir, file), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	newCreds := Credentials{APIKey: "vlr_key_rotated", APIURL: testCreds.APIURL, Workspace: testCreds.Workspace}
	if err := s.SaveOverwrite("alpha", newCreds, []byte("log_level: warn\n"), []byte(`{"v":2}`)); err != nil {
		t.Fatalf("SaveOverwrite() error = %v", err)
	}

	p, err := s.Load("alpha")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if p.Credentials != newCreds {
		t.Errorf("Credentials = %+v, want %+v", p.Credentials, newCreds)
	}
	gotYAML, err := os.ReadFile(filepath.Join(dir, "runner.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if string(gotYAML) != "log_level: warn\n" {
		t.Errorf("runner.yaml = %q, want replaced content", gotYAML)
	}
	for _, file := range []string{"credentials", "mcp-config.json"} {
		info, err := os.Stat(filepath.Join(dir, file))
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Errorf("%s perm after overwrite = %o, want 0600", file, perm)
		}
	}
}

func TestLoadParsesHandWrittenCredentialsFormat(t *testing.T) {
	root := t.TempDir()
	seedProfileDir(t, root, "alpha", testCreds)

	p, err := NewStore(root).Load("alpha")
	if err != nil {
		t.Fatalf("Load() error = %v", err)
	}
	if p.Credentials != testCreds {
		t.Errorf("Credentials = %+v, want %+v", p.Credentials, testCreds)
	}
}

func TestLoadMissingProfileReturnsErrProfileNotFound(t *testing.T) {
	s := NewStore(t.TempDir())
	_, err := s.Load("ghost")
	if !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("Load() error = %v, want ErrProfileNotFound", err)
	}
}

func TestListReturnsProfilesSortedByName(t *testing.T) {
	root := t.TempDir()
	credsB := Credentials{APIKey: "vlr_key_beta", APIURL: "https://other.example.com", Workspace: "beta-ws"}
	seedProfileDir(t, root, "zeta", credsB)
	seedProfileDir(t, root, "alpha", testCreds)

	profiles, err := NewStore(root).List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(profiles) != 2 {
		t.Fatalf("List() len = %d, want 2", len(profiles))
	}
	if profiles[0].Name != "alpha" || profiles[1].Name != "zeta" {
		t.Errorf("List() order = [%s, %s], want [alpha, zeta]", profiles[0].Name, profiles[1].Name)
	}
	if profiles[0].Credentials != testCreds {
		t.Errorf("alpha Credentials = %+v, want %+v", profiles[0].Credentials, testCreds)
	}
	if profiles[1].Credentials != credsB {
		t.Errorf("zeta Credentials = %+v, want %+v", profiles[1].Credentials, credsB)
	}
}

func TestListEmptyRootReturnsNoProfiles(t *testing.T) {
	profiles, err := NewStore(t.TempDir()).List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(profiles) != 0 {
		t.Errorf("List() len = %d, want 0", len(profiles))
	}
}

func TestDeleteRemovesProfileDirIncludingKey(t *testing.T) {
	root := t.TempDir()
	s := NewStore(root)
	dir := seedProfileDir(t, root, "alpha", testCreds)

	if err := s.Delete("alpha"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("profile dir still present after Delete: stat err = %v", err)
	}
	if _, err := s.Load("alpha"); !errors.Is(err, ErrProfileNotFound) {
		t.Errorf("Load() after Delete error = %v, want ErrProfileNotFound", err)
	}
}

func TestDeleteMissingProfileIsIdempotent(t *testing.T) {
	if err := NewStore(t.TempDir()).Delete("ghost"); err != nil {
		t.Fatalf("Delete() of missing profile error = %v, want nil", err)
	}
}

func TestMatchRequiresAllThreeFieldsEqual(t *testing.T) {
	root := t.TempDir()
	seedProfileDir(t, root, "alpha", testCreds)
	s := NewStore(root)

	tests := []struct {
		name  string
		creds Credentials
		found bool
	}{
		{"exact triple matches", testCreds, true},
		{"different key does not match", Credentials{APIKey: "vlr_key_new", APIURL: testCreds.APIURL, Workspace: testCreds.Workspace}, false},
		{"different url does not match", Credentials{APIKey: testCreds.APIKey, APIURL: "https://other.example.com", Workspace: testCreds.Workspace}, false},
		{"different workspace does not match", Credentials{APIKey: testCreds.APIKey, APIURL: testCreds.APIURL, Workspace: "other-ws"}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p, found, err := s.Match(tt.creds)
			if err != nil {
				t.Fatalf("Match() error = %v", err)
			}
			if found != tt.found {
				t.Fatalf("Match() found = %v, want %v", found, tt.found)
			}
			if found && p.Name != "alpha" {
				t.Errorf("Match() profile = %q, want alpha", p.Name)
			}
		})
	}
}

func TestMatchEmptyStoreFindsNothing(t *testing.T) {
	_, found, err := NewStore(t.TempDir()).Match(testCreds)
	if err != nil {
		t.Fatalf("Match() error = %v", err)
	}
	if found {
		t.Error("Match() on empty store found a profile")
	}
}

func TestSuggestName(t *testing.T) {
	tests := []struct {
		name     string
		existing []string // profiles already in the store
		creds    Credentials
		want     string
	}{
		{
			name:  "workspace at first host label",
			creds: Credentials{Workspace: "internal-projects", APIURL: "https://intern.example.com"},
			want:  "internal-projects@intern",
		},
		{
			name:  "port is not part of the host label",
			creds: Credentials{Workspace: "dev", APIURL: "http://localhost:8000"},
			want:  "dev@localhost",
		},
		{
			name:  "unparseable url falls back to workspace",
			creds: Credentials{Workspace: "internal-projects", APIURL: "://missing-scheme"},
			want:  "internal-projects",
		},
		{
			name:  "empty url falls back to workspace",
			creds: Credentials{Workspace: "internal-projects", APIURL: ""},
			want:  "internal-projects",
		},
		{
			name:     "taken name gets -2",
			existing: []string{"internal-projects@intern"},
			creds:    Credentials{Workspace: "internal-projects", APIURL: "https://intern.example.com"},
			want:     "internal-projects@intern-2",
		},
		{
			name:     "suffix keeps counting past -2",
			existing: []string{"internal-projects@intern", "internal-projects@intern-2"},
			creds:    Credentials{Workspace: "internal-projects", APIURL: "https://intern.example.com"},
			want:     "internal-projects@intern-3",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			root := t.TempDir()
			for _, name := range tt.existing {
				seedProfileDir(t, root, name, testCreds)
			}
			if got := NewStore(root).SuggestName(tt.creds); got != tt.want {
				t.Errorf("SuggestName() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestNameValidationRejectsUnsafeDirectoryNames(t *testing.T) {
	badNames := []struct {
		label string
		name  string
	}{
		{"empty", ""},
		{"path separator", "a/b"},
		{"parent traversal", ".."},
		{"nested traversal", "../escape"},
		{"leading dot", ".hidden"},
	}
	for _, bad := range badNames {
		t.Run(bad.label, func(t *testing.T) {
			s := NewStore(t.TempDir())
			if err := s.Save(bad.name, testCreds, []byte("y\n"), []byte("{}")); !errors.Is(err, ErrInvalidName) {
				t.Errorf("Save(%q) error = %v, want ErrInvalidName", bad.name, err)
			}
			if err := s.SaveOverwrite(bad.name, testCreds, []byte("y\n"), []byte("{}")); !errors.Is(err, ErrInvalidName) {
				t.Errorf("SaveOverwrite(%q) error = %v, want ErrInvalidName", bad.name, err)
			}
			if _, err := s.Load(bad.name); !errors.Is(err, ErrInvalidName) {
				t.Errorf("Load(%q) error = %v, want ErrInvalidName", bad.name, err)
			}
			if err := s.Delete(bad.name); !errors.Is(err, ErrInvalidName) {
				t.Errorf("Delete(%q) error = %v, want ErrInvalidName", bad.name, err)
			}
		})
	}
}

func TestPathAccessorsArePureJoins(t *testing.T) {
	root := t.TempDir()
	s := NewStore(root)
	// No profile exists — accessors are string joins, not lookups.
	dir := filepath.Join(root, "profiles", "alpha")
	if got, want := s.ConfigPath("alpha"), filepath.Join(dir, "runner.yaml"); got != want {
		t.Errorf("ConfigPath() = %q, want %q", got, want)
	}
	if got, want := s.CredentialsPath("alpha"), filepath.Join(dir, "credentials"); got != want {
		t.Errorf("CredentialsPath() = %q, want %q", got, want)
	}
	if got, want := s.MCPConfigPath("alpha"), filepath.Join(dir, "mcp-config.json"); got != want {
		t.Errorf("MCPConfigPath() = %q, want %q", got, want)
	}
}

func TestDefaultRootPrefersXDGConfigHome(t *testing.T) {
	xdg := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", xdg)
	if got, want := DefaultRoot(), filepath.Join(xdg, "backplane"); got != want {
		t.Errorf("DefaultRoot() = %q, want %q", got, want)
	}
}

func TestDefaultRootFallsBackToHomeConfig(t *testing.T) {
	home := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", "")
	t.Setenv("HOME", home)
	if got, want := DefaultRoot(), filepath.Join(home, ".config", "backplane"); got != want {
		t.Errorf("DefaultRoot() = %q, want %q", got, want)
	}
}
