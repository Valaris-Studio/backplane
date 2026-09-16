// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// FIX #3 (run-B): an approval must PARK-and-continue, not block the
// single-threaded work loop and then FAIL the card on deadline lapse. Live: I5
// raised an honest signing/SMOKE approval, the loop blocked ~18 min (I6 sat
// ready, unworked), then the lapse routed I5 to its FAILURE path and recorded
// an unjust failure. The fix: a pending approval parks the card intrinsically
// (`awaiting-approval` label + unassign + note, NO failure), the tick ends
// promptly so the loop works other cards, and the parked card resumes the SAME
// implement session when the approval is decided — via the per-poll-cycle
// status check (the approval-decided WS event wakes the same poll loop).

// approvalParkServer records the wire effects of parking + resuming an
// approval-gated card. Approval status is mutable so a test can park on
// "pending" and then drive the decision.
type approvalParkServer struct {
	URL string

	mu             sync.Mutex
	approvalStatus string
	decisionReason string
	cardGETLabels  []string
	failClaims     bool // when true, POST .../claim returns 409

	patches     []map[string]any  // PATCH /cards/{id} bodies
	notes       []map[string]any  // POST .../notes bodies
	unassigns   []string          // DELETE .../participants/{uid} paths
	claims      []string          // POST .../claim paths
	moves       []map[string]any  // PATCH .../move bodies
	execPatches []recordedRequest // PATCH /executions/{id}
	warnings    []recordedRequest // POST /executions/{id}/warnings

	// seq is the ordered semantic event log: "claim",
	// "patch-labels-with-awaiting", "patch-labels-without-awaiting". Order
	// assertions (L6: claim must precede label removal) read it via seqIndex.
	seq []string
}

func newApprovalParkServer(t *testing.T, boardID string) *approvalParkServer {
	t.Helper()
	s := &approvalParkServer{approvalStatus: "pending"}

	columns := []map[string]any{
		{"id": "col-backlog", "name": "To Do", "column_type": "backlog", "position": 1024.0},
		{"id": "col-active", "name": "Active", "column_type": "active", "position": 2048.0},
		{"id": "col-review", "name": "Review", "column_type": "review", "position": 3072.0},
		{"id": "col-done", "name": "Done", "column_type": "done", "position": 4096.0},
		// Deliberately NO `blocked` column — parking must be intrinsic.
	}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		body, _ := io.ReadAll(r.Body)
		var decoded map[string]any
		_ = json.Unmarshal(body, &decoded)
		path := r.URL.Path

		switch {
		case strings.Contains(path, "/approvals/") && r.Method == http.MethodGet:
			s.mu.Lock()
			resp := map[string]any{"id": "appr-park", "status": s.approvalStatus}
			if s.decisionReason != "" {
				resp["decision_reason"] = s.decisionReason
			}
			s.mu.Unlock()
			_ = json.NewEncoder(w).Encode(resp)
			return

		case strings.HasSuffix(path, "/warnings") && r.Method == http.MethodPost:
			s.mu.Lock()
			s.warnings = append(s.warnings, recordedRequest{Method: r.Method, Path: path, Body: string(body)})
			s.mu.Unlock()
			w.WriteHeader(http.StatusAccepted)

		case strings.Contains(path, "/heartbeat"):
			_ = json.NewEncoder(w).Encode(map[string]any{"id": "agent-1", "name": "test", "agent_type": "coding", "is_active": true})
			return

		case strings.Contains(path, "/prompt-configs"):
			_ = json.NewEncoder(w).Encode([]any{})
			return

		case strings.Contains(path, "/budget-status"):
			_ = json.NewEncoder(w).Encode(map[string]any{"is_exceeded": false, "spent_usd": 1.0, "budget_usd": 100.0})
			return

		case strings.Contains(path, "/executions") && r.Method == http.MethodPost:
			_ = json.NewEncoder(w).Encode(map[string]string{"id": "exec-resume"})
			return

		case strings.Contains(path, "/executions/") && r.Method == http.MethodPatch:
			s.mu.Lock()
			s.execPatches = append(s.execPatches, recordedRequest{Method: r.Method, Path: path, Body: string(body)})
			s.mu.Unlock()

		case strings.HasSuffix(path, "/claim") && r.Method == http.MethodPost:
			s.mu.Lock()
			s.claims = append(s.claims, path)
			s.seq = append(s.seq, "claim")
			failClaim := s.failClaims
			s.mu.Unlock()
			if failClaim {
				w.WriteHeader(http.StatusConflict)
				_, _ = w.Write([]byte(`{"detail":"already claimed"}`))
				return
			}

		case strings.HasSuffix(path, "/move") && r.Method == http.MethodPatch:
			s.mu.Lock()
			s.moves = append(s.moves, decoded)
			s.mu.Unlock()

		case strings.HasSuffix(path, "/notes") && r.Method == http.MethodPost:
			s.mu.Lock()
			s.notes = append(s.notes, decoded)
			s.mu.Unlock()

		case strings.HasSuffix(path, "/notes") && r.Method == http.MethodGet:
			_, _ = w.Write([]byte("[]"))
			return

		case strings.Contains(path, "/participants/") && r.Method == http.MethodDelete:
			s.mu.Lock()
			s.unassigns = append(s.unassigns, path)
			s.mu.Unlock()

		case strings.Contains(path, "/boards/"+boardID) && r.Method == http.MethodGet &&
			!strings.Contains(path, "/cards") && !strings.Contains(path, "/git-repos") && !strings.Contains(path, "/context"):
			_ = json.NewEncoder(w).Encode(map[string]any{"id": boardID, "name": "B", "columns": columns})
			return

		case strings.HasSuffix(path, "/boards") && r.Method == http.MethodGet:
			_ = json.NewEncoder(w).Encode([]valaris.Board{})
			return

		case strings.Contains(path, "/cards/search"):
			_ = json.NewEncoder(w).Encode([]valaris.Card{})
			return

		case strings.Contains(path, "/cards/") && r.Method == http.MethodGet:
			s.mu.Lock()
			labels := append([]string{}, s.cardGETLabels...)
			s.mu.Unlock()
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": "card-gated", "title": "Gated", "description": "",
				"labels": labels, "participants": []any{},
			})
			return

		case strings.Contains(path, "/cards/") && r.Method == http.MethodPatch:
			s.mu.Lock()
			s.patches = append(s.patches, decoded)
			if arr, ok := decoded["labels"].([]any); ok {
				event := "patch-labels-without-awaiting"
				for _, l := range arr {
					if v, _ := l.(string); v == awaitingApprovalLabel {
						event = "patch-labels-with-awaiting"
						break
					}
				}
				s.seq = append(s.seq, event)
			}
			s.mu.Unlock()
		}

		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)
	s.URL = srv.URL
	return s
}

func (s *approvalParkServer) setApproval(status, reason string) {
	s.mu.Lock()
	s.approvalStatus = status
	s.decisionReason = reason
	s.mu.Unlock()
}

func (s *approvalParkServer) setCardLabels(labels ...string) {
	s.mu.Lock()
	s.cardGETLabels = labels
	s.mu.Unlock()
}

func (s *approvalParkServer) labelPatched(label string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.patches {
		arr, ok := p["labels"].([]any)
		if !ok {
			continue
		}
		for _, l := range arr {
			if v, _ := l.(string); v == label {
				return true
			}
		}
	}
	return false
}

// labelsPatchedWithout reports whether some labels-PATCH excluded the label —
// the wire signature of removeLabel when the card GET carried it.
func (s *approvalParkServer) labelsPatchedWithout(label string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.patches {
		arr, ok := p["labels"].([]any)
		if !ok {
			continue
		}
		found := false
		for _, l := range arr {
			if v, _ := l.(string); v == label {
				found = true
				break
			}
		}
		if !found {
			return true
		}
	}
	return false
}

func (s *approvalParkServer) execPatchedStatus(execID, status string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.execPatches {
		if !strings.Contains(p.Path, "/executions/"+execID) {
			continue
		}
		var decoded map[string]any
		_ = json.Unmarshal([]byte(p.Body), &decoded)
		if v, _ := decoded["status"].(string); v == status {
			return true
		}
	}
	return false
}

func (s *approvalParkServer) anyExecFailed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.execPatches {
		var decoded map[string]any
		_ = json.Unmarshal([]byte(p.Body), &decoded)
		if v, _ := decoded["status"].(string); v == "failed" {
			return true
		}
	}
	return false
}

func (s *approvalParkServer) noteTitled(title string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, n := range s.notes {
		if v, _ := n["title"].(string); v == title {
			return true
		}
	}
	return false
}

func (s *approvalParkServer) movedToColumn(colID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, m := range s.moves {
		if v, _ := m["column_id"].(string); v == colID {
			return true
		}
	}
	return false
}

func (s *approvalParkServer) warningCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.warnings)
}

// seqIndex returns the position of the FIRST occurrence of the semantic event
// in the ordered request log, or -1 when it never happened.
func (s *approvalParkServer) seqIndex(event string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, e := range s.seq {
		if e == event {
			return i
		}
	}
	return -1
}

func (s *approvalParkServer) seqSnapshot() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string{}, s.seq...)
}

// approvalParkStrategy is an implementer-shaped stage with approvals enabled —
// the shape that raised the live I5 approval.
func approvalParkStrategy() *DataDrivenStrategy {
	return NewDataDrivenStrategy(valaris.StageConfig{
		Role:  "implementer",
		Claim: valaris.ClaimDef{ParticipantRole: "hero", ExecutionAction: "implement_card"},
		Git:   valaris.GitDef{Action: "create_branch"},
		LLM: valaris.LLMDef{
			Enabled: true, Stage: "implement",
			PostProcessKind: "writes_code", ApprovalEnabled: true,
		},
		OnSuccess: valaris.ActionDef{MoveToColumnType: "review"},
		OnFailure: valaris.ActionDef{MoveToColumnType: "backlog", Unassign: true},
	}, nil)
}

// parkGatedCard drives handleApproval against a pending approval and asserts
// the park happened (nil error + awaiting sentinel). Returns the parked card.
func parkGatedCard(t *testing.T, srv *approvalParkServer, loop *Loop, strat *DataDrivenStrategy, gitMgr *git.Manager, withWIP bool) (*discoverResult, string) {
	t.Helper()
	bare := initBareRemote(t)
	repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, "card-gated")
	if err != nil {
		t.Fatalf("clone: %v", err)
	}
	// Same branch naming as gitSetupWithConfig so the resume pass recovers the
	// park-time branch (and its WIP checkpoint) instead of creating a new one.
	branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, sanitizeBranch("card-gated", "Gated work"), "main")
	if err != nil {
		t.Fatalf("branch: %v", err)
	}
	if withWIP {
		// The stage wrote partial work before raising the approval — the park
		// must checkpoint it so the resume pass can build on it.
		if err := os.WriteFile(filepath.Join(repoDir, "partial.txt"), []byte("wip\n"), 0644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}

	card := &discoverResult{
		CardID: "card-gated", BoardID: "board-1", Title: "Gated work",
		GitRepoURL: bare, GitRepoName: "card-gated", DefaultBranch: "main",
	}
	implRes := &implementResult{
		Status:     "needs_approval",
		ApprovalID: "appr-park",
		Summary:    "human must confirm the signing handoff",
	}

	res, err := strat.handleApproval(context.Background(), context.Background(), loop, card, "exec-park", repoDir, implRes)
	if err != nil {
		t.Fatalf("handleApproval on a pending approval must park, not error: %v", err)
	}
	if res == nil || res.Status != statusAwaitingApproval {
		t.Fatalf("handleApproval must return the awaiting-approval sentinel, got %+v", res)
	}
	return card, branch
}

// (a)+(b): a pending approval parks the card and ends the tick promptly as a
// NON-failure — label stamped, participant removed, board-visible note, the
// execution closed (not dangling `running`, not `failed`), zero failure strikes
// and zero LLM spend. The loop is then free to reserve other cards.
func TestHandleApproval_PendingApproval_ParksCardAndEndsTickNonFailure(t *testing.T) {
	srv := newApprovalParkServer(t, "board-1")
	cfg := testConfig()
	// Old behavior blocked the tick for ApprovalMaxWait then failed the card.
	// Keep it large so a regression is caught by the promptness assertion.
	cfg.WorkLoop.ApprovalMaxWait = 5 * time.Second

	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := llm.NewMockProvider()
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, cfg)
	strat := approvalParkStrategy()

	start := time.Now()
	card, branch := parkGatedCard(t, srv, loop, strat, gitMgr, true)
	if elapsed := time.Since(start); elapsed > 2*time.Second {
		t.Errorf("park must end the tick promptly (no synchronous approval wait), took %s", elapsed)
	}

	// Intrinsic park: dedicated label (distinct from `blocked` — this is a
	// wait, not a defect) + participant removed.
	if !srv.labelPatched(awaitingApprovalLabel) {
		t.Errorf("park must stamp the %q label, patches=%v", awaitingApprovalLabel, srv.patches)
	}
	if len(srv.unassigns) == 0 {
		t.Error("park must remove the agent participant")
	}
	// Board-visible explanation.
	if !srv.noteTitled("Card parked awaiting human approval") {
		t.Errorf("park must write the awaiting-approval note, notes=%v", srv.notes)
	}
	// Execution closed, not dangling and NOT failed.
	if !srv.execPatchedStatus("exec-park", "aborted") {
		t.Errorf("park must close the raising execution as aborted, exec_patches=%v", srv.execPatches)
	}
	if srv.anyExecFailed() {
		t.Errorf("park must NOT fail any execution, exec_patches=%v", srv.execPatches)
	}
	if n := loop.CardFailureCount(card.CardID); n != 0 {
		t.Errorf("park must NOT record a card failure, count=%d", n)
	}
	if mock.CallCount() != 0 {
		t.Errorf("park must not burn an LLM call, calls=%d", mock.CallCount())
	}
	// Registry holds the resume token.
	if n := loop.parkedApprovalCount(); n != 1 {
		t.Fatalf("park must register exactly one parked approval, got %d", n)
	}

	// WIP checkpoint: the pre-approval working-tree changes were committed on
	// the card branch (clean tree + ahead of default) so resume builds on them.
	repoDir := filepath.Join(gitMgr.BaseDir, "card-gated")
	if err := gitMgr.CheckoutBranch(context.Background(), repoDir, branch); err != nil {
		t.Fatalf("checkout %s: %v", branch, err)
	}
	hasChanges, err := gitMgr.HasChanges(context.Background(), repoDir)
	if err != nil {
		t.Fatalf("HasChanges: %v", err)
	}
	if hasChanges {
		t.Error("park must checkpoint pre-approval WIP (working tree should be clean)")
	}
	ahead, err := gitMgr.CommitsAheadOfRemoteDefault(context.Background(), repoDir, "main")
	if err != nil {
		t.Fatalf("CommitsAhead: %v", err)
	}
	if ahead == 0 {
		t.Error("park must commit the WIP checkpoint on the card branch (0 commits ahead)")
	}
}

// (a): with the gated card parked, the legacy scans skip it and reserve a
// DIFFERENT eligible card — no idle wait, no re-reservation of the parked one.
func TestDiscoverColumnScan_AwaitingApprovalExcludedAndNextCardReserved(t *testing.T) {
	cards := []valaris.Card{
		{ID: "card-gated", BoardID: "board-1", Title: "Parked", ColumnType: "active", Labels: []string{awaitingApprovalLabel}},
		{ID: "card-free", BoardID: "board-1", Title: "Ready", ColumnType: "active"},
	}
	server := newLabelAwareScanServer(t, cards, true)
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "implementer",
		Discover: valaris.DiscoverDef{
			Strategy:   "column_scan",
			ColumnType: "active",
			// No exclude_label filter — the exclusion must be built in, so the
			// runner is safe even before the backend config adds it.
			Filters: map[string]any{"require_git_repo": true},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverColumnScan(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverColumnScan: %v", err)
	}
	if res.CardID != "card-free" {
		t.Errorf("scan must skip the awaiting-approval card and reserve the next eligible one, got %q", res.CardID)
	}
}

// (b): same built-in hard exclusion on the other legacy fallback, Loop.discover.
func TestLegacyDiscover_AwaitingApprovalLabelIsBuiltInHardExclusion(t *testing.T) {
	cards := []valaris.Card{
		{ID: "card-gated", BoardID: "board-1", Title: "Parked", ColumnType: "active", Labels: []string{awaitingApprovalLabel}},
	}
	server := newLabelAwareScanServer(t, cards, true)
	defer server.Close()

	loop := mustNewLoop(t, testClientWithURL(server.URL), llm.NewMockProvider(),
		&git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}, testConfig())

	res, err := loop.discover(context.Background(), "", false)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if res.CardID != "" {
		t.Errorf("an awaiting-approval card must never be reserved by legacy discover, got %q", res.CardID)
	}
}

// (c): when the approval is decided "approved", the per-cycle check resumes the
// card: label removed, participant re-added (idempotent claim), the SAME stored
// implement session resumed, and the result flows through the same post-LLM
// machinery (the WIP checkpoint makes the branch ahead → proceed to ship/review).
func TestResumeDecidedApprovals_ApprovedResumesSameSessionThroughPostLLMMachinery(t *testing.T) {
	srv := newApprovalParkServer(t, "board-1")
	cfg := testConfig()
	cfg.Git.AutoPR = false // no gh in tests

	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	postApprovalResp := mustJSON(t, map[string]string{"status": "done", "summary": "finished after approval"})
	mock := llm.NewMockProvider(postApprovalResp)
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, cfg)
	loop.sessions = NewSessionStore()
	loop.sessions.Set("agent-1", "card-gated", "implement", "sess-park-1")
	strat := approvalParkStrategy()

	card, _ := parkGatedCard(t, srv, loop, strat, gitMgr, true)

	// Decision arrives. The card GET now carries the park label so the resume's
	// removeLabel has something to strip.
	srv.setCardLabels(awaitingApprovalLabel)
	srv.setApproval("approved", "")

	loop.resumeDecidedApprovals(context.Background())

	if mock.CallCount() != 1 {
		t.Fatalf("resume must run exactly one post-approval LLM pass, got %d", mock.CallCount())
	}
	call := mock.LastCall()
	if call.Options.ResumeSessionID != "sess-park-1" {
		t.Errorf("resume must reuse the stored implement session, got %q", call.Options.ResumeSessionID)
	}
	if !strings.Contains(call.Prompt, "approval was granted") {
		t.Error("resume prompt must be the post-approval continuation prompt")
	}
	if !strings.Contains(call.Prompt, "human must confirm the signing handoff") {
		t.Error("resume prompt must carry the original approval summary")
	}
	if !srv.labelsPatchedWithout(awaitingApprovalLabel) {
		t.Errorf("resume must remove the %q label, patches=%v", awaitingApprovalLabel, srv.patches)
	}
	if len(srv.claims) == 0 {
		t.Error("resume must re-claim the card (idempotent participant re-add)")
	}
	if n := loop.parkedApprovalCount(); n != 0 {
		t.Errorf("resume must clear the parked registry entry, still %d", n)
	}
	// Same post-LLM machinery: the WIP checkpoint left the branch ahead, so the
	// clean post-approval pass proceeds to ship → card moves to review.
	if !srv.movedToColumn("col-review") {
		t.Errorf("resumed card must flow through ship to the review column, moves=%v", srv.moves)
	}
	if n := loop.CardFailureCount(card.CardID); n != 0 {
		t.Errorf("a successful resume must record no failure, count=%d", n)
	}
}

// rejected at decision time: existing terminal semantics (fill the failure
// counter → blocked) applied WITHOUT a synchronous wait — the card swaps to the
// durable `blocked` park, no LLM pass runs.
func TestResumeDecidedApprovals_RejectedAppliesTerminalSemanticsAtDecisionTime(t *testing.T) {
	srv := newApprovalParkServer(t, "board-1")
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := llm.NewMockProvider()
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, testConfig())
	strat := approvalParkStrategy()

	card, _ := parkGatedCard(t, srv, loop, strat, gitMgr, false)

	srv.setCardLabels(awaitingApprovalLabel)
	srv.setApproval("rejected", "too risky")

	loop.resumeDecidedApprovals(context.Background())

	wsCfg := loop.WorkspaceConfig()
	if got := loop.CardFailureCount(card.CardID); got < wsCfg.MaxReworkAttempts {
		t.Errorf("rejection must pre-fill the failure counter to %d, got %d", wsCfg.MaxReworkAttempts, got)
	}
	if !loop.IsCardBlocked(card.CardID) {
		t.Error("rejected card must be circuit-broken")
	}
	if !srv.labelPatched(blockedLabel) {
		t.Errorf("rejected card must swap to the durable `blocked` park, patches=%v", srv.patches)
	}
	if n := loop.parkedApprovalCount(); n != 0 {
		t.Errorf("rejected approval must clear the registry, still %d", n)
	}
	if mock.CallCount() != 0 {
		t.Errorf("rejection must not run an LLM pass, calls=%d", mock.CallCount())
	}
}

// expired keeps the card parked: a human can still re-decide or unpark. No
// failure, no LLM pass, entry retained.
func TestResumeDecidedApprovals_ExpiredKeepsCardParked(t *testing.T) {
	srv := newApprovalParkServer(t, "board-1")
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := llm.NewMockProvider()
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, testConfig())
	strat := approvalParkStrategy()

	card, _ := parkGatedCard(t, srv, loop, strat, gitMgr, false)
	srv.setApproval("expired", "")

	loop.resumeDecidedApprovals(context.Background())

	if n := loop.parkedApprovalCount(); n != 1 {
		t.Errorf("expired approval must keep the card parked, registry=%d", n)
	}
	if n := loop.CardFailureCount(card.CardID); n != 0 {
		t.Errorf("expired approval must NOT record a failure, count=%d", n)
	}
	if mock.CallCount() != 0 {
		t.Errorf("expired approval must not run an LLM pass, calls=%d", mock.CallCount())
	}
}

// (d): ApprovalMaxWait lapse no longer converts ANYTHING into a failure — the
// card stays parked, the fail endpoint is never hit, and the operator gets a
// periodic typed warning (one per ApprovalMaxWait window, not per poll).
func TestResumeDecidedApprovals_PendingPastMaxWait_WarnsButNeverFails(t *testing.T) {
	srv := newApprovalParkServer(t, "board-1")
	cfg := testConfig()
	cfg.WorkLoop.ApprovalMaxWait = 50 * time.Millisecond

	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := llm.NewMockProvider()
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, cfg)
	strat := approvalParkStrategy()

	card, _ := parkGatedCard(t, srv, loop, strat, gitMgr, false)

	// Lapse the window, approval still pending.
	loop.parkedApprovalsMu.Lock()
	for _, e := range loop.parkedApprovals {
		e.ParkedAt = time.Now().Add(-time.Second)
	}
	loop.parkedApprovalsMu.Unlock()

	loop.resumeDecidedApprovals(context.Background())

	if n := loop.parkedApprovalCount(); n != 1 {
		t.Fatalf("lapsed approval must stay parked, registry=%d", n)
	}
	if srv.anyExecFailed() {
		t.Errorf("lapse must never hit the fail endpoint, exec_patches=%v", srv.execPatches)
	}
	if n := loop.CardFailureCount(card.CardID); n != 0 {
		t.Errorf("lapse must record no failure, count=%d", n)
	}
	if srv.warningCount() == 0 {
		t.Error("lapsed approval must post a board-visible typed warning")
	}
	if !strings.Contains(srv.warnings[0].Path, "/executions/exec-park/warnings") {
		t.Errorf("warning must annotate the raising execution, path=%q", srv.warnings[0].Path)
	}
	var payload map[string]any
	_ = json.Unmarshal([]byte(srv.warnings[0].Body), &payload)
	if got := payload["kind"]; got != "approval_poll_deadline" {
		t.Errorf("warning kind = %v, want approval_poll_deadline", got)
	}

	// Cadence: an immediate second pass inside the same window must not spam.
	before := srv.warningCount()
	loop.resumeDecidedApprovals(context.Background())
	if srv.warningCount() != before {
		t.Errorf("warning must fire once per ApprovalMaxWait window, got %d then %d", before, srv.warningCount())
	}
}

// Wiring: pollCycle checks parked approvals before ticking, so BOTH the poll
// ticker and a WS approval event (which wakes the same poll loop via
// TriggerPoll) drive the resume without any synchronous wait.
func TestPollCycle_ResumesDecidedApprovals(t *testing.T) {
	srv := newApprovalParkServer(t, "board-1")
	cfg := testConfig()
	cfg.Git.AutoPR = false

	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	postApprovalResp := mustJSON(t, map[string]string{"status": "done", "summary": "finished after approval"})
	mock := llm.NewMockProvider(postApprovalResp)
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, cfg)
	strat := approvalParkStrategy()

	parkGatedCard(t, srv, loop, strat, gitMgr, true)
	srv.setCardLabels(awaitingApprovalLabel)
	srv.setApproval("approved", "")

	if shutdown := loop.pollCycle(context.Background(), context.Background()); shutdown {
		t.Fatal("pollCycle must not shut down")
	}

	if mock.CallCount() != 1 {
		t.Fatalf("pollCycle must resume the decided approval (1 post-approval LLM pass), got %d", mock.CallCount())
	}
	if n := loop.parkedApprovalCount(); n != 0 {
		t.Errorf("pollCycle resume must clear the registry, still %d", n)
	}
}

// L3 (adversarial review): the INSTANT-rejected branch (decision already
// terminal at raise time) must end with the same restart-durable park as the
// decided-later path (rejectDecidedApproval): `blocked` label stamped, not just
// the in-memory counter. The route: handleApproval pre-fills the failure
// counter → tickCard's blocked-status handling → failWithConfig sees the
// counter at threshold → failExecutionTo("blocked") → M2 stamps the label.
// This test pins that whole chain so a refactor of any link re-fails it.
func TestTickCard_InstantRejectedApproval_StampsBlockedLabel(t *testing.T) {
	srv := newApprovalParkServer(t, "board-1")
	srv.setApproval("rejected", "too risky")

	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := llm.NewMockProvider(mustJSON(t, map[string]string{
		"status": "needs_approval", "approval_id": "appr-park",
		"summary": "human must confirm the signing handoff",
	}))
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, testConfig())
	strat := approvalParkStrategy()

	bare := initBareRemote(t)
	card := &discoverResult{
		CardID: "card-gated", BoardID: "board-1", Title: "Gated work",
		GitRepoURL: bare, GitRepoName: "card-gated", DefaultBranch: "main",
	}

	if err := strat.tickCard(context.Background(), context.Background(), loop, card, silentLogger()); err != nil {
		t.Fatalf("instant-rejected tick must absorb the rejection (nil), got %v", err)
	}

	// Terminal semantics: counter filled + breaker engaged (existing behavior).
	wsCfg := loop.WorkspaceConfig()
	if got := loop.CardFailureCount(card.CardID); got < wsCfg.MaxReworkAttempts {
		t.Errorf("instant rejection must pre-fill the failure counter to %d, got %d", wsCfg.MaxReworkAttempts, got)
	}
	if !loop.IsCardBlocked(card.CardID) {
		t.Error("instant-rejected card must be circuit-broken")
	}
	// L3 core: the DURABLE half — the `blocked` label must be stamped exactly
	// like rejectDecidedApproval does, or a restart/backend never sees the park.
	if !srv.labelPatched(blockedLabel) {
		t.Errorf("instant rejection must stamp the durable `blocked` label, patches=%v", srv.patches)
	}
	// Instant path never parks an approval entry and burns no post-approval pass.
	if n := loop.parkedApprovalCount(); n != 0 {
		t.Errorf("instant rejection must not register a parked approval, got %d", n)
	}
	if mock.CallCount() != 1 {
		t.Errorf("instant rejection must not run a post-approval LLM pass, calls=%d", mock.CallCount())
	}
}

// L6 (adversarial review): the resume must CLAIM (idempotent) BEFORE removing
// the awaiting-approval label. In a multi-agent deployment the label is the
// only thing keeping siblings' /next-assignment off the card; removing it
// before the claim opens a reservation race window.
func TestResumeDecidedApprovals_ClaimsBeforeRemovingParkLabel(t *testing.T) {
	srv := newApprovalParkServer(t, "board-1")
	cfg := testConfig()
	cfg.Git.AutoPR = false

	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := llm.NewMockProvider(mustJSON(t, map[string]string{"status": "done", "summary": "finished after approval"}))
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, cfg)
	strat := approvalParkStrategy()

	parkGatedCard(t, srv, loop, strat, gitMgr, true)
	srv.setCardLabels(awaitingApprovalLabel)
	srv.setApproval("approved", "")

	loop.resumeDecidedApprovals(context.Background())

	claimIdx := srv.seqIndex("claim")
	removeIdx := srv.seqIndex("patch-labels-without-awaiting")
	if claimIdx == -1 {
		t.Fatalf("resume must claim the card, seq=%v", srv.seqSnapshot())
	}
	if removeIdx == -1 {
		t.Fatalf("resume must remove the awaiting-approval label, seq=%v", srv.seqSnapshot())
	}
	if claimIdx > removeIdx {
		t.Errorf("resume must claim BEFORE removing the park label (sibling-reservation window): claim@%d, removal@%d, seq=%v",
			claimIdx, removeIdx, srv.seqSnapshot())
	}
}

// L6 companion: when the resume claim fails, the card must stay fully parked —
// registry entry re-recorded AND label never removed (with claim-first ordering
// the label is untouched, so the park survives without a re-add) — and no LLM
// pass runs. The next cycle retries.
func TestResumeDecidedApprovals_ClaimFailure_KeepsCardParkedAndLabeled(t *testing.T) {
	srv := newApprovalParkServer(t, "board-1")
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := llm.NewMockProvider()
	loop := mustNewLoop(t, testClientWithURL(srv.URL), mock, gitMgr, testConfig())
	strat := approvalParkStrategy()

	card, _ := parkGatedCard(t, srv, loop, strat, gitMgr, false)
	srv.setCardLabels(awaitingApprovalLabel)
	srv.setApproval("approved", "")
	srv.mu.Lock()
	srv.failClaims = true
	srv.mu.Unlock()

	loop.resumeDecidedApprovals(context.Background())

	if n := loop.parkedApprovalCount(); n != 1 {
		t.Errorf("claim failure must re-park the approval for the next cycle, registry=%d", n)
	}
	if idx := srv.seqIndex("patch-labels-without-awaiting"); idx != -1 {
		t.Errorf("claim failure must leave the awaiting-approval label in place (never removed), seq=%v", srv.seqSnapshot())
	}
	if mock.CallCount() != 0 {
		t.Errorf("claim failure must not run an LLM pass, calls=%d", mock.CallCount())
	}
	if n := loop.CardFailureCount(card.CardID); n != 0 {
		t.Errorf("a transient claim failure must not strike the card, count=%d", n)
	}
}
