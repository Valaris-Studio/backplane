// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"log/slog"
	"sync"

	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// missingPipelineRoleWarned dedups the "step missing pipeline_role" WARN to one
// log line per (role, step-name) so noisy lifecycles don't flood the log.
var missingPipelineRoleWarned sync.Map

// lifecycleClaim wraps DataDrivenStrategy.claimWithConfig. Reads step.Params
// when set (participant_role, execution_action, pipeline_role) to allow
// lifecycles to override the stage-level defaults; falls back to s.config.Claim
// otherwise so hand-converted legacy stages keep working.
//
// Populates WalkState.ExecutionID. Errors propagate as-is — claim is a hard
// gate; without an execution id downstream steps have nothing to log against.
func lifecycleClaim(ctx context.Context, ws *lifecycle.WalkState, step *valaris.LifecycleStep) (string, string, error) {
	l := loopFromWalk(ws)
	s := strategyFromWalk(ws)
	card, err := requireCard(ws, step.Name, step.Kind)
	if err != nil {
		return "", "", err
	}

	// Step-level overrides win when present; otherwise fall through to stage.
	// Per-step values let one stage define multiple claim shapes (e.g., re-
	// claim as helper after a hero claim) without redefining the whole stage.
	prevRole := s.config.Claim.ParticipantRole
	prevAction := s.config.Claim.ExecutionAction
	prevPipelineRole := s.config.Claim.PipelineRole
	if pr := paramString(step, "participant_role", ""); pr != "" {
		s.config.Claim.ParticipantRole = pr
	}
	if ea := paramString(step, "execution_action", ""); ea != "" {
		s.config.Claim.ExecutionAction = ea
	}
	if plr := paramString(step, "pipeline_role", ""); plr != "" {
		s.config.Claim.PipelineRole = plr
	} else if s.config.Claim.PipelineRole == "" {
		// Legacy stage config (no pipeline_role at step or stage level): warn
		// once per (role, step-name) so the operator can fill the gap, then
		// proceed with empty — backend tolerates the absent field.
		dedupKey := s.config.Role + "\x00" + step.Name
		if _, loaded := missingPipelineRoleWarned.LoadOrStore(dedupKey, struct{}{}); !loaded {
			slog.Warn("claim step missing pipeline_role param", "role", s.config.Role, "step", step.Name)
		}
	}
	defer func() {
		s.config.Claim.ParticipantRole = prevRole
		s.config.Claim.ExecutionAction = prevAction
		s.config.Claim.PipelineRole = prevPipelineRole
	}()

	execID, err := s.claimWithConfig(ctx, l, card)
	if err != nil {
		return "", "", err
	}
	ws.ExecutionID = execID
	return "", "", nil
}
