// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"errors"
	"fmt"
	"log/slog"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// Board loops, leased completion work and parked approval resumes have no
// prepared dispatch path. They run only where context dispatch is legacy, and
// refuse rather than infer wherever a required floor holds.

// refuseRequiredDispatch reports why this board loop must not infer: the
// server's current policy requires prepared dispatch, this runner requires
// it, or the policy cannot be established.
func (m *LoopMode) refuseRequiredDispatch(ctx context.Context) error {
	current, err := negotiateDispatch(ctx, m.client, m.cfg, m.agentID)
	if err != nil {
		return fmt.Errorf("context dispatch: board loops cannot run: %w", err)
	}
	if current != nil && current.contract.Mode == valaris.ContextDispatchRequired {
		return errors.New("context dispatch: the server requires prepared dispatch, which board loops and completion work do not support; run this work through a supported pipeline dispatch flow, or have an operator review the workspace dispatch policy")
	}
	return nil
}

// unsupportedFlowWarning is the existing execution warning kind that reports
// a flow required context dispatch cannot run.
const unsupportedFlowWarning = "context_dispatch_unsupported_flow"

// errParkedResumeUnsupported refuses resuming a parked approval under a
// required dispatch floor.
var errParkedResumeUnsupported = errors.New("context dispatch: resuming a parked approval is unsupported under required context dispatch; the card stays parked with its approval, session and labels until an operator reschedules it")

// parkedResumeRequired reports whether resuming e would be required
// inference: its hold was bound under a required floor, this runner requires
// dispatch, or the server's current policy now requires it.
func (l *Loop) parkedResumeRequired(ctx context.Context, e *parkedApproval) (bool, error) {
	if hold := e.Card.Dispatch; hold != nil && hold.stamp.Mode == valaris.ContextDispatchRequired {
		return true, nil
	}
	if l.cfg.ContextDispatch.Require {
		return true, nil
	}
	current, err := l.negotiateDispatch(ctx)
	if err != nil {
		return false, err
	}
	return current != nil && current.contract.Mode == valaris.ContextDispatchRequired, nil
}

// reportParkedResumeUnsupported posts the card's unsupported-flow warning on
// its parked execution, once per park.
func (l *Loop) reportParkedResumeUnsupported(ctx context.Context, e *parkedApproval) {
	l.parkedApprovalsMu.Lock()
	reported := e.unsupportedReported
	l.parkedApprovalsMu.Unlock()
	if reported || e.ExecutionID == "" {
		return
	}
	message := fmt.Sprintf("Card %s is parked awaiting approval %s, and resuming a parked approval is unsupported under required context dispatch. "+
		"It stays parked with its approval decision, session and labels; reschedule the card to run it under the current policy.", e.CardID, e.ApprovalID)
	if err := l.client.PostExecutionWarning(ctx, agentIDOf(l), e.ExecutionID, unsupportedFlowWarning, message, e.CardID); err != nil {
		slog.Warn("could not report an unsupported parked resume; retrying next cycle", "card_id", e.CardID, "error", err)
		return
	}
	l.parkedApprovalsMu.Lock()
	e.unsupportedReported = true
	l.parkedApprovalsMu.Unlock()
}
