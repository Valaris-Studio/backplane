// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build integration

package workloop

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// TestReviewDryRun_RealPRBranch is the ISOLATED review-stage dry-run: it points
// the real codex binary at a real PR clone (a checked-out feature branch) with
// the EXACT production decisionOutputSchema and a self-contained review prompt
// (no MCP — the schema arg, not the MCP tools, is what crashed review). It
// asserts codex runs (exit 0, not the 0-token --output-schema startup crash) and
// returns a verdict that decodes through the production decodeDecisionEnvelope
// seam. This validates the review path against the actual artifact for ~one
// review turn (~$0.30) instead of re-burning ~$21 on plan+implement.
//
// Run:
//
//	REVIEW_DRYRUN_REPO=/tmp/backplane-runner-repos/example-frontend \
//	  go test -tags integration -run TestReviewDryRun_RealPRBranch ./internal/workloop/ -v
//
// The repo must already be checked out on the PR branch. Skips if unset / no codex.
func TestReviewDryRun_RealPRBranch(t *testing.T) {
	repo := os.Getenv("REVIEW_DRYRUN_REPO")
	if repo == "" {
		t.Skip("set REVIEW_DRYRUN_REPO to a checked-out PR clone")
	}
	if _, err := exec.LookPath("codex"); err != nil {
		t.Skip("no codex binary on PATH")
	}
	if fi, err := os.Stat(repo); err != nil || !fi.IsDir() {
		t.Fatalf("REVIEW_DRYRUN_REPO is not a directory: %v", err)
	}

	// Self-contained review prompt: same intent as the production reviewer, but
	// reads the diff from the working tree directly instead of via MCP, so the
	// only production-faithful variable under test is the --output-schema path.
	prompt := `You are an autonomous code review agent reviewing a pull request.

The working directory is a git checkout of the PR's feature branch. Inspect the
changes (e.g. ` + "`git diff main...HEAD`" + ` and read the changed files) and
evaluate them for: correctness, security (no secrets/injection/auth bypass),
test coverage, code style, and architecture.

When done, call the StructuredOutput tool to deliver your verdict per the schema:
- decision: "approve" if ready to merge, "request_changes" if blocking issues.
- summary: one-line verdict.
- findings: detailed notes; for request_changes include file:line refs.
- fix_cards: null (you are a normal reviewer, not an auditor).`

	cli := llm.NewCodexCLI()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	res, err := cli.Execute(ctx, prompt, llm.Options{
		WorkingDir:                 repo,
		Model:                      "gpt-5.5",
		DangerouslySkipPermissions: true,
		OutputSchema:               decisionOutputSchema, // the EXACT schema that crashed review
	})
	if err != nil {
		t.Fatalf("REVIEW DRY-RUN FAILED — codex review crashed: %v", err)
	}
	if res.ExitCode != 0 {
		t.Fatalf("REVIEW DRY-RUN FAILED — codex exit=%d (the --output-schema startup crash shape)", res.ExitCode)
	}

	review := decodeDecisionEnvelope(res)
	if review.Decision != "approve" && review.Decision != "request_changes" {
		t.Fatalf("review produced no usable decision (Output=%q)", res.Output)
	}
	if len(res.StructuredOutput) == 0 || !json.Valid(res.StructuredOutput) {
		t.Errorf("expected schema-conforming JSON on StructuredOutput, got %q", res.StructuredOutput)
	}

	t.Logf("REVIEW DRY-RUN OK — decision=%q tokens_in=%d tokens_out=%d\nsummary: %s\nfindings: %.400s",
		review.Decision, res.InputTokens, res.OutputTokens, review.Summary, review.Findings)
}
