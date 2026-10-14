// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/scope"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

type discoveredView struct {
	Root      string  `json:"root"`
	RepoURL   *string `json:"repo_url"`
	Reason    string  `json:"reason"`
	FirstSeen string  `json:"first_seen"`
}

func (c *apiClient) discover(t *testing.T, path string) (int, []byte) {
	t.Helper()
	return c.call(t, "POST", "/v1/projects/discover", `{"path":`+quoted(path)+`}`)
}

func (c *apiClient) discovered(t *testing.T, path string) discoveredView {
	t.Helper()
	status, body := c.discover(t, path)
	var answer struct {
		Discovered *discoveredView `json:"discovered"`
	}
	if status != http.StatusOK || json.Unmarshal(body, &answer) != nil || answer.Discovered == nil {
		t.Fatalf("discover %s: %d %s", path, status, body)
	}
	return *answer.Discovered
}

func gitRepo(t *testing.T, root, origin string) string {
	t.Helper()
	mustMkdir(t, filepath.Join(root, ".git"))
	config := ""
	if origin != "" {
		config = "[remote \"origin\"]\n\turl = " + origin + "\n"
	}
	mustWrite(t, filepath.Join(root, ".git", "config"), config)
	return root
}

func recordedProjects(t *testing.T, h *harness) []state.DiscoveredProject {
	t.Helper()
	discovered, err := state.Load[state.Discovered](store.Layout{Root: h.data}.Discovered())
	if err != nil {
		t.Fatal(err)
	}
	return discovered.Projects
}

func connectedAPI(t *testing.T) (*harness, *apiClient) {
	t.Helper()
	h := newHarness(t)
	h.connect(t)
	return h, h.api(t)
}

func TestAPIDiscover_RecordsARepoWithItsNormalizedRemote(t *testing.T) {
	h, api := connectedAPI(t)
	repo := gitRepo(t, filepath.Join(h.home, "code", "shop"), "https://token@GitHub.com/Acme/Shop.git/")
	got := api.discovered(t, repo)
	if got.Root != repo || got.RepoURL == nil || *got.RepoURL != "github.com/acme/shop" || got.Reason != "not_bound" {
		t.Fatalf("discovered %+v", got)
	}
	recorded := recordedProjects(t, h)
	if len(recorded) != 1 || recorded[0].Root != repo || recorded[0].RepoURL != "github.com/acme/shop" {
		t.Fatalf("recorded %+v", recorded)
	}
	_, body := api.call(t, "GET", "/v1/projects", "")
	var listed projectsReport
	if json.Unmarshal(body, &listed) != nil || len(listed.Discovered) != 1 || listed.Discovered[0].Root != repo {
		t.Fatalf("projects list %s", body)
	}
}

func TestAPIDiscover_RecordsTheRemoteExactlyAsAHookWould(t *testing.T) {
	h, api := connectedAPI(t)
	repo := gitRepo(t, filepath.Join(h.home, "code", "shop"), "git@gitlab.example:team/shop.git")
	got := api.discovered(t, repo)
	if repoRoot, _ := scope.FindRepo(repo); got.RepoURL == nil || *got.RepoURL != repoRoot.RemoteURL {
		t.Fatalf("discovered %+v, scope says %q", got, repoRoot.RemoteURL)
	}
}

func TestAPIDiscover_RecordsAFolderWithoutARemote(t *testing.T) {
	h, api := connectedAPI(t)
	plain := filepath.Join(h.home, "notes")
	mustMkdir(t, plain)
	noOrigin := gitRepo(t, filepath.Join(h.home, "code", "local"), "")
	for _, folder := range []string{plain, noOrigin} {
		got := api.discovered(t, folder)
		if got.Root != folder || got.RepoURL != nil || got.Reason != "no_origin" {
			t.Fatalf("discovered %+v", got)
		}
	}
	if recorded := recordedProjects(t, h); len(recorded) != 2 {
		t.Fatalf("recorded %+v", recorded)
	}
}

func TestAPIDiscover_ResolvesASubfolderToTheRepoRoot(t *testing.T) {
	h, api := connectedAPI(t)
	repo := gitRepo(t, filepath.Join(h.home, "code", "shop"), "git@github.com:acme/shop.git")
	subfolder := filepath.Join(repo, "web", "src")
	mustMkdir(t, subfolder)
	if got := api.discovered(t, subfolder); got.Root != repo {
		t.Fatalf("discovered %+v, want the root %s", got, repo)
	}
}

func TestAPIDiscover_WorksBeforeTheDeviceIsConnected(t *testing.T) {
	h := newHarness(t)
	api := h.api(t)
	repo := gitRepo(t, filepath.Join(h.home, "code", "shop"), "git@github.com:acme/shop.git")
	if got := api.discovered(t, repo); got.Root != repo {
		t.Fatalf("discovered %+v", got)
	}
}

func TestAPIDiscover_IsIdempotent(t *testing.T) {
	h, api := connectedAPI(t)
	repo := gitRepo(t, filepath.Join(h.home, "code", "shop"), "git@github.com:acme/shop.git")
	first := api.discovered(t, repo)
	h.app.now = func() time.Time { return time.Now().Add(time.Hour) }
	again := api.discovered(t, repo)
	if !jsonEqual(again, first) {
		t.Fatalf("re-adding changed the project: %+v then %+v", first, again)
	}
	if recorded := recordedProjects(t, h); len(recorded) != 1 {
		t.Fatalf("recorded twice: %+v", recorded)
	}
}

func TestAPIDiscover_KeepsAServerRefusalOfTheSameRemote(t *testing.T) {
	h, api := connectedAPI(t)
	repo := gitRepo(t, filepath.Join(h.home, "code", "shop"), "git@github.com:acme/shop.git")
	layout := store.Layout{Root: h.data}
	if err := state.MarkUnmatched(t.Context(), layout, scope.Project{Root: repo, RepoURL: "github.com/acme/shop"}, time.Now()); err != nil {
		t.Fatal(err)
	}
	api.discovered(t, repo)
	if recorded := recordedProjects(t, h); len(recorded) != 1 || !recorded[0].Unmatched {
		t.Fatalf("re-adding forgot the refusal: %+v", recorded)
	}
}

func TestAPIDiscover_RefusesWhatIsNeverAProject(t *testing.T) {
	h, api := connectedAPI(t)
	file := filepath.Join(h.home, "notes.txt")
	mustWrite(t, file, "x")
	temp := filepath.Join(h.root, "tmp", "scratch")
	mustMkdir(t, temp)
	dotfiles := gitRepo(t, h.home, "git@github.com:me/dotfiles.git")
	insideDotfiles := filepath.Join(dotfiles, "Documents")
	mustMkdir(t, insideDotfiles)
	cases := []struct {
		name, path, code string
		status           int
	}{
		{"relative", "code/app", "invalid_request", http.StatusBadRequest},
		{"not clean", h.home + "/code/../code/app", "invalid_request", http.StatusBadRequest},
		{"a file", file, "not_a_directory", http.StatusBadRequest},
		{"missing", filepath.Join(h.home, "gone"), "not_a_directory", http.StatusBadRequest},
		{"home", h.home, "home_or_root", http.StatusBadRequest},
		{"filesystem root", "/", "home_or_root", http.StatusBadRequest},
		{"inside a repo rooted at home", insideDotfiles, "home_or_root", http.StatusBadRequest},
		{"temp dir", temp, "temp_dir", http.StatusBadRequest},
	}
	for _, refused := range cases {
		status, body := api.discover(t, refused.path)
		if status != refused.status || envelopeCode(t, body) != refused.code {
			t.Errorf("%s: %d %s", refused.name, status, body)
		}
	}
	if recorded := recordedProjects(t, h); len(recorded) != 0 {
		t.Fatalf("a refused folder was recorded: %+v", recorded)
	}
}

func TestAPIDiscover_RefusesAnIgnoredPathAndWhatIsInsideIt(t *testing.T) {
	h, api := connectedAPI(t)
	repo := gitRepo(t, filepath.Join(h.home, "code", "shop"), "git@github.com:acme/shop.git")
	inside := filepath.Join(repo, "web")
	mustMkdir(t, inside)
	if err := h.run(t, "projects", "ignore", repo); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{repo, inside} {
		status, body := api.discover(t, path)
		if status != http.StatusConflict || envelopeCode(t, body) != "ignored_path" {
			t.Fatalf("%s: %d %s", path, status, body)
		}
	}
	if recorded := recordedProjects(t, h); len(recorded) != 0 {
		t.Fatalf("an ignored folder was recorded: %+v", recorded)
	}
}

func TestAPIDiscover_RefusesAPathANeverCaptureRuleExcludes(t *testing.T) {
	h, api := connectedAPI(t)
	setCachedInstallation(t, h, true, []string{"~/clients/**"})
	repo := gitRepo(t, filepath.Join(h.home, "clients", "northwind"), "git@github.com:northwind/site.git")
	status, body := api.discover(t, repo)
	if status != http.StatusConflict || envelopeCode(t, body) != "excluded_path" {
		t.Fatalf("excluded: %d %s", status, body)
	}
	if recorded := recordedProjects(t, h); len(recorded) != 0 {
		t.Fatalf("an excluded folder was recorded: %+v", recorded)
	}
}

func TestAPIDiscover_RefusesAFolderAlreadyBound(t *testing.T) {
	h, api := connectedAPI(t)
	inside := filepath.Join(h.repo, "src")
	mustMkdir(t, inside)
	for _, path := range []string{h.repo, inside} {
		status, body := api.discover(t, path)
		if status != http.StatusConflict || envelopeCode(t, body) != "already_mapped" {
			t.Fatalf("%s: %d %s", path, status, body)
		}
	}
	if recorded := recordedProjects(t, h); len(recorded) != 0 {
		t.Fatalf("a bound folder was recorded: %+v", recorded)
	}
}

func TestAPIDiscover_SaysSoWhenTheFoundListIsFull(t *testing.T) {
	h, api := connectedAPI(t)
	full := state.Discovered{}
	for index := range 256 {
		full.Projects = append(full.Projects, state.DiscoveredProject{Project: scope.Project{Root: filepath.Join(h.home, "old", fmt.Sprint(index))}})
	}
	if err := store.WriteJSON(store.Layout{Root: h.data}.Discovered(), full); err != nil {
		t.Fatal(err)
	}
	repo := gitRepo(t, filepath.Join(h.home, "code", "shop"), "git@github.com:acme/shop.git")
	status, body := api.discover(t, repo)
	if status != http.StatusConflict || envelopeCode(t, body) != "too_many_projects" {
		t.Fatalf("full list: %d %s", status, body)
	}
}
