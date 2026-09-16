// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build integration

package llm

import (
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// TestCodexCLI_Live exercises the real `codex` binary end-to-end: it spawns
// `codex exec --json` via the CodexCLI provider and asserts the driver parses a
// real NDJSON stream (agent_message text + token usage + thread/session id).
//
// Skipped by default (build tag `integration`) so the normal suite stays
// hermetic. Run with: go test -tags integration -run TestCodexCLI_Live ./internal/llm/
// Requires a stock `codex` on PATH, authed (codex login or CODEX_API_KEY).
func TestCodexCLI_Live(t *testing.T) {
	if _, err := exec.LookPath("codex"); err != nil {
		t.Skip("no codex binary on PATH")
	}

	cli := NewCodexCLI()
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	res, err := cli.Execute(ctx, "Reply with exactly the word DONE and make no changes.", Options{
		WorkingDir:                 t.TempDir(),
		DangerouslySkipPermissions: true,
	})
	if err != nil {
		t.Fatalf("Execute against real codex: %v", err)
	}
	if !strings.Contains(strings.ToUpper(res.Output), "DONE") {
		t.Errorf("Output = %q, want it to contain DONE", res.Output)
	}
	if res.SessionID == "" {
		t.Error("SessionID empty — thread.started not parsed from the real stream")
	}
	if res.InputTokens == 0 && res.OutputTokens == 0 {
		t.Error("no tokens parsed — turn.completed.usage not parsed from the real stream")
	}
	t.Logf("LIVE codex: session=%s in=%d out=%d output=%q",
		res.SessionID, res.InputTokens, res.OutputTokens, res.Output)
}

// TestCodexCLI_LiveResume exercises the REAL resume path end-to-end: it runs a
// first turn to obtain a session id, then resumes it via `codex exec resume`.
// This is the ground-truth guard for the resume arg grammar — it would have
// caught the `--cd` wedge (resume rejected --cd, exit 2, 0 tokens) that the
// unit allow-list alone could miss if the real CLI ever changes its flags.
// WorkingDir is set on BOTH turns so the resume path proves it does not leak a
// --cd the resume subcommand rejects.
func TestCodexCLI_LiveResume(t *testing.T) {
	if _, err := exec.LookPath("codex"); err != nil {
		t.Skip("no codex binary on PATH")
	}

	cli := NewCodexCLI()
	dir := t.TempDir()
	opts := Options{WorkingDir: dir, DangerouslySkipPermissions: true}

	ctx, cancel := context.WithTimeout(context.Background(), 180*time.Second)
	defer cancel()

	first, err := cli.Execute(ctx, "Reply with exactly the word ONE and make no changes.", opts)
	if err != nil {
		t.Fatalf("first turn: %v", err)
	}
	if first.SessionID == "" {
		t.Fatal("no session id from first turn — cannot test resume")
	}

	resumed, err := cli.ResumeSession(ctx, first.SessionID,
		"Reply with exactly the word TWO and make no changes.", opts)
	if err != nil {
		t.Fatalf("resume turn (the --cd wedge would surface here as exit 2): %v", err)
	}
	if resumed.ExitCode != 0 {
		t.Fatalf("resume exited %d — resume arg grammar regression", resumed.ExitCode)
	}
	if resumed.InputTokens == 0 && resumed.OutputTokens == 0 {
		t.Error("resume turn spent 0 tokens — it likely crashed before the model ran")
	}
	t.Logf("LIVE codex resume: session=%s output=%q", first.SessionID, resumed.Output)
}

// TestCodexCLI_LiveStructuredOutput exercises the REAL structured-output path:
// it hands codex an OutputSchema, which Execute materializes to a temp file and
// passes as --output-schema, and asserts codex returns a schema-conforming JSON
// payload on the StructuredOutput channel. This is the ground-truth guard for
// the gap behind the non-string-findings money-loop: without --output-schema,
// codex emits unconstrained text and the shape is whatever the model chooses.
// It mirrors the production decision envelope (decision/summary/findings).
func TestCodexCLI_LiveStructuredOutput(t *testing.T) {
	if _, err := exec.LookPath("codex"); err != nil {
		t.Skip("no codex binary on PATH")
	}

	const schema = `{"type":"object","properties":{"decision":{"type":"string","enum":["approve","request_changes"]},"summary":{"type":"string"},"findings":{"type":"string"}},"required":["decision","summary","findings"],"additionalProperties":false}`

	cli := NewCodexCLI()
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	res, err := cli.Execute(ctx,
		"You are a code reviewer. The change is trivial and correct. Respond with your verdict.",
		Options{
			WorkingDir:                 t.TempDir(),
			DangerouslySkipPermissions: true,
			OutputSchema:               schema,
		})
	if err != nil {
		t.Fatalf("Execute with schema against real codex: %v", err)
	}
	if len(res.StructuredOutput) == 0 {
		t.Fatalf("no StructuredOutput — --output-schema not enforced. Output=%q", res.Output)
	}
	var verdict struct {
		Decision string `json:"decision"`
		Summary  string `json:"summary"`
		Findings string `json:"findings"`
	}
	if err := json.Unmarshal(res.StructuredOutput, &verdict); err != nil {
		t.Fatalf("StructuredOutput is not schema-conforming JSON: %v\nraw=%s", err, res.StructuredOutput)
	}
	if verdict.Decision != "approve" && verdict.Decision != "request_changes" {
		t.Errorf("decision = %q, want an enum value from the schema", verdict.Decision)
	}
	t.Logf("LIVE codex structured: decision=%q summary=%q", verdict.Decision, verdict.Summary)
}
