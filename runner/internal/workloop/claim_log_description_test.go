// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// heroExecutionServer captures the POST body of the first /executions request
// so hero-claim tests can assert on the execution-log payload the runner
// actually sends, rather than on an intermediate helper's return value.
func heroExecutionServer(t *testing.T) (*httptest.Server, func() map[string]any) {
	t.Helper()
	var mu sync.Mutex
	var captured map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		if strings.Contains(r.URL.Path, "/executions") && r.Method == http.MethodPost {
			body, _ := io.ReadAll(r.Body)
			mu.Lock()
			if captured == nil {
				_ = json.Unmarshal(body, &captured)
			}
			mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "exec-hero-log"})
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)

	return srv, func() map[string]any {
		mu.Lock()
		defer mu.Unlock()
		return captured
	}
}

// The hero claim path must describe the execution with the stage's own verb,
// exactly like the helper path already does. A custom role going through this
// path used to be logged "Implementing card" regardless of what the stage does.
func TestHeroClaim_ExecutionDescriptionIsConfigDriven(t *testing.T) {
	tests := []struct {
		name            string
		stage           valaris.StageConfig
		wantDescription string
		wantAction      string
	}{
		{
			name: "built-in implementer keeps the legacy string",
			stage: valaris.StageConfig{
				Role:  "orchestrator",
				Claim: valaris.ClaimDef{ParticipantRole: "hero", ExecutionAction: "implement_card"},
			},
			wantDescription: "Implementing card: card-1",
			wantAction:      "implement_card",
		},
		{
			name: "reviewer running as hero is not logged as implementing",
			stage: valaris.StageConfig{
				Role:  "reviewer",
				Claim: valaris.ClaimDef{ParticipantRole: "hero", ExecutionAction: "review_card"},
			},
			wantDescription: "Reviewing card: card-1",
			wantAction:      "review_card",
		},
		{
			name: "custom role derives its verb from execution_action",
			stage: valaris.StageConfig{
				Role:  "security-auditor",
				Claim: valaris.ClaimDef{ParticipantRole: "hero", ExecutionAction: "audit_card"},
			},
			wantDescription: "Auditing card: card-1",
			wantAction:      "audit_card",
		},
		{
			name: "explicit log_verb overrides the derivation",
			stage: valaris.StageConfig{
				Role:  "security-auditor",
				Claim: valaris.ClaimDef{ParticipantRole: "hero", ExecutionAction: "audit_card", LogVerb: "Double-checking"},
			},
			wantDescription: "Double-checking card: card-1",
			wantAction:      "audit_card",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			srv, getBody := heroExecutionServer(t)

			loop := newLoopForKindTest(t, srv.URL)
			strat := NewDataDrivenStrategy(tt.stage, nil)
			ws := makeWalkState(t, loop, strat, &discoverResult{CardID: "card-1", BoardID: "board-1", Title: "t"})
			step := &valaris.LifecycleStep{Name: "claim", Kind: "claim"}

			if _, _, err := lifecycleClaim(context.Background(), ws, step); err != nil {
				t.Fatalf("lifecycleClaim: %v", err)
			}

			body := getBody()
			if body == nil {
				t.Fatal("expected POST /executions to be captured")
			}
			if got := body["input_summary"]; got != tt.wantDescription {
				t.Errorf("input_summary = %v, want %q", got, tt.wantDescription)
			}
			if got := body["action"]; got != tt.wantAction {
				t.Errorf("action = %v, want %q", got, tt.wantAction)
			}
			if got := body["role"]; got != tt.stage.Role {
				t.Errorf("role = %v, want %q", got, tt.stage.Role)
			}
		})
	}
}
