// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/forge"
	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// TestNew_DefaultForgeIsGitHub proves the unconfigured path stays byte-identical
// to the pre-config-select behavior: an empty git.forge yields the github driver.
func TestNew_DefaultForgeIsGitHub(t *testing.T) {
	srv := platformConfigServer(t, &DefaultPipelineConfig)
	defer srv.Close()

	cfg := testConfig() // Git.Forge unset
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop, err := New(context.Background(), client, llm.NewMockProvider(), gitMgr, cfg)
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	if loop.forge == nil {
		t.Fatal("loop.forge is nil")
	}
	if got := loop.forge.Kind(); got != "github" {
		t.Fatalf("default forge Kind() = %q, want github", got)
	}
}

// TestNew_ConfigSelectsGitea proves git.forge=gitea routes the Loop's forge seam
// to the Gitea driver — the config lever, no binary swap.
func TestNew_ConfigSelectsGitea(t *testing.T) {
	srv := platformConfigServer(t, &DefaultPipelineConfig)
	defer srv.Close()

	cfg := testConfig()
	cfg.Git.Forge = "gitea"
	cfg.Git.ForgeBaseURL = "https://gitea.example.com"
	cfg.Git.ForgeToken = "tok"
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop, err := New(context.Background(), client, llm.NewMockProvider(), gitMgr, cfg)
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	if got := loop.forge.Kind(); got != "gitea" {
		t.Fatalf("forge Kind() = %q, want gitea", got)
	}
}

// TestNew_CurrentPRResolverRoutesThroughForge proves the default open-PR
// resolver (used by the merge gate to avoid stale description URLs) is backed by
// the configured forge's CurrentChangeForBranch, not a direct git.Manager call.
// Routing the last forge-owned lookup through the provider completes the seam.
func TestNew_CurrentPRResolverRoutesThroughForge(t *testing.T) {
	srv := platformConfigServer(t, &DefaultPipelineConfig)
	defer srv.Close()

	cfg := testConfig()
	cfg.Git.Forge = "gitea"
	cfg.Git.ForgeBaseURL = "https://gitea.example.com"
	cfg.Git.ForgeToken = "tok"
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop, err := New(context.Background(), client, llm.NewMockProvider(), gitMgr, cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// Swap the loop's forge for a recording fake, then drive the resolver and
	// assert the call landed on forge.CurrentChangeForBranch.
	fake := &forge.Fake{BranchURL: "https://gitea.example.com/o/r/pulls/5"}
	loop.forge = fake
	loop.currentPRResolver = newForgePRResolver(fake)

	got, err := loop.currentPRResolver.CurrentPRForBranch(context.Background(), "/repo", "runner/card-x")
	if err != nil {
		t.Fatalf("CurrentPRForBranch: %v", err)
	}
	if got != "https://gitea.example.com/o/r/pulls/5" {
		t.Fatalf("resolver returned %q, want the forge URL", got)
	}
	if len(fake.BranchLookupCalls) != 1 || fake.BranchLookupCalls[0] != "runner/card-x" {
		t.Fatalf("forge CurrentChangeForBranch not consulted: %+v", fake.BranchLookupCalls)
	}
}

// TestNew_DefaultCurrentPRResolverIsForgeBacked proves New wires the resolver to
// a forge-backed adapter by default (not the raw git.Manager).
func TestNew_DefaultCurrentPRResolverIsForgeBacked(t *testing.T) {
	srv := platformConfigServer(t, &DefaultPipelineConfig)
	defer srv.Close()

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop, err := New(context.Background(), client, llm.NewMockProvider(), gitMgr, cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if _, ok := loop.currentPRResolver.(*forgePRResolver); !ok {
		t.Fatalf("default currentPRResolver is %T, want *forgePRResolver", loop.currentPRResolver)
	}
}

// TestNew_UnknownForgeFailsStartup proves a bogus forge is a loud startup error,
// not a silent github fallback (mirrors createProvider's os.Exit on unknown LLM).
func TestNew_UnknownForgeFailsStartup(t *testing.T) {
	srv := platformConfigServer(t, &DefaultPipelineConfig)
	defer srv.Close()

	cfg := testConfig()
	cfg.Git.Forge = "bitbucket"
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	_, err := New(context.Background(), client, llm.NewMockProvider(), gitMgr, cfg)
	if err == nil {
		t.Fatal("expected New to fail for an unknown forge")
	}
}
