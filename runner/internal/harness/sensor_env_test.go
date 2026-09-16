// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package harness

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// The harness sensors spawn git directly — sensor_conflict.go runs `merge-tree`
// and `show`, sensor_pr_overlap.go runs `diff` — and each sets only cmd.Dir,
// leaving cmd.Env nil. A nil Env means the child inherits the runner's ambient
// environment, and GIT_DIR/GIT_WORK_TREE outrank cmd.Dir entirely. The git
// Manager hardens exactly this via subprocessEnv(); these three spawn sites sit
// outside that package and get none of it.
//
// A sensor reading the wrong repository is not a cosmetic bug: conflict-check
// is a preventive gate, so a hijacked verdict either blocks a clean branch or
// waves a genuinely conflicted one through to push.

// setupCleanMergeRepo builds a repo whose feature branch merges into main with
// no conflict: main is untouched after the branch point.
func setupCleanMergeRepo(t *testing.T, dir string) string {
	t.Helper()
	gitFixture(t, dir, false)
	return dir
}

// setupConflictedRepo builds a repo whose feature branch conflicts with main:
// both edit the same line of foo.txt.
func setupConflictedRepo(t *testing.T, dir string) string {
	t.Helper()
	gitFixture(t, dir, true)
	return dir
}

func gitFixture(t *testing.T, dir string, conflict bool) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	runCleanGit(t, dir, "init", "-b", "main")
	runCleanGit(t, dir, "config", "user.email", "test@valaris.dev")
	runCleanGit(t, dir, "config", "user.name", "Test")
	runCleanGit(t, dir, "config", "commit.gpgsign", "false")

	write("foo.txt", "line 1\nline 2\nline 3\n")
	runCleanGit(t, dir, "add", ".")
	runCleanGit(t, dir, "commit", "-m", "initial")

	runCleanGit(t, dir, "checkout", "-b", "feature")
	write("foo.txt", "line 1\nFEATURE EDIT\nline 3\n")
	runCleanGit(t, dir, "add", ".")
	runCleanGit(t, dir, "commit", "-m", "feature change")

	runCleanGit(t, dir, "checkout", "main")
	if conflict {
		write("foo.txt", "line 1\nMAIN EDIT\nline 3\n")
		runCleanGit(t, dir, "add", ".")
		runCleanGit(t, dir, "commit", "-m", "main change")
	}
	runCleanGit(t, dir, "checkout", "feature")
}

// runCleanGit drives fixture setup with the hijackable discovery vars cleared.
// These tests set ambient GIT_DIR on purpose; if the fixture builder inherited
// it, setup would commit into the wrong repo and the assertions would be
// measuring their own scaffolding rather than the sensor.
func runCleanGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	env := os.Environ()
	cleaned := env[:0]
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		switch key {
		case "GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_CEILING_DIRECTORIES":
			continue
		}
		cleaned = append(cleaned, entry)
	}
	cmd.Env = cleaned
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v in %s: %v\n%s", args, dir, err, out)
	}
}

// Acceptance: two real repos, one clean and one conflicted, and a real ambient
// redirect. The sensor is pointed at the clean repo via WorkingDir, so the only
// honest verdict is "no conflicts". Ambient GIT_DIR/GIT_WORK_TREE pointing at
// the conflicted repo make `git merge-tree` read that one instead and exit 1,
// so the sensor reports a conflict in a file the target branch merges cleanly.
//
// Non-vacuous by construction: with the env scrubbed, merge-tree in the clean
// repo exits 0 and the sensor passes. Only the leak flips it.
func TestConflictCheckSensor_AmbientGitDirCannotRedirectTheMergeCheck(t *testing.T) {
	base := t.TempDir()
	clean := setupCleanMergeRepo(t, filepath.Join(base, "clean"))
	conflicted := setupConflictedRepo(t, filepath.Join(base, "conflicted"))

	t.Setenv("GIT_DIR", filepath.Join(conflicted, ".git"))
	t.Setenv("GIT_WORK_TREE", conflicted)

	sensor, err := NewConflictCheckSensor(map[string]any{"default_branch": "main"})
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}

	result, err := sensor.Evaluate(context.Background(), SensorInput{WorkingDir: clean})
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}

	if !result.Passed {
		t.Fatalf("conflict-check reported a conflict in a cleanly-merging repo: "+
			"ambient GIT_DIR/GIT_WORK_TREE outranked cmd.Dir, so `git merge-tree` "+
			"evaluated %s instead of %s. findings=%+v summary=%q",
			conflicted, clean, result.Findings, result.Summary)
	}
	if len(result.Findings) != 0 {
		t.Fatalf("findings len = %d, want 0 — these describe the ambient repo, not the "+
			"target: %+v", len(result.Findings), result.Findings)
	}
}

// The inverse, and the one that actually ships broken code. A genuinely
// conflicted branch must still be caught when the ambient env points at a clean
// repo — otherwise the preventive gate passes and the conflict is discovered
// reactively, after push, which is the exact cost this sensor exists to avoid.
func TestConflictCheckSensor_AmbientGitDirCannotMaskARealConflict(t *testing.T) {
	base := t.TempDir()
	clean := setupCleanMergeRepo(t, filepath.Join(base, "clean"))
	conflicted := setupConflictedRepo(t, filepath.Join(base, "conflicted"))

	t.Setenv("GIT_DIR", filepath.Join(clean, ".git"))
	t.Setenv("GIT_WORK_TREE", clean)

	sensor, err := NewConflictCheckSensor(map[string]any{"default_branch": "main"})
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}

	result, err := sensor.Evaluate(context.Background(), SensorInput{WorkingDir: conflicted})
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}

	if result.Passed {
		t.Fatalf("conflict-check passed a branch that really conflicts with main: "+
			"ambient GIT_DIR pointed `git merge-tree` at the clean repo %s instead of "+
			"the target %s, so the pre-push gate waved a conflicted branch through. "+
			"summary=%q", clean, conflicted, result.Summary)
	}
}

// countConflictRegions is the sensor's second spawn site (`git show`), reached
// only on the conflict path. It takes an explicit dir and is subject to the same
// override, so the region count in a Finding can be read out of the ambient
// repo. A count of zero on a file with a real conflict is the tell: the tree OID
// resolved by merge-tree does not exist in the hijacked repository.
func TestConflictCheckSensor_AmbientGitDirCannotCorruptRegionCounts(t *testing.T) {
	base := t.TempDir()
	conflicted := setupConflictedRepo(t, filepath.Join(base, "conflicted"))
	other := setupCleanMergeRepo(t, filepath.Join(base, "other"))

	sensor, err := NewConflictCheckSensor(map[string]any{"default_branch": "main"})
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}

	// Baseline with a clean environment establishes the honest region count, so
	// the assertion below compares against observed truth rather than a guess.
	baseline, err := sensor.Evaluate(context.Background(), SensorInput{WorkingDir: conflicted})
	if err != nil {
		t.Fatalf("baseline evaluate: %v", err)
	}
	if len(baseline.Findings) != 1 {
		t.Fatalf("baseline findings len = %d, want 1: %+v", len(baseline.Findings), baseline.Findings)
	}
	wantMessage := baseline.Findings[0].Message

	t.Setenv("GIT_DIR", filepath.Join(other, ".git"))
	t.Setenv("GIT_WORK_TREE", other)

	result, err := sensor.Evaluate(context.Background(), SensorInput{WorkingDir: conflicted})
	if err != nil {
		t.Fatalf("evaluate under ambient env: %v", err)
	}
	if len(result.Findings) != 1 {
		t.Fatalf("findings len = %d, want 1 — the ambient env changed which repo "+
			"merge-tree read: %+v", len(result.Findings), result.Findings)
	}
	if result.Findings[0].Message != wantMessage {
		t.Fatalf("region count changed under an ambient GIT_DIR: got %q, want %q. "+
			"`git show` in countConflictRegions inherited the ambient repo, where the "+
			"merge-tree OID does not resolve, so the count silently degraded to 0.",
			result.Findings[0].Message, wantMessage)
	}
}

// pr-overlap's diffFilesAgainst runs `git diff --name-only main...HEAD` with the
// same nil Env. The file list it produces is what gets intersected against open
// PRs, so an ambient redirect makes the sensor report overlap for files the
// branch under test never touched — and miss the ones it did.
func TestPROverlapSensor_AmbientGitDirCannotRedirectTheDiff(t *testing.T) {
	base := t.TempDir()

	target := setupPROverlapRepo(t, filepath.Join(base, "target"), "target-only.txt")
	ambient := setupPROverlapRepo(t, filepath.Join(base, "ambient"), "ambient-only.txt")

	t.Setenv("GIT_DIR", filepath.Join(ambient, ".git"))
	t.Setenv("GIT_WORK_TREE", ambient)

	// The open PR touches both files, so the finding set is decided purely by
	// which repo the diff was read from.
	lister := &fakePRLister{prs: []PullRequestInfo{{
		Number:      7,
		HeadRefName: "other/branch",
		Files:       []string{"target-only.txt", "ambient-only.txt"},
	}}}

	sensor := newPROverlapSensor(t, map[string]any{
		"repo_slug":      "valaris/example",
		"default_branch": "main",
	}, lister)

	result, err := sensor.Evaluate(context.Background(), SensorInput{WorkingDir: target})
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}

	var files []string
	for _, f := range result.Findings {
		files = append(files, f.File)
	}
	for _, f := range files {
		if f == "ambient-only.txt" {
			t.Fatalf("pr-overlap reported overlap on %q, a file the target branch never "+
				"touches: ambient GIT_DIR/GIT_WORK_TREE outranked cmd.Dir so `git diff` "+
				"read %s instead of %s. findings=%v", f, ambient, target, files)
		}
	}
	if len(files) != 1 || files[0] != "target-only.txt" {
		t.Fatalf("overlap files = %v, want exactly [target-only.txt] from the repo the "+
			"sensor was pointed at", files)
	}
}

// setupPROverlapRepo builds a repo on branch `feature` whose diff against main
// touches exactly one named file.
func setupPROverlapRepo(t *testing.T, dir, branchFile string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	runCleanGit(t, dir, "init", "-b", "main")
	runCleanGit(t, dir, "config", "user.email", "test@valaris.dev")
	runCleanGit(t, dir, "config", "user.name", "Test")
	runCleanGit(t, dir, "config", "commit.gpgsign", "false")

	write("README.md", "initial\n")
	runCleanGit(t, dir, "add", ".")
	runCleanGit(t, dir, "commit", "-m", "initial")

	runCleanGit(t, dir, "checkout", "-b", "feature")
	write(branchFile, "feature edit to "+branchFile+"\n")
	runCleanGit(t, dir, "add", ".")
	runCleanGit(t, dir, "commit", "-m", "feature change")

	return dir
}
