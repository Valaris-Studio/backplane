// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"
	"unicode"

	"github.com/Valaris-Studio/backplane/runner/internal/forge"
	"github.com/Valaris-Studio/backplane/runner/internal/harness"
	"github.com/Valaris-Studio/backplane/runner/internal/lifecycle"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// cardSetupTimeout bounds the pre-work phase of a card attempt (claim
// round-trip + git clone/checkout). Generous because a cold clone of a large
// repo is legitimately slow; it exists only so setup cannot hang forever.
const cardSetupTimeout = 10 * time.Minute

// DataDrivenStrategy implements Strategy using a StageConfig definition.
// It replaces the three hardcoded strategy structs (orchestrator, reviewer,
// documentator) with a single generic implementation parameterized by config.
// Given the legacy three-role stages (see pipeline_config_fixtures_test.go),
// behavior is identical to the hardcoded strategies it replaced.
type DataDrivenStrategy struct {
	config  valaris.StageConfig
	sensors *harness.SensorRegistry
}

func NewDataDrivenStrategy(cfg valaris.StageConfig, registry *harness.SensorRegistry) *DataDrivenStrategy {
	return &DataDrivenStrategy{config: cfg, sensors: registry}
}

func (s *DataDrivenStrategy) Name() string           { return s.config.Role }
func (s *DataDrivenStrategy) AllowedTools() []string { return s.config.LLM.Tools }

func (s *DataDrivenStrategy) Tick(ctx context.Context, l *Loop) error {
	// Lifecycle DSL override: when the stage declares an explicit step list,
	// dispatch through the generic walker instead of the legacy flat-config
	// Tick path. Empty Lifecycle preserves bit-for-bit pre-A.2 behavior — every
	// existing test, every existing prod stage, hits the original Tick body
	// below unchanged.
	if len(s.config.Lifecycle) > 0 {
		return s.tickViaLifecycle(ctx, l)
	}

	tickCtx, tickCancel := context.WithTimeout(ctx, l.cfg.WorkLoop.CardTimeout)
	defer tickCancel()

	l.resetTickCost()

	// 1. Discover
	card, err := s.discoverWithConfig(tickCtx, l)
	l.AccumulateDiscoverCost()
	if err != nil {
		return fmt.Errorf("discover (%s): %w", s.config.Role, err)
	}
	if card.CardID == "" {
		// Clear the per-tick assignment stash so a subsequent tick can't
		// accidentally inherit the previous tick's model.
		l.SetAssignmentLLM(valaris.AssignmentLLM{})
		l.SetCardBudgetOverride(nil)
		slog.Debug("no work available", "role", s.config.Role, "idle_backoff", l.idleBackoff)
		l.IncrementIdleBackoff()
		if l.health != nil {
			l.health.RecordSkip()
		}
		return nil
	}

	l.ResetIdleBackoff()
	l.lastTickHadWork = true

	// Stash backend-declared per-stage LLM dispatch so llmOpts prefers it
	// over the runner's yaml model. Cleared on tick exit so the heartbeat
	// goroutine's budget bookkeeping doesn't read stale state.
	l.SetAssignmentLLM(card.AssignmentLLM)
	l.SetCardBudgetOverride(card.BudgetUSDOverride)
	defer l.SetAssignmentLLM(valaris.AssignmentLLM{})
	defer l.SetCardBudgetOverride(nil)

	// Circuit breaker
	if l.IsCardBlocked(card.CardID) {
		slog.Warn("card blocked by circuit breaker, skipping", "role", s.config.Role, "card_id", card.CardID)
		if l.health != nil {
			l.health.RecordSkip()
		}
		// T2.4: no work actually happened — let scheduler fast-forward.
		l.lastTickHadWork = false
		return nil
	}

	// Health tracking
	if l.health != nil {
		l.health.SetStatus("working")
		l.health.SetCurrentCard(card.CardID, card.BoardID)
		defer func() {
			l.health.ClearCurrentCard()
			l.health.SetStatus("idle")
		}()
	}

	logger := slog.With("card_id", card.CardID, "board_id", card.BoardID, "role", s.config.Role)
	logger.Info("found card", "title", card.Title)

	// Budget check. T0.3: fail-closed — if we can't read the budget (backend
	// 500/429, network flake, auth problem), HALT rather than claim work and
	// burn tokens we can't account for. Previously the code logged a warning
	// and proceeded, which during a 429 storm defeated the budget cap entirely.
	// RecordFailure surfaces the reason via last_error in the heartbeat so the
	// frontend can show "budget check failed" without a prose search of logs.
	budget, err := l.client.GetBudgetStatus(tickCtx)
	if err != nil {
		slog.Warn("budget check failed, halting tick (fail-closed)", "error", err, "role", s.config.Role)
		if l.health != nil {
			l.health.RecordFailure(fmt.Sprintf("budget_check_failed: %v", err))
			l.health.RecordSkip()
		}
		// T2.4: no work actually happened — let scheduler fast-forward.
		l.lastTickHadWork = false
		return nil
	} else if budget.IsExceeded {
		slog.Warn("budget exceeded, skipping card",
			"spent_usd", budget.SpentUSD,
			"budget_usd", derefFloat64(budget.BudgetUSD),
			"card_id", card.CardID,
			"role", s.config.Role,
		)
		if l.health != nil {
			l.health.RecordSkip()
		}
		// T2.4: no work actually happened — let scheduler fast-forward.
		l.lastTickHadWork = false
		return nil
	}

	// Orchestrator-style rework branch: the "unassigned_or_rework" discover
	// strategy can return rework cards. Handle them separately.
	if card.Rework && s.config.Discover.Strategy == "unassigned_or_rework" {
		return s.tickRework(ctx, tickCtx, l, card, logger)
	}

	return s.tickCard(ctx, tickCtx, l, card, logger)
}

// tickCard handles the standard card flow: claim → git → llm → post-action.
func (s *DataDrivenStrategy) tickCard(ctx, tickCtx context.Context, l *Loop, card *discoverResult, logger *slog.Logger) error {
	cfg := s.config

	// Setup (claim, git clone) gets its OWN budget rather than spending the
	// card's: a cold clone of a large repo is wall-clock the card never asked
	// for, and charging it against CardTimeout could kill the attempt before the
	// first token. Derived from ctx so it is independent of the tick deadline
	// discovery already ate into, but still bounded — setup must not hang.
	setupCtx, setupCancel := context.WithTimeout(ctx, cardSetupTimeout)
	defer setupCancel()

	// 2. Claim
	execID, err := s.claimWithConfig(setupCtx, l, card)
	if err != nil {
		l.recordFailure(fmt.Sprintf("claim (%s) card %s: %v", cfg.Role, card.CardID, err), card.CardID)
		return fmt.Errorf("claim (%s) card %s: %w", cfg.Role, card.CardID, err)
	}
	logger = logger.With("execution_id", execID)
	logger.Info("card claimed")

	defer l.reportCost(ctx, execID)

	// Orchestrator: check merged PR shortcut. The shortcut bypasses
	// applyApproveMergeGate, so before honoring it we MUST confirm the reviewer
	// recorded an "approve" verdict-of-record (511c20ca). Without this guard a
	// card with a merged PR but a request_changes verdict (or no verdict at
	// all) would ship to Done on red CI.
	if cfg.Claim.ParticipantRole == "hero" && l.isCardPRMerged(setupCtx, card) {
		blocked, reason := s.mergedPRShortcutBlocked(setupCtx, l, card)
		if blocked {
			logger.Warn("merged PR shortcut blocked, falling through to normal flow",
				"reason", reason, "pr_url", card.PRURL)
		} else {
			logger.Info("card has already-merged PR, shipping directly", "pr_url", card.PRURL)
			// Merged-PR shortcut bypasses the branch-decision routing, so use the
			// stage's default OnSuccess target (empty falls back to "review" inside ship).
			if err := l.ship(setupCtx, card, execID, "", card.PRURL, cfg.OnSuccess.MoveToColumnType, nil); err != nil {
				logger.Warn("direct ship of merged PR failed", "error", err)
				l.recordFailure(fmt.Sprintf("ship merged PR: %v", err), card.CardID)
				return fmt.Errorf("ship merged PR: %w", err)
			}
			s.wakeRoles(l, cfg.OnSuccess.WakeRoles)
			if l.health != nil {
				l.health.RecordSuccess()
			}
			l.ClearCardFailure(card.CardID)
			logger.Info("merged PR card shipped directly", "pr", card.PRURL)
			return nil
		}
	}

	// 3. Git setup
	repoDir, branch, branchRecovered, cleanup, err := s.gitSetupWithConfig(ctx, setupCtx, l, card, false)
	if err != nil {
		return s.handleGitFailure(ctx, l, card, execID, err, cfg)
	}

	// The card budget starts HERE, once the workspace is ready — CardTimeout
	// bounds the work done on the card, not the wall-clock cost of getting to
	// it. A cold clone of a large repo used to eat the budget and kill the
	// attempt before the first token. Derived from ctx, not setupCtx, so the
	// work phase is not capped by setup's leftovers.
	tickCtx, workCancel := context.WithTimeout(ctx, l.cfg.WorkLoop.CardTimeout)
	defer workCancel()

	// 4. LLM phase
	var llmResult *llmStageResult
	if cfg.LLM.Enabled {
		llmResult, err = s.executeLLM(ctx, tickCtx, l, card, execID, repoDir)
		if err != nil {
			// Cluster I: mirror the lifecycle path's SUSPEND handling on the legacy
			// Tick path too, so a budget cutoff checkpoints + resumes instead of
			// wiping the branch even for a stage that ships no Lifecycle. Only
			// branch-owning stages have a WIP worth saving.
			var be *budgetSuspendError
			if errors.As(err, &be) && cfg.Git.Action == "create_branch" {
				suspended, escErr := s.checkpointAndSuspend(ctx, l, card, repoDir, branchRecovered, be)
				if suspended {
					return nil // clean stop: WIP committed + card parked, branch preserved
				}
				err = escErr
			} else if s.salvageCommittedImplement(l, card, execID, repoDir, branch, branchRecovered, l.lastTurnTokens == 0, err, logger) {
				// FIX #1: the pass died failure-shaped but its work was already
				// committed — salvage opened the PR and shipped the card on this
				// same tick. A SUCCESS: no failure strike, no second reservation.
				if l.health != nil {
					l.health.RecordSuccess()
				}
				return nil
			}
			s.failWithConfig(ctx, l, card, execID, fmt.Sprintf("%s failed: %v", cfg.LLM.Stage, err))
			cleanup()
			l.recordFailure(fmt.Sprintf("%s: %v", cfg.LLM.Stage, err), card.CardID)
			return fmt.Errorf("%s: %w", cfg.LLM.Stage, err)
		}

		// FIX #3: the stage raised an approval and the card was parked
		// (label + unassign + note + execution closed, all inside
		// parkForApproval). End the tick as a clean non-failure so the loop
		// proceeds to other cards immediately; the parked card resumes via
		// resumeDecidedApprovals when the human decides.
		if llmResult.implResult != nil && llmResult.implResult.Status == statusAwaitingApproval {
			logger.Info("tick ended early: card parked awaiting approval (non-failure)",
				"approval_id", llmResult.implResult.ApprovalID)
			return nil
		}

		// Handle blocked status: the agent declared it cannot complete the card.
		// Durably PARK it (engine applies the `blocked` label) so it leaves the
		// discovery queue instead of being re-dispatched every cycle — the agent
		// can't self-park (no update_card perm). If the label fails to bind, fall
		// back to the bounded failure path so the card is still accounted for.
		// (A declared cannot_proceed is handled in gitCommitAndPush below, ordered
		// AFTER the ahead>0 / duplicate checks so it never discards committed work
		// — unlike a blocked status, which is an unconditional "cannot complete".)
		if llmResult.implResult != nil && llmResult.implResult.Status == "blocked" {
			if s.parkForBlocked(ctx, l, card, execID, llmResult.implResult.Summary, logger) {
				cleanup()
				return nil
			}
			s.failWithConfig(ctx, l, card, execID, fmt.Sprintf("blocked: %s", llmResult.implResult.Summary))
			cleanup()
			l.recordFailure(fmt.Sprintf("blocked: %s", llmResult.implResult.Summary), card.CardID)
			return nil
		}

		// Graceful skip: runLLMStage returns decision="no_prompt" when the stage
		// has no cached prompt template AND no registered Go fallback. This is
		// NOT a failure — the operator hasn't seeded the template yet. Short-
		// circuit out so we don't run gitCommitAndPush (false "no code changes"
		// failure) or postActionWithConfig (non-conditional on_success actions
		// like move_to_column_type that would execute on a no-op tick).
		if llmResult != nil && llmResult.decision == "no_prompt" {
			s.skipNoPromptStage(ctx, l, card, execID, cleanup, logger)
			return nil
		}
	}

	// 4.5. Sensors
	var sensorRes *sensorResults
	if len(cfg.Sensors) > 0 {
		var err error
		sensorRes, err = s.runSensors(tickCtx, l, card, execID, repoDir)
		if err != nil {
			s.failWithConfig(ctx, l, card, execID, fmt.Sprintf("sensors failed: %v", err))
			cleanup()
			l.recordFailure(fmt.Sprintf("sensors: %v", err), card.CardID)
			return fmt.Errorf("sensors: %w", err)
		}
		// Option A: when any sensor has OnFail set, the operator owns failure
		// handling via ActionDef.Branches. Skip the legacy aggregated failure path
		// and let postActionWithConfig route via the decision.
		if sensorRes != nil && !sensorRes.allPassed && !sensorRes.hasFailureMapping {
			if sensorRes.findings != "" {
				if err := l.client.CreateReviewNote(tickCtx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID, "sensor_fail", sensorRes.findings); err != nil {
					slog.Warn("failed to create sensor findings note", "error", err)
				}
			}
			s.failWithConfig(ctx, l, card, execID, fmt.Sprintf("sensor gate failed: %s", sensorRes.summary))
			cleanup()
			l.recordFailure(fmt.Sprintf("sensor gate: %s", sensorRes.summary), card.CardID)
			return nil
		}
	}

	// 5. Post-LLM processing (git commit/push — only for roles that create
	// branches AND run an LLM stage that actually writes files). The gate is
	// LLMDef.PostProcessKind == "writes_code" (or the legacy mapping of the
	// default stage name). Sensor-only stages (cfg.LLM.Enabled == false)
	// verify state rather than mutate it, and produces_decision /
	// produces_note / mutates_backlog kinds produce non-code outputs — none
	// of these should hit the no-changes failure path (I.1.e bug 2 + I.1.g).
	if cfg.Git.Action == "create_branch" && cfg.LLM.Enabled && cfg.LLM.EffectivePostProcessKind() == "writes_code" {
		done, err := s.gitCommitAndPush(ctx, tickCtx, l, card, execID, repoDir, branch, branchRecovered, cleanup, logger, llmResult)
		if err != nil {
			return err
		}
		if done {
			return nil // no-changes or early exit handled inside
		}
	}

	// 6. Post-action
	return s.postActionWithConfig(ctx, tickCtx, l, card, execID, repoDir, branch, llmResult, sensorRes, cleanup, logger)
}

// tickRework handles the orchestrator rework flow: mediate → claim → checkout → fix → push → ship.
func (s *DataDrivenStrategy) tickRework(ctx, tickCtx context.Context, l *Loop, card *discoverResult, logger *slog.Logger) error {
	cfg := s.config

	// Check merged PR shortcut for rework
	if l.isCardPRMerged(tickCtx, card) {
		logger.Info("rework card has already-merged PR, skipping rework")
		if err := l.moveCardToColumnType(tickCtx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID, "done"); err != nil {
			logger.Warn("failed to move merged rework card to done", "error", err)
		}
		if l.health != nil {
			l.health.RecordSuccess()
		}
		l.ClearCardFailure(card.CardID)
		l.ClearNoChangeRework(card.CardID)
		return nil
	}

	reworkAttempt := l.CardReworkCount(card.CardID) + 1
	logger.Info("reworking rejected card", "attempt", reworkAttempt)

	// Mediate
	mediation, err := l.mediateRework(tickCtx, card, reworkAttempt)
	if err != nil {
		l.recordFailure(fmt.Sprintf("mediate rework %s: %v", card.CardID, err), card.CardID)
		return fmt.Errorf("mediate rework: %w", err)
	}

	if mediation.Escalate {
		logger.Warn("mediator escalated — blocking card", "card_id", card.CardID, "attempt", reworkAttempt)
		l.recordFailure(fmt.Sprintf("escalated after %d rework attempts", reworkAttempt), card.CardID)
		wsCfg := l.WorkspaceConfig()
		for i := l.CardFailureCount(card.CardID); i < wsCfg.MaxReworkAttempts; i++ {
			l.RecordCardFailure(card.CardID)
		}
		return nil
	}

	logger.Info("mediation complete", "action_plan_len", len(mediation.ActionPlan))

	// Rework claim
	execID, err := l.reworkClaim(tickCtx, card, s.config.Role)
	if err != nil {
		l.recordFailure(fmt.Sprintf("rework claim %s: %v", card.CardID, err), card.CardID)
		return fmt.Errorf("rework claim %s: %w", card.CardID, err)
	}
	logger = logger.With("execution_id", execID)
	logger.Info("rework execution started")

	defer l.reportCost(ctx, execID)

	// Git setup — checkout existing branch, fallback to create
	repoDir, err := l.git.CloneOrOpen(tickCtx, card.GitRepoURL, card.GitRepoName)
	if err != nil {
		l.failExecution(ctx, card, execID, fmt.Sprintf("git clone failed: %v", err))
		l.recordFailure(fmt.Sprintf("git clone: %v", err), card.CardID)
		return fmt.Errorf("git clone: %w", err)
	}

	branchName := sanitizeBranch(card.CardID, card.Title)
	branch := l.git.PrefixedBranch(branchName)
	baseRef := resolveBaseRef(cfg.Git, card)
	if err := l.git.CheckoutBranch(tickCtx, repoDir, branch); err != nil {
		logger.Warn("could not checkout rework branch, creating new", "branch", branch, "error", err)
		var createErr error
		branch, _, createErr = l.git.CreateBranch(tickCtx, repoDir, branchName, baseRef)
		if createErr != nil {
			l.failExecution(ctx, card, execID, fmt.Sprintf("git branch failed: %v", createErr))
			l.git.Cleanup(ctx, repoDir, "", card.DefaultBranch)
			l.recordFailure(fmt.Sprintf("git branch: %v", createErr), card.CardID)
			return fmt.Errorf("git branch: %w", createErr)
		}
	}

	cleanup := func() { l.git.Cleanup(ctx, repoDir, branch, card.DefaultBranch) }

	// Rework implement
	implResult, err := l.reworkImplement(tickCtx, card, execID, repoDir, mediation.ActionPlan)
	if err != nil {
		l.failExecution(ctx, card, execID, fmt.Sprintf("rework implement failed: %v", err))
		cleanup()
		l.recordFailure(fmt.Sprintf("rework implement: %v", err), card.CardID)
		return fmt.Errorf("rework implement: %w", err)
	}

	if implResult.Status == "blocked" {
		// Durably park (engine applies `blocked`) instead of failing into a
		// re-dispatch loop — same self-park cure as the implement path. Fall
		// back to the bounded failure path if the label fails to bind.
		if s.parkForBlocked(ctx, l, card, execID, implResult.Summary, logger) {
			cleanup()
			return nil
		}
		l.failExecution(ctx, card, execID, fmt.Sprintf("rework blocked: %s", implResult.Summary))
		cleanup()
		l.recordFailure(fmt.Sprintf("rework blocked: %s", implResult.Summary), card.CardID)
		return nil
	}

	// Git commit + squash + force push
	hasChanges, err := l.git.HasChanges(tickCtx, repoDir)
	if err != nil {
		l.failExecution(ctx, card, execID, fmt.Sprintf("checking changes: %v", err))
		cleanup()
		l.recordFailure(fmt.Sprintf("checking changes: %v", err), card.CardID)
		return fmt.Errorf("checking changes: %w", err)
	}
	if !hasChanges {
		// "No changes" after rework has two distinct causes that must be
		// handled differently:
		//
		// (a) The fix is ALREADY on the branch — the executor read the file,
		//     saw the requested change was present, and exited without
		//     writing. This happens when a prior rework attempt landed the
		//     fix but the reviewer hasn't re-run against the updated HEAD.
		//     Orchestrator keeps re-discovering the rejected card, mediates,
		//     re-executes, still no writes → infinite $$$ loop.
		//     Resolution: re-ship to review so the reviewer re-evaluates.
		//
		// (b) The branch is truly empty or identical to the base — legitimate
		//     no-op (sibling PR merged, tests self-healed, etc.). Safe to
		//     skip without incident; the consecutive-skip circuit breaker in
		//     skipReworkNoChanges still guards against stuck cases.
		//
		// FCH-3: count ahead of the card's REAL base (resolveBaseRef →
		// integration_branch), not the repo default — on an integration-based
		// board a branch that only carries integration's inherited history is 0
		// ahead of integration but >0 ahead of main, and counting against main
		// would re-ship an empty rework forever.
		baseRef := resolveBaseRef(s.config.Git, card)
		ahead, aheadErr := l.git.CommitsAheadOfRemoteDefault(tickCtx, repoDir, baseRef)
		if aheadErr != nil {
			logger.Warn("could not count commits ahead of base, treating as benign skip", "error", aheadErr, "base", baseRef)
		}
		if ahead > 0 {
			logger.Info("no working-tree changes, but branch has commits ahead of its base — re-shipping to review",
				"commits_ahead", ahead, "branch", branch, "base", baseRef)
			// Best-effort push in case the previous rework committed but
			// never pushed. If the remote is already up-to-date the push
			// is a no-op.
			if l.cfg.Git.ForceWithLease {
				if err := l.git.ForceWithLeasePush(tickCtx, repoDir); err != nil {
					logger.Warn("force-push of pre-existing commits failed, proceeding to ship anyway", "error", err)
				}
			} else {
				if err := l.git.Push(tickCtx, repoDir); err != nil {
					logger.Warn("push of pre-existing commits failed, proceeding to ship anyway", "error", err)
				}
			}

			prURL := card.PRURL
			if err := l.reworkShip(tickCtx, card, execID, branch, prURL); err != nil {
				logger.Warn("rework ship (no-new-changes path) failed", "error", err)
				l.recordFailure(fmt.Sprintf("rework ship (ahead): %v", err), card.CardID)
				cleanup()
				return fmt.Errorf("rework ship (ahead): %w", err)
			}
			s.wakeRoles(l, cfg.OnSuccess.WakeRoles)
			if err := l.git.ResetToDefault(tickCtx, repoDir, card.DefaultBranch); err != nil {
				logger.Warn("reset to default branch failed", "error", err)
			}
			if l.health != nil {
				l.health.RecordSuccess()
			}
			l.ClearCardFailure(card.CardID)
			l.ClearNoChangeRework(card.CardID)
			logger.Info("rework re-shipped pre-existing commits", "branch", branch, "attempt", reworkAttempt)
			return nil
		}

		logger.Warn("no git changes after rework")
		s.skipReworkNoChanges(ctx, l, card, execID, cleanup, logger)
		return nil
	}

	wsCfg := l.WorkspaceConfig()
	commitMsg := renderCommitMessage(wsCfg.CommitMessageTemplate, card.CardID, card.Title)
	if err := l.git.CommitAll(tickCtx, repoDir, commitMsg); err != nil {
		l.failExecution(ctx, card, execID, fmt.Sprintf("git commit: %v", err))
		cleanup()
		l.recordFailure(fmt.Sprintf("git commit: %v", err), card.CardID)
		return fmt.Errorf("git commit: %w", err)
	}

	if err := l.git.SquashOnto(tickCtx, repoDir, card.DefaultBranch, commitMsg); err != nil {
		logger.Warn("squash failed, pushing with multiple commits", "error", err)
	}

	if l.cfg.Git.ForceWithLease {
		if err := l.git.ForceWithLeasePush(tickCtx, repoDir); err != nil {
			l.failExecution(ctx, card, execID, fmt.Sprintf("git force-push: %v", err))
			cleanup()
			l.recordFailure(fmt.Sprintf("git force-push: %v", err), card.CardID)
			return fmt.Errorf("git force-push: %w", err)
		}
	} else {
		if err := l.git.Push(tickCtx, repoDir); err != nil {
			l.failExecution(ctx, card, execID, fmt.Sprintf("git push: %v", err))
			cleanup()
			l.recordFailure(fmt.Sprintf("git push: %v", err), card.CardID)
			return fmt.Errorf("git push: %w", err)
		}
	}

	prURL := card.PRURL
	if err := l.reworkShip(tickCtx, card, execID, branch, prURL); err != nil {
		logger.Warn("rework ship failed, code pushed but card not moved", "error", err)
		l.recordFailure(fmt.Sprintf("rework ship: %v", err), card.CardID)
		if err := l.git.ResetToDefault(tickCtx, repoDir, card.DefaultBranch); err != nil {
			logger.Warn("reset to default branch failed", "error", err)
		}
		return fmt.Errorf("rework ship: %w", err)
	}

	s.wakeRoles(l, cfg.OnSuccess.WakeRoles)

	if err := l.git.ResetToDefault(tickCtx, repoDir, card.DefaultBranch); err != nil {
		logger.Warn("reset to default branch failed", "error", err)
	}

	if l.health != nil {
		l.health.RecordSuccess()
	}

	l.ClearCardFailure(card.CardID)
	l.ClearNoChangeRework(card.CardID)
	logger.Info("rework completed", "branch", branch, "pr", prURL, "attempt", reworkAttempt, "cost_usd", l.tickCost, "tokens", l.tickTokens)
	return nil
}

// --- Sensor execution ---

// sensorResults aggregates the outcome of all SensorDef evaluations for a stage.
//
// decision is derived from per-sensor OnPass/OnFail mappings and feeds into
// ActionDef.Branches for conditional post-action routing:
//   - If any sensor fails, decision is the first failing sensor's OnFail.
//   - If all pass, decision is the last sensor's OnPass.
//   - Empty OnPass/OnFail produce an empty decision (legacy behavior).
//
// hasFailureMapping is true when at least one sensor's OnFail is non-empty.
// When true, Option A applies: the caller skips the aggregated failure path
// (CreateReviewNote + failWithConfig + recordFailure) and routes through
// ActionDef.Branches[decision] instead. When false, the legacy aggregated
// failure path runs.
type sensorResults struct {
	allPassed         bool
	findings          string
	summary           string
	decision          string
	hasFailureMapping bool
}

func (s *DataDrivenStrategy) runSensors(ctx context.Context, l *Loop, card *discoverResult, execID, repoDir string) (*sensorResults, error) {
	if len(s.config.Sensors) == 0 {
		return nil, nil
	}
	if s.sensors == nil {
		slog.Warn("sensors configured but no registry available", "role", s.config.Role)
		return nil, nil
	}

	var allFindings []string
	var summaries []string
	allPassed := true
	lastOnPass := ""
	firstFailureDecision := ""
	hasFailureMapping := false

	for _, def := range s.config.Sensors {
		if def.OnFail != "" {
			hasFailureMapping = true
		}

		sensor, err := s.sensors.Build(def.Name, def.Config)
		if err != nil {
			slog.Warn("failed to build sensor, skipping", "sensor", def.Name, "error", err)
			continue
		}

		input := harness.SensorInput{
			WorkingDir:  repoDir,
			CardID:      card.CardID,
			ExecutionID: execID,
			PRBranch:    card.PRBranch,
		}

		result, err := sensor.Evaluate(ctx, input)
		if err != nil {
			return nil, fmt.Errorf("sensor %s: %w", def.Name, err)
		}

		summaries = append(summaries, fmt.Sprintf("%s: %s", def.Name, result.Summary))

		if result.Passed {
			if def.OnPass != "" {
				lastOnPass = def.OnPass
			}
			continue
		}

		allPassed = false
		if firstFailureDecision == "" && def.OnFail != "" {
			firstFailureDecision = def.OnFail
		}
		for _, f := range result.Findings {
			loc := f.File
			if f.Line > 0 {
				loc = fmt.Sprintf("%s:%d", f.File, f.Line)
			}
			allFindings = append(allFindings, fmt.Sprintf("[%s] %s %s: %s", f.Severity, def.Name, loc, f.Message))
		}
	}

	decision := lastOnPass
	if !allPassed {
		decision = firstFailureDecision
	}

	return &sensorResults{
		allPassed:         allPassed,
		findings:          strings.Join(allFindings, "\n"),
		summary:           strings.Join(summaries, "; "),
		decision:          decision,
		hasFailureMapping: hasFailureMapping,
	}, nil
}

// resolveBranchAction returns the branch-specific ActionDef for a decision,
// or the base action unchanged when routing doesn't apply.
//
// Routing applies when: action.Conditional is true AND decision is non-empty
// AND action.Branches contains the decision key. Otherwise, the base action
// is returned so non-conditional stages (e.g., orchestrator) behave as before.
func resolveBranchAction(action valaris.ActionDef, decision string) valaris.ActionDef {
	if !action.Conditional || decision == "" {
		return action
	}
	branch, ok := action.Branches[decision]
	if !ok {
		return action
	}
	return branch
}

// deriveDecision selects the routing decision from available sources, in priority order:
//  1. LLM result decision (when llmResult.decision is non-empty) — e.g., reviewer's "approve"/"request_changes".
//  2. Sensor decision (when sensorRes.decision is non-empty) — e.g., tester's "pass"/"fail".
//
// An LLM-disabled stage (cfg.LLM.Enabled == false) passes nil for llmResult; the sensor
// decision is then the sole source, enabling sensor-only stages like the tester role.
// Returns empty string when no decision source is present (default pipeline behavior).
func deriveDecision(llmResult *llmStageResult, sensorRes *sensorResults) string {
	if llmResult != nil && llmResult.decision != "" {
		return llmResult.decision
	}
	if sensorRes != nil && sensorRes.decision != "" {
		return sensorRes.decision
	}
	return ""
}

// --- Discovery dispatch ---

func (s *DataDrivenStrategy) discoverWithConfig(ctx context.Context, l *Loop) (*discoverResult, error) {
	// Prefer the backend-owned scheduler. /next-assignment applies all
	// role filters, untyped-column exclusion, and role-scoped
	// preconditions (e.g. repo_has_no_open_pr) server-side so the runner
	// stops re-deriving semantics. Falls back to the legacy client-side
	// scan only when the endpoint is missing (404, older backend) — any
	// other error propagates so we don't silently mask outages.
	if l.client != nil && l.client.Agent != nil {
		// FOLLOWUP-7: when the runner is pinned to a single board, scope
		// the backend scheduler to it. Multi-board runners pass empty
		// board_id and let the scheduler choose across the workspace, which
		// matches the legacy column_scan fan-out across BoardIDs.
		req := valaris.NextAssignmentRequest{RoleOverride: s.config.Role}
		if len(l.cfg.Valaris.BoardIDs) == 1 {
			req.BoardID = l.cfg.Valaris.BoardIDs[0]
		}
		assignment, err := l.client.NextAssignment(
			ctx,
			l.cfg.Valaris.WorkspaceSlug,
			l.client.Agent.ID,
			req,
		)
		switch {
		case err == nil && assignment == nil:
			// 204 from the backend — no eligible card.
			return &discoverResult{}, nil
		case err == nil && assignment.Card.ID != "":
			// H1: production discover is this endpoint, and a live workspace
			// whose stored exclude_label lists predate the park labels can
			// hand out an intrinsically parked card. Refuse to work it — treat
			// the tick as no-work (the reservation TTL-drains); never fail the
			// card. Same built-in hard exclusion as the legacy scans.
			if cardIntrinsicallyParked(assignment.Card) {
				slog.Warn("next-assignment returned an intrinsically parked card — skipping tick (backend exclude_label config likely stale)",
					"card_id", assignment.Card.ID, "labels", assignment.Card.Labels, "role", s.config.Role)
				return &discoverResult{}, nil
			}
			return discoverResultFromAssignment(assignment), nil
		case err == nil:
			// 200 with empty body. Real backend would never do this,
			// but test stubs catch-all to `{}`. Fall through to the
			// legacy discover so those tests keep passing; production
			// runs hit one of the above branches.
		default:
			var apiErr *valaris.APIError
			if errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusNotFound {
				// Older backend without the endpoint — silent fallback.
			} else {
				slog.Warn("next-assignment failed, falling back to legacy discover", "role", s.config.Role, "error", err)
			}
		}
	}

	return s.legacyDiscoverWithGates(ctx, l)
}

// legacyDiscoverWithGates runs the legacy client-side scans — the resilience
// path when /next-assignment is unavailable — under the same correctness
// gates the backend scheduler enforces (card e6d468ab):
//
//  1. Dependency gating: a stage declaring discover.filters.
//     all_dependencies_done pushes that predicate into every fallback card
//     search (server-side SQL gate), so a dependency-blocked card is never
//     reserved here.
//  2. Model authority: a stage that declares an llm model must never
//     dispatch on the runner's yaml default. A concrete declared model is
//     stamped onto the result (llmOpts treats it as backend-authoritative);
//     a tier alias (premium/mid/low) only the backend's resolver can
//     translate refuses fallback dispatch entirely — idling loudly beats
//     silently downgrading the stage's model.
func (s *DataDrivenStrategy) legacyDiscoverWithGates(ctx context.Context, l *Loop) (*discoverResult, error) {
	declared := stageDeclaredLLM(s.config)
	// Deliberate posture: a tier-aliased stage has NO legacy fallback. Only the
	// backend's resolver can translate premium/mid/low into a concrete model,
	// so dispatching here would silently downgrade the stage to the runner's
	// yaml default — idling loudly beats a silent model downgrade, and a
	// backend outage therefore idles the fleet by design. The refusal is
	// scoped to stages that would actually DISPATCH an LLM: a stage with no
	// enabled LLM (disabled flat block, or a sensor-only lifecycle) never
	// consults the resolver, so its fallback proceeds (M1 adversarial review).
	if isTierAlias(declared.Model) && stageHasEnabledLLMDispatch(s.config) {
		slog.Warn("legacy discover fallback refused: stage declares an LLM tier alias the runner cannot resolve — waiting for next-assignment instead of dispatching a downgraded model",
			"role", s.config.Role, "declared_model", declared.Model)
		return &discoverResult{}, nil
	}

	var card *discoverResult
	var err error
	switch s.config.Discover.Strategy {
	case "unassigned_or_rework":
		// I.1.i: only include_label is plumbed into the legacy discover() —
		// the other filter keys stay column_scan-specific to keep default
		// pipeline behavior bit-for-bit identical when include_label is unset.
		// Cluster II Gap 3: include_label may be a list; legacy discover()
		// takes a single label, so pass the first (l.discover does a single-
		// label server query — full AND-compose only applies on column_scan).
		includeLabel := ""
		if labels := labelListFromFilters(s.config.Discover.Filters, "include_label"); len(labels) > 0 {
			includeLabel = labels[0]
		}
		allDepsDone, _ := s.config.Discover.Filters["all_dependencies_done"].(bool)
		card, err = l.discover(ctx, includeLabel, allDepsDone)
	case "column_scan":
		card, err = s.discoverColumnScan(ctx, l)
	default:
		return nil, fmt.Errorf("unknown discover strategy: %s", s.config.Discover.Strategy)
	}
	if err != nil || card == nil || card.CardID == "" {
		return card, err
	}
	if declared.Model != "" {
		card.AssignmentLLM = declared
	}
	return card, nil
}

// stageDeclaredLLM resolves the per-stage LLM dispatch declared in the cached
// pipeline_config. Mirrors the backend's /next-assignment split-brain
// resolution (card b8024b15): the lifecycle llm-step params are frontend-
// authored and take precedence field-by-field over the flat stage.llm block
// (backend-authored default).
func stageDeclaredLLM(stage valaris.StageConfig) valaris.AssignmentLLM {
	out := valaris.AssignmentLLM{
		Provider: stage.LLM.Provider,
		Model:    stage.LLM.Model,
	}
	for _, step := range stage.Lifecycle {
		if step.Kind != "llm" {
			continue
		}
		if p, _ := step.Params["provider"].(string); p != "" {
			out.Provider = p
		}
		if m, _ := step.Params["model"].(string); m != "" {
			out.Model = m
		}
		break
	}
	return out
}

// stageHasEnabledLLMDispatch reports whether the stage would actually dispatch
// an LLM at runtime. A lifecycle stage dispatches iff it carries an llm step
// (the legacy flat fields are ignored when a lifecycle is present); a legacy
// stage dispatches iff its flat llm block is enabled.
func stageHasEnabledLLMDispatch(stage valaris.StageConfig) bool {
	if len(stage.Lifecycle) > 0 {
		for _, step := range stage.Lifecycle {
			if step.Kind == "llm" {
				return true
			}
		}
		return false
	}
	return stage.LLM.Enabled
}

// isTierAlias reports whether model names an abstract LLM tier rather than a
// concrete model. Closed set mirroring backend llm_tiers._DEFAULT_TIER_MAP —
// the tier→model mapping is backend-owned (workspace-overridable resolver),
// so the runner must not guess a concrete model for these.
func isTierAlias(model string) bool {
	switch model {
	case "premium", "mid", "low":
		return true
	}
	return false
}

// discoverResultFromAssignment maps a backend NextAssignmentResponse onto
// the in-memory discoverResult struct the rest of the pipeline expects.
// Pulls PR URL/branch from the card description (existing convention) so
// downstream stages stay unchanged.
func discoverResultFromAssignment(a *valaris.NextAssignmentResponse) *discoverResult {
	r := &discoverResult{
		CardID:            a.Card.ID,
		BoardID:           a.Board.ID,
		Title:             a.Card.Title,
		PRURL:             extractPRURL(a.Card.Description),
		PRBranch:          extractPRBranch(a.Card.Description),
		ContextSources:    a.Context,
		AssignmentLLM:     a.LLM,
		Labels:            a.Card.Labels,
		BudgetUSDOverride: a.Card.BudgetUSDOverride,
		Skills:            a.Skills,
	}
	if a.Repo != nil {
		r.GitRepoURL = a.Repo.URL
		r.GitRepoName = a.Repo.Name
		r.DefaultBranch = defaultBranchOrMain(a.Repo.DefaultBranch)
		r.IntegrationBranch = a.Repo.IntegrationBranch
	}
	// Card's own slug is authoritative (inherited verbatim onto fix cards);
	// fall back to the resolved repo's REGISTERED slug. Never the display
	// name — on multi-repo boards where name != slug an echoed name is an
	// unknown slug and silently misroutes to the board's first repo.
	r.GitRepoSlug = a.Card.GitRepoSlug
	if r.GitRepoSlug == "" && a.Repo != nil {
		r.GitRepoSlug = a.Repo.Slug
	}
	return r
}

// discoverColumnScan generalizes discoverReview and discoverShipped into a single
// config-driven column scanner. Filters are applied from DiscoverDef.Filters.
func (s *DataDrivenStrategy) discoverColumnScan(ctx context.Context, l *Loop) (*discoverResult, error) {
	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}

	ws := l.cfg.Valaris.WorkspaceSlug
	boardIDs := l.cfg.Valaris.BoardIDs

	if len(boardIDs) == 0 {
		boards, err := l.client.ListBoards(ctx, ws)
		if err != nil {
			return nil, fmt.Errorf("listing boards: %w", err)
		}
		for _, b := range boards {
			boardIDs = append(boardIDs, b.ID)
		}
	}

	filters := s.config.Discover.Filters
	requirePRURL, _ := filters["require_pr_url"].(bool)
	// Cluster II Gap 3: label filters accept string-or-list, AND-composed
	// per token. The server narrows by the FIRST include label (it filters a
	// single label); the remaining include labels and all exclude labels are
	// enforced client-side below so a single-string filter stays bit-for-bit.
	includeLabels := labelListFromFilters(filters, "include_label")
	excludeLabels := labelListFromFilters(filters, "exclude_label")
	serverLabel := ""
	if len(includeLabels) > 0 {
		serverLabel = includeLabels[0]
	}
	skipParticipantRole := selfParticipationGuardRole(s.config.Discover, s.config.Role)
	requireGitRepo := requireGitRepoFromFilters(filters)
	// Dependency gate (card e6d468ab): push the scheduler's
	// all_dependencies_done predicate server-side so a dependency-blocked
	// card never surfaces in this legacy scan.
	allDepsDone, _ := filters["all_dependencies_done"].(bool)

	for _, boardID := range boardIDs {
		cards, err := l.client.SearchCards(ctx, ws, boardID, valaris.SearchCardsParams{
			ColumnType:          s.config.Discover.ColumnType,
			Label:               serverLabel,
			Limit:               50,
			AllDependenciesDone: allDepsDone,
		})
		if err != nil {
			slog.Warn("discover column_scan: search failed", "board_id", boardID, "role", s.config.Role, "error", err)
			continue
		}

		for _, c := range cards {
			if l.IsCardBlocked(c.ID) {
				continue
			}

			// Built-in hard exclusion: a force-blocked or approval-parked card
			// must stay invisible to every legacy scan even when the role's
			// configured exclude_label list doesn't mention the label
			// (belt-and-suspenders with config, and the only exclusion that
			// survives a runner restart).
			if cardIntrinsicallyParked(c) {
				continue
			}

			if c.ColumnType == "" {
				continue
			}

			// Filter: require PR URL
			prURL := extractPRURL(c.Description)
			if requirePRURL && prURL == "" {
				continue
			}

			// Filter: skip cards where the agent is already a participant with the configured role.
			if skipParticipantRole != "" && agentID != "" {
				alreadyParticipated := false
				for _, p := range c.Participants {
					selfParticipant := p.AgentID == agentID || p.UserID == agentID || p.UserID == l.client.UserID
					if selfParticipant && p.Role == skipParticipantRole {
						alreadyParticipated = true
						break
					}
				}
				if alreadyParticipated {
					continue
				}
			}

			// Filter: include labels — card must carry EVERY listed label
			// (the server already narrowed by the first; enforce the rest +
			// the first defensively in case the server ignored the param).
			includeMatched := true
			for _, label := range includeLabels {
				if !cardHasLabel(c, label) {
					includeMatched = false
					break
				}
			}
			if !includeMatched {
				continue
			}

			// Filter: exclude labels — reject if the card carries ANY listed.
			excluded := false
			for _, label := range excludeLabels {
				if cardHasLabel(c, label) {
					excluded = true
					break
				}
			}
			if excluded {
				continue
			}

			// Filter: require git repo (default on, can be disabled via require_git_repo: false).
			// When require_git_repo is false, repo is nil and the repo-derived
			// fields stay zero — including DefaultBranch, which must remain empty
			// (not "main") to preserve observable behavior for repo-less stages.
			var repo *valaris.GitRepo
			resolvedSlug := ""
			if requireGitRepo {
				repos, err := l.client.ListGitRepos(ctx, ws, boardID)
				if err != nil || len(repos) == 0 {
					continue
				}
				repo, resolvedSlug = resolveDiscoveredCardRepo(c.GitRepoSlug, repos)
			}

			result := newDiscoverResultFromRepo(c.ID, boardID, c.Title,
				prURL, extractPRBranch(c.Description), repo)
			if repo != nil {
				result.GitRepoSlug = resolvedSlug
			}
			return result, nil
		}
	}

	return &discoverResult{}, nil
}

// skipParticipantRoleFromFilters resolves the participant role that disqualifies a card.
// Precedence mirrors the backend scheduler (assignment_service._candidate_cards):
// canonical "skip_if_pipeline_role" first, then the DEPRECATED alias
// "skip_if_participant_role", then the legacy "skip_self_reviewed: true" which is
// equivalent to "skip_if_pipeline_role: reviewer". Runner-side participants expose
// only Role, so all three resolve to a match against CardParticipant.Role.
func skipParticipantRoleFromFilters(filters map[string]any) string {
	if role, ok := filters["skip_if_pipeline_role"].(string); ok && role != "" {
		return role
	}
	if role, ok := filters["skip_if_participant_role"].(string); ok && role != "" {
		return role
	}
	if legacy, _ := filters["skip_self_reviewed"].(bool); legacy {
		return "reviewer"
	}
	return ""
}

// selfParticipationGuardRole resolves the role whose presence on a card disqualifies
// it for this stage. An explicit skip key always wins. Absent one, a review-kind
// stage defaults to guarding against its OWN role, so a custom reviewer (e.g.
// "security_auditor") cannot re-pick a card it already processed just because it
// never configured a skip key. `allow_self_participant: true` opts out of that
// default; other column types never get it, preserving historic behavior.
func selfParticipationGuardRole(discover valaris.DiscoverDef, role string) string {
	if configured := skipParticipantRoleFromFilters(discover.Filters); configured != "" {
		return configured
	}
	if discover.ColumnType != "review" {
		return ""
	}
	if allowSelf, _ := discover.Filters["allow_self_participant"].(bool); allowSelf {
		return ""
	}
	return role
}

// requireGitRepoFromFilters returns whether the stage requires the board to have a linked repo.
// Defaults to true when the key is absent to preserve historic behavior.
func requireGitRepoFromFilters(filters map[string]any) bool {
	raw, ok := filters["require_git_repo"]
	if !ok {
		return true
	}
	if b, ok := raw.(bool); ok {
		return b
	}
	return true
}

// labelListFromFilters normalizes a label filter value (Cluster II Gap 3) to a
// slice of label strings. A plain string yields a one-element slice (back-
// compat). A list (decoded from JSON/YAML as []any) yields its non-empty
// string entries. Anything else yields nil — the filter is skipped.
func labelListFromFilters(filters map[string]any, key string) []string {
	switch v := filters[key].(type) {
	case string:
		if v == "" {
			return nil
		}
		return []string{v}
	case []string:
		out := make([]string, 0, len(v))
		for _, s := range v {
			if s != "" {
				out = append(out, s)
			}
		}
		return out
	case []any:
		out := make([]string, 0, len(v))
		for _, e := range v {
			if s, ok := e.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	default:
		return nil
	}
}

// cardHasLabel reports whether the card carries the given label.
func cardHasLabel(c valaris.Card, label string) bool {
	for _, l := range c.Labels {
		if l == label {
			return true
		}
	}
	return false
}

// cardIntrinsicallyParked reports whether the card carries a label the runner
// treats as a built-in hard discover exclusion: `blocked` (FIX #5 force-block),
// `awaiting-approval` (FIX #3 approval park), or `repo-slug-unresolved` (the
// backend's park for a card whose git_repo_slug names no registered repo). All
// are intrinsic to the card — column-independent, restart-durable, and enforced
// here regardless of whatever exclude_label lists the backend config ships.
func cardIntrinsicallyParked(c valaris.Card) bool {
	return cardHasLabel(c, blockedLabel) ||
		cardHasLabel(c, awaitingApprovalLabel) ||
		cardHasLabel(c, repoSlugUnresolvedLabel)
}

// --- Claim dispatch ---

func (s *DataDrivenStrategy) claimWithConfig(ctx context.Context, l *Loop, card *discoverResult) (string, error) {
	switch s.config.Claim.ParticipantRole {
	case "hero":
		return l.claim(ctx, card, s.config)
	case "helper":
		return s.claimHelper(ctx, l, card)
	default:
		return "", fmt.Errorf("unknown participant_role: %s", s.config.Claim.ParticipantRole)
	}
}

func (s *DataDrivenStrategy) claimHelper(ctx context.Context, l *Loop, card *discoverResult) (string, error) {
	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}
	ws := l.cfg.Valaris.WorkspaceSlug

	if err := l.client.AddCardParticipant(ctx, ws, card.BoardID, card.CardID, agentID, "helper", agentID, s.config.Claim.PipelineRole); err != nil {
		slog.Warn("claim helper: add_participant failed (may already exist)", "role", s.config.Role, "error", err)
	}

	execID, err := l.client.LogExecutionStart(ctx, agentID, ws, s.config.Claim.ExecutionAction, card.BoardID, card.CardID, fmt.Sprintf("%s: %s", executionLogDescription(s.config), card.CardID), s.config.Role)
	if err != nil {
		return "", fmt.Errorf("log_execution_start: %w", err)
	}
	return execID, nil
}

// agentIDOf returns the loop's agent ID, or "" when no agent is attached
// (focused unit tests that drive a stage without a real client).
func agentIDOf(l *Loop) string {
	if l.client != nil && l.client.Agent != nil {
		return l.client.Agent.ID
	}
	return ""
}

// --- Git setup dispatch ---

func (s *DataDrivenStrategy) gitSetupWithConfig(ctx, tickCtx context.Context, l *Loop, card *discoverResult, isRework bool) (repoDir, branch string, branchRecovered bool, cleanup func(), err error) {
	// Short-circuit: stages configured with git.action="none" never touch the
	// repo. Clone would fail on researcher/planner cards where GitRepoURL is
	// empty (no linked repo or no URL resolution). Return zero values + no-op
	// cleanup so downstream code is oblivious to whether git ran.
	if s.config.Git.Action == "none" || s.config.Git.Action == "" {
		return "", "", false, func() {}, nil
	}

	repoDir, err = l.git.CloneOrOpen(tickCtx, card.GitRepoURL, card.GitRepoName)
	if err != nil {
		return "", "", false, nil, fmt.Errorf("git clone: %w", err)
	}

	s.ensureBranchProtectionIfConfigured(tickCtx, l, card, repoDir)

	switch s.config.Git.Action {
	case "create_branch":
		branchName := sanitizeBranch(card.CardID, s.config.Git.BranchPrefix+card.Title)
		baseRef := resolveBaseRef(s.config.Git, card)
		branch, branchRecovered, err = l.git.CreateBranch(tickCtx, repoDir, branchName, baseRef)
		if err != nil {
			l.git.Cleanup(ctx, repoDir, "", card.DefaultBranch)
			return "", "", false, nil, fmt.Errorf("git branch: %w", err)
		}
		// A FRESH branch (not recovered) means this is a from-scratch attempt at
		// the card — any persisted LLM session is from a prior run whose branch is
		// gone. Resuming it re-ingests that run's entire transcript, doubling
		// implement tokens every relaunch (the F0 9M-token / $30 leak). Drop the
		// card's cached sessions so implement starts clean. A RECOVERED branch is
		// a within-run continuation (suspend/resume, rework) — keep the session so
		// the agent doesn't re-read the codebase. Session persistence across a
		// genuine process restart mid-branch still works (the branch is recovered).
		if !branchRecovered && l.sessions != nil {
			if agentID := agentIDOf(l); agentID != "" {
				l.sessions.Clear(agentID, card.CardID)
			}
		}

	case "checkout_pr_branch":
		branch = card.PRBranch
		if card.PRBranch != "" {
			if err := l.git.CheckoutBranch(tickCtx, repoDir, card.PRBranch); err != nil {
				// Squash-merged/deleted PR branches are the common case for a
				// post-merge stage (e.g. ui_validator on a DONE card). The merged
				// changes live on the default branch, so the stage still runs —
				// but report the branch we ACTUALLY validated so the downstream
				// note doesn't claim isolation on a branch that no longer exists.
				slog.Warn("could not checkout PR branch, reviewing default branch",
					"pr_branch", card.PRBranch, "default_branch", card.DefaultBranch, "role", s.config.Role, "error", err)
				branch = card.DefaultBranch
			}
		}

	case "checkout_integration_head":
		// Post-merge audit (e.g. ui_validator on a DONE card): validate what
		// SHIPS — integration HEAD on the default branch — NOT the frozen
		// merge-time PR branch. A stale PR branch is missing every fix merged
		// after this card, so auditing it re-renders already-fixed defects and
		// files phantom fix cards. Hard-fail on positioning error: a false audit
		// (stale tree) is worse than a re-runnable failed one.
		if err := l.git.CheckoutIntegrationHead(tickCtx, repoDir, card.DefaultBranch); err != nil {
			l.git.Cleanup(ctx, repoDir, "", card.DefaultBranch)
			return "", "", false, nil, fmt.Errorf("git checkout integration head: %w", err)
		}
		branch = card.DefaultBranch
	}

	// Shared-clone contamination guard (P0): the runner reuses ONE clone per
	// board, so a prior card's uncommitted residue — untracked files (e.g. a
	// foreign pnpm-lock.yaml from an out-of-order build) or stray tracked edits —
	// can still be sitting in the working tree right now. The implementer's
	// commit stages with `git add -A`, which would sweep that residue into THIS
	// card's commit (proven live: M-07 swept I-01's pnpm files into its rework
	// commit). Wipe the tree to the branch HEAD now — AFTER branch positioning
	// (so CreateBranch's recovered prior-attempt commits are preserved) and
	// BEFORE the LLM stage writes — so only this card's own work can be committed.
	// The runner does this itself; reset --hard is deny-listed inside the LLM
	// sandbox but the runner shells out directly.
	if err := l.git.WipeToHead(tickCtx, repoDir); err != nil {
		l.git.Cleanup(ctx, repoDir, "", card.DefaultBranch)
		return "", "", false, nil, fmt.Errorf("git wipe-to-head: %w", err)
	}

	cleanup = func() { l.git.Cleanup(ctx, repoDir, branch, card.DefaultBranch) }
	return repoDir, branch, branchRecovered, cleanup, nil
}

// shouldEnsureBranchProtection decides whether T2.3b branch-protection policy
// applies to this card's repo. Gating: the platform flag must be on (operators
// opt out for legacy/human-owned repos); the provider must be GitHub (awaiting
// T1.4 provider abstraction for GitLab/Bitbucket); and a default branch must
// be known. Blank provider is treated as GitHub for back-compat with older
// platforms that didn't yet persist the field.
func shouldEnsureBranchProtection(card *discoverResult) bool {
	if !card.RequireBranchProtection {
		return false
	}
	if card.GitRepoProvider != "" && card.GitRepoProvider != "github" {
		return false
	}
	if card.DefaultBranch == "" {
		return false
	}
	return true
}

// ensureBranchProtectionIfConfigured applies the T2.3b branch-protection
// policy on the card's default branch when shouldEnsureBranchProtection
// permits. Failures are logged and swallowed — a transient gh/API error must
// not block the current tick; the next clone retries.
//
// Cluster III: the companion repo-level `allow_auto_merge=true` flip
// (EnsureAutoMergeEnabled) was removed — the runner no longer arms GitHub
// auto-merge, so the proprietary repo toggle it required is dead weight.
func (s *DataDrivenStrategy) ensureBranchProtectionIfConfigured(tickCtx context.Context, l *Loop, card *discoverResult, repoDir string) {
	if !shouldEnsureBranchProtection(card) {
		return
	}
	if err := l.forge.EnsureBranchProtection(tickCtx, repoDir, card.DefaultBranch); err != nil {
		slog.Warn("branch protection setup failed (continuing tick)",
			"repo", card.GitRepoName, "branch", card.DefaultBranch, "error", err)
	}
}

// --- LLM execution dispatch ---

// llmStageResult captures the output of any LLM stage generically.
type llmStageResult struct {
	implResult   *implementResult // non-nil for implement stages
	reviewResult *reviewResult    // non-nil for review stages
	docResult    *docResult       // non-nil for document stages
	decision     string           // extracted for conditional routing (e.g., "approve", "request_changes")
	// rawOutput is the verbatim LLM stdout, propagated to WalkState.LLMRawOutput
	// so downstream terminal kinds (create_note body_from="raw",
	// mcp_call resolving $llm_output) can read it without re-parsing the
	// structured envelope.
	rawOutput string
}

// executeLLM runs the LLM phase for the stage and wraps the output into a
// generic llmStageResult. The three default stage names keep their specialized
// paths for bit-for-bit back-compat; any other stage name flows through
// runLLMStage and is dispatched by LLMDef.PostProcessKind.
func (s *DataDrivenStrategy) executeLLM(ctx, tickCtx context.Context, l *Loop, card *discoverResult, execID, repoDir string) (*llmStageResult, error) {
	stage := s.config.LLM.Stage

	switch stage {
	case "implement":
		implRes, err := l.implement(tickCtx, card, execID, repoDir)
		if err != nil {
			return nil, err
		}
		// Handle approval flow
		if implRes.Status == "needs_approval" && s.config.LLM.ApprovalEnabled {
			implRes, err = s.handleApproval(ctx, tickCtx, l, card, execID, repoDir, implRes)
			if err != nil {
				return nil, err
			}
		}
		raw := ""
		if implRes != nil {
			raw = implRes.Output
		}
		return &llmStageResult{implResult: implRes, rawOutput: raw}, nil

	case "review":
		reviewRes, err := l.reviewCode(tickCtx, card, execID, repoDir)
		if err != nil {
			return nil, err
		}
		return &llmStageResult{reviewResult: reviewRes, decision: reviewRes.Decision, rawOutput: reviewRes.Output}, nil

	case "document":
		docRes, err := l.generateDocs(tickCtx, card, execID, repoDir)
		if err != nil {
			return nil, err
		}
		return &llmStageResult{docResult: docRes, rawOutput: docRes.Output}, nil
	}

	// Custom stage — dispatch on PostProcessKind.
	return s.runLLMStage(ctx, tickCtx, l, card, execID, repoDir)
}

// genericLLMOutput mirrors the fields custom LLM stages are expected to emit.
// Every field is optional; parseLLMResultGeneric is tolerant of partial JSON.
type genericLLMOutput struct {
	Status   string `json:"status"`
	Decision string `json:"decision"`
	Summary  string `json:"summary"`
	// flexString: tolerate findings as string/array/object across coding agents
	// (Codex may emit a non-string). See flexString in json.go.
	Findings flexString `json:"findings"`
}

// runLLMStage runs a user-defined LLM stage: resolves the prompt via the
// platform cache with an optional hardcoded fallback (see customStageFallbacks),
// executes claude -p with the stage's AllowedTools, and wraps the output per
// PostProcessKind.
//
// Graceful skip: when no prompt template is cached AND no hardcoded fallback is
// registered for this stage, return a sentinel "no_prompt" decision rather than
// invoking the LLM with an empty prompt. Operator-defined personas without
// platform-seeded templates should defer to the next tick.
func (s *DataDrivenStrategy) runLLMStage(ctx, tickCtx context.Context, l *Loop, card *discoverResult, execID, repoDir string) (*llmStageResult, error) {
	stage := s.config.LLM.Stage
	kind := s.config.LLM.EffectivePostProcessKind()

	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}

	// Directives inject when the stage opts in OR when we'll fall back to the
	// minimal agentic prompt — directives are that fallback's only source of
	// project-specific guidance, so fetching them defensively is worth the call.
	var directivesText string
	if s.config.LLM.InjectDirectives || s.config.LLM.UseMinimalPromptWhenUnauthored {
		directivesText = l.fetchDirectives(tickCtx, card.BoardID)
	}

	pctx := PromptContext{
		Workspace:         l.cfg.Valaris.WorkspaceSlug,
		AgentID:           agentID,
		BoardID:           card.BoardID,
		CardID:            card.CardID,
		ExecutionID:       execID,
		ProjectDirectives: directivesText,
		ContextSources:    card.ContextSources,
	}
	// context_sources kinds replace runner-side fetchers (board_definition →
	// fetchDirectives, review_history → fetchReviewHistory); aliasing keeps
	// existing templates referencing {{.ProjectDirectives}}/{{.ReviewHistory}}
	// rendering unchanged (CTX-2, CTX-5).
	applyContextSourceAliases(&pctx)

	// Fallback lookup is keyed on stage name (not role) so operator configs
	// can pair a seeded fallback with any role they like. When neither the
	// cache nor customStageFallbacks covers this stage AND the stage has opted
	// into UseMinimalPromptWhenUnauthored, the platform's minimal agentic
	// prompt renders with role+stage literals so the agent can still execute.
	// Without the opt-in, fallback returns empty and the caller graceful-skips.
	fallback := func() string {
		if fn, ok := customStageFallbacks[stage]; ok {
			return fn(pctx)
		}
		if s.config.LLM.UseMinimalPromptWhenUnauthored {
			return renderMinimalAgenticPrompt(s.config.Role, stage, pctx)
		}
		return ""
	}

	prompt := l.resolvePrompt(stage, pctx, fallback)
	if prompt == "" {
		slog.Warn("custom LLM stage skipped: no prompt template cached",
			"role", s.config.Role, "stage", stage, "card_id", card.CardID)
		return &llmStageResult{decision: "no_prompt"}, nil
	}

	opts := l.llmOpts(stage)
	opts.WorkingDir = repoDir
	// produces_decision stages need the StructuredOutput tool offered so the
	// agent emits a routable verdict instead of prose. Default to the shared
	// decision schema unless the backend authored a per-stage schema (it never
	// does today — purely defensive, honors backend-authoritative config).
	if kind == "produces_decision" && opts.OutputSchema == "" {
		opts.OutputSchema = decisionOutputSchema
	}

	result, err := l.execute(tickCtx, prompt, opts)
	l.persistPrompt(tickCtx, execID, prompt)
	if err != nil {
		return nil, err
	}

	// produces_decision shares the reviewer's decode+fail-safe seam: a blank/
	// unparseable decision coerces to request_changes (never silently approve),
	// for the reviewer AND every custom decision role (ui_validator, etc.).
	if kind == "produces_decision" {
		review := decodeDecisionEnvelope(result)
		return &llmStageResult{
			reviewResult: &review,
			decision:     review.Decision,
			rawOutput:    result.Output,
		}, nil
	}

	out := parseLLMResultGeneric(result)

	res := wrapGenericOutput(kind, out)
	res.rawOutput = result.Output
	return res, nil
}

// parseLLMResultGeneric decodes the standard {status,decision,summary,findings}
// envelope via the shared decodeLLMEnvelope seam (structured-output-first,
// prose-JSON fallback). When no valid JSON is present the prose becomes the
// Summary verbatim — no fields are invented. The single tolerant parse path for
// every generic LLM stage.
func parseLLMResultGeneric(res *llm.Result) genericLLMOutput {
	var out genericLLMOutput
	if !decodeLLMEnvelope(res, &out) {
		raw := ""
		if res != nil {
			raw = res.Output
		}
		out.Summary = truncate(raw, 2000)
	}
	return out
}

// wrapGenericOutput shapes the parsed output into llmStageResult per kind.
// writes_code produces an implResult so the caller's git commit flow works.
// produces_note populates reviewResult so existing CreateReviewNote /
// AppendLearning plumbing has a findings source. mutates_backlog and a
// stage-unknown fallthrough leave the non-decision fields nil.
//
// produces_decision is intentionally absent: that kind is handled before this
// function in runLLMStage via the shared decodeDecisionEnvelope seam so it
// gets the never-silently-approve fail-safe (blank → request_changes).
func wrapGenericOutput(kind string, out genericLLMOutput) *llmStageResult {
	res := &llmStageResult{decision: out.Decision}

	switch kind {
	case "writes_code":
		status := out.Status
		if status == "" {
			status = "done"
		}
		res.implResult = &implementResult{Status: status, Summary: out.Summary}

	case "produces_note":
		// No git changes; just plumb findings through for note creation.
		res.reviewResult = &reviewResult{
			Decision: out.Decision,
			Summary:  out.Summary,
			Findings: out.Findings,
		}

	case "mutates_backlog":
		// LLM already wrote the side-effects via MCP. Nothing to persist.
	}

	return res
}

// errUntrackableApproval marks the approval-shaped failure exit: the stage
// explicitly demanded a human gate (needs_approval) but raised it in a form
// the runner cannot track (empty approval_id). Typed so downstream recovery —
// the FIX #1 salvage in particular — can recognize the human-gate intent and
// never ship the committed work past it.
var errUntrackableApproval = errors.New("stage requested approval without an approval_id; cannot track the decision")

// handleApproval routes a stage's approval_requested outcome. FIX #3: the
// runner does NOT wait on the human anymore — one immediate status check keeps
// the synchronous fast path for decisions that are already terminal at raise
// time (auto-approval policies decide instantly; the legacy tick tests rely on
// it), and EVERYTHING else parks the card and ends the tick so the loop keeps
// working other cards. The parked card resumes via resumeDecidedApprovals.
func (s *DataDrivenStrategy) handleApproval(ctx, tickCtx context.Context, l *Loop, card *discoverResult, execID, repoDir string, implResult *implementResult) (*implementResult, error) {
	logger := slog.With("card_id", card.CardID, "approval_id", implResult.ApprovalID, "role", s.config.Role)
	logger.Info("implementation needs approval")

	if implResult.ApprovalID == "" {
		return nil, errUntrackableApproval
	}

	// Zero-length grace window: a single immediate GET, never a wait.
	approval, err := l.client.GetApprovalStatus(tickCtx, l.cfg.Valaris.WorkspaceSlug, implResult.ApprovalID)
	if err != nil {
		// A status fetch flake must not fail the card — park; the per-cycle
		// check retries the GET.
		logger.Warn("approval status check failed at raise time — parking", "error", err)
		return s.parkForApproval(ctx, tickCtx, l, card, execID, repoDir, implResult)
	}

	switch approval.Status {
	case "approved", "auto_approved":
		logger.Info("approval granted")
		postCtx, postCancel := context.WithTimeout(ctx, l.cfg.WorkLoop.CardTimeout)
		defer postCancel()
		retryResult, err := l.implementAfterApproval(postCtx, card, execID, repoDir, implResult.Summary)
		if err != nil {
			return nil, fmt.Errorf("post-approval: %w", err)
		}
		if retryResult.Status != "done" {
			return &implementResult{Status: "blocked", Summary: fmt.Sprintf("post-approval blocked: %s", retryResult.Summary)}, nil
		}
		return retryResult, nil

	case "rejected":
		reason := ""
		if approval.DecisionReason != nil {
			reason = *approval.DecisionReason
		}
		logger.Warn("approval rejected", "reason", reason)
		// Human rejection is terminal. Without this, the returned "blocked"
		// status routes through on_failure → unassign → discover → re-claim,
		// burning an LLM call per retry until max_rework_attempts trips the
		// circuit breaker (typically 3 iterations). Pre-fill the failure
		// counter to the threshold so the next postActionWithConfig pass
		// sees the card as already-blocked and routes it to the blocked
		// column instead of the retry path. Mirrors the mediator-escalate
		// pattern above where the human's verdict is similarly final.
		wsCfg := l.WorkspaceConfig()
		for i := l.CardFailureCount(card.CardID); i < wsCfg.MaxReworkAttempts; i++ {
			l.RecordCardFailure(card.CardID)
		}
		return &implementResult{Status: "blocked", Summary: fmt.Sprintf("approval rejected: %s", reason)}, nil
	}

	// pending (and any not-yet-terminal status, including a freshly-expired
	// oddity) → park-and-continue. Expiry semantics live in the resume check:
	// an expired approval KEEPS the card parked for a human re-decision.
	return s.parkForApproval(ctx, tickCtx, l, card, execID, repoDir, implResult)
}

// --- Git commit and push ---

// gitCommitAndPush returns (done, err) where done=true means the caller should
// return nil immediately (the no-changes case was handled here).
func (s *DataDrivenStrategy) gitCommitAndPush(ctx, tickCtx context.Context, l *Loop, card *discoverResult, execID, repoDir, branch string, branchRecovered bool, cleanup func(), logger *slog.Logger, llmResult *llmStageResult) (bool, error) {
	// A DECLARED runtime-proof resolution wins regardless of diff state: the
	// stage itself determined the card's Done condition is a runtime
	// observation it cannot perform, so committing scratch output would be
	// noise. Park human-gated and release the reservation. A park that fails
	// to bind falls through to the ordinary (bounded) flow below.
	if declaredRuntimeProof(llmResult) {
		if s.parkForRuntimeProof(tickCtx, l, card, execID, cleanup, logger, llmResult) {
			return true, nil
		}
	}

	// A DECLARED needs-reconcile wins regardless of diff state, like runtime-proof:
	// the stage suspects a cross-card duplicate, so any scratch output it wrote is
	// noise — park for the board_reconciler rather than committing it. A park that
	// fails to bind falls through to the ordinary flow below.
	if declaredNeedsReconcile(llmResult) {
		if s.parkForReconcile(tickCtx, l, card, execID, cleanup, logger, llmResult) {
			return true, nil
		}
	}

	hasChanges, err := l.git.HasChanges(tickCtx, repoDir)
	if err != nil {
		s.failWithConfig(ctx, l, card, execID, fmt.Sprintf("checking changes: %v", err))
		cleanup()
		l.recordFailure(fmt.Sprintf("checking changes: %v", err), card.CardID)
		return false, fmt.Errorf("checking changes: %w", err)
	}

	// For documentator-like roles: no changes is not a failure — proceed to
	// postActionWithConfig which handles label tagging and health recording.
	if !hasChanges && s.config.OnFailure.StayInColumn {
		logger.Info("no changes to commit")
		return false, nil
	}

	if !hasChanges {
		// A clean working tree is NOT proof the stage did nothing: an LLM that
		// commits its own work mid-run leaves the tree clean but the branch
		// ahead of the base. Treating that as "produced no code changes" bounces
		// a successful implement (card 7849ada8). Distinguish the two by
		// counting commits ahead of the card's REAL base.
		//
		// FCH-3 (E1 · Hub de facturas): the base MUST be the branch the card was
		// forked from (resolveBaseRef → integration_branch), NOT the repo default
		// (main). On an integration-based board a stub that forks off integration
		// and produces zero real commits is 0 ahead of integration but MANY ahead
		// of main (it inherited integration's history). Counting against main read
		// that as "work already committed → proceed to PR" → no diff vs base → no
		// PR → re-reserve loop, and the ClearNoChangeRework below reset FCH-2's
		// backend cap every cycle. Comparing against the real base reports 0, so
		// the genuine no-op falls through to the bounded no-changes failure path.
		baseRef := resolveBaseRef(s.config.Git, card)
		ahead, aheadErr := l.git.CommitsAheadOfRemoteDefault(tickCtx, repoDir, baseRef)
		if aheadErr != nil {
			logger.Warn("could not count commits ahead of base; falling back to no-changes failure", "error", aheadErr, "base", baseRef)
		}
		if ahead > 0 {
			logger.Info("no working-tree changes, but branch is ahead of its base — work already committed, proceeding to PR/review",
				"commits_ahead", ahead, "branch", branch, "base", baseRef, "stage", s.config.LLM.Stage)
			// The commit step has nothing to do (clean tree), but the branch
			// may not be pushed yet. Push so the downstream create_pr can target
			// it; a no-op if the remote is already current.
			if branchRecovered {
				if err := l.git.ForceWithLeasePush(tickCtx, repoDir); err != nil {
					logger.Warn("force-push of pre-committed branch failed, proceeding anyway", "error", err)
				}
			} else {
				if err := l.git.Push(tickCtx, repoDir); err != nil {
					logger.Warn("push of pre-committed branch failed, proceeding anyway", "error", err)
				}
			}
			l.ClearNoChangeRework(card.CardID)
			return false, nil // done=false: proceed to post-action (open PR / move to review)
		}

		// A DECLARED duplicate is a sanctioned no-op, not a failure: the requested
		// change already exists on the base branch (a sibling PR shipped it), so an
		// empty diff is the CORRECT outcome. Close it as a duplicate — move to the
		// success column, stamp the `duplicate` label, drop the participant, clear
		// the failure counter — and release the reservation. Without this, a clean
		// tree falls into recordFailure below, which re-reserves the same card every
		// poll: the duplicate money-loop. Generic to every writes_code role; keyed
		// strictly on the declared resolution, never on role or card identity.
		if declaredDuplicate(llmResult) {
			s.closeAsDuplicate(ctx, tickCtx, l, card, execID, cleanup, logger, llmResult)
			return true, nil
		}

		// A DECLARED needs-reconcile is the A1b cross-card case: the stage
		// SUSPECTS its scope was already delivered by a DIFFERENT card/PR but is
		// not confident enough to self-close (that is the duplicate path above).
		// Park with the needs-reconcile label so the board_reconciler role
		// verifies and disposes — instead of re-reserving (the A1b money-loop) or
		// fabricating filler code (cero-dead-code violation). A park that fails to
		// bind falls through to the bounded no-changes flow below.
		if declaredNeedsReconcile(llmResult) {
			if s.parkForReconcile(tickCtx, l, card, execID, cleanup, logger, llmResult) {
				return true, nil
			}
		}

		// A DECLARED cannot_proceed is the impossible-card case (live I6/B6c): the
		// card needs a HUMAN decision or external input no code change can supply.
		// Park human-gated via the shared parkForBlocked (durable `blocked` label)
		// on the FIRST no-diff instead of re-reserving. Ordered AFTER the ahead>0
		// clear (committed-WIP must still ship) and AFTER declaredDuplicate (a real
		// duplicate still closes) — only a genuine no-diff "needs human input" card
		// parks here. A park that fails to bind falls through to the bounded
		// no-changes flow below. Generic across every code-writing role; keyed
		// strictly on the declared resolution, never on role or card identity.
		if declaredCannotProceed(llmResult) {
			if s.parkForBlocked(tickCtx, l, card, execID, summaryOf(llmResult), logger) {
				markBlockedParked(llmResult)
				cleanup()
				return true, nil
			}
		}

		// Signal-keyed backstop (FIX #4): a no-diff on a card carrying the
		// runtime-proof verification signal is the CORRECT outcome — its Done
		// condition is a runtime observation, not a code change. Park
		// human-gated on the FIRST no-diff instead of failing into the
		// re-reserve loop. After the declared-duplicate fast path so an
		// explicit duplicate declaration still closes the card. A park that
		// fails to bind (label not written) falls through to the bounded
		// no-changes failure flow below — never a clean exit on an unparked card.
		if s.cardRequiresRuntimeProof(tickCtx, l, card) {
			if s.parkForRuntimeProof(tickCtx, l, card, execID, cleanup, logger, llmResult) {
				return true, nil
			}
		}

		logger.Warn("no git changes after " + s.config.LLM.Stage)
		// Board-visible diagnostics: capture what the LLM actually produced so the
		// operator can open the card and see WHY implement wrote nothing, instead of
		// reconstructing it from scrolled-away stdout. Best-effort like the sensor-
		// findings sibling — a note-write failure must never alter the failure flow.
		s.writeNoChangesNote(tickCtx, l, card, llmResult)

		// Generic backstop to the duplicate money-loop: an UNDECLARED repeated
		// no-op (the stage keeps producing no diff without flagging it as a
		// duplicate) would otherwise re-reserve and burn a full implement pass
		// every cycle. Count consecutive no-ops on this card and, at the dedicated
		// threshold, force the card to `blocked` so the breaker (IsCardBlocked)
		// holds it out of discover until a human looks — rather than bouncing it
		// to backlog where it is immediately re-eligible. Mirrors the rework
		// path's skipReworkNoChanges guard; reason-agnostic, no role coupling.
		noOpCount := l.RecordNoChangeRework(card.CardID)
		if card.CardID != "" && noOpCount >= maxConsecutiveNoChangeImplements {
			msg := fmt.Sprintf("%s produced no code changes %d ticks in a row — blocking card for human review",
				s.config.LLM.Stage, noOpCount)
			logger.Warn("no-change implement limit reached — forcing card to blocked",
				"card_id", card.CardID, "consecutive_no_change", noOpCount,
				"limit", maxConsecutiveNoChangeImplements)
			// failExecutionTo("blocked") stamps the durable `blocked` label
			// itself (M2: in-memory block and label travel together on every
			// force-block routing); its move-to-blocked stays cosmetic
			// best-effort — boards without a `blocked` column must still park
			// (the production money-loop this guards against).
			l.failExecutionTo(ctx, card, execID, msg, "blocked")
			wsCfg := l.WorkspaceConfig()
			for i := l.CardFailureCount(card.CardID); i < wsCfg.MaxReworkAttempts; i++ {
				l.RecordCardFailure(card.CardID)
			}
			cleanup()
			return true, nil
		}

		s.failWithConfig(ctx, l, card, execID, s.config.LLM.Stage+" produced no code changes")
		cleanup()
		l.recordFailure(s.config.LLM.Stage+" produced no changes", card.CardID)
		return true, nil // done=true: failure handled, caller returns nil
	}

	wsCfg := l.WorkspaceConfig()
	commitMsg := renderCommitMessage(wsCfg.CommitMessageTemplate, card.CardID, card.Title)
	// Documentator uses a different commit prefix
	if s.config.Git.BranchPrefix != "" {
		commitMsg = fmt.Sprintf("docs(%s): %s", card.CardID, card.Title)
	}

	if err := l.git.CommitAll(tickCtx, repoDir, commitMsg); err != nil {
		s.failWithConfig(ctx, l, card, execID, fmt.Sprintf("git commit: %v", err))
		cleanup()
		l.recordFailure(fmt.Sprintf("git commit: %v", err), card.CardID)
		return false, fmt.Errorf("git commit: %w", err)
	}

	if branchRecovered {
		if err := l.git.ForceWithLeasePush(tickCtx, repoDir); err != nil {
			s.failWithConfig(ctx, l, card, execID, fmt.Sprintf("git force-push: %v", err))
			cleanup()
			l.recordFailure(fmt.Sprintf("git force-push: %v", err), card.CardID)
			return false, fmt.Errorf("git force-push: %w", err)
		}
	} else {
		if err := l.git.Push(tickCtx, repoDir); err != nil {
			s.failWithConfig(ctx, l, card, execID, fmt.Sprintf("git push: %v", err))
			cleanup()
			l.recordFailure(fmt.Sprintf("git push: %v", err), card.CardID)
			return false, fmt.Errorf("git push: %w", err)
		}
	}

	// Real changes were committed and pushed — reset the consecutive-no-op counter
	// so a later benign no-op on this card starts the backstop fresh.
	l.ClearNoChangeRework(card.CardID)
	return false, nil
}

// writeNoChangesNote persists a board-visible diagnostic when a writes_code
// stage produced a clean tree with no commits ahead — the operator can open the
// card and read what the LLM actually output instead of mining scrolled-away
// stdout. Best-effort: any failure is logged and swallowed so it can never alter
// the no-changes failure flow the caller is mid-way through (sibling of the
// sensor-findings note at the sensor gate).
//
// The wire `failure_class` is left empty on purpose: the backend validates that
// field against the five reviewer ReviewFailureClass values and 422s on anything
// else, so the "no_changes" classification lives in the title + body header
// where the operator reads it.
func (s *DataDrivenStrategy) writeNoChangesNote(tickCtx context.Context, l *Loop, card *discoverResult, llmResult *llmStageResult) {
	summary := ""
	raw := ""
	if llmResult != nil {
		if llmResult.implResult != nil {
			summary = llmResult.implResult.Summary
		}
		raw = llmResult.rawOutput
	}

	var b strings.Builder
	b.WriteString("**" + s.config.LLM.Stage + " produced no code changes** (failure_class: no_changes)\n\n")
	b.WriteString("The stage finished without writing any files or committing, so there is nothing to open a PR against. The LLM's own output is captured below for diagnosis.\n\n")
	if summary != "" {
		b.WriteString("## LLM summary\n\n" + summary + "\n\n")
	}
	if raw != "" {
		b.WriteString("## LLM raw output\n\n```\n" + truncate(raw, 2000) + "\n```\n")
	}
	if summary == "" && raw == "" {
		b.WriteString("_The LLM produced no parseable summary or output._\n")
	}

	title := "Implement: no changes produced"
	if err := l.client.CreateNote(tickCtx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID,
		"system", title, b.String(), "", false); err != nil {
		slog.Warn("failed to write no-changes diagnostics note", "error", err, "card_id", card.CardID)
	}
}

// declaredDuplicate reports whether the stage explicitly resolved its no-diff
// outcome as a duplicate (the change already exists on base). Nil-safe across the
// llmStageResult → implResult chain so a stage that produced no parseable
// envelope reads as "not declared" and follows the ordinary failure path.
func declaredDuplicate(llmResult *llmStageResult) bool {
	return llmResult != nil && llmResult.implResult != nil &&
		llmResult.implResult.Resolution == resolutionDuplicate
}

// closeAsDuplicate terminates a sanctioned-no-op tick as a SUCCESS: the work
// already shipped elsewhere, so the card is resolved. It moves the card to the
// done column, stamps the `duplicate` label (so the board distinguishes "closed
// because already shipped" from "built here"), records a board-visible note,
// clears the failure counter and records health success, then releases the repo
// checkout. It deliberately does NOT recordFailure — that is the re-reservation
// money-loop this whole path exists to break. Every step is best-effort: a failed
// label or note must not strand the card back in the failure flow, since the
// move-to-done is the load-bearing outcome that ends the loop.
func (s *DataDrivenStrategy) closeAsDuplicate(ctx, tickCtx context.Context, l *Loop, card *discoverResult, execID string, cleanup func(), logger *slog.Logger, llmResult *llmStageResult) {
	ws := l.cfg.Valaris.WorkspaceSlug
	summary := ""
	if llmResult != nil && llmResult.implResult != nil {
		summary = llmResult.implResult.Summary
	}
	logger.Info("closing card as duplicate (already shipped elsewhere — no diff is correct)",
		"stage", s.config.LLM.Stage, "summary", truncate(summary, 200))

	body := "**Closed as duplicate** — the requested change already exists on the base branch (shipped by another PR), so this card produces no diff. Closing as a duplicate rather than re-implementing."
	if summary != "" {
		body += "\n\n## Stage determination\n\n" + summary
	}
	if err := l.client.CreateNote(tickCtx, ws, card.BoardID, card.CardID, "system",
		"Closed as duplicate", body, "", false); err != nil {
		slog.Warn("close_as_duplicate: failed to write note", "error", err, "card_id", card.CardID)
	}

	// Stamp the routing label first so the card carries it BEFORE it lands in done
	// (a board watcher reading the move event then sees the reason already set).
	s.addLabel(tickCtx, l, card, duplicateLabel)

	if err := l.moveCardToColumnType(tickCtx, ws, card.BoardID, card.CardID, "done"); err != nil {
		// A failed move is the one outcome that re-opens the loop — but recordFailure
		// would too. Surface it loudly and still drop the participant so the card at
		// least stops being re-reserved to THIS agent; an operator can move it.
		slog.Warn("close_as_duplicate: failed to move card to done; loop may persist until moved",
			"error", err, "card_id", card.CardID)
	}

	// Drop this agent from the card so the scheduler can't re-hand it here while
	// the move settles (mirrors the UnassignSelf action's participant removal).
	if l.client.Agent != nil && l.client.Agent.ID != "" {
		if err := l.client.RemoveCardParticipant(tickCtx, ws, card.BoardID, card.CardID, l.client.Agent.ID); err != nil {
			slog.Warn("close_as_duplicate: failed to unassign self", "error", err, "card_id", card.CardID)
		}
	}

	// Close the execution so it can't dangle as `running` and 409 agent_busy on
	// every next_assignment (M1; same pattern as the park paths). "completed",
	// not "aborted": a duplicate close is a SUCCESS terminal.
	if l.client.Agent != nil && l.client.Agent.ID != "" && execID != "" {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := l.client.LogExecutionUpdate(cleanupCtx, l.client.Agent.ID, execID, "completed",
			"card closed as duplicate (already shipped elsewhere)"); err != nil {
			slog.Warn("close_as_duplicate: failed to mark execution completed", "execution_id", execID, "error", err)
		}
		cancel()
	}

	l.ClearCardFailure(card.CardID)
	if l.health != nil {
		l.health.RecordSuccess()
	}
	cleanup()

	// Sentinel for the lifecycle path (same seam as parkForRuntimeProof): the
	// close is TERMINAL, so lifecycleLLM must stop the walk here — otherwise it
	// continues to create_pr (a PR for a closed card) or, via on_failure, to a
	// fail-move that drags the closed card back out of done.
	if llmResult != nil {
		if llmResult.implResult == nil {
			llmResult.implResult = &implementResult{}
		}
		llmResult.implResult.Status = statusDuplicateClosed
	}
}

// declaredRuntimeProof reports whether the stage explicitly resolved that the
// card's Done condition is a runtime observation it cannot perform. Nil-safe
// across the llmStageResult → implResult chain, like declaredDuplicate.
func declaredRuntimeProof(llmResult *llmStageResult) bool {
	return llmResult != nil && llmResult.implResult != nil &&
		llmResult.implResult.Resolution == resolutionNeedsRuntimeProof
}

// cardRequiresRuntimeProof reports whether the card carries the verification
// signal: the needs-runtime-proof label, or the anchored
// `Acceptance: runtime-proof` body-marker line (runtimeProofMarkerRe, mirrors
// the backend's regex). Discover-result labels (populated by /next-assignment)
// are checked first; the GetCard fetch only runs on a no-diff tick when
// they're absent (legacy discover), so the extra round-trip is rare and cheap.
func (s *DataDrivenStrategy) cardRequiresRuntimeProof(ctx context.Context, l *Loop, card *discoverResult) bool {
	for _, label := range card.Labels {
		if label == needsRuntimeProofLabel {
			return true
		}
	}
	full, err := l.client.GetCard(ctx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID)
	if err != nil || full == nil {
		return false
	}
	for _, label := range full.Labels {
		if label == needsRuntimeProofLabel {
			return true
		}
	}
	return runtimeProofMarkerRe.MatchString(full.Description)
}

// parkForRuntimeProof terminates a verification-card tick as a HUMAN-GATED
// park, not a failure: the card's Done condition is a runtime observation no
// code-writing stage can satisfy, so a no-diff is the correct outcome and a
// human must perform the verification and close the card. Parks via the FIX #5
// intrinsic block: the blocked label is LOAD-BEARING and written FIRST on a
// dedicated background context (mirrors parkForApproval) — if it fails to
// bind, the park is OFF: return false with no side-effects so the caller falls
// back to the bounded no-changes flow instead of ending a still-discoverable
// card as a clean success (the unbounded-loop seam from the adversarial
// review). On success: note → cosmetic move → unassign → execution closed as
// aborted (mirrors the approval-park precedent; a dangling `running` row 409s
// agent_busy on every next_assignment) → sentinel status so the lifecycle walk
// stops at the park. Deliberately records NO failure and never touches the
// no-op counter — re-reservation is prevented by the label.
func (s *DataDrivenStrategy) parkForRuntimeProof(tickCtx context.Context, l *Loop, card *discoverResult, execID string, cleanup func(), logger *slog.Logger, llmResult *llmStageResult) bool {
	ws := l.cfg.Valaris.WorkspaceSlug
	summary := ""
	if llmResult != nil && llmResult.implResult != nil {
		summary = llmResult.implResult.Summary
	}

	labelCtx, cancelLabel := context.WithTimeout(context.Background(), 10*time.Second)
	err := s.addLabel(labelCtx, l, card, blockedLabel)
	cancelLabel()
	if err != nil {
		logger.Warn("runtime-proof park failed to bind (blocked label not written) — falling back to the bounded failure flow",
			"card_id", card.CardID, "error", err)
		return false
	}

	logger.Info("runtime-proof card parked for human verification (no-diff is the correct outcome)",
		"stage", s.config.LLM.Stage, "summary", truncate(summary, 200))

	body := "**Runtime-proof card parked for human verification** — this card's Done condition is a runtime observation (run the artifact and verify), not a code change. The stage correctly produced no implementable diff; a human must perform the verification and close the card."
	if summary != "" {
		body += "\n\n## Stage determination\n\n" + summary
	}
	if err := l.client.CreateNote(tickCtx, ws, card.BoardID, card.CardID, "system",
		"Runtime-proof card parked for human verification", body, "", false); err != nil {
		slog.Warn("park_runtime_proof: failed to write note", "error", err, "card_id", card.CardID)
	}

	// Cosmetic best-effort move; may no-op on boards without a blocked column.
	if err := l.moveCardToColumnType(tickCtx, ws, card.BoardID, card.CardID, "blocked"); err != nil {
		slog.Info("park_runtime_proof: no blocked column to move to (label alone parks the card)",
			"card_id", card.CardID, "error", err)
	}

	if l.client.Agent != nil && l.client.Agent.ID != "" {
		if err := l.client.RemoveCardParticipant(tickCtx, ws, card.BoardID, card.CardID, l.client.Agent.ID); err != nil {
			slog.Warn("park_runtime_proof: failed to unassign self", "error", err, "card_id", card.CardID)
		}
	}

	// Close the raising execution so it can't dangle as `running` (mirrors
	// parkForApproval: "aborted" is terminal and NOT a failure status).
	if l.client.Agent != nil && l.client.Agent.ID != "" && execID != "" {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := l.client.LogExecutionUpdate(cleanupCtx, l.client.Agent.ID, execID, "aborted",
			"runtime-proof card parked for human verification"); err != nil {
			slog.Warn("park_runtime_proof: failed to mark execution aborted", "execution_id", execID, "error", err)
		}
		cancel()
	}

	l.ClearCardFailure(card.CardID)
	if l.health != nil {
		l.health.RecordSuccess()
	}
	cleanup()

	// Sentinel for the lifecycle path: lifecycleLLM stops the walk on it so no
	// downstream step (create_pr/ship/fail-move) runs against the parked card.
	if llmResult != nil {
		if llmResult.implResult == nil {
			llmResult.implResult = &implementResult{}
		}
		llmResult.implResult.Status = statusRuntimeProofParked
	}
	return true
}

// declaredNeedsReconcile reports whether the stage explicitly resolved its
// no-diff outcome as a suspected CROSS-CARD duplicate it cannot self-close (the
// A1b case). Nil-safe across the llmStageResult → implResult chain, like
// declaredDuplicate / declaredRuntimeProof.
func declaredNeedsReconcile(llmResult *llmStageResult) bool {
	return llmResult != nil && llmResult.implResult != nil &&
		llmResult.implResult.Resolution == resolutionNeedsReconcile
}

// declaredCannotProceed reports whether the stage explicitly resolved its
// no-diff outcome as a card that needs HUMAN input it cannot supply (decision /
// external data / non-code asset). Nil-safe across the llmStageResult →
// implResult chain, like declaredDuplicate / declaredRuntimeProof /
// declaredNeedsReconcile.
func declaredCannotProceed(llmResult *llmStageResult) bool {
	return llmResult != nil && llmResult.implResult != nil &&
		llmResult.implResult.Resolution == resolutionCannotProceed
}

// summaryOf nil-safely extracts the stage's summary for a park reason.
func summaryOf(llmResult *llmStageResult) string {
	if llmResult != nil && llmResult.implResult != nil {
		return llmResult.implResult.Summary
	}
	return ""
}

// markBlockedParked sets the lifecycle sentinel so the walk stops at the blocked
// park (no create_pr / ship / fail-move runs against the parked card). Mirrors
// how parkForReconcile / parkForRuntimeProof set their own sentinel. parkForBlocked
// is shared with the blocked-DECISION path (executeLLM), which uses the legacy
// Tick flow and ignores this sentinel — so the sentinel lives at the call site,
// not inside parkForBlocked.
func markBlockedParked(llmResult *llmStageResult) {
	if llmResult == nil {
		return
	}
	if llmResult.implResult == nil {
		llmResult.implResult = &implementResult{}
	}
	llmResult.implResult.Status = statusBlockedParked
}

// parkForReconcile terminates a tick by parking the card for the board_reconciler
// role: the stage suspects its scope was already delivered by a DIFFERENT card/PR
// but is not confident enough to self-close, so neither re-reserving (the A1b
// money-loop) nor fabricating filler code (cero-dead-code) is acceptable.
//
// The needs-reconcile label is LOAD-BEARING and written FIRST on a dedicated
// background context (mirrors parkForRuntimeProof's blocked-label binding): the
// backend implementer/planner discover excludes it (breaking the loop) and the
// board_reconciler discover includes it (arming the disposal lane). If the label
// fails to bind the park is OFF — return false with no side-effects so the caller
// falls back to the bounded no-changes flow instead of ending a still-implementer-
// discoverable card as a clean success (the unbounded-loop seam).
//
// Differs from parkForRuntimeProof in two ways: (1) it does NOT move the card to a
// blocked column — the card stays in active where board_reconciler scans by label;
// (2) it writes the needs-reconcile routing label, not blocked. Like the park, it
// records NO failure and never touches the no-op counter (a correct outcome), and
// closes the raising execution as "aborted" so it can't dangle as `running`.
func (s *DataDrivenStrategy) parkForReconcile(tickCtx context.Context, l *Loop, card *discoverResult, execID string, cleanup func(), logger *slog.Logger, llmResult *llmStageResult) bool {
	ws := l.cfg.Valaris.WorkspaceSlug
	summary := ""
	if llmResult != nil && llmResult.implResult != nil {
		summary = llmResult.implResult.Summary
	}

	labelCtx, cancelLabel := context.WithTimeout(context.Background(), 10*time.Second)
	err := s.addLabel(labelCtx, l, card, needsReconcileLabel)
	cancelLabel()
	if err != nil {
		logger.Warn("reconcile park failed to bind (needs-reconcile label not written) — falling back to the bounded failure flow",
			"card_id", card.CardID, "error", err)
		return false
	}

	logger.Info("card parked for board reconciliation (suspected cross-card duplicate, not confident to self-close)",
		"stage", s.config.LLM.Stage, "summary", truncate(summary, 200))

	body := "**Card parked for board reconciliation** — the implement stage suspects this card's scope was already delivered by a DIFFERENT card or PR, but is not certain enough to close it as a duplicate. A board-reconciler role will verify the suspicion and either supersede the card (if it is genuinely already shipped), return it to active (if the scope is in fact unique), or repair its dependencies."
	if summary != "" {
		body += "\n\n## Stage determination\n\n" + summary
	}
	if err := l.client.CreateNote(tickCtx, ws, card.BoardID, card.CardID, "system",
		"Card parked for board reconciliation", body, "", false); err != nil {
		slog.Warn("park_reconcile: failed to write note", "error", err, "card_id", card.CardID)
	}

	// Deliberately NO column move: the card stays in active so board_reconciler's
	// label scan finds it. The needs-reconcile label alone keeps the implementer
	// off it (backend exclude_label).

	if l.client.Agent != nil && l.client.Agent.ID != "" {
		if err := l.client.RemoveCardParticipant(tickCtx, ws, card.BoardID, card.CardID, l.client.Agent.ID); err != nil {
			slog.Warn("park_reconcile: failed to unassign self", "error", err, "card_id", card.CardID)
		}
	}

	// Close the raising execution so it can't dangle as `running` (mirrors the
	// runtime-proof park: "aborted" is terminal and NOT a failure status).
	if l.client.Agent != nil && l.client.Agent.ID != "" && execID != "" {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := l.client.LogExecutionUpdate(cleanupCtx, l.client.Agent.ID, execID, "aborted",
			"card parked for board reconciliation"); err != nil {
			slog.Warn("park_reconcile: failed to mark execution aborted", "execution_id", execID, "error", err)
		}
		cancel()
	}

	l.ClearCardFailure(card.CardID)
	if l.health != nil {
		l.health.RecordSuccess()
	}
	cleanup()

	// Sentinel for the lifecycle path: lifecycleLLM stops the walk on it so no
	// downstream step (create_pr/ship/fail-move) runs against the parked card.
	if llmResult != nil {
		if llmResult.implResult == nil {
			llmResult.implResult = &implementResult{}
		}
		llmResult.implResult.Status = statusReconcileParked
	}
	return true
}

// parkForBlocked durably parks a card an agent declared it CANNOT complete
// (status=blocked). The old path recorded a failure but left the card un-
// labeled, so the backend scheduler re-dispatched it every cycle until a human
// hand-applied the `blocked` label — the agent couldn't self-park (its allow-
// list excludes update_card). The ENGINE applies the label here: durable,
// backend-visible (every discover excludes `blocked`), needs no agent perm.
//
// Same shape as parkForRuntimeProof, with two differences: (1) it takes the
// block reason directly (the caller has implResult.Summary), and (2) a genuine
// block is NOT a "correct no-diff" outcome — but the LABEL is the load-bearing
// park, so once it binds the in-memory failure counter is moot and we clear it
// to avoid double-accounting. Returns false (unbound) if the label write fails
// so the caller falls back to the ordinary bounded failure path.
func (s *DataDrivenStrategy) parkForBlocked(tickCtx context.Context, l *Loop, card *discoverResult, execID, reason string, logger *slog.Logger) bool {
	ws := l.cfg.Valaris.WorkspaceSlug

	labelCtx, cancelLabel := context.WithTimeout(context.Background(), 10*time.Second)
	err := s.addLabel(labelCtx, l, card, blockedLabel)
	cancelLabel()
	if err != nil {
		logger.Warn("blocked park failed to bind (blocked label not written) — falling back to the bounded failure flow",
			"card_id", card.CardID, "error", err)
		return false
	}

	logger.Info("card parked as blocked (agent declared it cannot complete)",
		"stage", s.config.LLM.Stage, "reason", truncate(reason, 200))

	body := "**Card blocked — parked for human follow-up.** The agent determined it cannot complete this card and there is no code change it can make. The card is labeled `blocked` so it leaves the work queue; a human must unblock or close it."
	if reason != "" {
		body += "\n\n## Reason\n\n" + reason
	}
	if err := l.client.CreateNote(tickCtx, ws, card.BoardID, card.CardID, "system",
		"Card blocked — parked for human follow-up", body, "", false); err != nil {
		slog.Warn("park_blocked: failed to write note", "error", err, "card_id", card.CardID)
	}

	// Cosmetic best-effort move; no-ops on boards without a blocked column
	// (the label alone parks the card).
	if err := l.moveCardToColumnType(tickCtx, ws, card.BoardID, card.CardID, "blocked"); err != nil {
		slog.Info("park_blocked: no blocked column to move to (label alone parks the card)",
			"card_id", card.CardID, "error", err)
	}

	if l.client.Agent != nil && l.client.Agent.ID != "" {
		if err := l.client.RemoveCardParticipant(tickCtx, ws, card.BoardID, card.CardID, l.client.Agent.ID); err != nil {
			slog.Warn("park_blocked: failed to unassign self", "error", err, "card_id", card.CardID)
		}
	}

	// Close the raising execution terminally so it can't dangle as `running`
	// (a dangling row 409s agent_busy on every next_assignment).
	if l.client.Agent != nil && l.client.Agent.ID != "" && execID != "" {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := l.client.LogExecutionUpdate(cleanupCtx, l.client.Agent.ID, execID, "aborted",
			"card parked as blocked"); err != nil {
			slog.Warn("park_blocked: failed to mark execution aborted", "execution_id", execID, "error", err)
		}
		cancel()
	}

	// Do NOT clear the failure counter: the `blocked` LABEL is the durable park,
	// but the in-memory counter is load-bearing for the instant-rejected-approval
	// path (handleApproval pre-fills it to the breaker threshold and this branch
	// must leave it intact so IsCardBlocked stays true). A genuinely blocked card
	// should also remain circuit-broken, so leaving the counter is correct both ways.
	return true
}

// --- Post-action dispatch ---

// postActionWithConfig routes to the appropriate post-action based on the
// decision resolved via deriveDecision (LLM > sensor precedence). Sensor-only
// decisions enable LLM-disabled stages like the tester role to drive the
// pipeline through ActionDef.Branches keyed on "pass"/"fail".
//
// ActionDef flags (MoveToColumnType, CreateReviewNote, AppendLearning,
// CleanupReviewNotes, Unassign, UnassignSelf, WakeRoles, AddLabel, RemoveLabel)
// are honored regardless of which LLM stage produced a result (or none at all,
// for sensor-only stages). Reviewer-specific helpers below handle the narrow
// GitHub-integration surface (posting PR reviews, arming on-approve auto-merge).
func (s *DataDrivenStrategy) postActionWithConfig(ctx, tickCtx context.Context, l *Loop, card *discoverResult, execID, repoDir, branch string, llmResult *llmStageResult, sensorRes *sensorResults, cleanup func(), logger *slog.Logger) error {
	cfg := s.config

	// Decision precedence: LLM result first, sensor second. See deriveDecision.
	decision := deriveDecision(llmResult, sensorRes)
	action := resolveBranchAction(cfg.OnSuccess, decision)

	// --- Reviewer-specific GitHub posting (keep PR comment/review outside generic flags). ---
	if llmResult != nil && llmResult.reviewResult != nil {
		s.postReviewToGitHub(tickCtx, l, card, repoDir, llmResult.reviewResult, logger)
	}

	isDocStage := llmResult != nil && llmResult.docResult != nil

	// --- Documentator-specific: handle skipped docs ---
	if isDocStage && llmResult.docResult.Status == "skipped" {
		logger.Info("no documentation changes needed")
		if cleanup != nil {
			cleanup()
		}
		s.applyLabelActions(tickCtx, l, card, execID, action, isDocStage)
		if l.health != nil {
			l.health.RecordSuccess()
		}
		return nil
	}

	// --- Documentator-specific: no changes but not a failure ---
	if cfg.Git.Action == "create_branch" && isDocStage {
		hasChanges, _ := l.git.HasChanges(tickCtx, repoDir)
		if !hasChanges {
			logger.Info("no doc changes to commit")
			if cleanup != nil {
				cleanup()
			}
			s.applyLabelActions(tickCtx, l, card, execID, action, isDocStage)
			if l.health != nil {
				l.health.RecordSuccess()
			}
			return nil
		}
	}

	// --- PR creation (orchestrator-like roles) ---
	prURL := ""
	// shipWarnings carry non-fatal issues (e.g. auto-merge arming refused
	// because branch protection isn't configured) to the final execution-
	// update PATCH so platform telemetry surfaces them on the execution row.
	var shipWarnings []string
	if cfg.Git.CreatePR && cfg.Git.Action == "create_branch" {
		if l.cfg.Git.AutoPR {
			summary := ""
			if llmResult != nil && llmResult.implResult != nil {
				summary = llmResult.implResult.Summary
			}
			// PR base must mirror the branching base — without --base, gh
			// targets the repo's web-UI default branch (main), bypassing
			// integration_branch and silently merging into main. Reuse the
			// same resolveBaseRef the create_branch step used.
			prBase := resolveBaseRef(cfg.Git, card)
			url, err := l.forge.OpenChange(tickCtx, repoDir, forge.OpenChangeInput{
				Title:        card.Title,
				Body:         fmt.Sprintf("Implements card %s\n\n%s", card.CardID, summary),
				SourceBranch: card.PRBranch,
				TargetBranch: prBase,
			})
			if err != nil {
				logger.Warn("PR creation failed", "error", err)
				shipWarnings = append(shipWarnings, fmt.Sprintf("PR creation failed: %v", err))
			} else {
				prURL = url
			}
		}
		// Cluster III: no on-ship auto-merge arming. The runner is
		// git-provider-agnostic; the PR stays open for the reviewer, whose
		// merge_pr step after an approve verdict is the only merge path.
	}

	// --- Hero-specific ship: move card + append PR/branch to description. ---
	// Helpers (reviewer, tester, documentator) route through the generic
	// applyActionFlags below — they don't update the card description.
	if cfg.Claim.ParticipantRole == "hero" && action.MoveToColumnType != "" {
		if err := l.ship(tickCtx, card, execID, branch, prURL, action.MoveToColumnType, shipWarnings); err != nil {
			logger.Warn("ship failed, code pushed but card not moved", "error", err)
			l.recordFailure(fmt.Sprintf("ship: %v", err), card.CardID)
			if err := l.git.ResetToDefault(tickCtx, repoDir, card.DefaultBranch); err != nil {
				logger.Warn("reset to default branch failed", "error", err)
			}
			return fmt.Errorf("ship: %w", err)
		}
	}

	// --- Reviewer approve gate: merge the PR before letting the card reach Done. ---
	// Until the backend owns a GitHub client, the runner merges directly so card
	// N+1 can fork from a main that actually contains card N's code. Without
	// this, reviewer-approve decouples from PR-merge and parallel cards fork
	// from a stale scaffold baseline (field report 2026-04-20: 20 PRs, all forked
	// from empty scaffold). On merge failure the card routes to Blocked instead
	// of Done so the pipeline doesn't silently diverge.
	//
	// PAR-2: when pipeline_config.merge_via_queue=true the runner enqueues onto
	// the backend merge queue instead of merging itself. Default false keeps
	// existing behavior; flip per-workspace once the backend worker is reliable.
	mergeGateRan := false
	if s.shouldEnqueueForMerge(l, llmResult, card) {
		s.enqueueForMerge(tickCtx, l, card, &action, logger)
		mergeGateRan = true
	} else {
		mergeGateRan = s.applyApproveMergeGate(tickCtx, l, card, repoDir, &action, llmResult, logger)
	}

	// --- Generic ActionDef flag handling (runs for every stage). ---
	// B19: post-action failures (e.g. backend rejecting an add_label because the
	// API key rotated mid-stage) must fail the tick. Silently logging "stage
	// completed" leaves the card in a half-committed state and lets the next
	// discover re-claim it — the exact re-claim loop observed on card 177bfcc5.
	if err := s.applyActionFlags(tickCtx, l, card, action, llmResult, sensorRes, logger); err != nil {
		logger.Warn("post-actions failed, stage did not complete", "error", err)
		l.recordFailure(fmt.Sprintf("post-actions: %v", err), card.CardID)
		return fmt.Errorf("post-actions: %w", err)
	}

	// --- Reviewer-specific execution completion marker. ---
	if llmResult != nil && llmResult.reviewResult != nil {
		if err := l.completeReviewExecution(tickCtx, card, execID, llmResult.reviewResult); err != nil {
			logger.Warn("complete review execution failed", "error", err)
		}
	}

	// --- Label lifecycle (generic for any stage; documentator gets its own completion marker) ---
	s.applyLabelActions(tickCtx, l, card, execID, action, isDocStage)
	if isDocStage && card.PRURL != "" {
		s.verifyPRMerge(tickCtx, l, card, repoDir, logger)
	}

	// --- Cross-strategy wakeups ---
	s.wakeRoles(l, action.WakeRoles)

	// --- Reviewer-specific tail: rework bookkeeping + arm on-approve auto-merge. ---
	// Skip the auto-merge re-arm when the approve gate ran — the PR is either
	// already merged (no-op re-arm is fine but wasteful) or we deliberately
	// routed to Blocked (re-arming would undo the block signal).
	if llmResult != nil && llmResult.reviewResult != nil && !mergeGateRan {
		s.handleReviewConditionalActions(ctx, tickCtx, l, card, repoDir, llmResult.reviewResult, logger)
	}

	// --- Cleanup ---
	if cfg.Git.Action == "create_branch" {
		if err := l.git.ResetToDefault(tickCtx, repoDir, card.DefaultBranch); err != nil {
			logger.Warn("reset to default branch failed", "error", err)
		}
	}

	if l.health != nil {
		l.health.RecordSuccess()
	}

	l.ClearCardFailure(card.CardID)
	logger.Info("stage completed", "role", cfg.Role, "branch", branch, "cost_usd", l.tickCost)
	return nil
}

// applyActionFlags honors every stage-agnostic ActionDef flag. This runs for
// helper claim paths (reviewer, documentator, tester) and as a supplement to
// hero ship (ship handles MoveToColumnType for heroes; this method skips it
// when the hero already moved the card).
//
// Findings source for CreateReviewNote: LLM reviewResult first, then the
// aggregated sensorRes.findings. When neither source has findings, the note
// is skipped (avoids empty notes when the flag is set but no context exists).
//
// First-error-wins: once the backend rejects one call (e.g. 403 after key
// rotation) the rest are almost certainly going to fail too. Returning early
// lets the caller fail the tick fast so rotation-detection can kick in instead
// of leaving the card in a half-committed state (B19).
func (s *DataDrivenStrategy) applyActionFlags(ctx context.Context, l *Loop, card *discoverResult, action valaris.ActionDef, llmResult *llmStageResult, sensorRes *sensorResults, logger *slog.Logger) error {
	ws := l.cfg.Valaris.WorkspaceSlug

	// CleanupReviewNotes before creating new ones so the latest note is the single
	// source of truth — same ordering as the pre-refactor reviewer path.
	if action.CleanupReviewNotes {
		if err := l.client.DeleteCardReviewNotes(ctx, ws, card.BoardID, card.CardID); err != nil {
			logger.Warn("failed to clean up review notes", "error", err)
			return fmt.Errorf("cleanup_review_notes: %w", err)
		}
	}

	// CreateReviewNote: prefer LLM findings, fall back to sensor aggregated findings.
	if action.CreateReviewNote {
		decision, findings := reviewNoteSource(llmResult, sensorRes)
		if findings != "" {
			if err := l.client.CreateReviewNote(ctx, ws, card.BoardID, card.CardID, decision, findings); err != nil {
				logger.Warn("failed to create review note via REST", "error", err)
				return fmt.Errorf("create_review_note: %w", err)
			}
		} else {
			logger.Debug("create_review_note flag set but no findings source available; skipping")
		}
	}

	// AppendLearning: reviewer learnings accrue on the board definition.
	if action.AppendLearning {
		learning := learningFromSources(card, llmResult, sensorRes)
		if learning != "" {
			if err := l.client.AppendDefinitionLearning(ctx, ws, card.BoardID, learning); err != nil {
				logger.Warn("failed to append learning to definition", "error", err)
				return fmt.Errorf("append_learning: %w", err)
			}
		}
	}

	// MoveToColumnType: hero path already moved via l.ship. For helpers (and for
	// hero stages that haven't opted into ship — none today), honor the flag.
	if action.MoveToColumnType != "" && s.config.Claim.ParticipantRole != "hero" {
		if err := l.moveCardToColumnType(ctx, ws, card.BoardID, card.CardID, action.MoveToColumnType); err != nil {
			logger.Warn("failed to move card", "target", action.MoveToColumnType, "error", err)
			return fmt.Errorf("move_to_column %q: %w", action.MoveToColumnType, err)
		}
	}

	// UnassignSelf: remove the current agent from the card participants.
	if action.UnassignSelf {
		agentID := ""
		if l.client.Agent != nil {
			agentID = l.client.Agent.ID
		}
		if agentID != "" {
			if err := l.client.RemoveCardParticipant(ctx, ws, card.BoardID, card.CardID, agentID); err != nil {
				logger.Warn("failed to unassign self", "error", err)
				return fmt.Errorf("unassign_self: %w", err)
			}
		}
	}

	// Unassign: remove the card owner (user_id). Used by orchestrator on failure
	// to free the card for reclaim.
	if action.Unassign && l.client.UserID != "" {
		if err := l.client.RemoveCardParticipant(ctx, ws, card.BoardID, card.CardID, l.client.UserID); err != nil {
			logger.Warn("failed to unassign owner", "error", err)
			return fmt.Errorf("unassign: %w", err)
		}
	}

	return nil
}

// reviewNoteSource picks the decision+findings pair fed to CreateReviewNote.
// LLM reviewResult has richer context (explicit decision + curated findings);
// fall back to sensor output (decision from OnPass/OnFail, aggregated finding
// lines) when the stage is sensor-only.
func reviewNoteSource(llmResult *llmStageResult, sensorRes *sensorResults) (decision, findings string) {
	if llmResult != nil && llmResult.reviewResult != nil {
		return llmResult.reviewResult.Decision, string(llmResult.reviewResult.Findings)
	}
	if sensorRes != nil {
		d := sensorRes.decision
		if d == "" {
			d = "sensor_fail"
		}
		return d, sensorRes.findings
	}
	return "", ""
}

// learningFromSources builds a board-level learning entry from whichever
// finding source is available. Format matches the pre-refactor reviewer
// output so existing dashboards keep working.
func learningFromSources(card *discoverResult, llmResult *llmStageResult, sensorRes *sensorResults) string {
	if llmResult != nil && llmResult.reviewResult != nil && llmResult.reviewResult.Findings != "" {
		return fmt.Sprintf("[%s] %s: %s", card.CardID, card.Title, llmResult.reviewResult.Findings)
	}
	if sensorRes != nil && sensorRes.findings != "" {
		return fmt.Sprintf("[%s] %s: %s", card.CardID, card.Title, sensorRes.findings)
	}
	return ""
}

// --- Reviewer-specific helpers ---
//
// The reviewer stage produces richer output (explicit approve/request_changes
// decision, GitHub PR integration, auto-merge arming) than sensor-driven stages.
// Generic flags (move, unassign, note creation, learnings, cleanup) are now in
// applyActionFlags; only the reviewer-unique pieces remain here.

// postReviewToGitHub mirrors the reviewer's decision onto the PR via gh CLI.
// No-op unless Git.ReviewOnGitHub is enabled and the card carries a PR URL.
func (s *DataDrivenStrategy) postReviewToGitHub(tickCtx context.Context, l *Loop, card *discoverResult, repoDir string, review *reviewResult, logger *slog.Logger) {
	if !l.cfg.Git.ReviewOnGitHub || card.PRURL == "" {
		return
	}
	if l.cfg.Git.ReviewMode == "github" {
		decision := forge.Comment
		switch review.Decision {
		case "approve":
			decision = forge.Approve
		case "request_changes":
			decision = forge.RequestChanges
		}
		if err := l.forge.Review(tickCtx, repoDir, card.PRURL, decision, string(review.Findings)); err != nil {
			logger.Warn("GitHub PR review failed", "error", err)
		}
		return
	}
	if err := l.forge.CommentOn(tickCtx, repoDir, card.PRURL, string(review.Findings)); err != nil {
		logger.Warn("GitHub PR comment failed", "error", err)
	}
}

// handleReviewConditionalActions runs reviewer-exclusive follow-ups that don't
// fit the ActionDef schema: rework counter bookkeeping. All generic actions
// (cleanup, move, learnings, unassign) ran earlier via applyActionFlags.
//
// Cluster III: the former approve-branch auto-merge re-arming safety net
// (ensureAutoMergeArmedOnApprove) was removed — the reviewer's merge_pr step
// after an approve verdict is the merge path, no arming needed.
func (s *DataDrivenStrategy) handleReviewConditionalActions(ctx, tickCtx context.Context, l *Loop, card *discoverResult, repoDir string, review *reviewResult, logger *slog.Logger) {
	switch review.Decision {
	case "request_changes":
		l.RecordCardRework(card.CardID)
	}
}

// --- Label primitives ---

// addLabel appends a label to the card's existing labels via REST, preserving
// order and idempotent when the label is already present. Pure data mutation:
// does not update the execution record (that is each stage's own responsibility).
// addLabel delegates to the Loop-level primitive. Returns the GET/PATCH error
// so load-bearing callers (the runtime-proof park) can detect a label that
// failed to bind; most callers keep treating it as best-effort and ignore it.
func (s *DataDrivenStrategy) addLabel(ctx context.Context, l *Loop, card *discoverResult, label string) error {
	return l.addCardLabel(ctx, card.BoardID, card.CardID, label)
}

// removeLabel drops a label from the card's existing labels via REST. No-op when
// the label is not present so it stays safe to call unconditionally after config.
func (s *DataDrivenStrategy) removeLabel(ctx context.Context, l *Loop, card *discoverResult, label string) {
	if label == "" {
		return
	}
	ws := l.cfg.Valaris.WorkspaceSlug
	current, err := l.client.GetCard(ctx, ws, card.BoardID, card.CardID)
	if err != nil {
		slog.Warn("remove_label: failed to get card", "card_id", card.CardID, "label", label, "error", err)
		return
	}
	found := false
	updated := make([]string, 0, len(current.Labels))
	for _, existing := range current.Labels {
		if existing == label {
			found = true
			continue
		}
		updated = append(updated, existing)
	}
	if !found {
		return
	}
	if err := l.client.UpdateCard(ctx, ws, card.BoardID, card.CardID, map[string]any{"labels": updated}); err != nil {
		slog.Warn("remove_label: failed to update labels", "card_id", card.CardID, "label", label, "error", err)
	}
}

// applyLabelActions applies the add/remove_label directives from an ActionDef.
// For documentator stages (isDocStage=true), the add path also records the
// "Card documented" execution completion — preserving the documentator's
// historic completion signal while every other stage gets pure REST mutation.
func (s *DataDrivenStrategy) applyLabelActions(ctx context.Context, l *Loop, card *discoverResult, execID string, action valaris.ActionDef, isDocStage bool) {
	if action.AddLabel != "" {
		if isDocStage {
			l.tagDocumented(ctx, card, execID)
		} else {
			s.addLabel(ctx, l, card, action.AddLabel)
		}
	}
	if action.RemoveLabel != "" {
		s.removeLabel(ctx, l, card, action.RemoveLabel)
	}
}

// mergedPRShortcutBlocked reports whether the orchestrator's merged-PR shortcut
// must be refused. The shortcut bypasses applyApproveMergeGate, so we must
// independently confirm the reviewer recorded an immutable "approve" verdict
// for this card before honoring it. Returns (blocked, reason). blocked=false
// means the shortcut may proceed.
//
// Backend GET /api/workspaces/{slug}/boards/{board}/cards/{card}/verdict
// returns the latest review_verdict note's parsed decision (or 404).
//
// Backend errors are conservative-blocking: a transient 500 / network flake
// during verdict lookup must NOT be treated as "no objection." Falling back
// to the normal flow is safe (the reviewer re-runs and the card moves
// through the regular path) but skipping the gate on a network error would
// reintroduce 511c20ca.
func (s *DataDrivenStrategy) mergedPRShortcutBlocked(ctx context.Context, l *Loop, card *discoverResult) (bool, string) {
	verdict, err := l.client.GetCardVerdict(ctx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID)
	if err != nil {
		return true, fmt.Sprintf("verdict lookup failed: %v", err)
	}
	if verdict == nil {
		return true, "no review verdict on record"
	}
	if verdict.Decision != "approve" {
		return true, fmt.Sprintf("latest verdict is %q, not approve", verdict.Decision)
	}
	return false, ""
}

// shouldEnqueueForMerge tests the same approve+PR conditions as
// applyApproveMergeGate but additionally requires the workspace's
// pipeline_config.merge_via_queue feature flag. Default false preserves
// pre-PAR-2 behavior bit-for-bit.
func (s *DataDrivenStrategy) shouldEnqueueForMerge(l *Loop, llmResult *llmStageResult, card *discoverResult) bool {
	if llmResult == nil || llmResult.reviewResult == nil {
		return false
	}
	if llmResult.reviewResult.Decision != "approve" {
		return false
	}
	if card.PRURL == "" || card.PRBranch == "" {
		return false
	}
	if card.GitRepoID == "" {
		return false
	}
	pc := l.platformConfig.PipelineConfig
	if pc == nil {
		return false
	}
	return pc.MergeViaQueue
}

// enqueueForMerge POSTs the approved PR onto the backend merge queue.
// Enqueue is idempotent — re-runs return the existing entry. On API
// failure the card stays in Review so the next reviewer tick re-tries;
// we never route to Blocked from here because the platform-side worker
// is the source of truth for merge success/conflict/failure.
func (s *DataDrivenStrategy) enqueueForMerge(ctx context.Context, l *Loop, card *discoverResult, action *valaris.ActionDef, logger *slog.Logger) {
	err := l.client.EnqueueForMerge(
		ctx,
		l.cfg.Valaris.WorkspaceSlug,
		card.CardID,
		card.GitRepoID,
		card.PRURL,
		card.PRBranch,
		card.IntegrationBranch,
	)
	if err != nil {
		logger.Warn("merge queue enqueue failed; leaving card in Review for retry",
			"card", card.CardID, "pr", card.PRURL, "error", err)
		// Suppress the approve branch's MoveToColumnType="done" so the card
		// stays where it is until the next reviewer tick re-enqueues.
		action.MoveToColumnType = ""
		return
	}
	logger.Info("merge queue enqueued; backend worker now owns this card",
		"card", card.CardID, "pr", card.PRURL)
	// Stop the approve branch from moving the card to Done locally — the
	// backend's merge-success path will move it once the merge lands.
	action.MoveToColumnType = ""
}

// applyApproveMergeGate is the runner-owned merge step that must succeed before
// a reviewer-approved card can reach Done. Returns true when the gate ran
// (merge attempted for an approve+PR card) so the caller can suppress the
// subsequent on-approve auto-merge re-arm.
//
// On success: leaves action unchanged; the normal MoveToColumnType="done"
// applies downstream. On failure: mutates action.MoveToColumnType to "blocked"
// and writes a merge-blocked review note carrying the failure reason. Leaves
// CreateReviewNote/CleanupReviewNotes/AppendLearning/UnassignSelf alone —
// those are bookkeeping for the *review* decision, not the merge step.
//
// Skipped entirely (returns false) when:
//   - the stage didn't produce a reviewResult (not a reviewer stage), or
//   - the decision isn't "approve" (nothing to merge), or
//   - the card has no PRURL (scaffold card or config without PRs).
func (s *DataDrivenStrategy) applyApproveMergeGate(ctx context.Context, l *Loop, card *discoverResult, repoDir string, action *valaris.ActionDef, llmResult *llmStageResult, logger *slog.Logger) bool {
	if llmResult == nil || llmResult.reviewResult == nil {
		return false
	}
	if llmResult.reviewResult.Decision != "approve" {
		return false
	}
	if card.PRURL == "" {
		return false
	}
	if l.mergeGate == nil {
		logger.Warn("approve-merge gate skipped: mergeGate unset (likely test harness with no fake injected)")
		return false
	}

	// Resolve the live PR for the branch. Re-claimed cards accumulate
	// "---\nBranch:\nPR:" blocks and extractPRURL returns the FIRST one,
	// which may point at a closed/merged PR. Fall back to card.PRURL when
	// the resolver is unavailable or errors (preserve today's semantics).
	prURL := card.PRURL
	if card.PRBranch != "" && l.currentPRResolver != nil {
		if live, err := l.currentPRResolver.CurrentPRForBranch(ctx, repoDir, card.PRBranch); err == nil && live != "" {
			prURL = live
		}
	}

	strategy := l.cfg.Git.MergeStrategy
	err := l.mergeGate(ctx, repoDir, prURL, strategy)
	if err != nil && isRebaseRetriableMergeError(err) && l.rebaseOnBase != nil {
		if rebaseErr := l.rebaseOnBase(ctx, repoDir, card.PRBranch, prURL); rebaseErr != nil {
			// Rebase failure is NOT a merge error — do not route through
			// isTransientMergeError. A half-rebased branch compounds the
			// problem on the next tick. Route directly to Blocked with the
			// rebase error surfaced so operators see what went wrong.
			logger.Warn("rebase before retry failed, routing card to Blocked", "pr", prURL, "error", rebaseErr)
			s.routeToBlocked(ctx, l, card, action, prURL, fmt.Sprintf("PR merge blocked on approval: rebase failed: %v. Card routed to Blocked — resolve the rebase manually before re-review.", rebaseErr), logger)
			return true
		}
		err = l.mergeGate(ctx, repoDir, prURL, strategy)
	}
	if err != nil {
		// Transient failures (network blips, rate limits, 5xx, timeouts) must
		// not burn the card to Blocked. The reviewer re-runs next tick and the
		// merge retries automatically. Only permanent failures (merge conflict,
		// CI red, branch protection) promote to Blocked with an explanation.
		if isTransientMergeError(err) {
			logger.Warn("approve-merge gate hit transient gh error; leaving card in current column for retry",
				"pr", prURL, "error", err)
			// Suppress the approve-branch move_to_column_type="done" — the merge
			// didn't happen, so the card must stay in Review for the next tick.
			action.MoveToColumnType = ""
			return true
		}
		logger.Warn("approve-merge gate failed, routing card to Blocked", "pr", prURL, "error", err)
		s.routeToBlocked(ctx, l, card, action, prURL, fmt.Sprintf("PR merge blocked on approval: %v. Card routed to Blocked — merge manually or rework the branch before re-review.", err), logger)
		return true
	}

	logger.Info("approve-merge gate succeeded", "pr", prURL, "strategy", strategy)
	return true
}

// routeToBlocked writes a merge-blocked review note with the given body and
// mutates action so the stage moves the card to Blocked without wiping the
// note we just created.
func (s *DataDrivenStrategy) routeToBlocked(ctx context.Context, l *Loop, card *discoverResult, action *valaris.ActionDef, prURL, note string, logger *slog.Logger) {
	if noteErr := l.client.CreateReviewNote(ctx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID, "merge-blocked", note); noteErr != nil {
		logger.Warn("failed to create merge-blocked review note", "error", noteErr)
	}
	action.MoveToColumnType = "blocked"
	// Do NOT let the approve branch's CleanupReviewNotes wipe the merge-blocked
	// note we just created — that would leave the operator with a Blocked card
	// and zero explanation. Merge-success path keeps cleanup enabled since the
	// PR is merged and prior review chatter is obsolete.
	action.CleanupReviewNotes = false
}

// transientMergeErrorMarkers are substrings in a `gh pr merge` error that indicate
// a retryable infrastructure failure rather than a permanent merge-blocking
// condition. The runner re-runs the reviewer next tick on a transient; on a
// permanent, it routes the card to Blocked with an explanation note.
var transientMergeErrorMarkers = []string{
	"rate limit",
	"timeout",
	"timed out",
	"temporarily unavailable",
	"connection reset",
	"connection refused",
	"i/o timeout",
	"no such host",
	"502 bad gateway",
	"503 service unavailable",
	"504 gateway timeout",
}

func isTransientMergeError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	for _, marker := range transientMergeErrorMarkers {
		if strings.Contains(msg, marker) {
			return true
		}
	}
	return false
}

// rebaseRetriableMergeErrorMarkers are substrings indicating the PR's base
// moved under us — recoverable by rebasing onto the fresh base and retrying
// once. Disjoint from transientMergeErrorMarkers: those stay-in-place for
// the next tick; these need active intervention (rebase) before retry.
var rebaseRetriableMergeErrorMarkers = []string{
	"base branch was modified",
}

func isRebaseRetriableMergeError(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	for _, marker := range rebaseRetriableMergeErrorMarkers {
		if strings.Contains(msg, marker) {
			return true
		}
	}
	return false
}

func (s *DataDrivenStrategy) verifyPRMerge(ctx context.Context, l *Loop, card *discoverResult, repoDir string, logger *slog.Logger) {
	status, err := l.forge.ChangeStatusFor(ctx, repoDir, card.PRURL)
	if err != nil {
		logger.Warn("failed to check PR status", "error", err)
		return
	}
	if status.State == forge.StateOpen && !status.Mergeable {
		note := fmt.Sprintf("PR merge blocked: state=%s, mergeable=%t. Requires manual attention or rework.", status.State, status.Mergeable)
		if err := l.client.CreateReviewNote(ctx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID, "merge-blocked", note); err != nil {
			logger.Warn("failed to create merge status note", "error", err)
		}
		logger.Warn("PR merge blocked", "pr", card.PRURL, "state", status.State, "mergeable", status.Mergeable)
	} else if status.State == forge.StateMerged {
		logger.Info("PR merged successfully", "pr", card.PRURL)
	}
}

// --- Skip handling (custom LLM stage without a seeded prompt) ---

// skipNoPromptStage cleans up after runLLMStage returns decision="no_prompt":
// the operator hasn't seeded the prompt template for this custom stage yet.
// This is a deferral, not a failure — the card stays in its current column,
// the participant claim is released so the next tick can reclaim, and the
// execution record is marked completed-with-skip (so the UI doesn't show a
// spurious failure and the circuit breaker doesn't rack up "failures" for
// what is really missing operator configuration).
func (s *DataDrivenStrategy) skipNoPromptStage(ctx context.Context, l *Loop, card *discoverResult, execID string, cleanup func(), logger *slog.Logger) {
	logger.Info("custom LLM stage skipped — no prompt cached",
		"role", s.config.Role, "stage", s.config.LLM.Stage, "card_id", card.CardID)

	if l.health != nil {
		l.health.RecordSkip()
	}

	cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}

	// 1. Mark execution record as skipped so the UI reflects the deferral.
	if agentID != "" && execID != "" {
		if err := l.client.LogExecutionUpdate(cleanupCtx, agentID, execID, "skipped", "no prompt template cached for stage"); err != nil {
			slog.Warn("skip: failed to mark execution as skipped", "execution_id", execID, "error", err)
		}
	}

	// 2. Release the participant claim so the card is reclaimable next tick.
	// Hero claims bind l.client.UserID; helper claims bind the agent ID.
	ws := l.cfg.Valaris.WorkspaceSlug
	releaseID := l.client.UserID
	if s.config.Claim.ParticipantRole == "helper" {
		releaseID = agentID
	}
	if releaseID != "" {
		if err := l.client.RemoveCardParticipant(cleanupCtx, ws, card.BoardID, card.CardID, releaseID); err != nil {
			slog.Warn("skip: failed to release participant", "card_id", card.CardID, "error", err)
		}
	}

	// 3. Reset git working tree (branch creation side-effect of gitSetupWithConfig).
	if cleanup != nil {
		cleanup()
	}

	// 4. Drop any cached LLM session for this card — next tick starts clean.
	if l.sessions != nil && agentID != "" {
		l.sessions.Clear(agentID, card.CardID)
	}
}

// skipReworkNoChanges records a benign no-op rework (tests now pass on their
// own, e.g. because a sibling PR merged) as status=skipped instead of failed.
// The card normally stays where it is; the scheduler will revisit it next
// tick if anything truly needs doing. We do NOT call recordFailure on the
// first skip — the circuit breaker must not trip on a card that is
// legitimately correct.
//
// Consecutive-skip guard: a rework tick that produces zero git changes on a
// card that is still rejected is sometimes a legitimate no-op but is often
// a stuck loop — e.g. the executor reads the fix already on disk and exits
// without writing, then the orchestrator re-discovers the same rejected
// card, mediates, re-executes, still writes nothing. Each cycle burns
// ~$0.10-$0.50 in LLM spend and makes no progress. After
// maxConsecutiveNoChangeReworks consecutive skips on the same card, we
// force-move it to "blocked" so a human can intervene.
func (s *DataDrivenStrategy) skipReworkNoChanges(ctx context.Context, l *Loop, card *discoverResult, execID string, cleanup func(), logger *slog.Logger) {
	if l.health != nil {
		l.health.RecordSkip()
	}

	cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	noChangeCount := l.RecordNoChangeRework(card.CardID)

	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}

	if noChangeCount >= maxConsecutiveNoChangeReworks {
		msg := fmt.Sprintf("rework produced no code changes %d ticks in a row — blocking card for human review", noChangeCount)
		logger.Warn("no-change rework limit reached — forcing card to blocked",
			"card_id", card.CardID, "consecutive_no_change", noChangeCount,
			"limit", maxConsecutiveNoChangeReworks)

		// failExecutionTo marks execution=failed, moves card to blocked,
		// and unassigns the agent. We ALSO bump reworkCount to
		// MaxReworkAttempts so IsCardBlocked keeps the card out of
		// future discover() results until the cooldown expires (or a
		// human clears it).
		l.failExecutionTo(ctx, card, execID, msg, "blocked")
		wsCfg := l.WorkspaceConfig()
		for i := l.CardReworkCount(card.CardID); i < wsCfg.MaxReworkAttempts; i++ {
			l.RecordCardRework(card.CardID)
		}

		if cleanup != nil {
			cleanup()
		}
		return
	}

	if agentID != "" && execID != "" {
		if err := l.client.LogExecutionUpdate(cleanupCtx, agentID, execID, "skipped", "rework produced no code changes"); err != nil {
			logger.Warn("rework skip: failed to mark execution as skipped", "execution_id", execID, "error", err)
		}
	}

	if cleanup != nil {
		cleanup()
	}
}

// --- Failure handling dispatch ---

// failWithConfig cleans up after a failed tick, honoring the stage's OnFailure
// config rather than always bouncing the card to "backlog".
//
// Force-to-blocked circuit breaker: if the current card has accumulated enough
// failures to trip the circuit breaker (`MaxReworkAttempts`), the target column
// is overridden to "blocked" regardless of the configured value. This prevents
// a persistently broken card from ping-ponging between Active and Backlog
// forever. The board must have a `column_type:"blocked"` column; if not, the
// move is skipped and the card stays where it is (logged at WARN).
func (s *DataDrivenStrategy) failWithConfig(ctx context.Context, l *Loop, card *discoverResult, execID, msg string) {
	// Force-to-blocked once the transient failure count reaches the threshold.
	// recordFailure (called by the caller) will push count past the threshold,
	// so we check against the projected post-increment value here. Checked
	// BEFORE the stay-in-column branch: the durable park (blocked label +
	// column) must apply to every stage shape, or a stay-in-column stage
	// retries forever on a card whose only breaker is in-memory.
	wsCfg := l.WorkspaceConfig()
	if card.CardID != "" && l.CardFailureCount(card.CardID)+1 >= wsCfg.MaxReworkAttempts {
		slog.Warn("card failure threshold reached — forcing move to blocked",
			"card_id", card.CardID, "count", l.CardFailureCount(card.CardID)+1,
			"threshold", wsCfg.MaxReworkAttempts,
			"configured_target", s.config.OnFailure.MoveToColumnType)
		l.failExecutionTo(ctx, card, execID, msg, "blocked")
		return
	}

	// Below the threshold a stage with NO configured on_failure target stays
	// in place: the card remains in the column the stage discovered it in, so
	// the same stage retries next poll. The old "backlog" fallback strands any
	// labeled mid-pipeline card in a column no role scans (run B, 2026-06-10:
	// a failed reviewer tick dumped a `planned` card from review into backlog,
	// unreachable by every role; same for a done-column card mid ui-validation).
	target := s.config.OnFailure.MoveToColumnType
	if s.config.OnFailure.StayInColumn || target == "" {
		l.failDocExecution(ctx, card, execID, msg)
		return
	}

	l.failExecutionTo(ctx, card, execID, msg, target)
}

func (s *DataDrivenStrategy) handleGitFailure(ctx context.Context, l *Loop, card *discoverResult, execID string, err error, cfg valaris.StageConfig) error {
	s.failWithConfig(ctx, l, card, execID, fmt.Sprintf("git setup failed: %v", err))
	l.recordFailure(fmt.Sprintf("git setup: %v", err), card.CardID)
	return fmt.Errorf("git setup (%s): %w", cfg.Role, err)
}

// --- Utility ---

func (s *DataDrivenStrategy) wakeRoles(l *Loop, roles []string) {
	for _, role := range roles {
		l.WakeRole(role)
	}
}

// executionLogDescription produces the "Implementing card" / "Reviewing card"
// style verb phrase for a stage's execution log. It is config-driven so custom
// roles are first-class: an explicit claim.log_verb wins, otherwise the verb is
// derived from claim.execution_action ("audit_card" -> "Auditing"), otherwise
// from the role name itself.
func executionLogDescription(stage valaris.StageConfig) string {
	if verb := strings.TrimSpace(stage.Claim.LogVerb); verb != "" {
		return upperFirst(verb) + " card"
	}
	if action := strings.TrimSpace(stage.Claim.ExecutionAction); action != "" {
		words := strings.Fields(strings.ReplaceAll(strings.TrimSuffix(action, "_card"), "_", " "))
		if len(words) > 0 {
			words[len(words)-1] = gerundOf(words[len(words)-1])
			return upperFirst(strings.Join(words, " ")) + " card"
		}
	}
	if role := strings.TrimSpace(stage.Role); role != "" {
		return upperFirst(role) + " card"
	}
	return "Processing card"
}

// gerundOf applies the English -ing spelling rules the built-in execution
// actions rely on: drop a silent trailing "e" (triage -> triaging, but see ->
// seeing), double a final consonant after a single vowel (run -> running), and
// leave an existing gerund alone.
//
// Doubling is restricted to short verbs because the real rule keys off syllable
// stress, which is not derivable from spelling: "run"/"scan" double, but the
// unstressed final syllable of "audit"/"visit" does not.
func gerundOf(verb string) string {
	if verb == "" || strings.HasSuffix(verb, "ing") {
		return verb
	}
	runes := []rune(verb)
	last := runes[len(runes)-1]

	if last == 'e' && len(runes) > 2 && !isVowel(runes[len(runes)-2]) {
		return string(runes[:len(runes)-1]) + "ing"
	}
	const maxDoublingLength = 4
	// "wxy" never double: fix -> fixing, play -> playing.
	if len(runes) >= 3 && len(runes) <= maxDoublingLength &&
		!isVowel(last) && !strings.ContainsRune("wxy", last) &&
		isVowel(runes[len(runes)-2]) && !isVowel(runes[len(runes)-3]) {
		return verb + string(last) + "ing"
	}
	return verb + "ing"
}

func isVowel(r rune) bool {
	return strings.ContainsRune("aeiou", unicode.ToLower(r))
}

// upperFirst capitalizes the first rune without touching the rest, so acronym
// roles ("QA") and non-ASCII roles ("ünit-tester") survive intact.
func upperFirst(s string) string {
	if s == "" {
		return s
	}
	runes := []rune(s)
	runes[0] = unicode.ToUpper(runes[0])
	return string(runes)
}

// tickViaLifecycle is the entry point when s.config.Lifecycle is non-empty.
// It builds a lifecycle.WalkState from the loop+strategy and delegates to the
// generic walker. Idle-tick bookkeeping (no-card → ResetIdleBackoff, health,
// etc.) mirrors the equivalent paths in the legacy Tick body so observability
// stays consistent between the two execution shapes.
func (s *DataDrivenStrategy) tickViaLifecycle(ctx context.Context, l *Loop) error {
	// Setup (discover, claim, cold clone) runs on its OWN budget; the walker
	// swaps in a fresh CardTimeout at the first non-setup step via
	// StartWorkBudget below. Same split the legacy tickCard path makes — see
	// cardSetupTimeout — so a slow clone can no longer kill the attempt before
	// the first token.
	tickCtx, tickCancel := context.WithTimeout(ctx, cardSetupTimeout)
	defer tickCancel()

	l.resetTickCost()

	// Clear the per-tick backend-declared model stash on every exit path so the
	// heartbeat goroutine's budget bookkeeping never reads a stale per-card
	// model. lifecycleDiscover sets it for the duration of the walk; this mirrors
	// the legacy Tick defer at strategy_generic.go:75.
	defer l.SetAssignmentLLM(valaris.AssignmentLLM{})
	defer l.SetCardBudgetOverride(nil)

	ws := &lifecycle.WalkState{
		Loop:     l,
		Strategy: s,
		Sensors:  s.sensors,
		Logger:   slog.With("role", s.config.Role, "exec_mode", "lifecycle"),
		// The card's work budget starts once the workspace is ready. Derived
		// from the OUTER ctx, not the setup-bounded tickCtx, so the work phase
		// gets a full CardTimeout rather than setup's leftovers — matching
		// tickCard, which derives its work budget from ctx for the same reason.
		StartWorkBudget: func(context.Context) (context.Context, context.CancelFunc) {
			return context.WithTimeout(ctx, l.cfg.WorkLoop.CardTimeout)
		},
	}

	// Report accumulated cost/tokens on EVERY exit path (clean walk, suspend,
	// error, idle) — the legacy tickCard path did this via defer but the walker
	// never did, so live-pipeline executions stayed NULL-cost in the DB. ws is a
	// pointer; ExecutionID is populated mid-walk by the claim step, so reading it
	// at defer time gets the right id (empty on no-card ticks → reportCost no-ops).
	// Use a fresh background context: tickCtx may already be canceled by the
	// CardTimeout when the defer runs, which would silently drop the PATCH. This
	// mirrors the clean-exit LogExecutionUpdate below (the same reasoning applies).
	defer func() {
		cctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		l.reportCost(cctx, ws.ExecutionID)
	}()

	err := lifecycle.Walker{}.Walk(tickCtx, ws, s.config.Lifecycle)
	if errors.Is(err, lifecycle.ErrNoWork) {
		slog.Debug("no work available (lifecycle)", "role", s.config.Role, "idle_backoff", l.idleBackoff)
		l.IncrementIdleBackoff()
		if l.health != nil {
			l.health.RecordSkip()
		}
		return nil
	}
	// A budget-suspended card is a clean stop: its WIP was checkpointed and the
	// card parked for resume. NOT a failure — skip failWithConfig/git_cleanup/
	// recordFailure (the checkpointAndSuspend path already committed + labeled,
	// and the branch MUST be preserved). The work happened, so record it like a
	// completed tick rather than an idle skip.
	if errors.Is(err, lifecycle.ErrSuspended) {
		slog.Info("card suspended mid-lifecycle (parked, not failed); state preserved for resume", "role", s.config.Role)
		// Close the execution with a TERMINAL status. The checkpoint/suspend path
		// shed the hero and parked the card but left this row `running` — and the
		// single-agent deployment's busy-guard then 409s `agent_busy` on every
		// subsequent next_assignment (all roles) citing this dead execution, so the
		// whole pipeline starves. "aborted" is terminal (sets completed_at, clears
		// the busy-guard) and, unlike a completion, does NOT release the
		// reservation — correct here, since the reservation is meant to TTL-drain
		// so the parked card is re-discovered for the resume pass. Best-effort:
		// mirror the clean-exit close below; a failed PATCH must not change the
		// suspend outcome (WIP is already committed + labeled).
		//
		// FIX #3: a suspend whose park path already closed its own execution
		// (approval park sets execution_released) must not be closed twice.
		suspendReleased, _ := ws.Get("execution_released")
		suspendReleasedBool, _ := suspendReleased.(bool)
		if !suspendReleasedBool && ws.ExecutionID != "" && l.client.Agent != nil {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			if err := l.client.LogExecutionUpdate(cleanupCtx, l.client.Agent.ID, ws.ExecutionID, "aborted", "budget-suspended; WIP checkpointed"); err != nil {
				slog.Warn("budget-suspend cleanup: failed to mark execution aborted", "execution_id", ws.ExecutionID, "error", err)
			}
			cancel()
		}
		l.ResetIdleBackoff()
		l.lastTickHadWork = true
		return nil
	}
	// FIX #1: a salvaged walk is a SUCCESS that already carried out its own
	// terminal sequence (PR opened, card shipped, execution completed) on a
	// fresh context. Mirror the clean-exit bookkeeping; never failWithConfig
	// or git_cleanup — the branch now backs an open PR.
	if errors.Is(err, lifecycle.ErrSalvaged) {
		slog.Info("lifecycle stage cut off after commits — salvaged into PR and shipped (success, no failure recorded)", "role", s.config.Role)
		l.ResetIdleBackoff()
		l.lastTickHadWork = true
		if l.health != nil {
			l.health.RecordSuccess()
		}
		return nil
	}
	if err != nil {
		// FOLLOWUP-9: legacy DataDrivenStrategy.Tick called failWithConfig +
		// the git cleanup closure on every error path. The walker doesn't —
		// it just returns the error. Without this restore the card stays
		// heroed, the execution stays in `running`, and every subsequent
		// tick 409s with agent_busy. Mirror the legacy contract here so
		// on_failure (StayInColumn / MoveToColumnType / Unassign) is
		// respected after a mid-walk error too.
		card := cardFromWalk(ws)
		if card != nil && card.CardID != "" {
			s.failWithConfig(ctx, l, card, ws.ExecutionID, fmt.Sprintf("lifecycle step failed: %v", err))
			l.recordFailure(err.Error(), card.CardID)
		}
		if v, ok := ws.Get("git_cleanup"); ok {
			if cleanup, ok := v.(func()); ok && cleanup != nil {
				cleanup()
			}
		}
		return fmt.Errorf("lifecycle (%s): %w", s.config.Role, err)
	}
	// FOLLOWUP-12: on clean walker exit, mark the execution `completed` if no
	// terminal kind already did. Terminal kinds that release inline (ship,
	// merge_pr) set ws.Variables["execution_released"]=true so this block
	// skips them. Without this, lifecycles ending on a kind that only carries
	// out its own action (apply_label, move_card, create_note) leak the
	// execution forever — every subsequent tick 409s with agent_busy.
	//
	// Participant removal is NOT done here on success: legacy behavior keeps
	// the hero/helper attached as the record of who did the work. Roles that
	// want unassign-on-success encode it via on_success.Unassign on a
	// branch-action path (see applyBranchAction), not via auto-cleanup.
	released, _ := ws.Get("execution_released")
	releasedBool, _ := released.(bool)
	if !releasedBool && ws.ExecutionID != "" && l.client.Agent != nil {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		if err := l.client.LogExecutionUpdate(cleanupCtx, l.client.Agent.ID, ws.ExecutionID, "completed", fmt.Sprintf("%s completed", s.config.Role)); err != nil {
			slog.Warn("lifecycle cleanup: failed to mark execution completed", "execution_id", ws.ExecutionID, "error", err)
		}
		cancel()
	}

	// A clean walk that engaged no card (ws.Card never populated by a discover
	// step) is an IDLE tick, not productive work. The disabled-documentator shape
	// — a bare `end` lifecycle with llm.enabled=false — exits cleanly here without
	// ever touching a card. Reporting it as work is catastrophic in the multi-role
	// scheduler: scheduledTick returns the instant a role reports work, so a no-op
	// role sitting mid-priority_order short-circuits the fast-forward walk and the
	// tail roles after it (e.g. ui_validator) are never reached — and
	// selfTriggerIfProductive re-arms on the phantom work, spinning the stall.
	// Mirror the ErrNoWork idle path above: leave lastTickHadWork as the caller
	// pre-set it (false in scheduledTick), so the walk fast-forwards to the next role.
	if cardFromWalk(ws) == nil {
		slog.Debug("no work available (lifecycle): walk engaged no card", "role", s.config.Role, "idle_backoff", l.idleBackoff)
		l.IncrementIdleBackoff()
		if l.health != nil {
			l.health.RecordSkip()
		}
		return nil
	}

	l.ResetIdleBackoff()
	l.lastTickHadWork = true
	if l.health != nil {
		l.health.RecordSuccess()
	}
	return nil
}
