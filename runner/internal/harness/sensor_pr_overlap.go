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

	"github.com/Valaris-Studio/backplane/runner/internal/forge"
	"github.com/Valaris-Studio/backplane/runner/internal/git"
)

// PullRequestInfo is a minimal projection of what `gh pr list` returns,
// limited to fields the overlap check needs.
type PullRequestInfo struct {
	Number      int      `json:"number"`
	HeadRefName string   `json:"headRefName"`
	Files       []string `json:"-"`
}

// PRListFetcher abstracts the call to `gh pr list` so tests can stub it.
// Production uses gitManagerPRLister (a thin adapter over git.Manager.ListOpenPRs);
// tests inject a fake. Keeping the sensor-local shape — PullRequestInfo and
// FetchOpenPRs — means the T1.4 GitHostProvider split only re-targets the
// adapter, not every test fixture.
type PRListFetcher interface {
	FetchOpenPRs(ctx context.Context, repoDir, repoSlug string) ([]PullRequestInfo, error)
}

// PROverlapSensor runs informational (non-blocking) detection of file-path
// overlap between the current branch and other open PRs in the same repo.
// Overlap != conflict, so this sensor never fails — operators who want
// overlap to block can chain a downstream action via findings.
type PROverlapSensor struct {
	repoSlug       string
	defaultBranch  string
	ignorePRNumber int
	timeout        time.Duration
	fetcher        PRListFetcher
}

const (
	prOverlapDefaultBranch  = "main"
	prOverlapDefaultTimeout = "30s"
)

// PROverlapManifest exposes the sensor to the platform registry.
func PROverlapManifest() SensorManifestEntry {
	return SensorManifestEntry{
		Name: "pr-overlap",
		Kind: SensorKindInferential,
		DefaultConfig: map[string]any{
			"repo_slug":        "",
			"default_branch":   prOverlapDefaultBranch,
			"ignore_pr_number": 0,
			"timeout":          prOverlapDefaultTimeout,
		},
		ConfigSchema: map[string]any{
			"repo_slug":        "string",
			"default_branch":   "string",
			"ignore_pr_number": "int",
			"timeout":          "string",
		},
		Description: "Heuristically flags open PRs that touch files overlapping the current branch's changes. Informational only — always passes; findings surface via review/post-action.",
	}
}

// NewPROverlapSensor constructs the sensor. `repo_slug` is required because
// the sensor cannot infer it from WorkingDir alone without extra git calls
// (and multiple remotes would be ambiguous).
//
// prListerFactory is swappable by tests (see TestMain / t.Cleanup patterns).
// Production uses gitManagerPRLister which delegates to git.Manager.ListOpenPRs
// — keeping all `gh` CLI surface area in the git package ahead of the T1.4
// GitHostProvider split.
var prListerFactory = func() PRListFetcher { return &gitManagerPRLister{} }

// NewPROverlapSensor builds the sensor from a pipeline-config map. `repo_slug`
// is optional: when omitted, `gh` falls back to CWD-based repo auto-detection,
// which is the right default for single-repo workspaces and for rework flows
// where the agent is already in the card's repo directory.
func NewPROverlapSensor(config map[string]any) (Sensor, error) {
	s := &PROverlapSensor{
		defaultBranch: prOverlapDefaultBranch,
		fetcher:       prListerFactory(),
	}
	timeoutStr := prOverlapDefaultTimeout

	if config != nil {
		if v, ok := config["repo_slug"].(string); ok {
			s.repoSlug = v
		}
		if v, ok := config["default_branch"].(string); ok && v != "" {
			s.defaultBranch = v
		}
		if v, ok := config["ignore_pr_number"]; ok {
			switch n := v.(type) {
			case int:
				s.ignorePRNumber = n
			case float64:
				s.ignorePRNumber = int(n)
			}
		}
		if v, ok := config["timeout"].(string); ok && v != "" {
			timeoutStr = v
		}
	}

	d, err := time.ParseDuration(timeoutStr)
	if err != nil {
		return nil, fmt.Errorf("pr-overlap: invalid timeout %q: %w", timeoutStr, err)
	}
	s.timeout = d

	return s, nil
}

func (s *PROverlapSensor) Name() string     { return "pr-overlap" }
func (s *PROverlapSensor) Kind() SensorKind { return Inferential }

func (s *PROverlapSensor) Evaluate(ctx context.Context, input SensorInput) (*SensorResult, error) {
	start := time.Now()

	runCtx, cancel := context.WithTimeout(ctx, s.timeout)
	defer cancel()

	branchFiles, err := diffFilesAgainst(runCtx, input.WorkingDir, s.defaultBranch)
	if err != nil {
		return nil, fmt.Errorf("pr-overlap: %w", err)
	}
	branchSet := make(map[string]bool, len(branchFiles))
	for _, f := range branchFiles {
		branchSet[f] = true
	}

	prs, err := s.fetcher.FetchOpenPRs(runCtx, input.WorkingDir, s.repoSlug)
	if err != nil {
		return nil, fmt.Errorf("pr-overlap: fetch open PRs: %w", err)
	}

	var findings []Finding
	for _, pr := range prs {
		if pr.Number == s.ignorePRNumber {
			continue
		}
		overlaps := intersect(branchSet, pr.Files)
		for _, path := range overlaps {
			findings = append(findings, Finding{
				Severity: "info",
				File:     path,
				Message:  fmt.Sprintf("open PR #%d on branch %q also modifies %s", pr.Number, pr.HeadRefName, path),
				Rule:     "pr-overlap/file",
			})
		}
	}

	durationMS := time.Since(start).Milliseconds()
	summary := fmt.Sprintf("%d overlapping file(s) across open PRs", len(findings))
	if len(findings) == 0 {
		summary = "no open-PR file overlap detected"
	}

	return &SensorResult{
		Passed:     true, // informational — never blocks
		Findings:   findings,
		Summary:    summary,
		DurationMS: durationMS,
	}, nil
}

// diffFilesAgainst returns the list of file paths changed on the current HEAD
// relative to the merge-base with baseBranch.
func diffFilesAgainst(ctx context.Context, dir, baseBranch string) ([]string, error) {
	cmd := exec.CommandContext(ctx, "git", "diff", "--name-only", baseBranch+"...HEAD")
	cmd.Dir = dir
	cmd.Env = git.SubprocessEnv(dir)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return nil, fmt.Errorf("git diff: %s", msg)
	}
	var files []string
	for _, line := range strings.Split(strings.TrimRight(stdout.String(), "\n"), "\n") {
		if line == "" {
			continue
		}
		files = append(files, line)
	}
	return files, nil
}

// intersect returns the sorted subset of candidates that exist in set.
func intersect(set map[string]bool, candidates []string) []string {
	var hits []string
	for _, c := range candidates {
		if set[c] {
			hits = append(hits, c)
		}
	}
	sort.Strings(hits)
	return hits
}

// gitManagerPRLister is the production PRListFetcher — delegates to
// git.Manager.ListOpenPRs so the pr-overlap sensor itself never shells
// to `gh`. Owning-package separation: harness has zero host-CLI surface.
type gitManagerPRLister struct {
	mgr *git.Manager // nil → zero-value Manager is fine (ListOpenPRs uses repoDir)
}

func (g *gitManagerPRLister) FetchOpenPRs(ctx context.Context, repoDir, repoSlug string) ([]PullRequestInfo, error) {
	mgr := g.mgr
	if mgr == nil {
		mgr = &git.Manager{}
	}
	raws, err := mgr.ListOpenPRs(ctx, repoDir, repoSlug)
	if err != nil {
		return nil, err
	}
	prs := make([]PullRequestInfo, 0, len(raws))
	for _, r := range raws {
		prs = append(prs, PullRequestInfo{
			Number:      r.Number,
			HeadRefName: r.HeadRefName,
			Files:       r.Files,
		})
	}
	return prs, nil
}

// ChangeLister is the narrow read-op the pr-overlap sensor needs from a forge.
// forge.Provider satisfies it, so the loop can inject the configured forge here
// without the harness package importing workloop (which would invert layers).
type ChangeLister interface {
	ListOpenChanges(ctx context.Context, repoDir, repoSlug string) ([]forge.ChangeFiles, error)
}

// forgePRLister routes the sensor's open-PR fetch through a forge.Provider's
// ListOpenChanges, mapping the neutral forge.ChangeFiles onto the sensor-local
// PullRequestInfo. This is the production adapter when a forge is configured —
// the github driver still shells `gh` internally, gitea speaks HTTP, etc.
type forgePRLister struct {
	forge ChangeLister
}

func newForgePRLister(f ChangeLister) *forgePRLister { return &forgePRLister{forge: f} }

func (f *forgePRLister) FetchOpenPRs(ctx context.Context, repoDir, repoSlug string) ([]PullRequestInfo, error) {
	changes, err := f.forge.ListOpenChanges(ctx, repoDir, repoSlug)
	if err != nil {
		return nil, err
	}
	prs := make([]PullRequestInfo, 0, len(changes))
	for _, c := range changes {
		prs = append(prs, PullRequestInfo{
			Number:      c.Number,
			HeadRefName: c.HeadBranch,
			Files:       c.Files,
		})
	}
	return prs, nil
}

// newPROverlapSensorWithFetcher builds a pr-overlap sensor bound to a specific
// PRListFetcher, bypassing the package-level prListerFactory. The registry uses
// this to inject a forge-backed fetcher; the parsing logic is shared with
// NewPROverlapSensor.
func newPROverlapSensorWithFetcher(config map[string]any, fetcher PRListFetcher) (Sensor, error) {
	s, err := NewPROverlapSensor(config)
	if err != nil {
		return nil, err
	}
	s.(*PROverlapSensor).fetcher = fetcher
	return s, nil
}
