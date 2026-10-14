// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/scope"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// The CLI's JSON output is a contract for scripts and for the control API,
// which serves the same shapes; these goldens were recorded before the
// handlers were shared with the API. BACKPLANE_UPDATE_GOLDEN=1 rewrites them.
var updateGolden = os.Getenv("BACKPLANE_UPDATE_GOLDEN") != ""

var goldenClock = time.Date(2026, 9, 28, 10, 0, 0, 0, time.UTC)

func (h *harness) placeholders(t *testing.T) *strings.Replacer {
	t.Helper()
	pairs := []string{h.server.URL, "<SERVER>", h.data, "<DATA>", h.home, "<HOME>", filepath.Dir(h.executable), "<BIN>", h.root, "<ROOT>", `"go_version": "` + runtime.Version() + `"`, `"go_version": "<GO>"`}
	if installation, _ := state.Load[state.Installation](filepath.Join(h.data, "installation.json")); installation.ID != "" {
		pairs = append(pairs, installation.ID, "<INSTALLATION>")
	}
	return strings.NewReplacer(pairs...)
}

func (h *harness) assertGolden(t *testing.T, name string, args ...string) {
	t.Helper()
	if err := h.run(t, args...); err != nil {
		t.Fatalf("%v: %v", args, err)
	}
	got := h.placeholders(t).Replace(h.stdout.String())
	path := filepath.Join("testdata", "golden", name+".json")
	if updateGolden {
		mustMkdir(t, filepath.Dir(path))
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != string(want) {
		t.Fatalf("%v output changed:\n--- got\n%s\n--- want\n%s", args, got, want)
	}
}

func TestCLIOutput_UnchangedFromGoldens(t *testing.T) {
	h := newHarness(t)
	h.app.now = func() time.Time { return goldenClock }
	h.connect(t)
	layout := store.Layout{Root: h.data}
	other := filepath.Join(h.home, "code", "other")
	mustMkdir(t, filepath.Join(other, ".git"))
	mustWrite(t, filepath.Join(other, ".git", "config"), "[remote \"origin\"]\n\turl = https://github.com/acme/other.git\n")
	if err := state.RecordDiscovered(context.Background(), layout, scope.Project{Root: other, RepoURL: "github.com/acme/other"}, goldenClock); err != nil {
		t.Fatal(err)
	}

	h.assertGolden(t, "status", "status")
	h.assertGolden(t, "pause", "pause")
	h.assertGolden(t, "status_paused", "status")
	h.assertGolden(t, "resume", "resume")
	h.assertGolden(t, "projects_list", "projects", "list")
	h.assertGolden(t, "projects_ignore", "projects", "ignore", other)
	h.assertGolden(t, "projects_list_ignored", "projects", "list")
	h.assertGolden(t, "agents_list", "agents", "list")
	h.assertGolden(t, "agents_status", "agents", "status")
	h.assertGolden(t, "agents_install", "agents", "install", "claude-code")
	h.assertGolden(t, "agents_uninstall", "agents", "uninstall", "claude-code")
	h.assertGolden(t, "version", "version")
	h.assertGolden(t, "disconnect", "disconnect")
	h.assertGolden(t, "status_disconnected", "status")
}
