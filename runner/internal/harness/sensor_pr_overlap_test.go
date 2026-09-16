// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package harness

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// fakePRLister is an in-memory PRListFetcher for tests.
// It records the repoSlug it was called with so tests can assert wiring.
type fakePRLister struct {
	prs          []PullRequestInfo
	err          error
	lastRepoDir  string
	lastRepoSlug string
	calls        int
}

func (f *fakePRLister) FetchOpenPRs(_ context.Context, repoDir, repoSlug string) ([]PullRequestInfo, error) {
	f.calls++
	f.lastRepoDir = repoDir
	f.lastRepoSlug = repoSlug
	return f.prs, f.err
}

// setupPROverlapFixture creates a git repo on branch `feature` whose diff
// against main touches the given files.
func setupPROverlapFixture(t *testing.T, branchFiles []string) string {
	t.Helper()
	dir := t.TempDir()

	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
	}
	write := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}

	run("init", "-b", "main")
	run("config", "user.email", "test@valaris.dev")
	run("config", "user.name", "Test")
	run("config", "commit.gpgsign", "false")

	write("README.md", "initial\n")
	run("add", ".")
	run("commit", "-m", "initial")

	run("checkout", "-b", "feature")
	for _, name := range branchFiles {
		write(name, "feature edit to "+name+"\n")
	}
	run("add", ".")
	run("commit", "-m", "feature change")

	return dir
}

func newPROverlapSensor(t *testing.T, config map[string]any, lister PRListFetcher) Sensor {
	t.Helper()
	// Swap the package-level factory for this test. t.Cleanup restores the
	// default ghPRLister so parallel tests don't bleed.
	orig := prListerFactory
	prListerFactory = func() PRListFetcher { return lister }
	t.Cleanup(func() { prListerFactory = orig })

	s, err := NewPROverlapSensor(config)
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}
	return s
}

func TestPROverlapSensor_NoOpenPRs_NoFindings(t *testing.T) {
	dir := setupPROverlapFixture(t, []string{"feature.txt"})
	lister := &fakePRLister{prs: nil}

	sensor := newPROverlapSensor(t, map[string]any{
		"repo_slug":      "valaris/example",
		"default_branch": "main",
	}, lister)

	result, err := sensor.Evaluate(context.Background(), SensorInput{WorkingDir: dir})
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if !result.Passed {
		t.Error("Passed = false, want true (informational sensor always passes)")
	}
	if len(result.Findings) != 0 {
		t.Errorf("findings len = %d, want 0", len(result.Findings))
	}
	if lister.lastRepoSlug != "valaris/example" {
		t.Errorf("repo_slug forwarded = %q, want valaris/example", lister.lastRepoSlug)
	}
}

func TestPROverlapSensor_NoOverlap(t *testing.T) {
	dir := setupPROverlapFixture(t, []string{"feature.txt"})
	lister := &fakePRLister{
		prs: []PullRequestInfo{
			{Number: 12, HeadRefName: "other", Files: []string{"unrelated.go"}},
		},
	}

	sensor := newPROverlapSensor(t, map[string]any{
		"repo_slug":      "valaris/example",
		"default_branch": "main",
	}, lister)

	result, err := sensor.Evaluate(context.Background(), SensorInput{WorkingDir: dir})
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if !result.Passed {
		t.Error("Passed = false, want true")
	}
	if len(result.Findings) != 0 {
		t.Errorf("findings len = %d, want 0: %+v", len(result.Findings), result.Findings)
	}
}

func TestPROverlapSensor_SingleOverlap(t *testing.T) {
	dir := setupPROverlapFixture(t, []string{"shared.go", "feature.txt"})
	lister := &fakePRLister{
		prs: []PullRequestInfo{
			{Number: 42, HeadRefName: "other-branch", Files: []string{"shared.go", "misc.md"}},
		},
	}

	sensor := newPROverlapSensor(t, map[string]any{
		"repo_slug":      "valaris/example",
		"default_branch": "main",
	}, lister)

	result, err := sensor.Evaluate(context.Background(), SensorInput{WorkingDir: dir})
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if !result.Passed {
		t.Error("Passed = false, want true (informational)")
	}
	if len(result.Findings) != 1 {
		t.Fatalf("findings len = %d, want 1: %+v", len(result.Findings), result.Findings)
	}
	f := result.Findings[0]
	if f.File != "shared.go" {
		t.Errorf("finding.File = %q, want shared.go", f.File)
	}
	if !strings.Contains(f.Message, "42") {
		t.Errorf("finding.Message = %q, should reference PR 42", f.Message)
	}
	if !strings.Contains(f.Message, "other-branch") {
		t.Errorf("finding.Message = %q, should reference branch", f.Message)
	}
}

func TestPROverlapSensor_MultipleOverlappingPRs(t *testing.T) {
	dir := setupPROverlapFixture(t, []string{"shared.go"})
	lister := &fakePRLister{
		prs: []PullRequestInfo{
			{Number: 1, HeadRefName: "pr-a", Files: []string{"shared.go"}},
			{Number: 2, HeadRefName: "pr-b", Files: []string{"shared.go"}},
		},
	}

	sensor := newPROverlapSensor(t, map[string]any{
		"repo_slug":      "valaris/example",
		"default_branch": "main",
	}, lister)

	result, err := sensor.Evaluate(context.Background(), SensorInput{WorkingDir: dir})
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if len(result.Findings) != 2 {
		t.Fatalf("findings len = %d, want 2: %+v", len(result.Findings), result.Findings)
	}
	prNums := map[string]bool{}
	for _, f := range result.Findings {
		if !strings.Contains(f.Message, "shared.go") && f.File != "shared.go" {
			t.Errorf("finding should reference shared.go: %+v", f)
		}
		if strings.Contains(f.Message, "#1") || strings.Contains(f.Message, "PR 1") {
			prNums["1"] = true
		}
		if strings.Contains(f.Message, "#2") || strings.Contains(f.Message, "PR 2") {
			prNums["2"] = true
		}
	}
	if !prNums["1"] || !prNums["2"] {
		t.Errorf("expected findings referencing both PRs 1 and 2, got %v (findings=%+v)", prNums, result.Findings)
	}
}

func TestPROverlapSensor_IgnorePRNumber(t *testing.T) {
	dir := setupPROverlapFixture(t, []string{"shared.go"})
	lister := &fakePRLister{
		prs: []PullRequestInfo{
			{Number: 100, HeadRefName: "self", Files: []string{"shared.go"}},
			{Number: 200, HeadRefName: "other", Files: []string{"shared.go"}},
		},
	}

	sensor := newPROverlapSensor(t, map[string]any{
		"repo_slug":         "valaris/example",
		"default_branch":    "main",
		"ignore_pr_number":  100,
	}, lister)

	result, err := sensor.Evaluate(context.Background(), SensorInput{WorkingDir: dir})
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if len(result.Findings) != 1 {
		t.Fatalf("findings len = %d, want 1 (PR 100 ignored): %+v", len(result.Findings), result.Findings)
	}
	if strings.Contains(result.Findings[0].Message, "100") {
		t.Errorf("finding should not reference ignored PR 100: %q", result.Findings[0].Message)
	}
}

func TestPROverlapSensor_Manifest(t *testing.T) {
	m := PROverlapManifest()
	if m.Name != "pr-overlap" {
		t.Errorf("name = %q, want pr-overlap", m.Name)
	}
	if m.Kind != SensorKindInferential {
		t.Errorf("kind = %q, want %q", m.Kind, SensorKindInferential)
	}
	if m.Description == "" {
		t.Error("description should be set")
	}
	if m.DefaultConfig["timeout"] != "30s" {
		t.Errorf("timeout = %v, want 30s", m.DefaultConfig["timeout"])
	}
}

func TestPROverlapSensor_FetcherError_Returned(t *testing.T) {
	dir := setupPROverlapFixture(t, []string{"shared.go"})
	lister := &fakePRLister{err: errors.New("gh auth failed")}

	sensor := newPROverlapSensor(t, map[string]any{
		"repo_slug":      "valaris/example",
		"default_branch": "main",
	}, lister)

	_, err := sensor.Evaluate(context.Background(), SensorInput{WorkingDir: dir})
	if err == nil {
		t.Fatal("expected fetcher error to surface, got nil")
	}
}

func TestPROverlapSensor_NameAndKind(t *testing.T) {
	s, err := NewPROverlapSensor(map[string]any{"repo_slug": "x/y"})
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}
	if s.Name() != "pr-overlap" {
		t.Errorf("Name = %q, want pr-overlap", s.Name())
	}
	if s.Kind() != Inferential {
		t.Errorf("Kind = %d, want Inferential", s.Kind())
	}
}

func TestPROverlapSensor_RepoSlugOptional_FallsBackToCWDAutoDetect(t *testing.T) {
	// With no repo_slug, the sensor builds cleanly and leaves repoSlug empty.
	// ghPRLister detects this and omits --repo, letting `gh` infer from CWD.
	s, err := NewPROverlapSensor(nil)
	if err != nil {
		t.Fatalf("constructor with nil config: %v", err)
	}
	if s.Name() != "pr-overlap" {
		t.Errorf("Name = %q, want pr-overlap", s.Name())
	}

	s2, err := NewPROverlapSensor(map[string]any{})
	if err != nil {
		t.Fatalf("constructor with empty config: %v", err)
	}
	if s2.Name() != "pr-overlap" {
		t.Errorf("Name = %q, want pr-overlap", s2.Name())
	}
}
