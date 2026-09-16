// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// fakeSkillFetcher counts fetches so cache-hit assertions can prove the
// materializer went to the network exactly once per content hash.
type fakeSkillFetcher struct {
	files map[string]*valaris.SkillVersionFiles // keyed by skill slug
	err   error

	// mu guards fetchN: the concurrency test calls this fake from several
	// goroutines at once.
	mu     sync.Mutex
	fetchN map[string]int
}

func (f *fakeSkillFetcher) FetchSkillVersionFiles(
	_ context.Context, _, skillSlug string, _ int,
) (*valaris.SkillVersionFiles, error) {
	f.mu.Lock()
	if f.fetchN == nil {
		f.fetchN = map[string]int{}
	}
	f.fetchN[skillSlug]++
	f.mu.Unlock()

	if f.err != nil {
		return nil, f.err
	}
	v, ok := f.files[skillSlug]
	if !ok {
		return nil, os.ErrNotExist
	}
	return v, nil
}

// fetchCount reports how many times slug was fetched, safely.
func (f *fakeSkillFetcher) fetchCount(slug string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.fetchN[slug]
}

func newTestMaterializer(t *testing.T, fetcher skillFetcher) *skillsMaterializer {
	t.Helper()
	return &skillsMaterializer{
		fetcher:  fetcher,
		cacheDir: filepath.Join(t.TempDir(), "skills-cache"),
	}
}

func TestMaterializeSkills_WritesFilesUnderSkillDir(t *testing.T) {
	fetcher := &fakeSkillFetcher{files: map[string]*valaris.SkillVersionFiles{
		"house-style": {
			Version:     3,
			ContentHash: "hash-a",
			Files: []valaris.SkillFile{
				{Path: "SKILL.md", Content: "# House Style\n"},
				{Path: "references/naming.md", Content: "semantic names\n"},
			},
		},
	}}
	m := newTestMaterializer(t, fetcher)
	destRoot := t.TempDir()

	manifest := []valaris.AssignmentSkill{
		{Slug: "house-style", Name: "House Style", Version: 3, ContentHash: "hash-a"},
	}
	dirs, err := m.Materialize(context.Background(), "default", manifest, destRoot, ".claude/skills")
	if err != nil {
		t.Fatalf("Materialize: %v", err)
	}

	if len(dirs) != 1 || dirs[0] != ".claude/skills/house-style" {
		t.Fatalf("materialized dirs = %v, want [.claude/skills/house-style]", dirs)
	}
	skillMD := filepath.Join(destRoot, ".claude/skills/house-style/SKILL.md")
	got, err := os.ReadFile(skillMD)
	if err != nil {
		t.Fatalf("reading materialized SKILL.md: %v", err)
	}
	if string(got) != "# House Style\n" {
		t.Errorf("SKILL.md = %q, want the verbatim published content", got)
	}
	nested, err := os.ReadFile(filepath.Join(destRoot, ".claude/skills/house-style/references/naming.md"))
	if err != nil {
		t.Fatalf("reading nested reference file: %v", err)
	}
	if string(nested) != "semantic names\n" {
		t.Errorf("nested file = %q, want verbatim content", nested)
	}
}

func TestMaterializeSkills_CacheHitSkipsSecondFetch(t *testing.T) {
	fetcher := &fakeSkillFetcher{files: map[string]*valaris.SkillVersionFiles{
		"house-style": {
			Version:     3,
			ContentHash: "hash-a",
			Files:       []valaris.SkillFile{{Path: "SKILL.md", Content: "# House Style\n"}},
		},
	}}
	m := newTestMaterializer(t, fetcher)
	manifest := []valaris.AssignmentSkill{
		{Slug: "house-style", Version: 3, ContentHash: "hash-a"},
	}

	// Two different destinations, same content hash: the cache must serve the
	// second one without a network round-trip.
	for _, dest := range []string{t.TempDir(), t.TempDir()} {
		if _, err := m.Materialize(context.Background(), "default", manifest, dest, ".claude/skills"); err != nil {
			t.Fatalf("Materialize into %s: %v", dest, err)
		}
	}
	if n := fetcher.fetchCount("house-style"); n != 1 {
		t.Errorf("fetch count = %d, want 1 (second call must hit the content-hash cache)", n)
	}
}

func TestMaterializeSkills_IdempotentRerun(t *testing.T) {
	fetcher := &fakeSkillFetcher{files: map[string]*valaris.SkillVersionFiles{
		"tdd": {Version: 1, ContentHash: "hash-t", Files: []valaris.SkillFile{
			{Path: "SKILL.md", Content: "# TDD\n"},
		}},
	}}
	m := newTestMaterializer(t, fetcher)
	destRoot := t.TempDir()
	manifest := []valaris.AssignmentSkill{{Slug: "tdd", Version: 1, ContentHash: "hash-t"}}

	first, err := m.Materialize(context.Background(), "default", manifest, destRoot, ".codex/skills")
	if err != nil {
		t.Fatalf("first Materialize: %v", err)
	}
	second, err := m.Materialize(context.Background(), "default", manifest, destRoot, ".codex/skills")
	if err != nil {
		t.Fatalf("second Materialize: %v", err)
	}
	if len(first) != len(second) || first[0] != second[0] {
		t.Errorf("re-run returned %v, want the same dirs as %v", second, first)
	}
	got, err := os.ReadFile(filepath.Join(destRoot, ".codex/skills/tdd/SKILL.md"))
	if err != nil {
		t.Fatalf("reading after re-run: %v", err)
	}
	if string(got) != "# TDD\n" {
		t.Errorf("content after re-run = %q, want unchanged", got)
	}
}

func TestMaterializeSkills_RejectsEscapingPath(t *testing.T) {
	// Defense in depth: the backend validates paths, but a traversal entry
	// reaching the runner must never write outside the skill's own directory.
	fetcher := &fakeSkillFetcher{files: map[string]*valaris.SkillVersionFiles{
		"evil": {Version: 1, ContentHash: "hash-e", Files: []valaris.SkillFile{
			{Path: "../../escaped.md", Content: "pwned\n"},
		}},
	}}
	m := newTestMaterializer(t, fetcher)
	destRoot := t.TempDir()
	manifest := []valaris.AssignmentSkill{{Slug: "evil", Version: 1, ContentHash: "hash-e"}}

	_, err := m.Materialize(context.Background(), "default", manifest, destRoot, ".claude/skills")
	if err == nil {
		t.Fatal("Materialize accepted a path escaping the skill dir, want an error")
	}
	if !strings.Contains(err.Error(), "escapes") {
		t.Errorf("error = %v, want it to name the escape", err)
	}
	if _, statErr := os.Stat(filepath.Join(destRoot, "escaped.md")); statErr == nil {
		t.Error("traversal entry was written outside the skill dir")
	}
}

func TestMaterializeSkills_EmptyManifestIsNoOp(t *testing.T) {
	fetcher := &fakeSkillFetcher{files: map[string]*valaris.SkillVersionFiles{}}
	m := newTestMaterializer(t, fetcher)
	destRoot := t.TempDir()

	dirs, err := m.Materialize(context.Background(), "default", nil, destRoot, ".claude/skills")
	if err != nil {
		t.Fatalf("Materialize on empty manifest: %v", err)
	}
	if len(dirs) != 0 {
		t.Errorf("dirs = %v, want none", dirs)
	}
	if len(fetcher.fetchN) != 0 {
		t.Errorf("fetch count = %v, want no network calls", fetcher.fetchN)
	}
	if _, err := os.Stat(filepath.Join(destRoot, ".claude")); err == nil {
		t.Error("empty manifest created a skills root, want no filesystem change")
	}
}

func TestMaterializeSkills_RefusesSkillOverTrackedFiles(t *testing.T) {
	// Backplane's own repo TRACKS .claude/. Overwriting a tracked project file
	// would ride into the customer's PR via the implementer's `git add -A`,
	// and .git/info/exclude never applies to tracked paths. A card without its
	// skills beats a corrupted PR, so this must fail the step loudly.
	fetcher := &fakeSkillFetcher{files: map[string]*valaris.SkillVersionFiles{
		"projskill": {Version: 1, ContentHash: "hash-p", Files: []valaris.SkillFile{
			{Path: "SKILL.md", Content: "WORKSPACE VERSION\n"},
		}},
	}}
	m := newTestMaterializer(t, fetcher)

	repoDir := initGitRepo(t)
	trackedFile := filepath.Join(repoDir, ".claude", "skills", "projskill", "SKILL.md")
	if err := os.MkdirAll(filepath.Dir(trackedFile), 0o755); err != nil {
		t.Fatal(err)
	}
	const projectContent = "PROJECT VERSION — must survive\n"
	if err := os.WriteFile(trackedFile, []byte(projectContent), 0o644); err != nil {
		t.Fatal(err)
	}
	gitCommitAll(t, repoDir)

	manifest := []valaris.AssignmentSkill{{Slug: "projskill", Version: 1, ContentHash: "hash-p"}}
	_, err := m.Materialize(context.Background(), "default", manifest, repoDir, ".claude/skills")
	if err == nil {
		t.Fatal("Materialize overwrote a tracked skill dir, want a refusal")
	}
	if !strings.Contains(err.Error(), "tracked") {
		t.Errorf("error = %v, want it to name the tracked-file conflict", err)
	}

	got, readErr := os.ReadFile(trackedFile)
	if readErr != nil {
		t.Fatalf("tracked file disappeared: %v", readErr)
	}
	if string(got) != projectContent {
		t.Errorf("tracked file = %q, want it byte-identical at %q", got, projectContent)
	}
	if status := gitStatusPorcelain(t, repoDir); status != "" {
		t.Errorf("git status = %q, want clean", status)
	}
}

func TestMaterializeSkills_AllowsUntrackedDestination(t *testing.T) {
	// The common case: the repo does not track .claude/skills at all. A
	// leftover untracked dir from a prior run must not be mistaken for tracked.
	fetcher := &fakeSkillFetcher{files: map[string]*valaris.SkillVersionFiles{
		"fresh": {Version: 1, ContentHash: "hash-f", Files: []valaris.SkillFile{
			{Path: "SKILL.md", Content: "# Fresh\n"},
		}},
	}}
	m := newTestMaterializer(t, fetcher)
	repoDir := initGitRepo(t)
	gitCommitAll(t, repoDir) // a repo with a commit but nothing under .claude

	stale := filepath.Join(repoDir, ".claude", "skills", "fresh")
	if err := os.MkdirAll(stale, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stale, "old.md"), []byte("stale\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	manifest := []valaris.AssignmentSkill{{Slug: "fresh", Version: 1, ContentHash: "hash-f"}}
	if _, err := m.Materialize(context.Background(), "default", manifest, repoDir, ".claude/skills"); err != nil {
		t.Fatalf("Materialize into an untracked dir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(stale, "old.md")); !os.IsNotExist(err) {
		t.Error("stale untracked file survived, want the dir replaced")
	}
}

func TestMaterializeSkills_RejectsEscapingSlug(t *testing.T) {
	// The backend's slug regex makes this unreachable today, but a hostile
	// slug would escape BOTH the repo and the cache root.
	fetcher := &fakeSkillFetcher{files: map[string]*valaris.SkillVersionFiles{}}
	m := newTestMaterializer(t, fetcher)
	destRoot := t.TempDir()

	for _, slug := range []string{"../../../evil", "nested/slug", "..", ".", "", "/abs"} {
		manifest := []valaris.AssignmentSkill{{Slug: slug, Version: 1, ContentHash: "hash-x"}}
		_, err := m.Materialize(context.Background(), "default", manifest, destRoot, ".claude/skills")
		if err == nil {
			t.Errorf("Materialize accepted slug %q, want a refusal", slug)
			continue
		}
		if !strings.Contains(err.Error(), "slug") {
			t.Errorf("slug %q: error = %v, want it to name the slug", slug, err)
		}
		if len(fetcher.fetchN) != 0 {
			t.Errorf("slug %q: fetched before validating, want nothing written", slug)
		}
	}
	if _, err := os.Stat(filepath.Join(destRoot, ".claude")); err == nil {
		t.Error("an escaping slug created a skills dir")
	}
}

func TestMaterializeSkills_RejectsContentHashMismatch(t *testing.T) {
	// The manifest's hash is the cache key; if the fetched version disagrees,
	// caching it would poison every later card that trusts that key.
	fetcher := &fakeSkillFetcher{files: map[string]*valaris.SkillVersionFiles{
		"drift": {Version: 1, ContentHash: "SERVED-DIFFERENT", Files: []valaris.SkillFile{
			{Path: "SKILL.md", Content: "# Drift\n"},
		}},
	}}
	m := newTestMaterializer(t, fetcher)
	destRoot := t.TempDir()

	manifest := []valaris.AssignmentSkill{{Slug: "drift", Version: 1, ContentHash: "EXPECTED"}}
	_, err := m.Materialize(context.Background(), "default", manifest, destRoot, ".claude/skills")
	if err == nil {
		t.Fatal("Materialize accepted a content-hash mismatch, want a refusal")
	}
	if !strings.Contains(err.Error(), "content hash") {
		t.Errorf("error = %v, want it to name the content-hash mismatch", err)
	}
	if _, statErr := os.Stat(filepath.Join(m.cacheDir, "EXPECTED")); statErr == nil {
		t.Error("mismatched version was cached under the expected key")
	}
	if _, statErr := os.Stat(filepath.Join(destRoot, ".claude")); statErr == nil {
		t.Error("mismatched version was materialized")
	}
}

func TestMaterializeSkills_ToleratesAbsentServedHash(t *testing.T) {
	// Only compare when BOTH sides carry a hash — an older backend that omits
	// it on the version payload must still work.
	fetcher := &fakeSkillFetcher{files: map[string]*valaris.SkillVersionFiles{
		"nohash": {Version: 1, Files: []valaris.SkillFile{{Path: "SKILL.md", Content: "# No hash\n"}}},
	}}
	m := newTestMaterializer(t, fetcher)
	destRoot := t.TempDir()

	manifest := []valaris.AssignmentSkill{{Slug: "nohash", Version: 1, ContentHash: "hash-n"}}
	if _, err := m.Materialize(context.Background(), "default", manifest, destRoot, ".claude/skills"); err != nil {
		t.Fatalf("Materialize with an absent served hash: %v", err)
	}
}

func TestEnsureCached_PublishesAtomicallyOnRename(t *testing.T) {
	// A half-written entry must never be visible under the final path: another
	// runner may be copying from it concurrently. Writing to a temp dir and
	// renaming is what makes the entry appear all-at-once.
	fetcher := &fakeSkillFetcher{files: map[string]*valaris.SkillVersionFiles{
		"atomic": {Version: 1, ContentHash: "hash-a", Files: []valaris.SkillFile{
			{Path: "SKILL.md", Content: "# Atomic\n"},
			{Path: "refs/one.md", Content: "one\n"},
		}},
	}}
	m := newTestMaterializer(t, fetcher)

	entry, err := m.ensureCached(context.Background(), "default",
		valaris.AssignmentSkill{Slug: "atomic", Version: 1, ContentHash: "hash-a"})
	if err != nil {
		t.Fatalf("ensureCached: %v", err)
	}
	// A published entry is complete by construction: marker + every file.
	if _, err := os.Stat(filepath.Join(entry, cacheCompleteMarker)); err != nil {
		t.Errorf("published entry has no completion marker: %v", err)
	}
	if _, err := os.Stat(filepath.Join(entry, "refs", "one.md")); err != nil {
		t.Errorf("published entry is missing a file: %v", err)
	}
	// No temp scaffolding may survive next to the published entry.
	siblings, _ := os.ReadDir(filepath.Dir(entry))
	for _, s := range siblings {
		if strings.Contains(s.Name(), "tmp") {
			t.Errorf("temp staging dir %q survived publication", s.Name())
		}
	}
}

func TestEnsureCached_ConcurrentPublishIsSafe(t *testing.T) {
	// Two goroutines racing the same cold entry must both end up with a valid
	// tree and no error — the loser of the rename treats it as a cache hit.
	fetcher := &fakeSkillFetcher{files: map[string]*valaris.SkillVersionFiles{
		"race": {Version: 1, ContentHash: "hash-r", Files: []valaris.SkillFile{
			{Path: "SKILL.md", Content: "# Race\n"},
		}},
	}}
	m := newTestMaterializer(t, fetcher)
	skill := valaris.AssignmentSkill{Slug: "race", Version: 1, ContentHash: "hash-r"}

	var wg sync.WaitGroup
	errs := make([]error, 4)
	paths := make([]string, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			paths[i], errs[i] = m.ensureCached(context.Background(), "default", skill)
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Errorf("goroutine %d: ensureCached: %v", i, err)
			continue
		}
		got, readErr := os.ReadFile(filepath.Join(paths[i], "SKILL.md"))
		if readErr != nil {
			t.Errorf("goroutine %d: entry unreadable: %v", i, readErr)
			continue
		}
		if string(got) != "# Race\n" {
			t.Errorf("goroutine %d: SKILL.md = %q, want the published content", i, got)
		}
	}
}

// TestMain redirects the skills cache for the whole package so no test reads
// or writes the developer's real ~/.backplane-runner/skills-cache. Without
// this, one test's cache entry satisfies another test's fetch and hides the
// behavior under test.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "skills-cache-test-")
	if err != nil {
		panic(err)
	}
	skillsCacheDirOverride = dir
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}
