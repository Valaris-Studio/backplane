// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// LIFECYCLE-FOLLOWUP-6 regression: when an `llm` lifecycle step runs with
// post_process_kind=writes_code and Git.Action=create_branch, the handler must
// commit and push the changes the LLM left in the working tree. The downstream
// `create_pr` step shells out to `gh pr create`, which 422s if (a) there are
// uncommitted changes or (b) the branch isn't pushed to a remote.
//
// Reproduces the 2026-05-16 prod smoke failure: lifecycleLLM only called
// executeLLM, skipping the commit+push that the legacy DataDrivenStrategy.Tick
// path runs at strategy_generic.go:256.
func TestKindLLM_WritesCode_CommitsAndPushes(t *testing.T) {
	bare := initBareRemote(t)

	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "test-repo")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-xyz", "main")
	if err != nil {
		t.Fatalf("create branch: %v", err)
	}
	// Simulate the LLM having written a file. The real LLM does this via
	// Claude's file-write tools; in tests we stage the equivalent dirty tree
	// so the post-LLM commit path has something to commit.
	if err := os.WriteFile(filepath.Join(repoDir, "implementation.txt"), []byte("LLM output"), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	srv, _ := kindHandlersServer(t, "b")
	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	mock := llm.NewMockProvider(`{"status":"done","summary":"implemented"}`)
	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	strat := NewDataDrivenStrategy(valaris.StageConfig{
		Role: "orchestrator",
		Git:  valaris.GitDef{Action: "create_branch"},
		LLM: valaris.LLMDef{
			Enabled:         true,
			Stage:           "implement",
			PostProcessKind: "writes_code",
		},
	}, nil)
	card := &discoverResult{
		CardID:        "card-xyz",
		BoardID:       "b",
		Title:         "Test card",
		GitRepoURL:    bare,
		GitRepoName:   "test-repo",
		DefaultBranch: "main",
	}
	ws := makeWalkState(t, loop, strat, card)
	ws.ExecutionID = "exec-1"
	ws.RepoDir = repoDir
	ws.Branch = branch
	ws.Set("branch_recovered", false)

	step := &valaris.LifecycleStep{
		Name: "implement", Kind: "llm",
		Params: map[string]any{"stage": "implement", "post_process_kind": "writes_code"},
	}
	if _, _, err := lifecycleLLM(context.Background(), ws, step); err != nil {
		t.Fatalf("lifecycleLLM: %v", err)
	}

	hasChanges, err := gitMgr.HasChanges(context.Background(), repoDir)
	if err != nil {
		t.Fatalf("HasChanges: %v", err)
	}
	if hasChanges {
		t.Error("expected lifecycleLLM to commit dirty working tree; HasChanges still true")
	}

	// Verify push reached the bare remote.
	cmd := newCmd("git", "ls-remote", "--heads", bare)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("ls-remote: %v\n%s", err, out)
	}
	if !strings.Contains(string(out), branch) {
		t.Errorf("expected branch %q on remote, got:\n%s", branch, out)
	}
}

// lifecycleLLM must propagate the verbatim LLM stdout onto
// WalkState.LLMRawOutput so downstream terminal kinds (create_note
// body_from="raw", mcp_call resolving $llm_output) can read it without
// re-parsing the structured envelope.
func TestKindLLM_PopulatesRawOutput(t *testing.T) {
	bare := initBareRemote(t)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "test-repo")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-raw", "main")
	if err != nil {
		t.Fatalf("create branch: %v", err)
	}
	if err := os.WriteFile(filepath.Join(repoDir, "out.txt"), []byte("body"), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	srv, _ := kindHandlersServer(t, "b")
	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	const rawStdout = `{"status":"done","summary":"impl"}`
	mock := llm.NewMockProvider(rawStdout)
	loop := mustNewLoop(t, client, mock, gitMgr, cfg)

	strat := NewDataDrivenStrategy(valaris.StageConfig{
		Role: "orchestrator",
		Git:  valaris.GitDef{Action: "create_branch"},
		LLM: valaris.LLMDef{
			Enabled:         true,
			Stage:           "implement",
			PostProcessKind: "writes_code",
		},
	}, nil)
	card := &discoverResult{
		CardID:        "card-raw",
		BoardID:       "b",
		Title:         "Raw test",
		GitRepoURL:    bare,
		GitRepoName:   "test-repo",
		DefaultBranch: "main",
	}
	ws := makeWalkState(t, loop, strat, card)
	ws.ExecutionID = "exec-raw"
	ws.RepoDir = repoDir
	ws.Branch = branch
	ws.Set("branch_recovered", false)

	step := &valaris.LifecycleStep{
		Name: "implement", Kind: "llm",
		Params: map[string]any{"stage": "implement", "post_process_kind": "writes_code"},
	}
	if _, _, err := lifecycleLLM(context.Background(), ws, step); err != nil {
		t.Fatalf("lifecycleLLM: %v", err)
	}
	if ws.LLMRawOutput != rawStdout {
		t.Errorf("ws.LLMRawOutput = %q, want %q", ws.LLMRawOutput, rawStdout)
	}
}

// Sentinel guard: lifecycleLLM must NOT attempt commit+push when executeLLM
// returns the no_prompt skip sentinel — that path means the stage was
// gracefully skipped and the working tree should be left as-is.
func TestKindLLM_WritesCode_NoPromptDoesNotCommit(t *testing.T) {
	bare := initBareRemote(t)

	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "test-repo")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-skip", "main")
	if err != nil {
		t.Fatalf("create branch: %v", err)
	}
	if err := os.WriteFile(filepath.Join(repoDir, "leftover.txt"), []byte("x"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	srv, _ := kindHandlersServer(t, "b")
	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	loop := mustNewLoop(t, client, llm.NewMockProvider(), gitMgr, cfg)

	// Custom stage with no template + no fallback → runLLMStage returns the
	// "no_prompt" sentinel without touching the working tree.
	strat := NewDataDrivenStrategy(valaris.StageConfig{
		Role: "custom_role",
		Git:  valaris.GitDef{Action: "create_branch"},
		LLM: valaris.LLMDef{
			Enabled:         true,
			Stage:           "unauthored_stage",
			PostProcessKind: "writes_code",
		},
	}, nil)
	ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "card-skip", BoardID: "b", DefaultBranch: "main"})
	ws.ExecutionID = "exec-skip"
	ws.RepoDir = repoDir
	ws.Branch = branch
	ws.Set("branch_recovered", false)

	step := &valaris.LifecycleStep{
		Name: "impl", Kind: "llm",
		Params: map[string]any{"stage": "unauthored_stage", "post_process_kind": "writes_code"},
	}
	dec, _, err := lifecycleLLM(context.Background(), ws, step)
	if err != nil {
		t.Fatalf("lifecycleLLM: %v", err)
	}
	if dec != "no_prompt" {
		t.Errorf("decision = %q, want no_prompt", dec)
	}

	// Working tree should still be dirty — sentinel must not commit anything.
	hasChanges, err := gitMgr.HasChanges(context.Background(), repoDir)
	if err != nil {
		t.Fatalf("HasChanges: %v", err)
	}
	if !hasChanges {
		t.Error("no_prompt sentinel must not commit; expected HasChanges=true, got false")
	}
}
