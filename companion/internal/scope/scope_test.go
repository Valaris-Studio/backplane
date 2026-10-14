// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package scope

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
)

var now = time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)

type fixture struct {
	root, home, temp string
	cached           policy.Cached
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	root := canonical(t, t.TempDir())
	f := &fixture{root: root, home: filepath.Join(root, "home"), temp: filepath.Join(root, "tmp")}
	mkdir(t, f.home)
	mkdir(t, f.temp)
	f.cached = policy.Cached{RefreshedAt: now.Add(-time.Hour), Policy: policy.Policy{
		Installation: policy.Installation{ID: "inst", AutoMatchRepos: true, EnabledAgents: []string{"claude_code"}},
	}}
	return f
}

func (f *fixture) input(cwd string) Input {
	cached := f.cached
	return Input{Policy: &cached, AgentID: "claude_code", Cwd: cwd, Home: f.home, TempDirs: []string{f.temp}, Now: now}
}

func (f *fixture) repo(t *testing.T, name, origin string) string {
	t.Helper()
	dir := filepath.Join(f.home, "code", name)
	mkdir(t, filepath.Join(dir, ".git"))
	config := "[core]\n\tbare = false\n"
	if origin != "" {
		config += "[remote \"upstream\"]\n\turl = https://example.com/wrong/repo\n[remote \"origin\"]\n\turl = " + origin + "\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n"
	}
	write(t, filepath.Join(dir, ".git", "config"), config)
	return dir
}

func TestExclusionsWinInPrecedenceOrder(t *testing.T) {
	f := newFixture(t)
	repo := f.repo(t, "app", "git@github.com:acme/app.git")
	f.cached.Policy.Mappings = []policy.Mapping{{ID: "m1", WorkspaceID: "w", RootPath: repo, Enabled: true}}
	cases := []struct {
		name   string
		mutate func(*Input)
		want   Reason
	}{
		{"local pause beats everything", func(in *Input) { in.LocalPaused = true; in.Policy = nil }, ReasonLocalPaused},
		{"never connected", func(in *Input) { in.Policy = nil }, ReasonNotConnected},
		{"unauthorized device", func(in *Input) { in.Unauthorized = true }, ReasonUnauthorized},
		{"stale policy", func(in *Input) { in.Policy.RefreshedAt = now.Add(-policy.TrustWindow - time.Minute) }, ReasonPolicyStale},
		{"policy from the future", func(in *Input) { in.Policy.RefreshedAt = now.Add(time.Hour) }, ReasonPolicyStale},
		{"server pause", func(in *Input) { in.Policy.Policy.Installation.Paused = true }, ReasonServerPaused},
		{"agent not enabled", func(in *Input) { in.AgentID = "codex" }, ReasonAgentDisabled},
		{"no agents enabled", func(in *Input) { in.Policy.Policy.Installation.EnabledAgents = []string{} }, ReasonAgentDisabled},
		{"relative cwd", func(in *Input) { in.Cwd = "code/app" }, ReasonInvalidCwd},
		{"missing cwd", func(in *Input) { in.Cwd = filepath.Join(repo, "missing") }, ReasonInvalidCwd},
		{"cwd is a file", func(in *Input) { in.Cwd = filepath.Join(repo, ".git", "config") }, ReasonInvalidCwd},
		{"home directory", func(in *Input) { in.Cwd = f.home }, ReasonHomeOrRoot},
		{"filesystem root", func(in *Input) { in.Cwd = filepath.VolumeName(f.root) + string(filepath.Separator) }, ReasonHomeOrRoot},
		{"exclude glob", func(in *Input) { in.Policy.Policy.Installation.ExcludeGlobs = []string{"~/code/app"} }, ReasonExcluded},
		{"exclude glob matches ancestor", func(in *Input) {
			in.Policy.Policy.Installation.ExcludeGlobs = []string{"**/code"}
			in.Cwd = filepath.Join(repo, ".git")
		}, ReasonExcluded},
		{"local ignore", func(in *Input) { in.IgnoredPaths = []string{repo} }, ReasonIgnored},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in := f.input(repo)
			c.mutate(&in)
			decision := Decide(in)
			if decision.InScope || decision.Reason != c.want {
				t.Fatalf("got %+v, want reason %s", decision, c.want)
			}
		})
	}
	if decision := Decide(f.input(repo)); !decision.InScope || decision.MappingID != "m1" {
		t.Fatalf("baseline must be in scope: %+v", decision)
	}
	allAgents := f.input(repo)
	allAgents.Policy.Policy.Installation.EnabledAgents = nil
	if decision := Decide(allAgents); !decision.InScope {
		t.Fatalf("null enabled_agents means every agent: %+v", decision)
	}
}

func TestTempDirectoriesAreExcluded(t *testing.T) {
	f := newFixture(t)
	scratch := filepath.Join(f.temp, "scratch")
	mkdir(t, scratch)
	f.cached.Policy.Mappings = []policy.Mapping{{ID: "m1", WorkspaceID: "w", RootPath: f.temp, Enabled: true}}
	if decision := Decide(f.input(scratch)); decision.InScope || decision.Reason != ReasonTempDir {
		t.Fatalf("temp dir captured: %+v", decision)
	}
}

func TestLongestExplicitMappingWinsAndDisabledMappingExcludes(t *testing.T) {
	f := newFixture(t)
	parent := filepath.Join(f.home, "work")
	child := filepath.Join(parent, "client")
	deep := filepath.Join(child, "src", "pkg")
	sibling := filepath.Join(f.home, "work-other")
	mkdir(t, deep)
	mkdir(t, sibling)
	f.cached.Policy.Mappings = []policy.Mapping{
		{ID: "parent", WorkspaceID: "w", RootPath: parent, Enabled: true, ContentLevel: "standard"},
		{ID: "child", WorkspaceID: "w", RootPath: child, Enabled: true, ContentLevel: "metadata"},
	}
	decision := Decide(f.input(deep))
	if !decision.InScope || decision.MappingID != "child" || decision.ContentLevel != privacy.Metadata || decision.Reason != ReasonMapped {
		t.Fatalf("longest prefix not chosen: %+v", decision)
	}
	if decision := Decide(f.input(sibling)); decision.InScope {
		t.Fatalf("prefix match crossed a path boundary: %+v", decision)
	}
	f.cached.Policy.Mappings[1].Enabled = false
	if decision := Decide(f.input(deep)); decision.InScope || decision.Reason != ReasonMappingDisabled {
		t.Fatalf("disabled nested mapping must exclude: %+v", decision)
	}
	f.cached.Policy.Mappings[1].ContentLevel = "future-level"
	f.cached.Policy.Mappings[1].Enabled = true
	if decision := Decide(f.input(deep)); decision.ContentLevel != privacy.Metadata {
		t.Fatalf("unknown content level must fail closed to metadata: %+v", decision)
	}
}

func TestSymlinkedCwdResolvesToCanonicalMapping(t *testing.T) {
	f := newFixture(t)
	project := filepath.Join(f.home, "project")
	mkdir(t, project)
	alias := filepath.Join(f.home, "alias")
	if err := os.Symlink(project, alias); err != nil {
		t.Skip(err)
	}
	f.cached.Policy.Mappings = []policy.Mapping{{ID: "m1", WorkspaceID: "w", RootPath: project, Enabled: true}}
	decision := Decide(f.input(alias))
	if !decision.InScope || decision.MappingID != "m1" || decision.Cwd != project {
		t.Fatalf("symlinked cwd not canonicalized: %+v", decision)
	}
	outside := filepath.Join(f.home, "outside")
	mkdir(t, outside)
	escape := filepath.Join(project, "escape")
	if err := os.Symlink(outside, escape); err != nil {
		t.Skip(err)
	}
	if decision := Decide(f.input(escape)); decision.InScope {
		t.Fatalf("symlink escaped the mapped root: %+v", decision)
	}
}

func TestAutoMatchByRemoteAgainstCatalog(t *testing.T) {
	f := newFixture(t)
	repo := f.repo(t, "app", "git@GitHub.com:acme/app.git")
	sub := filepath.Join(repo, "internal", "x")
	mkdir(t, sub)
	f.cached.Policy.RepoCatalog = []policy.CatalogRepo{{WorkspaceID: "w", BoardID: "b", RepoURLNormalized: "github.com/acme/app"}}
	decision := Decide(f.input(sub))
	if !decision.InScope || decision.PendingAutoMatch == nil || decision.Reason != ReasonAutoMatchPending {
		t.Fatalf("catalog repo not auto-matched: %+v", decision)
	}
	if decision.PendingAutoMatch.Root != repo || decision.PendingAutoMatch.RepoURL != "github.com/acme/app" || decision.ContentLevel != privacy.Standard {
		t.Fatalf("wrong pending match: %+v", decision.PendingAutoMatch)
	}
	in := f.input(sub)
	in.UnmatchedRoots = []string{repo}
	if decision := Decide(in); decision.InScope || decision.Reason != ReasonUnmapped {
		t.Fatalf("server-refused root retried: %+v", decision)
	}
	f.cached.Policy.Installation.AutoMatchRepos = false
	decision = Decide(f.input(sub))
	if decision.InScope || decision.Reason != ReasonUnmapped || decision.Discovered == nil || decision.Discovered.RepoURL != "github.com/acme/app" {
		t.Fatalf("auto-match off must leave the repo discovered only: %+v", decision)
	}
	f.cached.Policy.Mappings = []policy.Mapping{{ID: "by-url", WorkspaceID: "w", RepoURLNormalized: "github.com/acme/app", Enabled: true}}
	if decision := Decide(f.input(sub)); !decision.InScope || decision.MappingID != "by-url" {
		t.Fatalf("mapping by normalized remote ignored: %+v", decision)
	}
}

func TestUnmappedRepoIsDiscoveredAndNonRepoIsNot(t *testing.T) {
	f := newFixture(t)
	repo := f.repo(t, "lib", "https://gitlab.example.com/team/lib.git")
	decision := Decide(f.input(repo))
	if decision.InScope || decision.Reason != ReasonUnmapped || decision.Discovered == nil || decision.Discovered.Root != repo || decision.Discovered.RepoURL != "gitlab.example.com/team/lib" {
		t.Fatalf("unmapped repo not discovered: %+v", decision)
	}
	plain := filepath.Join(f.home, "notes")
	mkdir(t, plain)
	if decision := Decide(f.input(plain)); decision.InScope || decision.Discovered != nil {
		t.Fatalf("non-repo directory must record nothing: %+v", decision)
	}
}

func TestWorktreeGitFileFollowsCommonDir(t *testing.T) {
	f := newFixture(t)
	main := f.repo(t, "main", "ssh://git@github.com/acme/main")
	worktreeGitDir := filepath.Join(main, ".git", "worktrees", "feature")
	mkdir(t, worktreeGitDir)
	write(t, filepath.Join(worktreeGitDir, "commondir"), "../..\n")
	worktree := filepath.Join(f.home, "wt", "feature")
	mkdir(t, worktree)
	write(t, filepath.Join(worktree, ".git"), "gitdir: "+worktreeGitDir+"\n")
	decision := Decide(f.input(worktree))
	if decision.Discovered == nil || decision.Discovered.Root != worktree || decision.Discovered.RepoURL != "github.com/acme/main" {
		t.Fatalf("worktree remote not resolved through commondir: %+v", decision)
	}
	relative := filepath.Join(f.home, "wt", "relative")
	mkdir(t, relative)
	rel, _ := filepath.Rel(relative, worktreeGitDir)
	write(t, filepath.Join(relative, ".git"), "gitdir: "+rel+"\n")
	if decision := Decide(f.input(relative)); decision.Discovered == nil || decision.Discovered.RepoURL != "github.com/acme/main" {
		t.Fatalf("relative gitdir not resolved: %+v", decision)
	}
}

func TestNormalizeRemote(t *testing.T) {
	cases := map[string]string{
		"git@github.com:acme/app.git":            "github.com/acme/app",
		"git@github.com:acme/app":                "github.com/acme/app",
		"https://github.com/acme/app.git":        "github.com/acme/app",
		"https://GitHub.COM/Acme/App/":           "github.com/acme/app",
		"git@github.com:Acme/App.git":            "github.com/acme/app",
		"https://user:pass@github.com/acme/app":  "github.com/acme/app",
		"ssh://git@github.com/acme/app":          "github.com/acme/app",
		"ssh://git@github.com:2222/acme/app.git": "github.com/acme/app",
		"http://gitlab.local/group/sub/proj.git": "gitlab.local/group/sub/proj",
		"git://example.org/x/y.git":              "example.org/x/y",
		"  git@bitbucket.org:team/repo.git \n":   "bitbucket.org/team/repo",
		"/srv/git/local.git":                     "",
		"file:///srv/git/local.git":              "",
		"":                                       "",
		"https://github.com":                     "",
		"C:\\repos\\thing":                       "",
	}
	for input, want := range cases {
		if got := NormalizeRemote(input); got != want {
			t.Errorf("NormalizeRemote(%q) = %q, want %q", input, got, want)
		}
	}
}

func canonical(t *testing.T, path string) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

func mkdir(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatal(err)
	}
}

func write(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestOnlyAdmissionStatesAreTransient(t *testing.T) {
	transient := map[Reason]bool{ReasonUnauthorized: true, ReasonPolicyStale: true, ReasonNotConnected: true}
	for _, reason := range []Reason{ReasonMapped, ReasonAutoMatchPending, ReasonLocalPaused, ReasonNotConnected, ReasonUnauthorized, ReasonPolicyStale, ReasonServerPaused, ReasonAgentDisabled, ReasonInvalidCwd, ReasonHomeOrRoot, ReasonTempDir, ReasonExcluded, ReasonIgnored, ReasonMappingDisabled, ReasonUnmapped} {
		if reason.Transient() != transient[reason] {
			t.Errorf("%s transient = %v", reason, reason.Transient())
		}
	}
}
