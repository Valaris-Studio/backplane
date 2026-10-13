// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

func requireCaseInsensitiveHome(t *testing.T, h *harness) {
	t.Helper()
	probe := filepath.Join(h.root, "CaseProbe")
	mustMkdir(t, probe)
	defer os.Remove(probe)
	original, _ := os.Stat(probe)
	swapped, err := os.Stat(filepath.Join(h.root, "cASEpROBE"))
	if err != nil || !os.SameFile(original, swapped) {
		t.Skip("temp volume is case-sensitive")
	}
}

// upperBelow upper-cases path below the harness root, keeping the root as is.
func upperBelow(h *harness, path string) string {
	return h.root + strings.ToUpper(strings.TrimPrefix(path, h.root))
}

func storeIgnoredPaths(t *testing.T, h *harness, paths ...string) {
	t.Helper()
	layout := store.Layout{Root: h.data}
	err := state.Update(context.Background(), layout, layout.Preferences(), func(preferences *state.Preferences) bool {
		preferences.IgnoredPaths = paths
		return true
	})
	if err != nil {
		t.Fatal(err)
	}
}

func ignoredPaths(t *testing.T, h *harness) []string {
	t.Helper()
	preferences, err := state.Load[state.Preferences](store.Layout{Root: h.data}.Preferences())
	if err != nil {
		t.Fatal(err)
	}
	return preferences.IgnoredPaths
}

func TestCanonicalPath_ReturnsTheOnDiskCase(t *testing.T) {
	h := newHarness(t)
	requireCaseInsensitiveHome(t, h)
	folder := filepath.Join(h.home, "Projects", "Shop")
	mustMkdir(t, folder)
	if got, err := canonicalPath(upperBelow(h, folder)); err != nil || got != folder {
		t.Fatalf("canonicalPath = %q, %v; want %q", got, err, folder)
	}
	if _, err := canonicalPath(upperBelow(h, filepath.Join(h.home, "missing"))); err != errNotADirectory {
		t.Fatalf("a missing folder in another case: %v", err)
	}
}

func TestAPIDiscover_RefusesAnIgnoredPathSpelledInAnotherCase(t *testing.T) {
	h, api := connectedAPI(t)
	requireCaseInsensitiveHome(t, h)
	repo := gitRepo(t, filepath.Join(h.home, "code", "shop"), "git@github.com:acme/shop.git")
	if err := h.run(t, "projects", "ignore", repo); err != nil {
		t.Fatal(err)
	}
	status, body := api.discover(t, upperBelow(h, repo))
	if status != http.StatusConflict || envelopeCode(t, body) != "ignored_path" {
		t.Fatalf("respelled ignored repo: %d %s", status, body)
	}
	if recorded := recordedProjects(t, h); len(recorded) != 0 {
		t.Fatalf("an ignored folder was recorded: %+v", recorded)
	}
}

func TestAPIDiscover_RefusesAPathIgnoredInAnotherCaseByAnOlderVersion(t *testing.T) {
	h, api := connectedAPI(t)
	requireCaseInsensitiveHome(t, h)
	repo := gitRepo(t, filepath.Join(h.home, "code", "shop"), "git@github.com:acme/shop.git")
	storeIgnoredPaths(t, h, upperBelow(h, repo))
	status, body := api.discover(t, repo)
	if status != http.StatusConflict || envelopeCode(t, body) != "ignored_path" {
		t.Fatalf("ignored entry stored in another case: %d %s", status, body)
	}
}

func TestAPIDiscover_RefusesAnExcludedPathSpelledInAnotherCase(t *testing.T) {
	h, api := connectedAPI(t)
	requireCaseInsensitiveHome(t, h)
	setCachedInstallation(t, h, true, []string{"~/clients/**"})
	repo := gitRepo(t, filepath.Join(h.home, "clients", "northwind"), "git@github.com:northwind/site.git")
	status, body := api.discover(t, upperBelow(h, repo))
	if status != http.StatusConflict || envelopeCode(t, body) != "excluded_path" {
		t.Fatalf("respelled excluded repo: %d %s", status, body)
	}
}

func TestAPIDiscover_RefusesABoundFolderSpelledInAnotherCase(t *testing.T) {
	h, api := connectedAPI(t)
	requireCaseInsensitiveHome(t, h)
	status, body := api.discover(t, upperBelow(h, h.repo))
	if status != http.StatusConflict || envelopeCode(t, body) != "already_mapped" {
		t.Fatalf("respelled bound repo: %d %s", status, body)
	}
}

func TestAPIDiscover_RecordsTheOnDiskSpelling(t *testing.T) {
	h, api := connectedAPI(t)
	requireCaseInsensitiveHome(t, h)
	repo := gitRepo(t, filepath.Join(h.home, "code", "Shop"), "git@github.com:acme/shop.git")
	if got := api.discovered(t, upperBelow(h, repo)); got.Root != repo {
		t.Fatalf("recorded root %q, want the on-disk %q", got.Root, repo)
	}
}

func TestProjectsIgnore_RecognizesAnEntryStoredInAnotherCase(t *testing.T) {
	h := newHarness(t)
	requireCaseInsensitiveHome(t, h)
	folder := filepath.Join(h.home, "private")
	mustMkdir(t, folder)
	storeIgnoredPaths(t, h, upperBelow(h, folder))
	if err := h.run(t, "projects", "ignore", folder); err != nil {
		t.Fatal(err)
	}
	if got := ignoredPaths(t, h); len(got) != 1 {
		t.Fatalf("ignoring an already-ignored folder duplicated it: %v", got)
	}
}

func TestProjectsUnignore_RemovesAnEntryStoredInAnotherCase(t *testing.T) {
	h := newHarness(t)
	requireCaseInsensitiveHome(t, h)
	folder := filepath.Join(h.home, "private")
	other := filepath.Join(h.home, "other")
	mustMkdir(t, folder)
	mustMkdir(t, other)
	storeIgnoredPaths(t, h, upperBelow(h, folder), other)
	if err := h.run(t, "projects", "unignore", folder); err != nil {
		t.Fatal(err)
	}
	if got := ignoredPaths(t, h); !slices.Equal(got, []string{other}) {
		t.Fatalf("ignored after unignore: %v", got)
	}
}
