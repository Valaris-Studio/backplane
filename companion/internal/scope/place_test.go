// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package scope

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
)

func TestBranchIsReadFromHeadWithoutGit(t *testing.T) {
	f := newFixture(t)
	repo := f.repo(t, "app", "git@github.com:acme/app.git")
	cases := map[string]string{
		"ref: refs/heads/feature/x\n":                "feature/x",
		"0123456789abcdef0123456789abcdef01234567\n": "0123456",
		"ref: refs/remotes/origin/main\n":            "",
		"not a head\n":                               "",
		"0123456789abcdef0123456789abcdef0123456z\n": "",
	}
	for head, want := range cases {
		write(t, filepath.Join(repo, ".git", "HEAD"), head)
		if found, ok := FindRepo(repo); !ok || found.Branch != want {
			t.Errorf("HEAD %q: branch %q, want %q", head, found.Branch, want)
		}
	}
	os.Remove(filepath.Join(repo, ".git", "HEAD"))
	if found, _ := FindRepo(repo); found.Branch != "" {
		t.Errorf("missing HEAD gave branch %q", found.Branch)
	}
}

func TestLinkedWorktreeReadsItsOwnHead(t *testing.T) {
	f := newFixture(t)
	main := f.repo(t, "main", "git@github.com:acme/main.git")
	write(t, filepath.Join(main, ".git", "HEAD"), "ref: refs/heads/main\n")
	worktreeGitDir := filepath.Join(main, ".git", "worktrees", "feature")
	mkdir(t, worktreeGitDir)
	write(t, filepath.Join(worktreeGitDir, "commondir"), "../..\n")
	write(t, filepath.Join(worktreeGitDir, "HEAD"), "ref: refs/heads/feature\n")
	worktree := filepath.Join(f.home, "wt", "feature")
	mkdir(t, worktree)
	write(t, filepath.Join(worktree, ".git"), "gitdir: "+worktreeGitDir+"\n")
	found, ok := FindRepo(worktree)
	if !ok || found.Branch != "feature" || found.RemoteURL != "github.com/acme/main" {
		t.Fatalf("worktree: %+v", found)
	}
}

func TestDecisionPlacesTheSessionAtItsProject(t *testing.T) {
	f := newFixture(t)
	repo := f.repo(t, "app", "git@github.com:acme/app.git")
	write(t, filepath.Join(repo, ".git", "HEAD"), "ref: refs/heads/main\n")
	sub := filepath.Join(repo, "cmd")
	mkdir(t, sub)
	notes := filepath.Join(f.home, "notes")
	mkdir(t, notes)
	homes := []string{f.home}

	f.cached.Policy.Mappings = []policy.Mapping{{ID: "by-url", WorkspaceID: "w", RepoURLNormalized: "github.com/acme/app", Enabled: true}}
	want := privacy.Place{Roots: []string{repo}, Homes: homes, RepoURL: "github.com/acme/app", Branch: "main"}
	if decision := Decide(f.input(sub)); !reflect.DeepEqual(decision.Place, want) {
		t.Errorf("rootless mapping: %+v", decision.Place)
	}

	f.cached.Policy.Mappings = nil
	f.cached.Policy.RepoCatalog = []policy.CatalogRepo{{WorkspaceID: "w", RepoURLNormalized: "github.com/acme/app"}}
	if decision := Decide(f.input(sub)); decision.PendingAutoMatch == nil || !reflect.DeepEqual(decision.Place, want) {
		t.Errorf("pending auto-match: %+v", decision.Place)
	}

	f.cached.Policy.Mappings = []policy.Mapping{{ID: "explicit", WorkspaceID: "w", RootPath: sub, Enabled: true}}
	want = privacy.Place{Roots: []string{sub}, Homes: homes, RepoURL: "github.com/acme/app", Branch: "main"}
	if decision := Decide(f.input(sub)); !reflect.DeepEqual(decision.Place, want) {
		t.Errorf("explicit mapping inside a repository: %+v", decision.Place)
	}

	f.cached.Policy.Mappings = []policy.Mapping{{ID: "explicit", WorkspaceID: "w", RootPath: sub, RepoURLNormalized: "github.com/acme/chosen", Enabled: true}}
	if decision := Decide(f.input(sub)); decision.Place.RepoURL != "github.com/acme/chosen" {
		t.Errorf("explicit mapping's repository ignored: %+v", decision.Place)
	}

	f.cached.Policy.Mappings = []policy.Mapping{{ID: "folder", WorkspaceID: "w", RootPath: notes, Enabled: true}}
	want = privacy.Place{Roots: []string{notes}, Homes: homes}
	if decision := Decide(f.input(notes)); !reflect.DeepEqual(decision.Place, want) {
		t.Errorf("non-repository folder: %+v", decision.Place)
	}
}

func TestPlaceKeepsTheSpellingTheAgentUsed(t *testing.T) {
	f := newFixture(t)
	project := filepath.Join(f.home, "project")
	mkdir(t, filepath.Join(project, "src"))
	alias := filepath.Join(f.home, "alias")
	if err := os.Symlink(project, alias); err != nil {
		t.Skip(err)
	}
	f.cached.Policy.Mappings = []policy.Mapping{{ID: "m1", WorkspaceID: "w", RootPath: project, Enabled: true}}
	decision := Decide(f.input(filepath.Join(alias, "src")))
	if want := []string{project, alias}; !reflect.DeepEqual(decision.Place.Roots, want) {
		t.Fatalf("roots %v, want %v", decision.Place.Roots, want)
	}
}

func TestSymlinkedGitDirectoryIsFollowed(t *testing.T) {
	f := newFixture(t)
	gitDir := filepath.Join(f.home, "git-dirs", "app.git")
	mkdir(t, gitDir)
	write(t, filepath.Join(gitDir, "config"), "[remote \"origin\"]\n\turl = git@github.com:acme/app.git\n")
	write(t, filepath.Join(gitDir, "HEAD"), "ref: refs/heads/main\n")
	repo := filepath.Join(f.home, "code", "app")
	mkdir(t, repo)
	if err := os.Symlink(gitDir, filepath.Join(repo, ".git")); err != nil {
		t.Skip(err)
	}
	found, ok := FindRepo(repo)
	if !ok || found.Root != repo || found.RemoteURL != "github.com/acme/app" || found.Branch != "main" {
		t.Fatalf("symlinked .git: %+v %v", found, ok)
	}
}
