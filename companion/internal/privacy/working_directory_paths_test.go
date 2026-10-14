// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package privacy

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestWorkingDirectoryPlacementAbsolutePathsWithSpaces(t *testing.T) {
	cases := []struct {
		name, root, directory, want string
	}{
		{"posix inside", "/srv/My Projects/app", "/srv/My Projects/app/packages/api worker", "packages/api worker"},
		{"posix root", "/srv/My Projects/app", "/srv/My Projects/app", "."},
		{"posix outside", "/srv/My Projects/app", "/opt/Other Projects/api worker", "api worker"},
		{"posix sibling prefix", "/srv/My Projects/app", "/srv/My Projects/application/api worker", "api worker"},
		{"posix doubled separators", "/srv/My Projects/app", "/srv//My Projects/app//api worker", "api worker"},
		{"windows inside", `C:\My Projects\app`, `C:\My Projects\app\packages\api worker`, `packages\api worker`},
		{"windows root", `C:\My Projects\app`, `C:\My Projects\app`, "."},
		{"windows outside", `C:\My Projects\app`, `D:\Other Projects\api worker`, "api worker"},
		{"windows rooted outside", `C:\My Projects\app`, `\Other Projects\api worker`, "api worker"},
		{"windows rooted not unc", `\\server\team share\app`, `\server\team share\app\packages\api worker`, "api worker"},
		{"windows case insensitive", `C:\My Projects\app`, `c:\my projects\APP\api worker`, "api worker"},
		{"windows doubled separators", `C:\My Projects\app`, `C:\\My Projects\\app\\api worker`, "api worker"},
		{"unc inside", `\\server\team share\app`, `\\server\team share\app\api worker`, "api worker"},
		{"unc outside", `\\server\team share\app`, `\\other\private share\api worker`, "api worker"},
		{"verbatim drive inside", `C:\My Projects\app`, `\\?\C:\My Projects\app\api worker`, "api worker"},
		{"verbatim drive outside", `C:\My Projects\app`, `\\?\D:\Other Projects\api worker`, "api worker"},
		{"verbatim root", `\\?\C:\My Projects\app`, `C:\My Projects\app\api worker`, "api worker"},
		{"verbatim unc inside", `\\server\team share\app`, `\\?\UNC\server\team share\app\api worker`, "api worker"},
		{"verbatim unc outside", `\\server\team share\app`, `\\?\UNC\other\private share\api worker`, "api worker"},
		{"file url inside", "/srv/My Projects/app", "file:///srv/My%20Projects/app/api%20worker", "api worker"},
		{"file url outside", "/srv/My Projects/app", "file:///opt/Other%20Projects/api%20worker", "api worker"},
		{"unmapped absolute", "", "/opt/Other Projects/api worker", "api worker"},
	}
	for _, level := range []ContentLevel{Standard, Full, Rich} {
		for _, tc := range cases {
			t.Run(string(level)+"/"+tc.name, func(t *testing.T) {
				original := eventIn(tc.directory)
				original["raw"].(map[string]any)["nested"] = []any{map[string]any{"CWD": tc.directory, "WorkDir": tc.directory}}
				before, _ := json.Marshal(original)
				got := PlaceEvent(WorkingDirectoryName(original, level), Place{Roots: []string{tc.root}})
				assertEveryWorkingDirectory(t, got, tc.want)
				nested := got["raw"].(map[string]any)["nested"].([]any)[0].(map[string]any)
				for _, key := range []string{"CWD", "WorkDir"} {
					if nested[key] != tc.want {
						t.Errorf("nested %s = %q, want %q", key, nested[key], tc.want)
					}
				}
				after, _ := json.Marshal(original)
				if string(after) != string(before) {
					t.Fatal("placing a working directory mutated the source event")
				}
				if twice := PlaceEvent(WorkingDirectoryName(got, level), Place{Roots: []string{tc.root}}); !reflect.DeepEqual(twice, got) {
					t.Errorf("a second privacy pass changed the placed event: %v", twice)
				}
			})
		}
	}
}

func TestWorkingDirectoryPlacementPreservesNonPathValuesAndUnrelatedContent(t *testing.T) {
	for _, value := range []string{
		"release builds are ready", "use /opt/team data when ready", "GET /users/42/profile",
		"https://example.test/team%20data?cwd=/tmp/work", "ssh://git@example.test/team/app",
		"api worker", "packages/api worker", "./packages/api worker", "../api worker", ".",
		`C:relative folder`, "", "  already relative  ",
	} {
		t.Run(value, func(t *testing.T) {
			event := eventIn(value)
			event["details"] = map[string]any{
				"message": "Build /opt/team data after lunch", "file": "/opt/team data/source.go",
				"url": "https://example.test/team%20data", "cwd_hint": "/opt/team data",
				"count": 3, "enabled": true, "nested": []any{"a/b report", nil},
			}
			for _, level := range []ContentLevel{Standard, Full, Rich} {
				got := PlaceEvent(WorkingDirectoryName(event, level), Place{Roots: []string{"/srv/My Projects/app"}})
				if !reflect.DeepEqual(got, event) {
					t.Errorf("%s altered a non-absolute working directory or unrelated content: got %v, want %v", level, got, event)
				}
			}
		})
	}
}

func TestWorkingDirectoryPlacementDoesNotChangeGenericPathHeuristics(t *testing.T) {
	event := map[string]any{
		"cwd":      "/opt/team data/api worker",
		"message":  "Build /opt/team data/api worker after lunch",
		"file":     "/opt/team data/api worker",
		"cwd_hint": "/opt/team data/api worker",
	}
	want := map[string]any{
		"cwd":      "api worker",
		"message":  "Build /opt/team data/api worker after lunch",
		"file":     "/opt/team data/api worker",
		"cwd_hint": "/opt/team data/api worker",
	}
	got := PlaceEvent(WorkingDirectoryName(event, Full), Place{Roots: []string{"/srv/My Projects/app"}})
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("only the recognized working-directory member should change: got %v, want %v", got, want)
	}
}
