// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
)

// servePlatformConfig returns an httptest.Server that satisfies the platform
// config fetch Loop.New does at startup. Everything else responds with {}.
// isCardPRMerged never touches the platform, so this is just a no-op stub.
func servePlatformConfig(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agents/me/config" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"agent_id": "agent-1",
				"workspace_config": map[string]any{
					"pipeline_config": DefaultPipelineConfig,
				},
			})
			return
		}
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestIsCardPRMerged_EmptyPRURL(t *testing.T) {
	srv := servePlatformConfig(t)
	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoop(t, client, nil, gitMgr, cfg)

	card := &discoverResult{
		CardID:     "card-1",
		BoardID:    "board-1",
		GitRepoURL: "https://github.com/test/repo.git",
		PRURL:      "",
	}

	if loop.isCardPRMerged(context.Background(), card) {
		t.Error("expected false when PRURL is empty")
	}
}

func TestIsCardPRMerged_EmptyGitRepoURL(t *testing.T) {
	srv := servePlatformConfig(t)
	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoop(t, client, nil, gitMgr, cfg)

	card := &discoverResult{
		CardID:     "card-1",
		BoardID:    "board-1",
		GitRepoURL: "",
		PRURL:      "https://github.com/test/repo/pull/1",
	}

	if loop.isCardPRMerged(context.Background(), card) {
		t.Error("expected false when GitRepoURL is empty")
	}
}

func TestIsCardPRMerged_BothEmpty(t *testing.T) {
	srv := servePlatformConfig(t)
	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoop(t, client, nil, gitMgr, cfg)

	card := &discoverResult{
		CardID:  "card-1",
		BoardID: "board-1",
	}

	if loop.isCardPRMerged(context.Background(), card) {
		t.Error("expected false when both PRURL and GitRepoURL are empty")
	}
}

func TestIsCardPRMerged_CloneFails_ReturnsFalse(t *testing.T) {
	srv := servePlatformConfig(t)
	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	// Point BaseDir at a non-existent/invalid path so clone fails
	gitMgr := &git.Manager{BaseDir: "/nonexistent/path/for/test", DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoop(t, client, nil, gitMgr, cfg)

	card := &discoverResult{
		CardID:      "card-1",
		BoardID:     "board-1",
		GitRepoURL:  "https://github.com/test/repo.git",
		GitRepoName: "repo",
		PRURL:       "https://github.com/test/repo/pull/1",
	}

	// CloneOrOpen will fail because the remote doesn't exist and BaseDir is invalid.
	// isCardPRMerged should return false gracefully.
	if loop.isCardPRMerged(context.Background(), card) {
		t.Error("expected false when clone fails")
	}
}
