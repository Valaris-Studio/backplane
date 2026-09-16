// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// skillsServer answers skill-version fetches and counts them, so a test can
// prove the empty-manifest path never reaches the network.
func skillsServer(t *testing.T) (*httptest.Server, func() int) {
	t.Helper()
	var mu sync.Mutex
	fetches := 0

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		if strings.Contains(r.URL.Path, "/skills/") && strings.Contains(r.URL.Path, "/versions/") {
			mu.Lock()
			fetches++
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"version":      2,
				"content_hash": "hash-k",
				"files": []map[string]any{
					{"path": "SKILL.md", "content": "# House Style\n"},
				},
			})
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)

	return srv, func() int {
		mu.Lock()
		defer mu.Unlock()
		return fetches
	}
}

// initGitRepo makes a real git repo in a temp dir. Safe: it is out of tree and
// nothing here runs reset --hard against the live worktree.
func initGitRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	cmd := exec.Command("git", "init")
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %v (%s)", err, out)
	}
	return dir
}

func skillsWalkState(t *testing.T, loop *Loop, repoDir string, manifest []valaris.AssignmentSkill) *lifecycle.WalkState {
	t.Helper()
	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "implementer"}, nil)
	card := &discoverResult{CardID: "card-1", BoardID: "board-1", Title: "t", Skills: manifest}
	ws := makeWalkState(t, loop, strat, card)
	ws.RepoDir = repoDir
	return ws
}

func skillsStep() *valaris.LifecycleStep {
	return &valaris.LifecycleStep{Name: "skills", Kind: "skills_setup"}
}

func TestKindSkillsSetup_MaterializesIntoRepo(t *testing.T) {
	srv, _ := skillsServer(t)
	loop := newLoopForKindTest(t, srv.URL)
	loop.provider = llm.NewClaudeCLI()
	repoDir := initGitRepo(t)

	manifest := []valaris.AssignmentSkill{
		{Slug: "house-style", Name: "House Style", Version: 2, ContentHash: "hash-k"},
	}
	ws := skillsWalkState(t, loop, repoDir, manifest)

	if _, _, err := lifecycleSkillsSetup(context.Background(), ws, skillsStep()); err != nil {
		t.Fatalf("skills_setup: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(repoDir, ".claude/skills/house-style/SKILL.md"))
	if err != nil {
		t.Fatalf("reading materialized skill: %v", err)
	}
	if string(got) != "# House Style\n" {
		t.Errorf("SKILL.md = %q, want the verbatim published content", got)
	}
}

func TestKindSkillsSetup_ExcludesSkillsDirExactlyOnce(t *testing.T) {
	// .git/info/exclude is what protects materialized skills from `git clean
	// -fd`, which every git_setup runs. Appending twice would work but signals
	// the guard isn't idempotent, so pin the count.
	srv, _ := skillsServer(t)
	loop := newLoopForKindTest(t, srv.URL)
	loop.provider = llm.NewClaudeCLI()
	repoDir := initGitRepo(t)

	manifest := []valaris.AssignmentSkill{{Slug: "house-style", Version: 2, ContentHash: "hash-k"}}

	for i := 0; i < 2; i++ {
		ws := skillsWalkState(t, loop, repoDir, manifest)
		if _, _, err := lifecycleSkillsSetup(context.Background(), ws, skillsStep()); err != nil {
			t.Fatalf("skills_setup run %d: %v", i+1, err)
		}
	}

	content, err := os.ReadFile(filepath.Join(repoDir, ".git", "info", "exclude"))
	if err != nil {
		t.Fatalf("reading .git/info/exclude: %v", err)
	}
	if n := strings.Count(string(content), ".claude/skills/"); n != 1 {
		t.Errorf(".git/info/exclude mentions .claude/skills/ %d times, want exactly 1:\n%s", n, content)
	}
}

func TestKindSkillsSetup_EmptyManifestSkipsNetwork(t *testing.T) {
	srv, fetches := skillsServer(t)
	loop := newLoopForKindTest(t, srv.URL)
	loop.provider = llm.NewClaudeCLI()
	repoDir := initGitRepo(t)

	ws := skillsWalkState(t, loop, repoDir, nil)
	if _, _, err := lifecycleSkillsSetup(context.Background(), ws, skillsStep()); err != nil {
		t.Fatalf("skills_setup with empty manifest: %v", err)
	}
	if n := fetches(); n != 0 {
		t.Errorf("fetch count = %d, want 0 on an empty manifest", n)
	}
	if _, err := os.Stat(filepath.Join(repoDir, ".claude")); err == nil {
		t.Error("empty manifest created a skills dir, want no filesystem change")
	}
}

func TestKindSkillsSetup_NoLocatorProviderSkips(t *testing.T) {
	// The mock provider declares no discovery directory. Writing files anyway
	// would leave litter the agent never reads.
	srv, fetches := skillsServer(t)
	loop := newLoopForKindTest(t, srv.URL)
	loop.provider = llm.NewMockProvider()
	repoDir := initGitRepo(t)

	manifest := []valaris.AssignmentSkill{{Slug: "house-style", Version: 2, ContentHash: "hash-k"}}
	ws := skillsWalkState(t, loop, repoDir, manifest)

	if _, _, err := lifecycleSkillsSetup(context.Background(), ws, skillsStep()); err != nil {
		t.Fatalf("skills_setup with no locator: %v", err)
	}
	if n := fetches(); n != 0 {
		t.Errorf("fetch count = %d, want 0 when the provider has no skills dir", n)
	}
	entries, _ := os.ReadDir(repoDir)
	for _, e := range entries {
		if e.Name() == ".claude" || e.Name() == ".codex" {
			t.Errorf("created %s for a provider that declares no skills dir", e.Name())
		}
	}
}

func TestKindSkillsSetup_RequiresGitSetup(t *testing.T) {
	srv, _ := skillsServer(t)
	loop := newLoopForKindTest(t, srv.URL)
	loop.provider = llm.NewClaudeCLI()

	manifest := []valaris.AssignmentSkill{{Slug: "house-style", Version: 2, ContentHash: "hash-k"}}
	ws := skillsWalkState(t, loop, "", manifest) // no RepoDir => git_setup never ran

	_, _, err := lifecycleSkillsSetup(context.Background(), ws, skillsStep())
	if err == nil || !strings.Contains(err.Error(), "git_setup") {
		t.Errorf("want an error naming git_setup, got: %v", err)
	}
}

func TestKindSkillsSetup_CleanupRemovesMaterializedSkills(t *testing.T) {
	// Skills must never survive into a commit, a PR, or the next card. The
	// wrapped cleanup is what guarantees that, and it must still run the
	// original git cleanup it wrapped.
	srv, _ := skillsServer(t)
	loop := newLoopForKindTest(t, srv.URL)
	loop.provider = llm.NewClaudeCLI()
	repoDir := initGitRepo(t)

	manifest := []valaris.AssignmentSkill{{Slug: "house-style", Version: 2, ContentHash: "hash-k"}}
	ws := skillsWalkState(t, loop, repoDir, manifest)

	originalRan := false
	ws.Set("git_cleanup", func() { originalRan = true })

	if _, _, err := lifecycleSkillsSetup(context.Background(), ws, skillsStep()); err != nil {
		t.Fatalf("skills_setup: %v", err)
	}
	skillsRoot := filepath.Join(repoDir, ".claude", "skills")
	if _, err := os.Stat(skillsRoot); err != nil {
		t.Fatalf("skills were not materialized: %v", err)
	}

	wrapped, ok := ws.Get("git_cleanup")
	if !ok {
		t.Fatal("git_cleanup missing from the walk scratchpad")
	}
	cleanup, ok := wrapped.(func())
	if !ok {
		t.Fatalf("git_cleanup = %T, want func()", wrapped)
	}
	cleanup()

	if !originalRan {
		t.Error("wrapped cleanup did not run the original git cleanup")
	}
	if _, err := os.Stat(skillsRoot); !os.IsNotExist(err) {
		t.Errorf("materialized skills root still present after cleanup (err=%v)", err)
	}
}

// TestReworkClaim_StampsMaterializedSkills proves the manifest actually
// reaches the execution row from a real pipeline call site, not just from the
// client method in isolation.
func TestReworkClaim_StampsMaterializedSkills(t *testing.T) {
	srv, getBody := roleCapturingExecutionServer(t)
	loop := newLoopForKindTest(t, srv.URL)

	card := &discoverResult{
		CardID: "card-s1", BoardID: "board-1", Title: "Rework",
		Skills: []valaris.AssignmentSkill{
			{Slug: "house-style", Name: "House Style", Version: 3, ContentHash: "abc123"},
		},
	}
	if _, err := loop.reworkClaim(context.Background(), card, "implementer"); err != nil {
		t.Fatalf("reworkClaim: %v", err)
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(getBody()), &payload); err != nil {
		t.Fatalf("decode executions body: %v", err)
	}
	rows, ok := payload["skills"].([]any)
	if !ok || len(rows) != 1 {
		t.Fatalf("executions.skills = %v, want one row", payload["skills"])
	}
	row, _ := rows[0].(map[string]any)
	if row["slug"] != "house-style" {
		t.Errorf("executions.skills[0].slug = %v, want house-style", row["slug"])
	}
}

// gitCommitAll stages and commits everything in dir, so a test can assert
// against TRACKED files. Identity is set locally to keep the commit hermetic.
func gitCommitAll(t *testing.T, dir string) {
	t.Helper()
	for _, args := range [][]string{
		{"config", "user.email", "test@example.com"},
		{"config", "user.name", "Test"},
		{"add", "-A"},
		{"commit", "-m", "fixture", "--allow-empty"},
	} {
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v (%s)", args, err, out)
		}
	}
}

// gitStatusPorcelain returns the trimmed `git status --porcelain` output, so a
// test can assert the working tree was left untouched.
func gitStatusPorcelain(t *testing.T, dir string) string {
	t.Helper()
	cmd := exec.Command("git", "status", "--porcelain")
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git status: %v (%s)", err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestKindSkillsSetup_CleanupSparesTrackedSiblings(t *testing.T) {
	// The cleanup must remove exactly what Materialize created. A blanket
	// RemoveAll of the skills root deletes tracked project files it never
	// created, and a commit between cleanup and the next reset ships that
	// deletion into the customer's PR.
	srv, _ := skillsServer(t)
	loop := newLoopForKindTest(t, srv.URL)
	loop.provider = llm.NewClaudeCLI()
	repoDir := initGitRepo(t)

	// A tracked project skill that shares the skills root but NOT the slug.
	tracked := filepath.Join(repoDir, ".claude", "skills", "projskill", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(tracked), 0o755); err != nil {
		t.Fatal(err)
	}
	const projectContent = "PROJECT SKILL — not ours to delete\n"
	if err := os.WriteFile(tracked, []byte(projectContent), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCommitAll(t, repoDir)

	manifest := []valaris.AssignmentSkill{{Slug: "house-style", Version: 2, ContentHash: "hash-k"}}
	ws := skillsWalkState(t, loop, repoDir, manifest)
	if _, _, err := lifecycleSkillsSetup(context.Background(), ws, skillsStep()); err != nil {
		t.Fatalf("skills_setup: %v", err)
	}

	wrapped, _ := ws.Get("git_cleanup")
	cleanup, ok := wrapped.(func())
	if !ok {
		t.Fatalf("git_cleanup = %T, want func()", wrapped)
	}
	cleanup()

	got, err := os.ReadFile(tracked)
	if err != nil {
		t.Fatalf("cleanup deleted a tracked sibling: %v", err)
	}
	if string(got) != projectContent {
		t.Errorf("tracked sibling = %q, want unchanged", got)
	}
	if _, err := os.Stat(filepath.Join(repoDir, ".claude", "skills", "house-style")); !os.IsNotExist(err) {
		t.Errorf("materialized skill dir survived cleanup (err=%v)", err)
	}
	if status := gitStatusPorcelain(t, repoDir); status != "" {
		t.Errorf("git status after cleanup = %q, want clean", status)
	}
}

func TestKindSkillsSetup_PrunesEmptySkillsRootOnCleanup(t *testing.T) {
	// When the runner created the whole skills root, cleanup should leave no
	// empty scaffolding behind.
	srv, _ := skillsServer(t)
	loop := newLoopForKindTest(t, srv.URL)
	loop.provider = llm.NewClaudeCLI()
	repoDir := initGitRepo(t)

	manifest := []valaris.AssignmentSkill{{Slug: "house-style", Version: 2, ContentHash: "hash-k"}}
	ws := skillsWalkState(t, loop, repoDir, manifest)
	if _, _, err := lifecycleSkillsSetup(context.Background(), ws, skillsStep()); err != nil {
		t.Fatalf("skills_setup: %v", err)
	}
	wrapped, _ := ws.Get("git_cleanup")
	wrapped.(func())()

	if _, err := os.Stat(filepath.Join(repoDir, ".claude")); !os.IsNotExist(err) {
		t.Errorf(".claude scaffolding survived cleanup (err=%v)", err)
	}
}

func TestKindSkillsSetup_ExcludesBeforeMaterializing(t *testing.T) {
	// Ordering matters: a crash between materialization and the exclude write
	// leaves skills visible to `git add -A`. Writing the exclude first closes
	// that window, so it must be present even when materialization fails.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		if strings.Contains(r.URL.Path, "/versions/") {
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"detail":"boom"}`))
			return
		}
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)

	loop := newLoopForKindTest(t, srv.URL)
	loop.provider = llm.NewClaudeCLI()
	repoDir := initGitRepo(t)

	// A hash no other test caches: a cache hit here would skip the fetch this
	// test needs to fail.
	manifest := []valaris.AssignmentSkill{{Slug: "house-style", Version: 2, ContentHash: "hash-exclude-order"}}
	ws := skillsWalkState(t, loop, repoDir, manifest)

	if _, _, err := lifecycleSkillsSetup(context.Background(), ws, skillsStep()); err == nil {
		t.Fatal("expected the failing fetch to fail the step")
	}

	content, err := os.ReadFile(filepath.Join(repoDir, ".git", "info", "exclude"))
	if err != nil {
		t.Fatalf("exclude was not written before materialization: %v", err)
	}
	if !strings.Contains(string(content), ".claude/skills/") {
		t.Errorf(".git/info/exclude = %q, want the skills entry written up front", content)
	}
}
