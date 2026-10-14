// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package agentaccess

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

func TestFile_SavesPrivatelyAndRoundTrips(t *testing.T) {
	layout := store.Layout{Root: t.TempDir()}
	file := File{
		Endpoint: "https://backplane.example",
		Mappings: map[string]MappingAccess{"m1": {Enabled: true, Root: "/src/app", WorkspaceSlug: "acme", WorkspaceName: "Acme", BoardID: "b1", BoardName: "App"}},
		Written:  Written{ClaudeCode: []string{"/src/app"}, CodexCLI: true},
	}
	if err := Save(layout, file); err != nil {
		t.Fatal(err)
	}
	if info, _ := os.Stat(Path(layout)); runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("agent_access.json is %v", info.Mode().Perm())
	}
	if filepath.Base(Path(layout)) != "agent_access.json" {
		t.Fatalf("path %s", Path(layout))
	}
	loaded, err := Load(layout)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Version != 1 || loaded.Mappings["m1"].BoardName != "App" || !loaded.Written.CodexCLI || loaded.Written.ClaudeCode[0] != "/src/app" {
		t.Fatalf("round trip %+v", loaded)
	}
	raw, _ := os.ReadFile(Path(layout))
	for _, member := range []string{`"version":1`, `"endpoint"`, `"workspace_slug"`, `"written"`, `"claude_code"`, `"codex_cli"`, `"pi_cli"`} {
		if !strings.Contains(string(raw), member) {
			t.Errorf("file lacks %s: %s", member, raw)
		}
	}
}

func TestFile_MissingIsEmptyNotAnError(t *testing.T) {
	loaded, err := Load(store.Layout{Root: t.TempDir()})
	if err != nil || len(loaded.Mappings) != 0 || loaded.Written.ClaudeCode == nil {
		t.Fatalf("missing file: %+v %v", loaded, err)
	}
}

func TestFile_ReadableByOthersIsRefused(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX modes")
	}
	layout := store.Layout{Root: t.TempDir()}
	os.WriteFile(Path(layout), []byte(`{"version":1}`), 0o644)
	if _, err := Load(layout); !errors.Is(err, store.ErrUnsafePath) {
		t.Fatalf("a world-readable file was trusted: %v", err)
	}
}

func TestFile_LaunchMappingsCarryBoardContext(t *testing.T) {
	file := File{Mappings: map[string]MappingAccess{"m1": {Enabled: true, Root: "/src/app", WorkspaceSlug: "acme", BoardID: "b1", BoardName: "App"}}}
	mappings := file.LaunchMappings()
	if len(mappings) != 1 || mappings[0].ID != "m1" || mappings[0].BoardID != "b1" || !mappings[0].Enabled || mappings[0].Root != "/src/app" {
		t.Fatalf("launch mappings %+v", mappings)
	}
}

func TestFile_LaunchMappingsCoverEveryRoot(t *testing.T) {
	file := File{Mappings: map[string]MappingAccess{"m1": {Enabled: true, Root: "/src/app", Roots: []string{"/src/app", "/src/app-copy"}, BoardID: "b1"}}}
	mappings := file.LaunchMappings()
	if len(mappings) != 2 || mappings[0].ID != "m1" || mappings[1].ID != "m1" || mappings[0].Root != "/src/app" || mappings[1].Root != "/src/app-copy" {
		t.Fatalf("launch mappings %+v", mappings)
	}
}
