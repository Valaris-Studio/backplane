// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// The input is an actual response from test_reviewed_handoff_continuation.py.
// This records provider-bound bytes; it does not simulate a successful agent
// implementation or claim the copied assignment is still authorized for work.
func TestReviewedHandoffAssignmentReachesProvider(t *testing.T) {
	path := os.Getenv("CONTINUATION_ASSIGNMENT_IN")
	if path == "" {
		t.Skip("requires the synthetic HTTP handoff receipt")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var receipt struct {
		Assignment    valaris.NextAssignmentResponse `json:"assignment"`
		Stage         valaris.StageConfig            `json:"stage"`
		Template      string                         `json:"prompt_template"`
		Workspace     string                         `json:"workspace_slug"`
		AgentID       string                         `json:"agent_id"`
		Alias         string                         `json:"alias"`
		Excluded      []string                       `json:"excluded_markers"`
		RenderedHash  string                         `json:"rendered_context_sha256"`
		PromptCeiling int                            `json:"fixture_prompt_ceiling_bytes"`
	}
	if err := json.Unmarshal(raw, &receipt); err != nil {
		t.Fatal(err)
	}
	expected := receipt.Assignment.Context[receipt.Alias]
	if expected == "" || receipt.Assignment.Role != receipt.Stage.Role {
		t.Fatal("receipt does not describe its configured source and role")
	}
	hash := sha256.Sum256([]byte(expected))
	if hex.EncodeToString(hash[:]) != receipt.RenderedHash {
		t.Fatal("assignment bytes differ from the HTTP qualification receipt")
	}
	var mu sync.Mutex
	var persistedPrompt string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/next-assignment") {
			var request valaris.NextAssignmentRequest
			if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
				t.Error(err)
			}
			if request.BoardID != receipt.Assignment.Board.ID || request.RoleOverride != receipt.Stage.Role {
				t.Errorf("wrong assignment scope: %+v", request)
			}
			_ = json.NewEncoder(w).Encode(receipt.Assignment)
			return
		}
		if r.Method == http.MethodPatch && strings.HasSuffix(r.URL.Path, "/executions/synthetic-transport-execution") {
			var body struct {
				Prompt string `json:"input_prompt"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			mu.Lock()
			persistedPrompt = body.Prompt
			mu.Unlock()
			_, _ = w.Write([]byte("{}"))
			return
		}
		t.Errorf("unexpected request (raw-source fetch is forbidden): %s %s", r.Method, r.URL.Path)
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()
	provider := llm.NewMockProvider(`{"status":"recorded","summary":"Transport probe only; no booking work performed"}`)
	provider.NameOverride = receipt.Assignment.LLM.Provider
	loop := newLLMTestLoop(t, provider, receipt.Stage)
	loop.client = valaris.NewClient(server.URL, "vlr_synthetic_transport_only")
	loop.client.Agent = &valaris.AgentConfig{ID: receipt.AgentID, IsActive: true}
	loop.cfg.Valaris.WorkspaceSlug = receipt.Workspace
	loop.cfg.Valaris.BoardIDs = []string{receipt.Assignment.Board.ID}
	loop.promptCache[receipt.Stage.Role+":"+receipt.Stage.LLM.Stage] = receipt.Template
	strategy := loop.strategy.(*DataDrivenStrategy)
	card, err := strategy.discoverWithConfig(context.Background(), loop)
	if err != nil {
		t.Fatal(err)
	}
	if card.CardID != receipt.Assignment.Card.ID {
		t.Fatal("assignment card changed")
	}
	loop.SetAssignmentLLM(card.AssignmentLLM)
	if _, err := strategy.executeLLM(context.Background(), context.Background(), loop, card,
		"synthetic-transport-execution", t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if provider.CallCount() != 1 {
		t.Fatalf("provider calls: %d", provider.CallCount())
	}
	call := provider.LastCall()
	if !strings.Contains(call.Prompt, expected) {
		t.Fatal("configured arbitrary alias did not reach provider input")
	}
	if !strings.Contains(call.Prompt, "Mandatory: change only the synthetic repository") {
		t.Fatal("mandatory instruction lost")
	}
	for _, marker := range receipt.Excluded {
		if strings.Contains(call.Prompt+call.Options.SystemPrompt, marker) {
			t.Fatalf("private/unselected marker leaked: %s", marker)
		}
	}
	if call.Options.Model != receipt.Assignment.LLM.Model {
		t.Fatalf("resolved model changed: %s", call.Options.Model)
	}
	if len(call.Prompt)+len(call.Options.SystemPrompt) > receipt.PromptCeiling {
		t.Fatal("fixture provider-input ceiling exceeded")
	}
	mu.Lock()
	defer mu.Unlock()
	if persistedPrompt != call.Prompt {
		t.Fatal("prompt receipt does not match provider input")
	}
	promptHash := sha256.Sum256([]byte(call.Prompt))
	qualification := map[string]any{
		"evidence_kind":          "recording-provider-no-inference-no-application-changes",
		"assignment_file_sha256": hexDigest(raw), "prompt": call.Prompt,
		"prompt_sha256": hex.EncodeToString(promptHash[:]), "prompt_bytes": len(call.Prompt),
		"system_prompt_bytes": len(call.Options.SystemPrompt), "model": call.Options.Model,
		"provider": provider.Name(), "persisted_prompt_equals_dispatched": true,
	}
	if output := os.Getenv("CONTINUATION_PROMPT_OUT"); output != "" {
		encoded, err := json.MarshalIndent(qualification, "", "  ")
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(output, append(encoded, '\n'), 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func hexDigest(value []byte) string {
	hash := sha256.Sum256(value)
	return hex.EncodeToString(hash[:])
}
