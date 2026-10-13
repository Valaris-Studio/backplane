// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package privacy

import (
	"reflect"
	"testing"
)

func eventIn(directory string) map[string]any {
	return map[string]any{
		"session": map[string]any{"id": "s1", "working_directory": directory},
		"raw":     map[string]any{"cwd": directory, "pi": map[string]any{"cwd": directory}},
		"tool":    map[string]any{"arguments": map[string]any{"workdir": directory}},
	}
}

func workingDirectories(event map[string]any) []any {
	session, _ := event["session"].(map[string]any)
	raw, _ := event["raw"].(map[string]any)
	pi, _ := raw["pi"].(map[string]any)
	arguments, _ := event["tool"].(map[string]any)["arguments"].(map[string]any)
	return []any{session["working_directory"], raw["cwd"], pi["cwd"], arguments["workdir"]}
}

func assertEveryWorkingDirectory(t *testing.T, event map[string]any, want any) {
	t.Helper()
	for _, got := range workingDirectories(event) {
		if got != want {
			t.Fatalf("working directories %v, want each %v", workingDirectories(event), want)
		}
	}
}

func TestWorkingDirectoryName_MetadataReducesNestedPathToBaseName(t *testing.T) {
	event := WorkingDirectoryName(eventIn("/home/x/code/acme/storefront-api/packages/api"), Metadata)
	assertEveryWorkingDirectory(t, event, "api")
}

func TestWorkingDirectoryName_MetadataRootBecomesFolderName(t *testing.T) {
	event := WorkingDirectoryName(eventIn("/home/x/code/acme/storefront-api"), Metadata)
	placed := PlaceEvent(event, Place{Roots: []string{"/home/x/code/acme/storefront-api"}})
	assertEveryWorkingDirectory(t, placed, "storefront-api")
}

func TestWorkingDirectoryName_MetadataReducesRawCwdMembers(t *testing.T) {
	event := map[string]any{"raw": map[string]any{"CWD": "/srv/app/web", "turns": []any{map[string]any{"workdir": "/srv/app/worker"}}}}
	reduced := WorkingDirectoryName(event, Metadata)
	raw := reduced["raw"].(map[string]any)
	if raw["CWD"] != "web" || raw["turns"].([]any)[0].(map[string]any)["workdir"] != "worker" {
		t.Fatalf("raw working directories: %v", raw)
	}
}

func TestWorkingDirectoryName_WindowsAndFileURLAndTrailingSlash(t *testing.T) {
	for directory, want := range map[string]string{
		`C:\Users\x\code\shop\api`:          "api",
		`\\?\C:\Users\x\code\shop\api\`:     "api",
		"file:///home/x/code/shop/api":     "api",
		"file:///C:/home/x/code/shop/api/": "api",
		"/home/x/code/shop/api/":           "api",
		"  /home/x/code/shop/api  ":        "api",
	} {
		if got := WorkingDirectoryName(eventIn(directory), Metadata); workingDirectories(got)[0] != want {
			t.Errorf("%q became %v, want %q", directory, workingDirectories(got)[0], want)
		}
	}
}

func TestWorkingDirectoryName_FilesystemRootDropped(t *testing.T) {
	for _, directory := range []string{"/", `C:\`, "C:/", `\\?\C:\`, "file:///", "", "   "} {
		event := WorkingDirectoryName(eventIn(directory), Metadata)
		assertEveryWorkingDirectory(t, event, nil)
		if _, kept := event["session"].(map[string]any)["working_directory"]; kept {
			t.Errorf("%q: a root names no folder, so nothing is sent", directory)
		}
	}
}

func TestWorkingDirectoryName_StandardAndFullUnchanged(t *testing.T) {
	for _, level := range []ContentLevel{Standard, Full} {
		original := eventIn("/home/x/code/shop/packages/api")
		if got := WorkingDirectoryName(eventIn("/home/x/code/shop/packages/api"), level); !reflect.DeepEqual(got, original) {
			t.Errorf("%s changed the working directory: %v", level, got)
		}
		placed := PlaceEvent(WorkingDirectoryName(original, level), Place{Roots: []string{"/home/x/code/shop"}})
		assertEveryWorkingDirectory(t, placed, "packages/api")
	}
}

func TestWorkingDirectoryName_Idempotent(t *testing.T) {
	once := WorkingDirectoryName(eventIn("/home/x/code/shop/packages/api"), Metadata)
	if twice := WorkingDirectoryName(once, Metadata); !reflect.DeepEqual(twice, once) {
		t.Fatalf("a second pass changed %v into %v", once, twice)
	}
}
