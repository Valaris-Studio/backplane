// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// FIX #3 (run-B) — approval PARK-and-continue.
//
// The work loop is single-threaded over work, and a stage that raised an
// approval used to wait synchronously inside its tick: zero polls, zero
// other-card work until the human decided or ApprovalMaxWait lapsed — and the
// lapse routed a legitimately human-gated card to its FAILURE path (live: I5
// idled the whole pipeline ~18 min, then collected an unjust failure while I6
// sat ready and eligible). PARK is the replacement outcome: record a resume
// token, make the card intrinsically invisible to every discover (a dedicated
// `awaiting-approval` label — the same restart-durable primitive as the FIX #5
// `blocked` label, but semantically a WAIT, not a defect), release the
// reservation without any failure strike, and end the tick so the loop keeps
// working other cards. The parked card resumes its original implement session
// when the approval is decided. Signal-keyed and white-label: any role, any
// approval.

// awaitingApprovalLabel is the durable, backend-visible park signal for an
// approval-gated card. Distinct from blockedLabel on purpose — `blocked` means
// "a defect needs a human", `awaiting-approval` means "a human decision is the
// next pipeline step". Both are built-in hard exclusions in every legacy
// discover (see cardIntrinsicallyParked), so no build role can re-reserve the
// card even before the backend config's exclude_label lists catch up.
const awaitingApprovalLabel = "awaiting-approval"

// statusAwaitingApproval is the sentinel implementResult.Status the park path
// returns so both tick flows (legacy tickCard and the lifecycle walker) end the
// stage as a clean non-failure stop instead of flowing into commit/post-action.
const statusAwaitingApproval = "awaiting_approval"

// parkedApproval is one resume token: everything needed to continue a card
// after its approval is decided. The implement session itself lives in the
// SessionStore (keyed agent/card/stage); SessionID here is informational.
//
// The registry is in-memory only — lost on restart BY DESIGN (scope kept
// tight): the awaiting-approval label keeps the card safely parked and
// invisible across restarts, and a human unparks it by deciding the approval
// and removing the label (or re-triggering the card). Run() logs this on
// startup.
type parkedApproval struct {
	ApprovalID  string
	CardID      string
	Role        string
	ExecutionID string // the (aborted) execution that raised the approval; periodic warnings annotate it
	Summary     string // the stage's summary at raise time → ApprovalSummary on resume
	SessionID   string
	Card        *discoverResult
	Strategy    *DataDrivenStrategy // fallback when the role left ownedStrategies
	ParkedAt    time.Time
	LastWarnAt  time.Time
}

func (l *Loop) parkApproval(e *parkedApproval) {
	l.parkedApprovalsMu.Lock()
	defer l.parkedApprovalsMu.Unlock()
	l.parkedApprovals[e.CardID] = e
}

func (l *Loop) unparkApproval(cardID string) {
	l.parkedApprovalsMu.Lock()
	defer l.parkedApprovalsMu.Unlock()
	delete(l.parkedApprovals, cardID)
}

func (l *Loop) parkedApprovalCount() int {
	l.parkedApprovalsMu.Lock()
	defer l.parkedApprovalsMu.Unlock()
	return len(l.parkedApprovals)
}

func (l *Loop) parkedApprovalSnapshot() []*parkedApproval {
	l.parkedApprovalsMu.Lock()
	defer l.parkedApprovalsMu.Unlock()
	out := make([]*parkedApproval, 0, len(l.parkedApprovals))
	for _, e := range l.parkedApprovals {
		out = append(out, e)
	}
	return out
}

// strategyForParkedApproval resolves the strategy that resumes a parked card.
// Prefer the live owned strategy for the role (it survives config refreshes);
// fall back to the instance captured at park time so a role dropped from the
// pipeline mid-park can still finish its card.
func (l *Loop) strategyForParkedApproval(e *parkedApproval) *DataDrivenStrategy {
	if s, ok := l.ownedStrategies[e.Role].(*DataDrivenStrategy); ok && s != nil {
		return s
	}
	return e.Strategy
}

// resumeDecidedApprovals is the poll-fallback half of the resume trigger: one
// cheap GET per parked approval per poll cycle. The WS half needs no dedicated
// code — routeEvent already wakes TriggerPoll on every approval.* event, which
// runs pollCycle, which runs this. Decision semantics:
//
//	approved/auto_approved → resume the same implement session
//	rejected               → existing terminal semantics, applied NOW
//	expired                → KEEP parked (a human can re-decide or unpark)
//	pending / fetch error  → keep parked; periodic typed warning for visibility
func (l *Loop) resumeDecidedApprovals(ctx context.Context) {
	for _, e := range l.parkedApprovalSnapshot() {
		approval, err := l.client.GetApprovalStatus(ctx, l.cfg.Valaris.WorkspaceSlug, e.ApprovalID)
		if err != nil {
			slog.Warn("parked approval status check failed; card stays parked",
				"card_id", e.CardID, "approval_id", e.ApprovalID, "error", err)
			continue
		}

		switch approval.Status {
		case "approved", "auto_approved":
			l.unparkApproval(e.CardID)
			s := l.strategyForParkedApproval(e)
			if s == nil {
				slog.Error("no strategy available to resume approved card — card stays labeled for a human",
					"card_id", e.CardID, "role", e.Role)
				continue
			}
			if err := s.resumeApprovedCard(ctx, l, e, approval); err != nil {
				slog.Error("resuming approved card failed", "card_id", e.CardID, "error", err)
			}

		case "rejected":
			l.unparkApproval(e.CardID)
			if s := l.strategyForParkedApproval(e); s != nil {
				s.rejectDecidedApproval(ctx, l, e, approval)
			}

		case "expired":
			slog.Warn("parked approval expired — keeping card parked for a human re-decision or unpark",
				"card_id", e.CardID, "approval_id", e.ApprovalID)
			l.maybeWarnParkedApproval(ctx, e)

		default: // pending
			l.maybeWarnParkedApproval(ctx, e)
		}
	}
}

// maybeWarnParkedApproval keeps a long-pending approval visible: one typed
// approval_poll_deadline warning per ApprovalMaxWait window. ApprovalMaxWait
// is purely a warning cadence now — the lapse NEVER converts into a failure.
func (l *Loop) maybeWarnParkedApproval(ctx context.Context, e *parkedApproval) {
	cadence := l.cfg.WorkLoop.ApprovalMaxWait
	if cadence <= 0 {
		cadence = time.Hour
	}
	l.parkedApprovalsMu.Lock()
	last := e.LastWarnAt
	if last.IsZero() {
		last = e.ParkedAt
	}
	due := time.Since(last) >= cadence
	if due {
		e.LastWarnAt = time.Now()
	}
	parkedFor := time.Since(e.ParkedAt)
	l.parkedApprovalsMu.Unlock()
	if !due {
		return
	}
	l.recordApprovalPollWarning(ctx, e.Card, e.ExecutionID, e.ApprovalID, parkedFor.Round(time.Second))
}

// parkForApproval performs the park: WIP checkpoint → registry entry → label →
// note → unassign → close the raising execution → release the repo checkout.
// Deliberately records NO failure and never clears the implement session — the
// resume pass continues it. Every board mutation is best-effort (the registry
// entry + label are the load-bearing parts); the label uses a dedicated
// background context so a near-dead tickCtx can't drop the only durable signal.
func (s *DataDrivenStrategy) parkForApproval(ctx, tickCtx context.Context, l *Loop, card *discoverResult, execID, repoDir string, implResult *implementResult) (*implementResult, error) {
	ws := l.cfg.Valaris.WorkspaceSlug
	logger := slog.With("card_id", card.CardID, "approval_id", implResult.ApprovalID, "role", s.config.Role)

	// Checkpoint pre-approval WIP so the resume pass builds on it instead of
	// re-creating it from session memory against a wiped tree (mirrors
	// checkpointAndSuspend: commit, then best-effort push).
	if hasChanges, err := l.git.HasChanges(tickCtx, repoDir); err == nil && hasChanges {
		msg := fmt.Sprintf("wip(%s): checkpoint before approval %s", card.CardID, implResult.ApprovalID)
		if err := l.git.CommitAll(tickCtx, repoDir, msg); err != nil {
			logger.Warn("approval park: WIP commit failed; resume will rely on the session", "error", err)
		} else if err := l.git.Push(tickCtx, repoDir); err != nil {
			logger.Warn("approval park: WIP push failed; checkpoint kept locally", "error", err)
		}
	}

	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}
	sessionID := ""
	if l.sessions != nil {
		sessionID = l.sessions.Get(agentID, card.CardID, "implement")
	}

	l.parkApproval(&parkedApproval{
		ApprovalID:  implResult.ApprovalID,
		CardID:      card.CardID,
		Role:        s.config.Role,
		ExecutionID: execID,
		Summary:     implResult.Summary,
		SessionID:   sessionID,
		Card:        card,
		Strategy:    s,
		ParkedAt:    time.Now(),
	})

	labelCtx, cancelLabel := context.WithTimeout(context.Background(), 10*time.Second)
	s.addLabel(labelCtx, l, card, awaitingApprovalLabel)
	cancelLabel()

	body := fmt.Sprintf("**Card parked awaiting human approval** — the stage raised approval `%s` and the card is parked (not failed) until a human decides. The pipeline keeps working other cards meanwhile; this card resumes its original session automatically on approval.", implResult.ApprovalID)
	if implResult.Summary != "" {
		body += "\n\n## What needs approving\n\n" + implResult.Summary
	}
	if err := l.client.CreateNote(tickCtx, ws, card.BoardID, card.CardID, "system",
		"Card parked awaiting human approval", body, "", false); err != nil {
		slog.Warn("approval park: failed to write note", "error", err, "card_id", card.CardID)
	}

	if agentID != "" {
		if err := l.client.RemoveCardParticipant(tickCtx, ws, card.BoardID, card.CardID, agentID); err != nil {
			slog.Warn("approval park: failed to unassign self", "error", err, "card_id", card.CardID)
		}
	}

	// Close the raising execution so it can't dangle as `running` and trip the
	// single-agent busy-guard. "aborted" is terminal (mirrors the budget-suspend
	// precedent in tickViaLifecycle) and is NOT a failure status.
	if agentID != "" && execID != "" {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := l.client.LogExecutionUpdate(cleanupCtx, agentID, execID, "aborted",
			fmt.Sprintf("awaiting human approval %s; card parked", implResult.ApprovalID)); err != nil {
			slog.Warn("approval park: failed to mark execution aborted", "execution_id", execID, "error", err)
		}
		cancel()
	}

	if l.health != nil {
		l.health.RecordSuccess()
	}
	// Free the shared clone for other cards. Empty featureBranch keeps the
	// (checkpointed) card branch alive for the resume pass.
	l.git.Cleanup(ctx, repoDir, "", card.DefaultBranch)

	logger.Info("card parked awaiting approval; loop continues with other work")
	return &implementResult{
		Status:     statusAwaitingApproval,
		ApprovalID: implResult.ApprovalID,
		Summary:    implResult.Summary,
	}, nil
}

// resumeApprovedCard continues a parked card after its approval was granted:
// idempotent re-claim (fresh execution) → unpark label → branch recovery →
// implementAfterApproval on the SAME session → the same post-LLM machinery as
// a normal tick (sensors, commit/push, PR, post-actions).
func (s *DataDrivenStrategy) resumeApprovedCard(ctx context.Context, l *Loop, e *parkedApproval, approval *valaris.ApprovalStatus) error {
	card := e.Card
	logger := slog.With("card_id", card.CardID, "approval_id", e.ApprovalID, "role", s.config.Role)
	logger.Info("approval granted — resuming parked card", "status", approval.Status)

	tickCtx, cancel := context.WithTimeout(ctx, l.cfg.WorkLoop.CardTimeout)
	defer cancel()
	l.resetTickCost()
	// llmOpts/prompt resolution read l.strategy; pin it to the resuming role
	// for the duration of this out-of-band tick (poll-cycle single-threaded,
	// same discipline as scheduledTick).
	prevStrategy := l.strategy
	l.strategy = s
	defer func() { l.strategy = prevStrategy }()
	l.lastTickHadWork = true

	// L6: claim FIRST (idempotent on the backend), THEN drop the park label.
	// The label is the only thing keeping sibling agents' /next-assignment off
	// this card — removing it before the claim opens a reservation race window
	// in multi-agent deployments. Claim-first also simplifies the failure
	// path: a failed claim leaves the label untouched, so re-parking needs no
	// label re-add.
	execID, err := s.claimWithConfig(tickCtx, l, card)
	if err != nil {
		// The human's decision must survive a transient claim failure: the
		// card is still labeled (the park never lifted), so just re-register
		// the resume token and let the next cycle retry.
		l.parkApproval(e)
		return fmt.Errorf("resume claim (%s) card %s: %w", s.config.Role, card.CardID, err)
	}
	logger = logger.With("execution_id", execID)
	defer l.reportCost(ctx, execID)

	s.removeLabel(tickCtx, l, card, awaitingApprovalLabel)

	repoDir, branch, branchRecovered, cleanup, err := s.gitSetupWithConfig(ctx, tickCtx, l, card, false)
	if err != nil {
		return s.handleGitFailure(ctx, l, card, execID, err, s.config)
	}

	implRes, err := l.implementAfterApproval(tickCtx, card, execID, repoDir, e.Summary)
	if err != nil {
		s.failWithConfig(ctx, l, card, execID, fmt.Sprintf("post-approval: %v", err))
		cleanup()
		l.recordFailure(fmt.Sprintf("post-approval: %v", err), card.CardID)
		return fmt.Errorf("post-approval: %w", err)
	}
	if implRes.Status != "done" {
		s.failWithConfig(ctx, l, card, execID, fmt.Sprintf("post-approval blocked: %s", implRes.Summary))
		cleanup()
		l.recordFailure(fmt.Sprintf("post-approval blocked: %s", implRes.Summary), card.CardID)
		return nil
	}
	llmResult := &llmStageResult{implResult: implRes, rawOutput: implRes.Output}

	// Same gates as tickCard steps 4.5–6 so the resumed result flows through
	// identical machinery.
	var sensorRes *sensorResults
	if len(s.config.Sensors) > 0 {
		sensorRes, err = s.runSensors(tickCtx, l, card, execID, repoDir)
		if err != nil {
			s.failWithConfig(ctx, l, card, execID, fmt.Sprintf("sensors failed: %v", err))
			cleanup()
			l.recordFailure(fmt.Sprintf("sensors: %v", err), card.CardID)
			return fmt.Errorf("sensors: %w", err)
		}
		if sensorRes != nil && !sensorRes.allPassed && !sensorRes.hasFailureMapping {
			s.failWithConfig(ctx, l, card, execID, fmt.Sprintf("sensor gate failed: %s", sensorRes.summary))
			cleanup()
			l.recordFailure(fmt.Sprintf("sensor gate: %s", sensorRes.summary), card.CardID)
			return nil
		}
	}

	if s.config.Git.Action == "create_branch" && s.config.LLM.EffectivePostProcessKind() == "writes_code" {
		done, err := s.gitCommitAndPush(ctx, tickCtx, l, card, execID, repoDir, branch, branchRecovered, cleanup, logger, llmResult)
		if err != nil {
			return err
		}
		if done {
			return nil
		}
	}

	return s.postActionWithConfig(ctx, tickCtx, l, card, execID, repoDir, branch, llmResult, sensorRes, cleanup, logger)
}

// rejectDecidedApproval applies the pre-existing rejection semantics — a human
// rejection is terminal: pre-fill the failure counter to the threshold so the
// breaker holds the card, and swap the wait-park for the durable `blocked`
// park — but at DECISION time, with no synchronous wait and no LLM pass.
func (s *DataDrivenStrategy) rejectDecidedApproval(ctx context.Context, l *Loop, e *parkedApproval, approval *valaris.ApprovalStatus) {
	card := e.Card
	reason := ""
	if approval.DecisionReason != nil {
		reason = *approval.DecisionReason
	}
	slog.Warn("approval rejected — blocking parked card",
		"card_id", card.CardID, "approval_id", e.ApprovalID, "reason", reason)

	wsCfg := l.WorkspaceConfig()
	for i := l.CardFailureCount(card.CardID); i < wsCfg.MaxReworkAttempts; i++ {
		l.RecordCardFailure(card.CardID)
	}

	labelCtx, cancelLabel := context.WithTimeout(context.Background(), 10*time.Second)
	s.removeLabel(labelCtx, l, card, awaitingApprovalLabel)
	s.addLabel(labelCtx, l, card, blockedLabel)
	cancelLabel()

	// Cosmetic best-effort move; the label is the load-bearing park (FIX #5).
	if err := l.moveCardToColumnType(ctx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID, "blocked"); err != nil {
		slog.Info("approval rejection: no blocked column to move to (label alone parks the card)",
			"card_id", card.CardID, "error", err)
	}

	body := fmt.Sprintf("**Approval rejected — card blocked.** A human rejected approval `%s`; the card is parked for human follow-up.", e.ApprovalID)
	if reason != "" {
		body += "\n\n## Rejection reason\n\n" + reason
	}
	if err := l.client.CreateNote(ctx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID, "system",
		"Approval rejected — card blocked", body, "", false); err != nil {
		slog.Warn("approval rejection: failed to write note", "error", err, "card_id", card.CardID)
	}
}
