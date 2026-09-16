// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package harness

import (
	"context"
	"errors"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/forge"
)

// TestForgePRLister_MapsChangeFilesToPullRequestInfo proves the forge-backed
// PRListFetcher routes through forge.Provider.ListOpenChanges and maps the
// neutral forge.ChangeFiles onto the sensor-local PullRequestInfo 1:1.
func TestForgePRLister_MapsChangeFilesToPullRequestInfo(t *testing.T) {
	fake := &forge.Fake{
		OpenChanges: []forge.ChangeFiles{
			{Number: 7, HeadBranch: "runner/card-a", Files: []string{"a.go", "b.go"}},
			{Number: 9, HeadBranch: "runner/card-b", Files: []string{"c.go"}},
		},
	}
	lister := newForgePRLister(fake)

	prs, err := lister.FetchOpenPRs(context.Background(), "/repo", "owner/repo")
	if err != nil {
		t.Fatalf("FetchOpenPRs: %v", err)
	}
	if len(prs) != 2 {
		t.Fatalf("got %d PRs, want 2", len(prs))
	}
	if prs[0].Number != 7 || prs[0].HeadRefName != "runner/card-a" || len(prs[0].Files) != 2 {
		t.Fatalf("PR[0] mismapped: %+v", prs[0])
	}
	if prs[1].Number != 9 || prs[1].HeadRefName != "runner/card-b" || len(prs[1].Files) != 1 {
		t.Fatalf("PR[1] mismapped: %+v", prs[1])
	}
	// The repoSlug must be forwarded to the forge so cross-repo scoping works.
	if len(fake.ListOpenCalls) != 1 || fake.ListOpenCalls[0] != "owner/repo" {
		t.Fatalf("repoSlug not forwarded to forge: %+v", fake.ListOpenCalls)
	}
}

func TestForgePRLister_PropagatesError(t *testing.T) {
	fake := &forge.Fake{Err: errors.New("forge unreachable")}
	lister := newForgePRLister(fake)
	_, err := lister.FetchOpenPRs(context.Background(), "/repo", "owner/repo")
	if err == nil {
		t.Fatal("expected forge error to propagate")
	}
}

// TestDefaultRegistryWithForge_RoutesOverlapSensorThroughForge proves that a
// pr-overlap sensor built from the forge-injected registry fetches open changes
// from the supplied forge.Provider — not the default gh-CLI gitManagerPRLister.
func TestDefaultRegistryWithForge_RoutesOverlapSensorThroughForge(t *testing.T) {
	fake := &forge.Fake{
		OpenChanges: []forge.ChangeFiles{{Number: 3, HeadBranch: "runner/x", Files: nil}},
	}
	reg := DefaultRegistryWithForge(fake)

	s, err := reg.Build("pr-overlap", map[string]any{"repo_slug": "owner/repo"})
	if err != nil {
		t.Fatalf("Build pr-overlap: %v", err)
	}
	sensor, ok := s.(*PROverlapSensor)
	if !ok {
		t.Fatalf("built sensor is %T, want *PROverlapSensor", s)
	}
	// Drive only the fetcher seam (Evaluate needs a real git repo for the diff).
	prs, err := sensor.fetcher.FetchOpenPRs(context.Background(), "/repo", "owner/repo")
	if err != nil {
		t.Fatalf("fetcher: %v", err)
	}
	if len(prs) != 1 || prs[0].Number != 3 {
		t.Fatalf("sensor fetcher did not route through forge: %+v", prs)
	}
	if len(fake.ListOpenCalls) != 1 {
		t.Fatalf("forge ListOpenChanges not called: %+v", fake.ListOpenCalls)
	}
}

// TestDefaultRegistryWithForge_NilForgeFallsBackToDefault keeps the no-forge
// path behavior-identical to DefaultRegistry (gh-CLI gitManagerPRLister).
func TestDefaultRegistryWithForge_NilForgeFallsBackToDefault(t *testing.T) {
	reg := DefaultRegistryWithForge(nil)
	s, err := reg.Build("pr-overlap", nil)
	if err != nil {
		t.Fatalf("Build pr-overlap: %v", err)
	}
	sensor := s.(*PROverlapSensor)
	if _, ok := sensor.fetcher.(*gitManagerPRLister); !ok {
		t.Fatalf("nil forge should fall back to gitManagerPRLister, got %T", sensor.fetcher)
	}
}
