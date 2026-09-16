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
	"time"
)

// setupGitRepoWithConflict builds a local fixture: a fresh repo with `main`
// and a feature branch. Both branches edit overlapping lines of a shared file
// when wantConflict == true; otherwise the edits target different files.
//
// Returns the repo dir. Feature branch is checked out as HEAD.
//
// If extraConflictFile is set, the caller gets a second conflicting file on
// both branches (used to assert multiple findings).
type fixtureOpts struct {
	wantConflict      bool
	extraConflictFile bool
}

func setupGitFixture(t *testing.T, opts fixtureOpts) string {
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

	write("foo.txt", "line 1\nline 2\nline 3\n")
	if opts.extraConflictFile {
		write("bar.txt", "alpha\nbeta\ngamma\n")
	}
	run("add", ".")
	run("commit", "-m", "initial")

	run("checkout", "-b", "feature")
	write("foo.txt", "line 1\nFEATURE EDIT\nline 3\n")
	if opts.extraConflictFile {
		write("bar.txt", "alpha\nFEATURE BAR\ngamma\n")
	}
	run("add", ".")
	run("commit", "-m", "feature change")

	run("checkout", "main")
	if opts.wantConflict {
		write("foo.txt", "line 1\nMAIN EDIT\nline 3\n")
		if opts.extraConflictFile {
			write("bar.txt", "alpha\nMAIN BAR\ngamma\n")
		}
	} else {
		// Edit a different file entirely so no conflict arises.
		write("other.txt", "unrelated\n")
	}
	run("add", ".")
	run("commit", "-m", "main change")

	run("checkout", "feature")
	return dir
}

func TestConflictCheckSensor_Pass_NoConflict(t *testing.T) {
	dir := setupGitFixture(t, fixtureOpts{wantConflict: false})

	sensor, err := NewConflictCheckSensor(map[string]any{"default_branch": "main"})
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}

	result, err := sensor.Evaluate(context.Background(), SensorInput{WorkingDir: dir})
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if !result.Passed {
		t.Errorf("Passed = false, want true (no conflicts). findings=%+v summary=%q", result.Findings, result.Summary)
	}
	if len(result.Findings) != 0 {
		t.Errorf("findings len = %d, want 0: %+v", len(result.Findings), result.Findings)
	}
}

func TestConflictCheckSensor_Fail_SingleFileConflict(t *testing.T) {
	dir := setupGitFixture(t, fixtureOpts{wantConflict: true})

	sensor, err := NewConflictCheckSensor(map[string]any{"default_branch": "main"})
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}

	result, err := sensor.Evaluate(context.Background(), SensorInput{WorkingDir: dir})
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if result.Passed {
		t.Errorf("Passed = true, want false (conflict exists)")
	}
	if len(result.Findings) != 1 {
		t.Fatalf("findings len = %d, want 1: %+v", len(result.Findings), result.Findings)
	}
	if result.Findings[0].File != "foo.txt" {
		t.Errorf("finding.File = %q, want foo.txt", result.Findings[0].File)
	}
	if !strings.Contains(result.Findings[0].Message, "region(s)") {
		t.Errorf("finding.Message = %q, want region count in message", result.Findings[0].Message)
	}
	if result.Findings[0].Line != 0 {
		t.Errorf("finding.Line = %d, want 0 (region count belongs in Message, not Line)", result.Findings[0].Line)
	}
}

func TestConflictCheckSensor_Fail_MultipleFiles(t *testing.T) {
	dir := setupGitFixture(t, fixtureOpts{wantConflict: true, extraConflictFile: true})

	sensor, err := NewConflictCheckSensor(map[string]any{"default_branch": "main"})
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}

	result, err := sensor.Evaluate(context.Background(), SensorInput{WorkingDir: dir})
	if err != nil {
		t.Fatalf("evaluate: %v", err)
	}
	if result.Passed {
		t.Errorf("Passed = true, want false (conflicts exist)")
	}
	if len(result.Findings) != 2 {
		t.Fatalf("findings len = %d, want 2: %+v", len(result.Findings), result.Findings)
	}
	paths := map[string]bool{}
	for _, f := range result.Findings {
		paths[f.File] = true
	}
	if !paths["foo.txt"] || !paths["bar.txt"] {
		t.Errorf("expected findings for foo.txt and bar.txt, got %v", paths)
	}
}

func TestConflictCheckSensor_Error_InvalidBranch(t *testing.T) {
	dir := setupGitFixture(t, fixtureOpts{wantConflict: false})

	sensor, err := NewConflictCheckSensor(map[string]any{"default_branch": "nonexistent-branch"})
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}

	_, err = sensor.Evaluate(context.Background(), SensorInput{WorkingDir: dir})
	if err == nil {
		t.Fatal("expected error for missing branch, got nil")
	}
}

func TestConflictCheckSensor_Manifest(t *testing.T) {
	m := ConflictCheckManifest()
	if m.Name != "conflict-check" {
		t.Errorf("name = %q, want conflict-check", m.Name)
	}
	if m.Kind != SensorKindComputational {
		t.Errorf("kind = %q, want %q", m.Kind, SensorKindComputational)
	}
	if m.Description == "" {
		t.Error("description should be set")
	}
	if m.DefaultConfig["default_branch"] != "main" {
		t.Errorf("default_branch = %v, want main", m.DefaultConfig["default_branch"])
	}
	if m.DefaultConfig["timeout"] != "30s" {
		t.Errorf("timeout = %v, want 30s", m.DefaultConfig["timeout"])
	}
}

func TestConflictCheckSensor_Timeout(t *testing.T) {
	dir := setupGitFixture(t, fixtureOpts{wantConflict: true})

	sensor, err := NewConflictCheckSensor(map[string]any{
		"default_branch": "main",
		"timeout":        "1ns",
	})
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}

	// With a 1ns internal timeout the git subprocess cannot complete —
	// Evaluate must surface a deadline-exceeded error.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err = sensor.Evaluate(ctx, SensorInput{WorkingDir: dir})
	if err == nil {
		t.Fatal("expected timeout error, got nil")
	}
}

func TestConflictCheckSensor_NameAndKind(t *testing.T) {
	s, err := NewConflictCheckSensor(nil)
	if err != nil {
		t.Fatalf("constructor: %v", err)
	}
	if s.Name() != "conflict-check" {
		t.Errorf("Name = %q, want conflict-check", s.Name())
	}
	if s.Kind() != Computational {
		t.Errorf("Kind = %d, want Computational", s.Kind())
	}
}
