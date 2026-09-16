// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package profile

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// Legacy layout: the three fixed-path files directly under the config root,
// as written by the wizard/doctor before profiles existed. The legacy MCP
// config sits beside runner.yaml (mcpFixTargetPath resolves it beside the
// discovered runner config), so at the root it is root/mcp-config.json.
const (
	legacyCredentialsBody = "# legacy credentials\n" +
		"VALARIS_API_KEY=vlr_key_legacy\n" +
		"VALARIS_API_URL=https://legacy.example.com\n" +
		"VALARIS_WORKSPACE=legacy-ws\n"
	legacyRunnerYAML = "log_level: debug\n"
	legacyMCPConfig  = `{"mcpServers":{"valaris":{}}}`
)

var legacyCreds = Credentials{
	APIKey:    "vlr_key_legacy",
	APIURL:    "https://legacy.example.com",
	Workspace: "legacy-ws",
}

func writeLegacyFiles(t *testing.T, root string, files map[string]string) {
	t.Helper()
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func allLegacyFiles() map[string]string {
	return map[string]string{
		"credentials":     legacyCredentialsBody,
		"runner.yaml":     legacyRunnerYAML,
		"mcp-config.json": legacyMCPConfig,
	}
}

func TestListMigratesLegacyFilesIntoDefaultProfile(t *testing.T) {
	root := t.TempDir()
	writeLegacyFiles(t, root, allLegacyFiles())

	profiles, err := NewStore(root).List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(profiles) != 1 {
		t.Fatalf("List() len = %d, want 1 migrated default profile", len(profiles))
	}
	if profiles[0].Name != "default" {
		t.Errorf("migrated profile name = %q, want %q", profiles[0].Name, "default")
	}
	if profiles[0].Credentials != legacyCreds {
		t.Errorf("migrated Credentials = %+v, want %+v", profiles[0].Credentials, legacyCreds)
	}

	defaultDir := filepath.Join(root, "profiles", "default")
	for name, want := range map[string]string{
		"runner.yaml":     legacyRunnerYAML,
		"mcp-config.json": legacyMCPConfig,
	} {
		got, err := os.ReadFile(filepath.Join(defaultDir, name))
		if err != nil {
			t.Fatalf("migrated %s not present: %v", name, err)
		}
		if string(got) != want {
			t.Errorf("migrated %s = %q, want copy of legacy content %q", name, got, want)
		}
	}
}

func TestMigrationLeavesLegacyFilesInPlaceUntouched(t *testing.T) {
	root := t.TempDir()
	writeLegacyFiles(t, root, allLegacyFiles())

	if _, err := NewStore(root).List(); err != nil {
		t.Fatalf("List() error = %v", err)
	}

	for name, want := range allLegacyFiles() {
		got, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			t.Fatalf("legacy %s missing after migration: %v", name, err)
		}
		if string(got) != want {
			t.Errorf("legacy %s changed by migration:\ngot  %q\nwant %q", name, got, want)
		}
	}
}

func TestSecondListDoesNotDuplicateMigration(t *testing.T) {
	root := t.TempDir()
	writeLegacyFiles(t, root, allLegacyFiles())
	s := NewStore(root)

	if _, err := s.List(); err != nil {
		t.Fatalf("first List() error = %v", err)
	}
	profiles, err := s.List()
	if err != nil {
		t.Fatalf("second List() error = %v", err)
	}
	if len(profiles) != 1 {
		t.Fatalf("second List() len = %d, want still exactly 1", len(profiles))
	}
	if profiles[0].Name != "default" {
		t.Errorf("second List() profile = %q, want default", profiles[0].Name)
	}
}

func TestLoadTriggersLegacyMigrationToo(t *testing.T) {
	root := t.TempDir()
	writeLegacyFiles(t, root, allLegacyFiles())

	p, err := NewStore(root).Load("default")
	if err != nil {
		t.Fatalf("Load(default) on legacy root error = %v", err)
	}
	if p.Credentials != legacyCreds {
		t.Errorf("Load(default) Credentials = %+v, want %+v", p.Credentials, legacyCreds)
	}
}

func TestMigrationIsNoOpWhenAnyProfileExists(t *testing.T) {
	root := t.TempDir()
	writeLegacyFiles(t, root, allLegacyFiles())
	seedProfileDir(t, root, "existing", testCreds)

	profiles, err := NewStore(root).List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(profiles) != 1 || profiles[0].Name != "existing" {
		names := make([]string, len(profiles))
		for i, p := range profiles {
			names[i] = p.Name
		}
		t.Fatalf("List() = %v, want only [existing] — legacy files must not migrate over a populated store", names)
	}
	if _, err := os.Stat(filepath.Join(root, "profiles", "default")); !os.IsNotExist(err) {
		t.Errorf("profiles/default created despite existing profile: stat err = %v", err)
	}
}

func TestMigrationCopiesOnlyTheLegacyFilesPresent(t *testing.T) {
	root := t.TempDir()
	// Doctor/wizard runs can leave partial legacy state: credentials without
	// an mcp-config, for example.
	writeLegacyFiles(t, root, map[string]string{
		"credentials": legacyCredentialsBody,
		"runner.yaml": legacyRunnerYAML,
	})

	profiles, err := NewStore(root).List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(profiles) != 1 || profiles[0].Name != "default" {
		t.Fatalf("List() = %d profiles, want 1 default", len(profiles))
	}

	defaultDir := filepath.Join(root, "profiles", "default")
	if _, err := os.Stat(filepath.Join(defaultDir, "runner.yaml")); err != nil {
		t.Errorf("migrated runner.yaml missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(defaultDir, "mcp-config.json")); !os.IsNotExist(err) {
		t.Errorf("mcp-config.json invented by migration: stat err = %v", err)
	}
}

func TestNoMigrationWhenNoLegacyFilesExist(t *testing.T) {
	root := t.TempDir()

	profiles, err := NewStore(root).List()
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(profiles) != 0 {
		t.Fatalf("List() len = %d, want 0", len(profiles))
	}
	if _, err := NewStore(root).Load("default"); !errors.Is(err, ErrProfileNotFound) {
		t.Errorf("Load(default) on empty root error = %v, want ErrProfileNotFound", err)
	}
}
