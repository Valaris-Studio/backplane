// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// Retain a fake executor while exercising the real Codex deny capability report.
type completionUnsupportedDenyProvider struct{ *llm.MockProvider }

func (p *completionUnsupportedDenyProvider) UnenforceableDeny(deny []string) []string {
	return llm.NewCodexCLI().UnenforceableDeny(deny)
}

type completionResultDenyProvider struct{ *llm.MockProvider }

func (p *completionResultDenyProvider) Execute(ctx context.Context, prompt string, opts llm.Options) (*llm.Result, error) {
	result, err := p.MockProvider.Execute(ctx, prompt, opts)
	result.UnenforcedDeny = []string{"WebFetch"}
	return result, err
}

func TestCompletionReviewRejectsUnenforcedConfiguredDenyResult(t *testing.T) {
	repo, sha, _ := completionSourceRepo(t)
	var claim map[string]any
	if err := json.Unmarshal([]byte(completionClaim(t, "review", "mock", repo, sha, nil)), &claim); err != nil {
		t.Fatal(err)
	}
	claim["work"].(map[string]any)["tool_policy"] = map[string]any{"deny": []string{"WebFetch"}}
	encoded, _ := json.Marshal(claim)
	srv := completionRunOnceServer(t, string(encoded))
	provider := &completionResultDenyProvider{llm.NewMockProvider("reviewed")}
	provider.Caps = llm.Capabilities{StructuredOutput: true}
	provider.QueueStructured([]byte(`{"outcome":"passed","summary":"reviewed"}`))
	m := newLoopModeForServer(t, srv.base, provider)
	if err := m.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	assertCompletionAcknowledgment(t, srv, sha, "failed")
}

func TestCompletionReviewRejectsUnenforceableConfiguredDeny(t *testing.T) {
	repo, sha, _ := completionSourceRepo(t)
	var claim map[string]any
	if err := json.Unmarshal([]byte(completionClaim(t, "review", "mock", repo, sha, nil)), &claim); err != nil {
		t.Fatal(err)
	}
	claim["work"].(map[string]any)["tool_policy"] = map[string]any{"deny": []string{"WebFetch"}}
	encoded, _ := json.Marshal(claim)
	srv := completionRunOnceServer(t, string(encoded))
	provider := &completionUnsupportedDenyProvider{llm.NewMockProvider("reviewed")}
	provider.Caps = llm.Capabilities{StructuredOutput: true}
	provider.QueueStructured([]byte(`{"outcome":"passed","summary":"review passed without honoring configured deny"}`))
	m := newLoopModeForServer(t, srv.base, provider)
	if err := m.Run(context.Background()); err == nil || !strings.Contains(err.Error(), "cannot enforce") {
		t.Fatalf("expected preflight compatibility error, got %v", err)
	}
	if provider.CallCount() != 0 {
		t.Fatalf("provider launched %d times despite reporting configured WebFetch deny unenforceable", provider.CallCount())
	}
	if len(srv.claims) != 0 || len(srv.results) != 0 {
		t.Fatal("incompatible review reached claim/result mutation")
	}
}
