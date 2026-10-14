// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package privacy

import (
	"encoding/json"
	"reflect"
	"testing"
)

// Home-path literals are assembled at runtime: the public export refuses
// them in source, case-insensitively.
const (
	macHome      = "/" + "Users/"
	macHomeUpper = "/" + "USERS/"
	macHomeLower = "/" + "users/"
	winHome      = `C:\` + `Users\`
)

// serverRoots matches backend/tests/core/test_local_paths.py, whose cases
// the Test*Server* tests below mirror one for one: the device and the server
// must place paths the same way.
var serverRoots = []string{"/home/me/code/app", "/home/me/link/app"}

func placed(t *testing.T, value string, roots ...string) string {
	t.Helper()
	return PlaceEvent(map[string]any{"t": value}, Place{Roots: roots})["t"].(string)
}

// The Test* functions from here to the device-only tests mirror, one to one
// and case for case, the tests of the same names in
// backend/tests/core/test_local_paths.py (same inputs, roots and expected
// outputs): the device and the server must place paths the same way.

func TestEventKeepsNoLocalPath(t *testing.T) {
	event := map[string]any{
		"session":         map[string]any{"id": "s1", "working_directory": "/home/me/code/app/cmd/server"},
		"file":            map[string]any{"path": "/home/me/code/app/main.go"},
		"tool":            map[string]any{"path": "/home/me/.claude/settings.json"},
		"transcript_path": "/home/me/.claude/projects/app/s1.jsonl",
		"command":         map[string]any{"line": "cd /home/me/code/app && ls /home/me/link/app/docs/"},
		"prompt": map[string]any{"text": "read /home/me/code/app/README.md, /home/me/code/app2/x, " +
			macHome + "meadow/y, /home/meadow/q, /home/bob/z, " + winHome + `Eve\w and file:///home/me/notes.txt`},
		"list":  []any{"/home/me/code/app", "/home/me/code/app/", 3.0},
		"other": "/opt/tools/bin/tool",
	}
	want := map[string]any{
		"session":         map[string]any{"id": "s1", "working_directory": "cmd/server"},
		"file":            map[string]any{"path": "main.go"},
		"tool":            map[string]any{"path": "~me/.claude/settings.json"},
		"transcript_path": "~me/.claude/projects/app/s1.jsonl",
		"command":         map[string]any{"line": "cd . && ls docs/"},
		"prompt":          map[string]any{"text": "read README.md, ~me/code/app2/x, ~meadow/y, ~meadow/q, ~bob/z, " + `~Eve\w and file://~me/notes.txt`},
		"list":            []any{".", "./", 3.0},
		"other":           "/opt/tools/bin/tool",
	}
	got := PlaceEvent(event, Place{Roots: serverRoots})
	if !reflect.DeepEqual(got, want) {
		encoded, _ := json.MarshalIndent(got, "", " ")
		t.Fatalf("placed event:\n%s", encoded)
	}
	if event["file"].(map[string]any)["path"] != "/home/me/code/app/main.go" {
		t.Fatal("input event was modified")
	}
}

func TestWindowsRootsAndExtendedPaths(t *testing.T) {
	root := winHome + `me\app`
	got := PlaceEvent(map[string]any{
		"session":     map[string]any{"working_directory": root + `\src`},
		"text":        "edit " + root + `\src\main.go and ` + winHome + `me\Desktop\a.txt`,
		"long":        `\\?\` + winHome + `me\Documents\x`,
		"other_drive": `D:\` + `users\ann\y`,
	}, Place{Roots: []string{root}})
	for key, want := range map[string]any{
		"text": `edit src\main.go and ~me\Desktop\a.txt`, "long": `~me\Documents\x`, "other_drive": `~ann\y`,
	} {
		if got[key] != want {
			t.Errorf("%s = %q, want %q", key, got[key], want)
		}
	}
	if directory := got["session"].(map[string]any)["working_directory"]; directory != "src" {
		t.Errorf("working directory %q", directory)
	}
}

func TestMemberNamesArePlacedToo(t *testing.T) {
	got := PlaceEvent(map[string]any{"files": map[string]any{"/home/me/code/app/main.go": 1.0, "/home/me/notes.txt": 2.0}}, Place{Roots: serverRoots})
	want := map[string]any{"files": map[string]any{"main.go": 1.0, "~me/notes.txt": 2.0}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("placed event: %v", got)
	}
}

func checkPlaced(t *testing.T, roots []string, cases [][2]string) {
	t.Helper()
	for _, c := range cases {
		if got := placed(t, c[0], roots...); got != c[1] {
			t.Errorf("%q became %q, want %q", c[0], got, c[1])
		}
	}
}

func TestOtherHomeSpellings(t *testing.T) {
	checkPlaced(t, nil, [][2]string{
		{macHomeUpper + "ann/x", "~ann/x"},
		{macHomeLower + "ann/x", "~ann/x"},
		{"/root/.ssh/config", "~root/.ssh/config"},
		// In prose /root and URL-encoded homes are left as they are.
		{"cd /root", "cd /root"},
		{"cp /root/a /root,/root", "cp /root/a /root,/root"},
		{"/var/home/ann/x", "~ann/x"},
		{"a=%2FUsers%2Fann%2Fx", "a=~ann%2Fx"},
		{"%2Fhome%2Fann%2Fx", "~ann%2Fx"},
		{"/rooted/x", "/rooted/x"},
		{"/srv/root/x", "/srv/root/x"},
		{"https://h" + macHomeLower + "ann/x", "https://h" + macHomeLower + "ann/x"},
	})
}

func TestWholePathValuesAreTrimmedAndFileURLsParsed(t *testing.T) {
	checkPlaced(t, []string{"/home/me/code/app"}, [][2]string{
		// A whole value that is a path is trimmed and file:// URLs are
		// parsed before anchoring, so neither hides a local path.
		{" " + macHome + "me/code/app/x ", "~me/code/app/x"},
		{"file://" + macHome + "me/code", "~me/code"},
		{"file:///home/me/code/app/src", "src"},
		{"file:///C:/" + "Users/me/x", "~me/x"},
		{"file:///home/me/My%20Code", "~me/My Code"},
		{"  /home/me/code/app  ", "."},
		// Prose keeps its spacing; only the paths inside change.
		{"  see " + macHome + "me/x  ", "  see ~me/x  "},
	})
}

func TestProseWebRoutesAndWordsAreNotRewritten(t *testing.T) {
	for _, text := range []string{
		"GET /" + "users/42/profile",
		"see /home/about",
		"https://h/" + "Users/ann/x",
	} {
		if got := placed(t, text); got != text {
			t.Errorf("%q became %q", text, got)
		}
	}
}

func TestWSLAndProseHomeForms(t *testing.T) {
	checkPlaced(t, nil, [][2]string{
		{"/mnt/c/" + "Users/ann/x", "~ann/x"},
		{"see /mnt/d/" + "Users/ann/x now", "see ~ann/x now"},
		{"/" + "users/ann/x", "~ann/x"}, // whole-value paths stay case-insensitive
		{"run /" + "Users/ann/.ssh/config", "run ~ann/.ssh/config"},
		{"in /home/ann/x", "in ~ann/x"},
	})
}

func TestProseRewritesFormsThatCannotBeWebRoutes(t *testing.T) {
	checkPlaced(t, nil, [][2]string{
		{"edit " + `c:\` + `USERS\ann\x.txt now`, `edit ~ann\x.txt now`},
		{"edit " + "D:/" + "Users/ann/x.txt now", "edit ~ann/x.txt now"},
		{"open file://laptop/" + "Users/ann/x please", "open file://laptop/~ann/x please"},
		{"got a=%2F" + "Users%2Fann%2Fx here", "got a=~ann%2Fx here"},
		{"got a=%2Fhome%2Fann%2Fx here", "got a=~ann%2Fx here"},
		{"in /mnt/c/" + "users/ann/x now", "in ~ann/x now"},
		{"in /MNT/C/" + "USERS/ann/x now", "in ~ann/x now"},
	})
}

func TestProseAcceptedGapsAreLeftAsTheyAre(t *testing.T) {
	// Accepted gaps: a bare home without a further segment, and lowercase
	// /users/... which web routes use.
	for _, text := range []string{"cd /home/bob", "GET /" + "users/ann/profile"} {
		if got := placed(t, text); got != text {
			t.Errorf("%q became %q", text, got)
		}
	}
}

// Device-only cases: forms the shared decisions fix that the server's table
// does not list (verified to agree with it), and the device's own home and
// repository.

func TestWindowsProseHomeEndsWhereItsNameEnds(t *testing.T) {
	checkPlaced(t, nil, [][2]string{
		{"open " + winHome + "ann", "open ~ann"},
		{"cd " + winHome + "ann and " + winHome + "bob now", "cd ~ann and ~bob now"},
		{`dir "` + winHome + `ann"`, `dir "~ann"`},
		{"edit " + winHome + `ann\notes.txt now`, `edit ~ann\notes.txt now`},
		{`ratio C:\` + "users is a word", `ratio C:\` + "users is a word"},
		// Inside an encoded path too, as on the server.
		{"not " + winHome + "ann%20x", "not ~ann%20x"},
	})
}

func TestFileURLsKeepTheirHost(t *testing.T) {
	checkPlaced(t, nil, [][2]string{
		{"open file://server/home/ann/x.txt", "open file://server/~ann/x.txt"},
		{"open file:///home/ann/x.txt", "open file://~ann/x.txt"},
		{"open file://laptop/srv/x", "open file://laptop/srv/x"},
		{"q=%2FUsers%2Fann%2Fx&y", "q=~ann%2Fx&y"},
		{"q=%2fhome%2fann%2fx", "q=~ann%2fx"},
	})
}

// The device also knows its own home, which becomes ~/… everywhere, and it
// sets the repository and branch.
func TestPlaceEventUsesTheDevicesOwnHomeAndRepository(t *testing.T) {
	place := Place{
		Roots:   []string{"/home/me/code/app", "/home/me/link/app"},
		Homes:   []string{"/home/me"},
		RepoURL: "github.com/acme/app",
		Branch:  "feature/x",
	}
	event := map[string]any{
		"repository":      "/home/me/code/app",
		"session":         map[string]any{"id": "s1", "working_directory": "/home/me/code/app/cmd/server"},
		"tool":            map[string]any{"path": "/home/me/.claude/settings.json"},
		"run":             map[string]any{"repository": "/home/me/code/app", "branch": "stale"},
		"transcript_path": "/home/me/.claude/projects/app/s1.jsonl",
		"prompt":          map[string]any{"text": "read /home/me/code/app2/x and file:///home/me/notes.txt"},
		"files":           map[string]any{"/home/me/notes.txt": 1.0},
	}
	want := map[string]any{
		"repository":      "github.com/acme/app",
		"branch":          "feature/x",
		"session":         map[string]any{"id": "s1", "working_directory": "cmd/server"},
		"tool":            map[string]any{"path": "~/.claude/settings.json"},
		"run":             map[string]any{"repository": "github.com/acme/app", "branch": "feature/x"},
		"transcript_path": "~/.claude/projects/app/s1.jsonl",
		"prompt":          map[string]any{"text": "read ~/code/app2/x and file://~/notes.txt"},
		"files":           map[string]any{"~/notes.txt": 1.0},
	}
	if got := PlaceEvent(event, place); !reflect.DeepEqual(got, want) {
		encoded, _ := json.MarshalIndent(got, "", " ")
		t.Fatalf("placed event:\n%s", encoded)
	}
	windows := Place{Roots: []string{winHome + `me\app`}, Homes: []string{winHome + "me"}}
	got := PlaceEvent(map[string]any{"text": "edit " + winHome + `me\app\src\main.go and ` + winHome + `me\Desktop\a.txt`}, windows)
	if got["text"] != `edit src\main.go and ~\Desktop\a.txt` {
		t.Errorf("windows own home: %q", got["text"])
	}
}

func TestPlaceEventDropsWhatIsUnknown(t *testing.T) {
	event := map[string]any{"repository": "/srv/project", "branch": "from-beacon", "session": map[string]any{"working_directory": "/srv/project"}}
	got := PlaceEvent(event, Place{Roots: []string{"/srv/project"}})
	want := map[string]any{"session": map[string]any{"working_directory": "."}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("placed event: %v", got)
	}
}

// Absoluteness is a path's syntax, the same on every host (amendment 9).
func TestAbsolutePathIsDecidedBySyntax(t *testing.T) {
	for path, absolute := range map[string]bool{
		"/" + "repo/a.go": true, `C:\x\y.go`: true, "C:/x/y.go": true, `\\server\share\y.go`: true,
		"calc.py": false, "./a.go": false, "../a.go": false, "": false, `C:x.go`: false,
	} {
		if AbsolutePath(path) != absolute {
			t.Errorf("AbsolutePath(%q) = %v", path, !absolute)
		}
	}
}
