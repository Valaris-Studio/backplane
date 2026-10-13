// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build integration

package workloop

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

type handoffNativeObserver struct {
	llm.Provider
	expected, noteID string
	excluded         []string
	ceiling          int
	prompt           string
	options          llm.Options
	result           *llm.Result
}

func (p *handoffNativeObserver) Capabilities() llm.Capabilities {
	return p.Provider.(llm.CapabilityProvider).Capabilities()
}

func (p *handoffNativeObserver) Execute(ctx context.Context, prompt string, opts llm.Options) (*llm.Result, error) {
	if !strings.Contains(prompt, p.expected) || !strings.Contains(prompt, p.noteID) {
		return nil, fmt.Errorf("refusing dispatch without reviewed context and explicit note identity")
	}
	for _, marker := range p.excluded {
		if strings.Contains(prompt+opts.SystemPrompt, marker) {
			return nil, fmt.Errorf("refusing dispatch of excluded marker")
		}
	}
	if len(prompt)+len(opts.SystemPrompt) > p.ceiling {
		return nil, fmt.Errorf("refusing dispatch beyond fixture byte ceiling")
	}
	if opts.ResumeSessionID != "" || len(opts.ContextDirs) != 0 {
		return nil, fmt.Errorf("continuation must start fresh without extra source directories")
	}
	p.prompt, p.options = prompt, opts
	result, err := p.Provider.Execute(ctx, prompt, opts)
	p.result = result
	return result, err
}

// Run only via the matching Python fixture, while its real HTTP backend is
// alive. This consumes real provider tokens and changes only its toy checkout.
func TestReviewedHandoffLiveClaudeContinuation(t *testing.T) {
	if os.Getenv("RUN_LIVE_CONTINUATION") != "1" {
		t.Skip("requires explicit real-provider opt-in")
	}
	out := os.Getenv("CONTINUATION_LIVE_OUT")
	raw, err := os.ReadFile(filepath.Join(out, "packet.json"))
	if err != nil {
		t.Fatal(err)
	}
	var packet struct {
		Assignment valaris.NextAssignmentResponse `json:"assignment"`
		Workspace  string                         `json:"workspace_slug"`
		AgentID    string                         `json:"agent_id"`
		Alias      string                         `json:"alias"`
		Expected   string                         `json:"expected_context"`
		Excluded   []string                       `json:"excluded_markers"`
		NoteID     string                         `json:"note_id"`
		Ceiling    int                            `json:"fixture_prompt_ceiling_bytes"`
		Repo       string                         `json:"repo"`
	}
	if err := json.Unmarshal(raw, &packet); err != nil {
		t.Fatal(err)
	}
	provider := &handoffNativeObserver{
		Provider: llm.NewClaudeCLI(), expected: packet.Expected, noteID: packet.NoteID,
		excluded: packet.Excluded, ceiling: packet.Ceiling,
	}
	client := valaris.NewClient(os.Getenv("CONTINUATION_LIVE_URL"), os.Getenv("CONTINUATION_AGENT_KEY"))
	client.Agent = &valaris.AgentConfig{ID: packet.AgentID, IsActive: true, AgentType: "coding"}
	cfg := testConfig()
	cfg.Valaris.WorkspaceSlug = packet.Workspace
	cfg.Valaris.BoardIDs = []string{packet.Assignment.Board.ID}
	cfg.LLM.MCPConfigPath = os.Getenv("CONTINUATION_MCP_TEMPLATE")
	cfg.LLM.MaxBudgetUSD = 3
	cfg.LLM.ContextDirs = nil
	ctx, cancel := context.WithTimeout(context.Background(), 210*time.Second)
	defer cancel()
	loop, err := New(ctx, client, provider,
		&git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "fixture/"}, cfg)
	if err != nil {
		t.Fatal(err)
	}
	strategy, ok := loop.ownedStrategies[packet.Assignment.Role].(*DataDrivenStrategy)
	if !ok {
		t.Fatal("backend's configured role did not produce an executable strategy")
	}
	loop.strategy = strategy
	loop.refreshPromptCacheForRole(ctx, packet.Assignment.Role)
	card, err := strategy.discoverWithConfig(ctx, loop)
	if err != nil {
		t.Fatal(err)
	}
	if card == nil || card.CardID != packet.Assignment.Card.ID || card.ContextSources[packet.Alias] != packet.Expected {
		t.Fatal("fresh authorized assignment differs from reviewed card/source")
	}
	if card.AssignmentLLM.Provider != provider.Name() || card.AssignmentLLM.Model == "" {
		t.Fatal("unexpected backend provider/model")
	}
	loop.SetAssignmentLLM(card.AssignmentLLM)
	executionID, err := client.LogExecutionStartWithLLM(ctx, packet.AgentID, packet.Workspace,
		packet.Assignment.StageAction, card.BoardID, card.CardID, "Synthetic booking continuation",
		packet.Assignment.Role, card.AssignmentLLM.PromptSlug, card.AssignmentLLM.Model, card.AssignmentLLM.Provider)
	if err != nil {
		t.Fatal(err)
	}
	_, runErr := strategy.executeLLM(ctx, ctx, loop, card, executionID, packet.Repo)
	evidence := map[string]any{
		"evidence_kind": "real-ClaudeCLI-through-production-runner-dispatch",
		"execution_id":  executionID, "provider": provider.Name(), "model": provider.options.Model,
		"prompt": provider.prompt, "prompt_sha256": hexDigest([]byte(provider.prompt)),
		"prompt_bytes": len(provider.prompt), "system_prompt_bytes": len(provider.options.SystemPrompt),
		"packet_sha256": hexDigest(raw), "fresh_session": provider.options.ResumeSessionID == "",
	}
	if provider.result != nil {
		result := provider.result
		evidence["exit_code"], evidence["session_id"], evidence["output"] = result.ExitCode, result.SessionID, result.Output
		evidence["input_tokens"], evidence["output_tokens"] = result.InputTokens, result.OutputTokens
		evidence["cache_creation_tokens"], evidence["cache_read_tokens"] = result.CacheCreationTokens, result.CacheReadTokens
		evidence["duration_seconds"], evidence["runner_reported_cost_usd"] = result.Duration.Seconds(), result.CostUSD
	}
	if runErr != nil {
		evidence["error"] = runErr.Error()
	}
	encoded, err := json.MarshalIndent(evidence, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(out, "provider.json"), append(encoded, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	if runErr != nil {
		t.Fatal(runErr)
	}
	if provider.result == nil || provider.result.ExitCode != 0 || provider.result.SessionID == "" {
		t.Fatal("provider did not finish a real identified session")
	}
}
