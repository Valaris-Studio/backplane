// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package contracttest

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestHostPathIsAbsoluteOnThisPlatform(t *testing.T) {
	for _, posix := range []string{"/tmp/fixture-repo", "/private/tmp/rc01-pi/work/calc.py"} {
		host := HostPath(posix)
		if !filepath.IsAbs(host) || filepath.ToSlash(host) != filepath.ToSlash(filepath.VolumeName(host))+posix {
			t.Errorf("HostPath(%q) = %q", posix, host)
		}
	}
}

func TestHostFixtureRewritesWholePathsAndKeepsTheLineJSON(t *testing.T) {
	raw := []byte(`{"cwd":"/private/tmp/rc01-pi/work","path":"/private/tmp/rc01-pi/work/sub/calc.py","note":"in /private/tmp/rc01-pi/work today","other":"/private/tmp/rc01-pi/workshop"}`)
	var line map[string]string
	if err := json.Unmarshal(HostFixture(raw, "/private/tmp/rc01-pi/work"), &line); err != nil {
		t.Fatalf("not JSON: %v", err)
	}
	root := HostPath("/private/tmp/rc01-pi/work")
	if line["cwd"] != root || line["path"] != filepath.Join(root, "sub", "calc.py") || line["note"] != "in "+root+" today" {
		t.Fatalf("rewritten %v", line)
	}
	if line["other"] != "/private/tmp/rc01-pi/workshop" {
		t.Fatalf("a sibling path was mangled: %q", line["other"])
	}
}

func TestReplacePathKeepsTheDocumentJSON(t *testing.T) {
	to := filepath.Join(t.TempDir(), "projects")
	var doc map[string]string
	if err := json.Unmarshal(ReplacePath([]byte(`{"p":"/home/fixture/projects/x.jsonl"}`), "/home/fixture/projects", to), &doc); err != nil || doc["p"] != filepath.Join(to, "x.jsonl") {
		t.Fatalf("%v %v", doc, err)
	}
}

func TestSetTempDirMovesTheProcessTempDir(t *testing.T) {
	dir := t.TempDir()
	SetTempDir(t, dir)
	if os.TempDir() != dir {
		t.Fatalf("os.TempDir() = %q, want %q", os.TempDir(), dir)
	}
}
