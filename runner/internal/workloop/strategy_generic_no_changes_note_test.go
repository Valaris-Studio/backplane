// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// When implement produces a clean tree with 0 commits ahead (genuine no-op), the
// runner must write a board-visible diagnostic note carrying the LLM's summary so
// the operator can see WHY nothing was produced, then fall through to the
// existing failure handling unchanged.
func TestGitCommitAndPush_NoChangesWritesDiagnosticNote(t *testing.T) {
	bare := initBareRemote(t)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "test-repo")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-empty", "main")
	if err != nil {
		t.Fatalf("create branch: %v", err)
	}

	srv, getPosts := noteCapturingServer(t)
	cfg := testConfig()
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, cfg)
	strat := writesCodeStrategy()

	card := &discoverResult{CardID: "card-empty", BoardID: "b", Title: "Empty work", DefaultBranch: "main"}
	llmResult := &llmStageResult{
		implResult: &implementResult{Status: "done", Summary: "I analyzed the repo but found nothing to change"},
		rawOutput:  "verbatim llm stdout explaining the no-op decision",
	}

	before := loop.CardFailureCount(card.CardID)
	done, err := strat.gitCommitAndPush(
		context.Background(), context.Background(),
		loop, card, "exec-1", repoDir, branch, false,
		func() {}, silentLogger(), llmResult,
	)
	if err != nil {
		t.Fatalf("gitCommitAndPush err: %v", err)
	}
	if !done {
		t.Fatal("genuine no-op must return done=true (existing failure flow unchanged)")
	}
	if after := loop.CardFailureCount(card.CardID); after <= before {
		t.Errorf("CardFailureCount before=%d after=%d: no-op must still record a failure", before, after)
	}

	var diag map[string]any
	for _, n := range getPosts() {
		content, _ := n.Decoded["content"].(string)
		if strings.Contains(content, "no_changes") {
			diag = n.Decoded
			break
		}
	}
	if diag == nil {
		t.Fatalf("expected a diagnostic note marking no_changes, got posts: %v", getPosts())
	}
	// The wire failure_class MUST stay empty: the backend validates that field
	// against the five reviewer ReviewFailureClass values and 422s on anything
	// else, which would drop the note in prod. The no_changes classification
	// lives in the body header instead.
	if fc, ok := diag["failure_class"]; ok && fc != "" {
		t.Errorf("wire failure_class must be empty (backend rejects non-review classes), got: %v", fc)
	}
	content, _ := diag["content"].(string)
	if !strings.Contains(content, "I analyzed the repo but found nothing to change") {
		t.Errorf("diagnostic note body must contain the LLM summary, got: %q", content)
	}
	if !strings.Contains(content, "verbatim llm stdout explaining the no-op decision") {
		t.Errorf("diagnostic note body must contain the raw LLM output, got: %q", content)
	}
}

// Best-effort: a nil llmResult (LLM produced nothing parseable) must NOT panic
// and must still record the failure and return done=true.
func TestGitCommitAndPush_NoChangesNilLLMResultIsSafe(t *testing.T) {
	bare := initBareRemote(t)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "test-repo")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, "card-empty", "main")
	if err != nil {
		t.Fatalf("create branch: %v", err)
	}

	srv, _ := noteCapturingServer(t)
	cfg := testConfig()
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, cfg)
	strat := writesCodeStrategy()

	card := &discoverResult{CardID: "card-empty", BoardID: "b", Title: "Empty work", DefaultBranch: "main"}

	done, err := strat.gitCommitAndPush(
		context.Background(), context.Background(),
		loop, card, "exec-1", repoDir, branch, false,
		func() {}, silentLogger(), nil,
	)
	if err != nil {
		t.Fatalf("gitCommitAndPush err: %v", err)
	}
	if !done {
		t.Fatal("genuine no-op must return done=true even with nil llmResult")
	}
}
