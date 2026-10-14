// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package mcpentry

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

const fixtureKey = "vlr_fixture_secret_key_do_not_leak_0001"

func writeFile(t *testing.T, path, content string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func ownedEntry(executable string) map[string]any {
	return map[string]any{"command": executable, "args": []any{"mcp"}}
}

func TestEditJSON_KeepsModeNumbersAndForeignMembers(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	big := "9007199254740993"
	writeFile(t, path, `{"numStartups":`+big+`,"projects":{"/a":{"x":1}}}`, 0o644)
	err := EditJSON(path, false, func(root map[string]any) (bool, error) {
		root["added"] = true
		return true, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	text := readFile(t, path)
	if !strings.Contains(text, big) || !strings.Contains(text, `"/a"`) || !strings.Contains(text, `"added": true`) {
		t.Fatalf("members or numbers lost: %s", text)
	}
	if info, _ := os.Stat(path); runtime.GOOS != "windows" && info.Mode().Perm() != 0o644 {
		t.Fatalf("mode changed to %v", info.Mode().Perm())
	}
}

func TestEditJSON_UnchangedEditWritesNothing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	original := `{"a":1}`
	writeFile(t, path, original, 0o600)
	if err := EditJSON(path, false, func(map[string]any) (bool, error) { return false, nil }); err != nil {
		t.Fatal(err)
	}
	if readFile(t, path) != original {
		t.Fatal("an unchanged edit rewrote the file")
	}
}

func TestEditJSON_CreatesMissingFileOnlyWhenAsked(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "new-parent")
	path := filepath.Join(dir, "config.json")
	edit := func(root map[string]any) (bool, error) { root["k"] = "v"; return true, nil }
	if err := EditJSON(path, false, edit); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a missing file was created without create")
	}
	if err := EditJSON(path, true, edit); err != nil {
		t.Fatal(err)
	}
	if info, err := os.Stat(dir); err != nil || runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
		t.Fatalf("parent not created 0700: %v %v", info, err)
	}
	if info, _ := os.Stat(path); runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("new file is %v, want 0600", info.Mode().Perm())
	}
}

func TestEditJSON_RefusesSymlink(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks need privileges on Windows")
	}
	dir := t.TempDir()
	target := filepath.Join(dir, "real.json")
	writeFile(t, target, `{}`, 0o600)
	link := filepath.Join(dir, "config.json")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	err := EditJSON(link, true, func(root map[string]any) (bool, error) { root["k"] = 1; return true, nil })
	if !errors.Is(err, agent.ErrConfigSymlink) {
		t.Fatalf("want agent_config_symlink, got %v", err)
	}
	if readFile(t, target) != `{}` {
		t.Fatal("the symlink target was written")
	}
}

func TestEditJSON_RetriesOnConcurrentRewrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	writeFile(t, path, `{"a":1}`, 0o600)
	concurrent := `{"a":2,"written_by":"agent"}`
	BeforeWrite = func(string) { os.WriteFile(path, []byte(concurrent), 0o600) }
	defer func() { BeforeWrite = nil }()
	err := EditJSON(path, false, func(root map[string]any) (bool, error) { root["ours"] = true; return true, nil })
	if !errors.Is(err, agent.ErrConfigChanged) {
		t.Fatalf("want agent_config_changed, got %v", err)
	}
	if readFile(t, path) != concurrent {
		t.Fatal("a version we did not read was replaced")
	}
}

func TestEditJSON_InvalidFileIsNotWritten(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	writeFile(t, path, `{"a":`, 0o600)
	err := EditJSON(path, true, func(root map[string]any) (bool, error) { root["k"] = 1; return true, nil })
	if !errors.Is(err, agent.ErrConfigInvalid) {
		t.Fatalf("want agent_config_invalid, got %v", err)
	}
	if readFile(t, path) != `{"a":` {
		t.Fatal("an invalid file was rewritten")
	}
}

func TestIsOwned_RecognisesCompanionLauncherOnly(t *testing.T) {
	cases := []struct {
		entry any
		owned bool
	}{
		{ownedEntry("/Applications/Backplane Companion.app/Contents/MacOS/backplane-companion"), true},
		{map[string]any{"command": `C:\Program Files\Backplane\backplane-companion.exe`, "args": []any{"mcp", "--mapping", "m1"}}, true},
		{map[string]any{"command": "/usr/bin/backplane-companion", "args": []any{"hook", "claude-code"}}, false},
		{map[string]any{"command": "uvx", "args": []any{"backplane-mcp"}}, false},
		{map[string]any{"command": "/opt/backplane-companion-evil/uvx", "args": []any{"mcp"}}, false},
		{map[string]any{"command": "/usr/bin/backplane-companion"}, false},
		{"not an object", false},
	}
	for _, c := range cases {
		if got := IsOwned(c.entry); got != c.owned {
			t.Errorf("IsOwned(%v) = %v, want %v", c.entry, got, c.owned)
		}
	}
}

func TestPut_WritesAndIsIdempotent(t *testing.T) {
	servers := map[string]any{"other": map[string]any{"command": "x"}}
	changed, err := Put(servers, ownedEntry("/bin/backplane-companion"))
	if err != nil || !changed {
		t.Fatalf("first put: %v %v", changed, err)
	}
	// A decoded entry (args as []any) equals the one we write.
	var decoded map[string]any
	raw, _ := json.Marshal(servers)
	json.Unmarshal(raw, &decoded)
	if changed, err := Put(decoded, ownedEntry("/bin/backplane-companion")); err != nil || changed {
		t.Fatalf("second put changed: %v %v", changed, err)
	}
	if _, kept := servers["other"]; !kept {
		t.Fatal("foreign entry dropped")
	}
}

func TestPut_ForeignNameIsTaken(t *testing.T) {
	foreign := map[string]any{"command": "uvx", "args": []any{"backplane-mcp"}}
	servers := map[string]any{Name: foreign}
	changed, err := Put(servers, ownedEntry("/bin/backplane-companion"))
	if !errors.Is(err, ErrNameTaken) || changed {
		t.Fatalf("want mcp_name_taken, got %v %v", changed, err)
	}
	if servers[Name].(map[string]any)["command"] != "uvx" {
		t.Fatal("the foreign entry was touched")
	}
}

func TestRemove_OnlyOwned(t *testing.T) {
	servers := map[string]any{Name: ownedEntry("/bin/backplane-companion"), "valaris": map[string]any{"command": "uvx"}}
	if !Remove(servers) {
		t.Fatal("owned entry not removed")
	}
	if _, ok := servers["valaris"]; !ok || len(servers) != 1 {
		t.Fatalf("remove touched others: %v", servers)
	}
	foreign := map[string]any{Name: map[string]any{"command": "uvx"}}
	if Remove(foreign) || foreign[Name] == nil {
		t.Fatal("a foreign backplane entry was removed")
	}
}

func TestRepoint_RewritesOnlyOwnedCommand(t *testing.T) {
	servers := map[string]any{Name: map[string]any{"command": "/old/backplane-companion", "args": []any{"mcp"}, "extra": "kept"}}
	if !Repoint(servers, "/new/backplane-companion") {
		t.Fatal("stale command not repointed")
	}
	entry := servers[Name].(map[string]any)
	if entry["command"] != "/new/backplane-companion" || entry["extra"] != "kept" {
		t.Fatalf("repoint result %v", entry)
	}
	if Repoint(servers, "/new/backplane-companion") {
		t.Fatal("repoint of a current entry reported a change")
	}
	foreign := map[string]any{Name: map[string]any{"command": "uvx", "args": []any{"mcp"}}}
	if Repoint(foreign, "/new/backplane-companion") {
		t.Fatal("a foreign entry was repointed")
	}
}

func TestScan_ReportsValarisEntryNamesNeverEnvValues(t *testing.T) {
	servers := map[string]any{
		"valaris":   map[string]any{"command": "uvx", "args": []any{"backplane-mcp"}, "env": map[string]any{"VALARIS_API_URL": "https://other.example", "VALARIS_API_KEY": fixtureKey}},
		"legacy":    map[string]any{"command": "python", "args": []any{"-m", "valaris_mcp"}},
		"envonly":   map[string]any{"command": "bash", "args": []any{"-c", "run"}, "env": map[string]any{"VALARIS_API_URL": "https://x.example"}},
		"github":    map[string]any{"command": "npx", "args": []any{"github-mcp"}, "env": map[string]any{"TOKEN": fixtureKey}},
		Name:        ownedEntry("/bin/backplane-companion"),
		"notatable": "string",
	}
	findings := Scan(servers, "https://backplane.example")
	encoded, _ := json.Marshal(findings)
	if strings.Contains(string(encoded), fixtureKey) || strings.Contains(string(encoded), "other.example") {
		t.Fatalf("scan leaked an env value: %s", encoded)
	}
	want := map[string]string{"valaris": ReasonOtherBackplane, "legacy": ReasonOtherBackplane, "envonly": ReasonOtherBackplane}
	if len(findings) != len(want) {
		t.Fatalf("findings %+v", findings)
	}
	for _, finding := range findings {
		if want[finding.EntryName] != finding.Reason {
			t.Errorf("finding %+v", finding)
		}
	}
}

func TestScan_SameEndpointDetected(t *testing.T) {
	servers := map[string]any{
		"valaris": map[string]any{"command": "uvx", "args": []any{"backplane-mcp"}, "env": map[string]any{"VALARIS_API_URL": "https://backplane.example/"}},
	}
	findings := Scan(servers, "https://backplane.example")
	if len(findings) != 1 || findings[0].Reason != ReasonSameEndpoint || findings[0].EntryName != "valaris" {
		t.Fatalf("findings %+v", findings)
	}
	if other := Scan(servers, "https://other-backplane.example"); len(other) != 1 || other[0].Reason != ReasonOtherBackplane {
		t.Fatalf("another endpoint must be other_backplane_entry: %+v", other)
	}
}

func TestScan_ForeignBackplaneNameIsTaken(t *testing.T) {
	servers := map[string]any{Name: map[string]any{"command": "uvx", "args": []any{"something"}}}
	findings := Scan(servers, "https://backplane.example")
	if len(findings) != 1 || findings[0].Reason != ReasonNameTaken || findings[0].EntryName != Name {
		t.Fatalf("findings %+v", findings)
	}
}
