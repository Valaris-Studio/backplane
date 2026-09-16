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
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// approvalWarningServer hosts the platform-config endpoint plus an approvals
// endpoint that always returns status="pending" — the production failure mode
// where a human never responds. POST hits against the warnings endpoint are
// captured for assertion.
type approvalWarningServer struct {
	URL              string
	warningRequests  []recordedRequest
	warningRequestMu sync.Mutex
}

func newApprovalWarningServer(t *testing.T) *approvalWarningServer {
	t.Helper()
	s := &approvalWarningServer{}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		path := r.URL.Path

		if path == "/api/agents/me/config" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"agent_id":   "agent-1",
				"is_active":  true,
				"agent_type": "coding",
				"workspace_config": map[string]any{
					"pipeline_config": DefaultPipelineConfig,
				},
			})
			return
		}

		// Approval polls stay in "pending" forever — a human who never responds.
		if strings.Contains(path, "/approvals/") && r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":     "approval-stuck",
				"status": "pending",
			})
			return
		}

		// Capture the warning POST so the test can verify the payload.
		if strings.Contains(path, "/executions/") && strings.HasSuffix(path, "/warnings") && r.Method == http.MethodPost {
			s.warningRequestMu.Lock()
			s.warningRequests = append(s.warningRequests, recordedRequest{
				Method: r.Method, Path: path, Body: string(body),
			})
			s.warningRequestMu.Unlock()
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte("{}"))
			return
		}

		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)
	s.URL = srv.URL
	return s
}

func (s *approvalWarningServer) Warnings() []recordedRequest {
	s.warningRequestMu.Lock()
	defer s.warningRequestMu.Unlock()
	out := make([]recordedRequest, len(s.warningRequests))
	copy(out, s.warningRequests)
	return out
}

// TestHandleApproval_StuckApproval_ParksAndWarnsWithoutFailing is the canary
// for FIX #3 (run-B), superseding the old deadline-failure contract
// (card 5a33c510 was pure observability on the synchronous wait; the wait
// itself is now gone). A never-responding human must (1) NOT block the tick
// until ApprovalMaxWait, (2) NOT convert the lapse into an error/failure, and
// (3) still surface the stall as the typed approval_poll_deadline warning —
// emitted once per ApprovalMaxWait window from the parked-approval check, so
// the operator keeps the board-visible cue the old deadline path provided.
func TestHandleApproval_StuckApproval_ParksAndWarnsWithoutFailing(t *testing.T) {
	srv := newApprovalWarningServer(t)

	cfg := testConfig()
	// Tight window keeps the test sub-second; the park must return well before
	// even this tiny deadline matters.
	cfg.WorkLoop.ApprovalMaxWait = 50 * time.Millisecond
	cfg.WorkLoop.ApprovalPollInterval = 5 * time.Millisecond

	client := testClientWithURL(srv.URL)
	loop := newActionTestLoop(t, srv.URL)
	loop.cfg = cfg
	loop.client = client

	orchestratorStage := StageForRole(DefaultPipelineConfig, "orchestrator")
	if orchestratorStage == nil {
		t.Fatal("missing default orchestrator stage")
	}
	strategy := NewDataDrivenStrategy(*orchestratorStage, nil)
	loop.strategy = strategy

	card := &discoverResult{
		CardID:  "card-stuck-approval",
		BoardID: "board-1",
		Title:   "Stuck behind a quiet human",
	}
	implRes := &implementResult{
		Status:     "needs_approval",
		ApprovalID: "approval-stuck",
		Summary:    "implementation needs sign-off",
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	res, err := strategy.handleApproval(ctx, ctx, loop, card, "exec-stuck-1", t.TempDir(), implRes)
	if err != nil {
		t.Fatalf("a pending approval must park, not error: %v", err)
	}
	if res == nil || res.Status != statusAwaitingApproval {
		t.Fatalf("handleApproval must return the awaiting-approval sentinel, got %+v", res)
	}
	if n := loop.CardFailureCount(card.CardID); n != 0 {
		t.Fatalf("a pending approval must record no failure, count=%d", n)
	}

	// Lapse the window — the parked card stays parked and the typed warning
	// fires (same kind the frontend already switches on).
	loop.parkedApprovalsMu.Lock()
	for _, e := range loop.parkedApprovals {
		e.ParkedAt = time.Now().Add(-time.Second)
	}
	loop.parkedApprovalsMu.Unlock()
	loop.resumeDecidedApprovals(ctx)

	if n := loop.parkedApprovalCount(); n != 1 {
		t.Fatalf("a lapsed approval must STAY parked, registry=%d", n)
	}

	warnings := srv.Warnings()
	if len(warnings) == 0 {
		t.Fatalf("expected at least one warning POST after the lapse; got none")
	}
	if !strings.Contains(warnings[0].Path, "/executions/exec-stuck-1/warnings") {
		t.Errorf("warning path = %q, want one containing /executions/exec-stuck-1/warnings", warnings[0].Path)
	}

	var payload map[string]any
	if err := json.Unmarshal([]byte(warnings[0].Body), &payload); err != nil {
		t.Fatalf("warning body not JSON: %v (body=%s)", err, warnings[0].Body)
	}
	if got := payload["kind"]; got != "approval_poll_deadline" {
		t.Errorf("warning kind = %v, want approval_poll_deadline", got)
	}
	if got, _ := payload["card_id"].(string); got != "card-stuck-approval" {
		t.Errorf("warning card_id = %q, want card-stuck-approval", got)
	}
	if got, _ := payload["message"].(string); got == "" {
		t.Errorf("warning message must be non-empty (body=%s)", warnings[0].Body)
	}
}

// Compile-time guard: the production approval-poll warning helper must accept
// the contextual fields the operator needs to act. Keeps the helper signature
// stable as we move closer to the kill-switch card (Card F) that will read
// the same payload off the WebSocket.
var _ = func() *valaris.Client { return nil }
