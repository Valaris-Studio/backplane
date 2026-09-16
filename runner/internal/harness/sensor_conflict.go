// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package harness

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"sort"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
)

// ConflictCheckSensor simulates a three-way merge between HEAD and the
// default branch using `git merge-tree --write-tree` and reports one Finding
// per conflicted file. It is a preventive gate: running it before push avoids
// the expensive reactive rework cycle that happens when a pushed PR conflicts
// with main.
//
// Reference: concurrency audit 2026-04-16 identified git merge-tree as the
// canonical cheap primitive for pre-push conflict detection.
type ConflictCheckSensor struct {
	defaultBranch string
	timeout       time.Duration
}

const (
	conflictCheckDefaultBranch  = "main"
	conflictCheckDefaultTimeout = "30s"
)

const conflictMarker = "<<<<<<<"

// ConflictCheckManifest exposes the sensor to the platform registry so the
// pipeline builder and backend validator can surface it without hardcoding.
func ConflictCheckManifest() SensorManifestEntry {
	return SensorManifestEntry{
		Name: "conflict-check",
		Kind: SensorKindComputational,
		DefaultConfig: map[string]any{
			"default_branch": conflictCheckDefaultBranch,
			"timeout":        conflictCheckDefaultTimeout,
		},
		ConfigSchema: map[string]any{
			"default_branch": "string",
			"timeout":        "string",
		},
		Description: "Runs 'git merge-tree' against the default branch to detect merge conflicts before push. Emits one finding per conflicted file.",
	}
}

func NewConflictCheckSensor(config map[string]any) (Sensor, error) {
	s := &ConflictCheckSensor{
		defaultBranch: conflictCheckDefaultBranch,
	}
	timeoutStr := conflictCheckDefaultTimeout

	if v, ok := config["default_branch"].(string); ok && v != "" {
		s.defaultBranch = v
	}
	if v, ok := config["timeout"].(string); ok && v != "" {
		timeoutStr = v
	}

	d, err := time.ParseDuration(timeoutStr)
	if err != nil {
		return nil, fmt.Errorf("conflict-check: invalid timeout %q: %w", timeoutStr, err)
	}
	s.timeout = d
	return s, nil
}

func (s *ConflictCheckSensor) Name() string     { return "conflict-check" }
func (s *ConflictCheckSensor) Kind() SensorKind { return Computational }

// Evaluate runs `git merge-tree --write-tree <default> HEAD`.
//
// Exit status (per git-merge-tree(1), EXIT STATUS section):
//
//	0 = clean merge, 1 = conflicts, >1 = error (bad ref, etc.)
//
// Output on conflict:
//
//	<tree-oid>
//	<mode> <oid> <stage> <path>
//	...
//	<informational messages>
//
// We dedupe paths (one file appears on each of stages 1/2/3) and then ask
// `git show <tree>:<path>` to count conflict marker regions per file.
func (s *ConflictCheckSensor) Evaluate(ctx context.Context, input SensorInput) (*SensorResult, error) {
	start := time.Now()

	runCtx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, "git", "merge-tree", "--write-tree", s.defaultBranch, "HEAD")
	cmd.Dir = input.WorkingDir
	// Without this an ambient GIT_DIR outranks cmd.Dir and merge-tree evaluates
	// a different repository — which would mask a real conflict and let the
	// pre-push gate wave conflicted work through.
	cmd.Env = git.SubprocessEnv(input.WorkingDir)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()
	durationMS := time.Since(start).Milliseconds()

	if runCtx.Err() == context.DeadlineExceeded {
		return nil, fmt.Errorf("conflict-check: timeout after %s", s.timeout)
	}

	exitCode := 0
	if ee, ok := runErr.(*exec.ExitError); ok {
		exitCode = ee.ExitCode()
	} else if runErr != nil {
		return nil, fmt.Errorf("conflict-check: %w: %s", runErr, strings.TrimSpace(stderr.String()))
	}

	// Exit 0 => clean merge (no conflicts).
	if exitCode == 0 {
		return &SensorResult{
			Passed:     true,
			Summary:    fmt.Sprintf("no merge conflicts against %s", s.defaultBranch),
			DurationMS: durationMS,
		}, nil
	}

	// Exit > 1 => real error (unknown ref, git broken, etc.).
	if exitCode != 1 {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = fmt.Sprintf("exit code %d", exitCode)
		}
		return nil, fmt.Errorf("conflict-check: git merge-tree failed: %s", msg)
	}

	// Exit 1 => conflicts exist. Parse the output.
	lines := strings.Split(strings.TrimRight(stdout.String(), "\n"), "\n")
	if len(lines) == 0 || lines[0] == "" {
		return nil, fmt.Errorf("conflict-check: empty merge-tree output on exit 1")
	}
	treeOID := lines[0]

	conflictedPaths := parseConflictedPaths(lines[1:])
	findings := make([]Finding, 0, len(conflictedPaths))
	for _, path := range conflictedPaths {
		regions := countConflictRegions(runCtx, input.WorkingDir, treeOID, path)
		// Leave Line at its zero value: the count is a file-level metric, not
		// a line number. runSensors renders "path:Line" for human output, so
		// stuffing the region count into Line would read as a fake line
		// reference downstream.
		findings = append(findings, Finding{
			Severity: "error",
			File:     path,
			Message:  fmt.Sprintf("merge conflict against %s (%d region(s))", s.defaultBranch, regions),
			Rule:     "conflict-check/merge",
		})
	}

	return &SensorResult{
		Passed:     false,
		Findings:   findings,
		Summary:    fmt.Sprintf("%d file(s) conflict with %s", len(findings), s.defaultBranch),
		DurationMS: durationMS,
	}, nil
}

// parseConflictedPaths extracts unique file paths from merge-tree's conflicted
// file info section. Each conflicted file produces one line per stage
// (1=base, 2=ours, 3=theirs); we dedupe while preserving first-seen order.
// Informational message lines (starting with a capital word, e.g. "Auto-merging")
// are skipped — they don't match the "<mode> <oid> <stage> <path>" shape.
func parseConflictedPaths(lines []string) []string {
	seen := make(map[string]bool)
	var paths []string
	for _, line := range lines {
		if line == "" {
			continue
		}
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		// First field must look like a file mode (6 octal digits).
		if !looksLikeMode(fields[0]) {
			continue
		}
		path := strings.Join(fields[3:], " ")
		path = strings.Trim(path, `"`)
		if seen[path] {
			continue
		}
		seen[path] = true
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

func looksLikeMode(s string) bool {
	if len(s) != 6 {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '7' {
			return false
		}
	}
	return true
}

// countConflictRegions runs `git show <tree>:<path>` and counts conflict
// marker lines. Returns 0 if the file can't be read (defensive — the Finding
// still exists for the path; line count is only advisory).
func countConflictRegions(ctx context.Context, dir, tree, path string) int {
	cmd := exec.CommandContext(ctx, "git", "show", tree+":"+path)
	cmd.Dir = dir
	cmd.Env = git.SubprocessEnv(dir)
	out, err := cmd.Output()
	if err != nil {
		return 0
	}
	count := 0
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, conflictMarker) {
			count++
		}
	}
	return count
}
