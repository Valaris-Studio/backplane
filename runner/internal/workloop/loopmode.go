// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// LoopMode runs the third mode alongside the pipeline work loop and
// -discover: bind to one board and repeat a headless agent session on an
// operator-authored prompt until the platform loop config disables it or a
// safety rail trips. It shares the provider registry/resolution rules with
// Loop but owns none of Loop's card/pipeline state — loop mode never touches
// the scheduler (see docs/loop-mode-contract.md).
type LoopMode struct {
	client          *valaris.Client
	cfg             *config.Config
	providers       map[string]llm.Provider
	defaultProvider llm.Provider
	workspaceSlug   string
	boardID         string
	agentID         string

	// keepAlive turns a loop-off from an exit into a wait. Default false, so
	// every pre-existing invocation keeps exiting exactly as it did.
	keepAlive bool
	// wake is signalled when the platform re-enables the loop over the
	// WebSocket, cutting the idle wait short. Nil is fine — the poll fallback
	// alone still resumes within idleWaitMax.
	wake <-chan struct{}
	// after is the pacing seam (default time.After). The idle backoff sleeps
	// in tens of seconds, which no unit test can afford to wait out.
	after func(time.Duration) <-chan time.Time
	// mcpSurface caches the once-per-run tools/list probe shared by the
	// surface pre-flights (see servedMCPCatalog).
	mcpSurface           *mcpSurfaceProbe
	completionRetryAfter time.Time
	completionNotices    map[string]string
	budgetHistory        *valaris.LoopHistory
	budgetSpent          float64
	// Tests of completion scheduling inject the I/O boundary; production uses
	// the actual configured MCP process before any source/review/validation work.
	completionMCPCheck func(context.Context, string, string, string, *valaris.BoardLoopConfig) (MCPLaunchReport, error)
}

// Idle pacing while the loop is off. The ceiling is the load-bearing number:
// the backend flips an agent to `offline` after ALIVE_THRESHOLD_SECONDS = 90s
// without a heartbeat, and every idle tick sends one, so backing off past that
// would make a perfectly healthy waiting runner read as dead.
const (
	idleWaitBase = 30 * time.Second
	idleWaitMax  = 60 * time.Second
)

// idleWaitDelay paces re-checking a disabled board: one short probe, then the
// ceiling. Unlike parkDelay this is not operator-tunable — it is pinned to the
// liveness threshold, not to a preference.
func idleWaitDelay(consecutiveIdle int) time.Duration {
	if consecutiveIdle <= 1 {
		return idleWaitBase
	}
	return idleWaitMax
}

// isUnprocessableEntity reports whether err is a 422 from the platform — the
// shape a backend older than a payload field returns when its schema rejects
// the unknown value outright.
func isUnprocessableEntity(err error) bool {
	var apiErr *valaris.APIError
	return errors.As(err, &apiErr) && apiErr.StatusCode == http.StatusUnprocessableEntity
}

// SetKeepAlive opts this runner into waiting for the loop to be re-enabled
// instead of exiting when it is switched off.
func (m *LoopMode) SetKeepAlive(on bool) { m.keepAlive = on }

// SetWake wires the WebSocket wake channel used to cut an idle wait short.
func (m *LoopMode) SetWake(wake <-chan struct{}) { m.wake = wake }

// SetAfter overrides the idle-wait timer (tests inject a fake clock).
func (m *LoopMode) SetAfter(after func(time.Duration) <-chan time.Time) { m.after = after }

// sleep waits d, honouring the injected timer seam.
func (m *LoopMode) sleep(d time.Duration) <-chan time.Time {
	if m.after != nil {
		return m.after(d)
	}
	return time.After(d)
}

// NewLoopMode constructs a LoopMode bound to one board. providers may be nil
// (single-provider runner); defaultProvider is always required.
func NewLoopMode(client *valaris.Client, cfg *config.Config, providers map[string]llm.Provider, defaultProvider llm.Provider, workspaceSlug, boardID, agentID string) *LoopMode {
	return &LoopMode{
		client:          client,
		cfg:             cfg,
		providers:       providers,
		defaultProvider: defaultProvider,
		workspaceSlug:   workspaceSlug,
		boardID:         boardID,
		agentID:         agentID,
	}
}

// Run drives the loop until the platform disables it, a safety rail trips,
// or ctx is cancelled. A disabled-at-fetch exit, and a rail-tripped exit
// whose disable PATCH landed, return nil — both are normal, successful
// stops. A rail-tripped exit whose disable PATCH FAILED returns that error:
// the board is still enabled, so the next launch would resume iterating and
// spending, and exiting 0 would hide that. Fetch/config errors are fatal.
//
// Under starvation_policy "park" (the default), each cycle pre-flights the
// board with GET /loop/readiness before paying for a session: not-actionable
// parks the loop — no session, no iteration number, no budget spend, no
// failure-counter interaction — sleeping with backoff (parkDelay) and
// heartbeating so agent presence stays fresh. Parked cycles log NO execution
// rows (visibility is the log line + the board's own readiness surface —
// per-probe rows would spam the feed).
func (m *LoopMode) Run(ctx context.Context) error {
	// Resolve explicit run intent before any board mutation or paid iteration.
	// Unlike tier preferences, an override must never fall back to another agent.
	var overrideProvider llm.Provider
	var override *config.ModelSelection
	if m.cfg.LLM.RunOverride != nil {
		selection := *m.cfg.LLM.RunOverride
		if err := selection.Validate(); err != nil {
			return err
		}
		override = &selection
		overrideProvider = m.providers[selection.Provider]
		if overrideProvider == nil && m.defaultProvider != nil && m.defaultProvider.Name() == selection.Provider {
			overrideProvider = m.defaultProvider
		}
		if overrideProvider == nil || overrideProvider.Name() != selection.Provider {
			return fmt.Errorf("loop run model override provider %q is unavailable; refusing fallback", selection.Provider)
		}
	}
	var spent float64
	var consecutiveFailures int
	iterations := 0         // real provider sessions run; parked cycles consume nothing
	iterationOffset := 0    // prior iterations across the board's life (seeded once)
	consecutiveParks := 0   // drives parkDelay backoff; reset by a session that found work
	consecutiveBlocked := 0 // blocked_on_human streak; drives the MaxBlockedOnHuman rail
	consecutiveIdle := 0    // keep-alive wait streak; drives idleWaitDelay backoff
	readinessUnsupported := false
	capWarned := false // once-per-run budget-cap enforceability warnings
	seeded := false

	// Cross-run continuity (card 371bd382): seed {{.Iteration}} numbering and
	// the spent accumulator from the board's execution history, so a restart
	// neither collides note titles nor launders money already spent this
	// budget epoch. max_iterations deliberately stays per-process — it is a
	// runaway guard, not money; a restart may always run again.
	seedContinuity := func() error {
		history, err := m.client.GetLoopHistory(ctx, m.workspaceSlug, m.boardID)
		if err != nil {
			return fmt.Errorf("cannot establish loop budget: %w", err)
		}
		seeded = true
		m.budgetHistory = history
		iterationOffset = history.IterationCount
		spent = history.SpentUSD
		epoch := ""
		if history.BudgetEpoch != nil {
			epoch = *history.BudgetEpoch
		}
		slog.Info("loop mode: continuity seeded",
			"board_id", m.boardID,
			"prior_iterations", iterationOffset,
			"spent_usd_since_epoch", spent,
			"budget_epoch", epoch)
		return nil
	}

	recap := func(budget float64) {
		slog.Info("loop spend recap", "board_id", m.boardID,
			"spent_usd", spent, "budget_usd", budget, "iterations", iterations)
	}

	// Park-streak start, stamped once when a streak begins and cleared on
	// wake. Reporting "parked since now" on every tick would answer the one
	// question the field exists for — how long has it been asleep — wrong.
	var parkedSince time.Time

	// heartbeatLoopState reports board attribution and loop state on every
	// tick. Parked ticks carry the reason and the streak start; ticking ticks
	// carry neither, which is what tells the backend to clear a stale park
	// story. Non-fatal like every heartbeat: a warning, never a stall.
	// idle_waiting is newer than some backends the runner talks to. Their
	// heartbeat schema rejects the unknown literal outright (422), which would
	// stall last_seen_at on every idle tick and drift the agent `offline`
	// while it is perfectly healthy. On the first rejection, latch to the
	// long-supported "parked" for the process lifetime — same shape as
	// readinessUnsupported below.
	idleStateUnsupported := false

	heartbeatLoopState := func(state, reason string) {
		if state == valaris.LoopStateIdleWaiting && idleStateUnsupported {
			state = valaris.LoopStateParked
		}
		buildReport := func(state string) *valaris.HealthReport {
			report := valaris.NewHealthReport()
			report.LoopBoardID = m.boardID
			report.LoopState = state
			// idle_waiting joins parked in carrying the streak story: both are
			// "asleep since X because Y", and the operator's question is the
			// same one either way.
			if state == valaris.LoopStateParked || state == valaris.LoopStateIdleWaiting {
				if parkedSince.IsZero() {
					parkedSince = time.Now().UTC()
				}
				report.LoopParkReason = reason
				report.LoopParkedSince = parkedSince.Format(time.RFC3339)
			} else {
				parkedSince = time.Time{}
			}
			return report
		}

		err := m.client.Heartbeat(ctx, buildReport(state))
		if err != nil && state == valaris.LoopStateIdleWaiting && isUnprocessableEntity(err) {
			// Re-send in the SAME tick rather than waiting for the next one:
			// a skipped beat plus a full backoff gaps past the 90s liveness
			// threshold and flickers the agent offline exactly once.
			idleStateUnsupported = true
			slog.Warn("loop mode: backend rejected loop_state=idle_waiting — reporting parked for the rest of this run",
				"board_id", m.boardID)
			err = m.client.Heartbeat(ctx, buildReport(valaris.LoopStateParked))
		}
		if err != nil {
			slog.Warn("loop mode: heartbeat failed", "board_id", m.boardID, "error", err)
		}
	}

	for {
		cfg, err := m.client.GetBoardLoop(ctx, m.workspaceSlug, m.boardID)
		if err != nil {
			return fmt.Errorf("loop mode: %w", err)
		}
		if !cfg.Enabled {
			reason := ""
			if cfg.DisabledReason != nil {
				reason = *cfg.DisabledReason
			}
			if !m.keepAlive {
				slog.Info("loop disabled", "board_id", m.boardID, "reason", reason)
				recap(cfg.BudgetUSD)
				return nil
			}

			// Keep-alive: an operator switching the loop off is a PAUSE, not
			// the end of the job. Wait it out — no session, no execution row,
			// no budget, one heartbeat and one config fetch per cycle.
			//
			// Safe to sit above the rail checks below precisely because the
			// rails only fire while the loop is ENABLED: a budget-exhausted or
			// completed run reaches its `m.disable(...)` on the cycle that
			// spots it and returns from there, so keep-alive never sees it.
			// What lands here is a board someone else turned off.
			consecutiveIdle++
			delay := idleWaitDelay(consecutiveIdle)
			if reason == "" {
				reason = "loop disabled on the board"
			}
			if m.completionNoticeChanged("idle", reason) {
				slog.Info("loop mode: idle — waiting for the loop to be re-enabled",
					"board_id", m.boardID,
					"reason", m.completionOutput(reason, ""),
					"idle_cycles", consecutiveIdle,
					"next_check_in", delay)
			}
			heartbeatLoopState(valaris.LoopStateIdleWaiting, reason)
			select {
			case <-ctx.Done():
				recap(cfg.BudgetUSD)
				return nil
			case <-m.wake:
			case <-m.sleep(delay):
			}
			// Re-enabling resets budget_epoch server-side, so the spend this
			// process accumulated belongs to a closed epoch. Carrying it over
			// would charge the new run for the old one's money and trip the
			// budget rail on the very first cycle after the wake.
			seeded = false
			continue
		}
		consecutiveIdle = 0
		delete(m.completionNotices, "idle")

		if cfg.CompletionPolicy != nil {
			if err := m.preflightCompletionWorkflow(ctx, cfg); err != nil {
				return err
			}
			probe := m.completionMCPCheck
			if probe == nil {
				probe = PreflightCompletionMCP
			}
			report, err := probe(ctx, m.cfg.LLM.MCPConfigPath, m.workspaceSlug, m.boardID, cfg)
			if err != nil {
				return err
			}
			m.mcpSurface = &mcpSurfaceProbe{done: true, served: report.Catalog}
			if m.completionNoticeChanged("mcp", report) {
				slog.Info("MCP launch verified", "mcp_config", report.ConfigPath,
					"mcp_executable", report.Executable, "mcp_server", report.ServerName,
					"mcp_version", report.Version, "board_id", m.boardID)
			}
			readiness, err := PreflightCompletionReadiness(ctx, m.client, m.workspaceSlug, m.boardID, cfg)
			if err != nil {
				return fmt.Errorf("%s", m.completionOutput(err.Error(), ""))
			}
			if m.completionNoticeChanged("readiness", readiness) {
				for _, check := range readiness.Verified {
					slog.Info("Server completion prerequisite verified", "detail", m.completionOutput(check, ""))
				}
				for _, check := range readiness.Unverified {
					slog.Info("Server completion prerequisite unverified", "detail", m.completionOutput(check, ""))
				}
			}

		}

		if !seeded {
			if err := seedContinuity(); err != nil {
				return err
			}
			// One fault, one line: a missing grant is already fully explained by
			// the allowlist warning, and probing an ungranted tool would add a
			// second message pointing somewhere else.
			if warnMissingOffSwitch(cfg.Tools) {
				slog.Warn(offSwitchPreflightWarning, "board_id", m.boardID, "granted_tools", len(cfg.Tools))
			} else if !m.offSwitchCallable(ctx) {
				slog.Warn(offSwitchUncallableWarning, "board_id", m.boardID)
			} else {
				// Third and last question, and the only one that has ever
				// actually failed: the grant is present and the endpoint
				// accepts, but does the MCP server the session talks to
				// SERVE the tool? Runs silently unless the answer is a
				// conclusive no (see warnUnservedOffSwitch).
				m.warnUnservedOffSwitch(ctx)
			}
			// Independent of the off-switch: a grant naming a tool the server
			// only serves as a deprecated alias works now and breaks on the
			// next backplane-mcp minor. Warns once per run, like the rest.
			m.warnDeprecatedGrants(ctx, cfg.Tools)
		}

		if cfg.CompletionPolicy != nil {
			m.budgetSpent = spent
			held, executed, completionCost, err := m.runCompletionWork(ctx, cfg, cfg.BudgetUSD-spent)
			spent += completionCost
			if err != nil {
				if ctx.Err() != nil {
					return nil
				}
				return err
			}
			if held {
				heartbeatLoopState(valaris.LoopStateParked, "completion acceptance pending")
				if !executed {
					select {
					case <-ctx.Done():
						return nil
					case <-m.wake:
					case <-m.sleep(30 * time.Second):
					}
				}
				continue
			}
		}

		if iterations >= cfg.MaxIterations {
			err := m.disableWithStructuredReason(
				ctx,
				fmt.Sprintf("max_iterations reached (%d)", cfg.MaxIterations),
				valaris.BoardLoopStructuredReason{
					Code:   valaris.BoardLoopReasonMaxIterationsReached,
					Params: map[string]any{"max_iterations": cfg.MaxIterations},
				},
			)
			recap(cfg.BudgetUSD)
			return err
		}
		if spent >= cfg.BudgetUSD {
			err := m.disableWithStructuredReason(
				ctx,
				fmt.Sprintf("budget_usd exhausted ($%.2f of $%.2f)", spent, cfg.BudgetUSD),
				valaris.BoardLoopStructuredReason{
					Code: valaris.BoardLoopReasonBudgetExhausted,
					Params: map[string]any{
						"spent_usd":  spent,
						"budget_usd": cfg.BudgetUSD,
					},
				},
			)
			recap(cfg.BudgetUSD)
			return err
		}

		// Run-complete is checked BEFORE readiness and before the iteration
		// counter moves: a finished run must cost no session, no execution
		// row, and no budget — the whole reason this condition is declarative
		// rather than a paragraph in the loop prompt.
		if cfg.CompletionQuery != nil {
			if done, ok := m.completionQuerySatisfied(ctx, cfg.CompletionQuery); ok && done {
				err := m.disable(ctx, completionQueryReason(cfg.CompletionQuery))
				recap(cfg.BudgetUSD)
				return err
			}
		}

		if cfg.StarvationPolicy != "always_run" && !readinessUnsupported {
			readiness, err := m.client.GetLoopReadiness(ctx, m.workspaceSlug, m.boardID)
			switch {
			case errors.Is(err, valaris.ErrLoopReadinessUnsupported):
				// Pre-rollout backend: latch the fallback so the probe isn't
				// retried (and re-warned) every cycle for the process lifetime.
				readinessUnsupported = true
				slog.Warn("loop mode: backend does not serve /loop/readiness — falling back to always_run",
					"board_id", m.boardID)
			case err != nil:
				// Fail OPEN: a transient probe outage must not stall the loop.
				// Next cycle probes again.
				slog.Warn("loop mode: readiness probe failed — running the iteration anyway",
					"board_id", m.boardID, "error", err)
			case !readiness.Actionable:
				consecutiveParks++
				delay := parkDelay(cfg.IterationDelaySeconds, consecutiveParks)
				if m.completionNoticeChanged("parked", readiness) {
					slog.Info("loop mode: parked — nothing actionable",
						"board_id", m.boardID,
						"blocked", readiness.BlockedCount,
						"awaiting_merge", readiness.AwaitingMergeCount,
						"review_open_prs", readiness.ReviewOpenPRCount,
						"parked_cycles", consecutiveParks,
						"next_probe_in", delay)
				}
				heartbeatLoopState(valaris.LoopStateParked, parkReason(readiness))
				select {
				case <-ctx.Done():
					return nil
				case <-m.completionWake(cfg):
				case <-m.iterationWait(cfg, delay):
				}
				continue
			}
		}

		delete(m.completionNotices, "parked")
		iterations++
		var provider llm.Provider
		var model string
		if override != nil {
			provider, model = overrideProvider, override.Model
		} else {
			dispatch := valaris.AssignmentLLM{Provider: cfg.Provider, Model: cfg.Model}
			if isTierAlias(cfg.Model) {
				dispatch.Tier = cfg.Model
			}
			if cfg.CompletionPolicy != nil && cfg.Provider != "" {
				provider, err = m.completionSourceProvider(cfg)
				if err != nil {
					return err
				}
			} else {
				provider = resolveProvider(m.cfg, m.providers, m.defaultProvider, dispatch, "loop")
			}
			model = resolveModelForProvider(m.cfg, provider, dispatch, cfg.Model, "loop")
			if isTierAlias(model) {
				// Loop configs are served verbatim, so a tier alias can survive to
				// here (pipeline assignments arrive with tiers already resolved to
				// concrete ids by the backend). An alias is provider-routing intent,
				// never a runnable model id — substitute the runner's own configured
				// model (empty = the provider's default).
				model = m.cfg.LLM.Model
			}
		}
		slog.Info("loop model selection", "board_id", m.boardID,
			"requested_provider", cfg.Provider, "requested_model", cfg.Model,
			"effective_provider", provider.Name(), "effective_model", model,
			"run_override", override != nil)

		// Two budgets, one effective cap: the board's budget_usd is the
		// cumulative rail; yaml llm.max_budget_usd is a per-session ceiling.
		// The session gets min(remaining, yaml) — REMAINING, not the full
		// budget, so the cap tightens with every dollar spent and a late
		// session can overshoot by at most one session AT the cap.
		budgetReport := m.reportBudget(cfg, spent, provider, "source")
		sessionCap := budgetReport.SessionCapUSD

		if !capWarned {
			capWarned = true
			caps := llm.Capabilities{}
			if cp, ok := provider.(llm.CapabilityProvider); ok {
				caps = cp.Capabilities()
			}
			if !caps.BudgetCap {
				slog.Warn("loop mode: this provider cannot enforce a per-session budget cap — the cap is advisory; only the loop's cumulative budget rail limits spend",
					"board_id", m.boardID, "provider", provider.Name())
			} else if budgetReport.SessionEnforcement != "provider_enforced" {
				slog.Warn("loop mode: session dollar enforcement is unverified — subscription auth or unsupported provider billing can leave the setting advisory",
					"board_id", m.boardID, "provider", provider.Name())
			}
		}

		// The user-visible iteration number is GLOBAL (offset + this
		// process's count) — prompts, execution rows, and note titles stay
		// monotonic across restarts. The rails above use the process-local
		// counter only.
		globalIteration := iterationOffset + iterations
		heartbeatLoopState(valaris.LoopStateTicking, "")
		if err := m.preflightCompletionWorkflow(ctx, cfg); err != nil {
			return err
		}
		executionID := m.startExecution(ctx, globalIteration, provider, model, cfg, override != nil)
		if cfg.CompletionPolicy != nil && executionID == "" {
			return fmt.Errorf("completion policy requires a recorded source execution; restore execution logging before resuming")
		}

		failed, cost, outcome := m.runIteration(ctx, cfg, globalIteration, executionID, provider, model, sessionCap, spent)
		spent += cost
		if ctx.Err() != nil {
			// Operator interrupt landed mid-session: the aborted session is
			// not a failure and must not reach any rail — a disable here
			// would flip the board's flag on a process stop.
			recap(cfg.BudgetUSD)
			return nil
		}

		if cfg.CompletionPolicy != nil && !failed && outcome != nil && outcome.Outcome == outcomeObjectiveComplete {
			status, err := m.client.GetCompletionWork(ctx, m.workspaceSlug, m.boardID)
			if err != nil {
				return err
			}
			if status.Outstanding() {
				continue
			}
		}
		// A completion CLAIM is checked against the completion_query before it
		// can end the run: with a query configured, the board is the
		// authority and the session is a witness. A refuted claim is a wrong
		// session, i.e. a failed iteration — that way a model stuck on "we're
		// done" burns the failure breaker instead of looping forever. An
		// unverifiable claim (probe outage) is treated the same: not honored.
		if cfg.CompletionQuery != nil && !failed && outcome != nil && outcome.Outcome == outcomeObjectiveComplete {
			if done, ok := m.completionQuerySatisfied(ctx, cfg.CompletionQuery); !ok || !done {
				slog.Warn("loop mode: session reported objective_complete but completion_query disagrees — counting the iteration as failed",
					"board_id", m.boardID, "label", cfg.CompletionQuery.Label, "probe_ok", ok)
				failed = true
				outcome = nil
			}
		}

		if failed {
			consecutiveFailures++
		} else {
			consecutiveFailures = 0
		}
		if consecutiveFailures >= cfg.MaxConsecutiveFailures {
			err := m.disableWithStructuredReason(
				ctx,
				fmt.Sprintf("%d consecutive failed iterations", consecutiveFailures),
				valaris.BoardLoopStructuredReason{
					Code:   valaris.BoardLoopReasonConsecutiveFailures,
					Params: map[string]any{"count": consecutiveFailures},
				},
			)
			recap(cfg.BudgetUSD)
			return err
		}

		// Terminal transitions belong to the HARNESS (card 102dc48e): the
		// session REPORTS its verdict, code decides whether the run is over.
		// Only a SUCCESSFUL session's verdict is load-bearing — a provider
		// error or timeout can carry any structured payload, and one
		// hallucinated completion must not be able to kill a run.
		reported := ""
		if !failed && outcome != nil {
			reported = outcome.Outcome
		}
		if reported == outcomeBlockedOnHuman {
			consecutiveBlocked++
		} else if !failed {
			consecutiveBlocked = 0
		}

		switch {
		case reported == outcomeObjectiveComplete:
			err := m.disable(ctx, objectiveCompleteReason(globalIteration, outcome.Summary))
			recap(cfg.BudgetUSD)
			return err
		case reported == outcomeBlockedOnHuman && cfg.MaxBlockedOnHuman > 0 && consecutiveBlocked >= cfg.MaxBlockedOnHuman:
			err := m.disable(ctx, blockedOnHumanReason(consecutiveBlocked, outcome.Summary))
			recap(cfg.BudgetUSD)
			return err
		}

		delay := time.Duration(cfg.IterationDelaySeconds) * time.Second
		// The agent's own "nothing to do" / "needs a human" verdict feeds the
		// park path even when the probe read actionable (e.g. ready cards the
		// prompt cannot act on) — back off instead of paying again immediately.
		// A blocked_on_human below the threshold lands here: parked, not
		// stopped, because the human may act between iterations.
		if (reported == outcomeNothingReady || reported == outcomeBlockedOnHuman) && cfg.StarvationPolicy != "always_run" {
			consecutiveParks++
			delay = parkDelay(cfg.IterationDelaySeconds, consecutiveParks)
			slog.Info("loop mode: session reported "+reported+" — parking",
				"board_id", m.boardID, "parked_cycles", consecutiveParks, "next_probe_in", delay)
			heartbeatLoopState(valaris.LoopStateParked, "session reported "+reported)
		} else {
			consecutiveParks = 0
		}

		select {
		case <-ctx.Done():
			// Operator interrupt / parent cancellation: exit cleanly without
			// flipping the flag. This is the ONE exit path that must bypass
			// every rail above — stopping the process is not finishing the job.
			recap(cfg.BudgetUSD)
			return nil
		case <-m.completionWake(cfg):
		case <-m.iterationWait(cfg, delay):
		}
	}
}

// parkReason renders the readiness probe's counts as the one-line account the
// operator reads off the board chip. The counts matter more than the verdict:
// "waiting on 3 PRs" and "3 blocked cards" are the same `actionable: false`
// but call for opposite human actions.
func parkReason(readiness *valaris.LoopReadiness) string {
	if readiness == nil {
		return "nothing actionable"
	}
	var parts []string
	if readiness.AwaitingMergeCount > 0 {
		parts = append(parts, fmt.Sprintf("%d awaiting merge", readiness.AwaitingMergeCount))
	}
	if readiness.BlockedCount > 0 {
		parts = append(parts, fmt.Sprintf("%d blocked", readiness.BlockedCount))
	}
	if readiness.ExplicitlyBlockedCount > 0 {
		parts = append(parts, fmt.Sprintf("%d cards in Blocked", readiness.ExplicitlyBlockedCount))
	}
	if len(parts) == 0 {
		return "nothing actionable"
	}
	return "nothing actionable: " + strings.Join(parts, ", ")
}

// parkDelay paces re-probing while parked: the iteration delay, doubling per
// consecutive parked cycle, capped at 10×. A zero base stays zero — the
// operator opted out of pacing, and a probe is one HTTP GET.
func parkDelay(baseSeconds, consecutiveParks int) time.Duration {
	if baseSeconds <= 0 {
		return 0
	}
	base := time.Duration(baseSeconds) * time.Second
	ceiling := 10 * base
	delay := base
	for p := 1; p < consecutiveParks; p++ {
		delay *= 2
		if delay >= ceiling {
			return ceiling
		}
	}
	return delay
}

// startExecution logs the iteration's AgentExecution start (card-less,
// action "loop_iteration"). Non-fatal observability per spec point 8/9 — a
// failure here logs a warning and the iteration still runs. Returns "" when
// logging failed, so downstream completion logging
// (LogExecutionUpdateWithMetrics) knows to skip. The iteration's heartbeat is
// sent by the caller, which owns the loop-state it reports.
//
// provider/model are the RESOLVED dispatch (post tier-remap, computed once
// per iteration in Run before this call) so the execution row is stamped
// with what the runner actually ran, not a tier alias or an empty string.
func (m *LoopMode) startExecution(ctx context.Context, iteration int, provider llm.Provider, model string, requested *valaris.BoardLoopConfig, overridden bool) string {
	summary := fmt.Sprintf("loop iteration %d", iteration)
	if overridden {
		summary += fmt.Sprintf("; board requested provider=%q model=%q; run override provider=%q model=%q", requested.Provider, requested.Model, provider.Name(), model)
	}
	executionID, err := m.client.LogExecutionStartWithLLM(
		ctx, m.agentID, m.workspaceSlug, "loop_iteration", m.boardID, "",
		summary, "", "", model, provider.Name(),
	)
	if err != nil {
		slog.Warn("loop mode: failed to log execution start", "board_id", m.boardID, "iteration", iteration, "error", err)
		return ""
	}
	return executionID
}

// Structured session outcomes (the park backstop): the harness can see board
// state via the readiness probe, but only the session itself knows whether
// the actionable-looking work was actually workable. Loop sessions request
// this schema whenever the provider supports structured output.
const (
	outcomeWorked            = "worked"
	outcomeNothingReady      = "nothing_ready"
	outcomeBlockedOnHuman    = "blocked_on_human"
	outcomeObjectiveComplete = "objective_complete"
)

// loopOutcomeSchema follows OpenAI structured-output rules so it works for
// BOTH claude --json-schema (inline) and codex --output-schema (file): with
// additionalProperties:false, `required` must list EVERY property.
const loopOutcomeSchema = `{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "outcome": {
      "type": "string",
      "enum": ["worked", "nothing_ready", "blocked_on_human", "objective_complete"],
      "description": "worked: made real progress this iteration. nothing_ready: no actionable work existed. blocked_on_human: work exists but needs a human first. objective_complete: the loop's objective is finished."
    },
    "summary": {
      "type": "string",
      "description": "One or two sentences on what happened this iteration."
    }
  },
  "required": ["outcome", "summary"]
}`

type loopOutcome struct {
	Outcome string `json:"outcome"`
	Summary string `json:"summary"`
}

// parseLoopOutcome extracts the structured outcome from a session result.
// Nil result, no structured payload, or malformed JSON all yield nil — the
// outcome is a best-effort backstop, never a failure condition.
func parseLoopOutcome(result *llm.Result) *loopOutcome {
	if result == nil || len(result.StructuredOutput) == 0 {
		return nil
	}
	var outcome loopOutcome
	if err := json.Unmarshal(result.StructuredOutput, &outcome); err != nil || outcome.Outcome == "" {
		return nil
	}
	return &outcome
}

// runIteration renders the prompts, executes one provider session, and
// reports the outcome. Returns whether the iteration counts as a FAILURE
// (per spec point 9), the cost incurred (0 on a render/mkdir failure that
// never reached the provider), and the session's structured outcome (nil when
// the provider emitted none). The whole outcome — not just its enum — is
// returned because the terminal transitions Run owns quote the session's own
// summary as the stop reason. provider/model are the dispatch already
// resolved once per iteration by Run, before startExecution — runIteration
// itself never re-resolves. sessionCap is the effective per-session ceiling
// (min of board-remaining and yaml, computed by Run); spentBefore is the
// cumulative spend entering this iteration, for the 80% budget warning.
func (m *LoopMode) runIteration(ctx context.Context, cfg *valaris.BoardLoopConfig, iteration int, executionID string, provider llm.Provider, model string, sessionCap, spentBefore float64) (failed bool, cost float64, outcome *loopOutcome) {
	pctx := PromptContext{
		Workspace:   m.workspaceSlug,
		BoardID:     m.boardID,
		AgentID:     m.agentID,
		ExecutionID: executionID,
		Iteration:   iteration,
	}

	systemPrompt, err := renderPrompt(cfg.SystemPrompt, pctx)
	if err != nil {
		slog.Warn("loop mode: system_prompt template render failed — treating iteration as failed", "board_id", m.boardID, "error", err)
		m.completeExecution(ctx, executionID, "failed", fmt.Sprintf("template render error: %v", err))
		return true, 0, nil
	}
	loopPrompt, err := renderPrompt(cfg.LoopPrompt, pctx)
	if err != nil {
		slog.Warn("loop mode: loop_prompt template render failed — treating iteration as failed", "board_id", m.boardID, "error", err)
		m.completeExecution(ctx, executionID, "failed", fmt.Sprintf("template render error: %v", err))
		return true, 0, nil
	}

	if err := cfg.ValidateCompletionContract(); err != nil {
		m.completeExecution(ctx, executionID, "failed", err.Error())
		return true, 0, nil
	}
	if cfg.CompletionPolicy != nil {
		if executionID == "" {
			return true, 0, nil
		}
		systemPrompt += "\n\n## Mandatory completion policy\n" + cfg.CompletionContext
		systemPrompt += "\n\n## Mandatory source execution identity\nsource_execution_id: " + executionID + "\nUse this exact execution ID when submitting completion evidence for this iteration."
	}

	loopPrompt += toolManifest(cfg.Tools)

	workDir := filepath.Join(m.cfg.Git.BaseDir, "loop", m.boardID)
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		slog.Warn("loop mode: failed to create working dir — treating iteration as failed", "board_id", m.boardID, "dir", workDir, "error", err)
		m.completeExecution(ctx, executionID, "failed", fmt.Sprintf("working dir error: %v", err))
		return true, 0, nil
	}

	m.materializeBoardSkills(ctx, provider, workDir)

	iterCtx, cancel := context.WithTimeout(ctx, time.Duration(cfg.IterationTimeoutSeconds)*time.Second)
	defer cancel()

	opts := llm.Options{
		SystemPrompt:               systemPrompt,
		Model:                      model,
		MCPConfigPath:              m.cfg.LLM.MCPConfigPath,
		AllowedTools:               cfg.Tools,
		PermissionMode:             m.cfg.LLM.PermissionMode,
		DangerouslySkipPermissions: m.cfg.LLM.DangerouslySkipPermissions,
		ContextDirs:                m.cfg.LLM.ContextDirs,
		AnthropicAPIKey:            m.cfg.LLM.AnthropicAPIKey,
		WorkingDir:                 workDir,
		MaxBudgetUSD:               sessionCap,
	}
	if cfg.CompletionPolicy != nil {
		opts.SourceExecutionID = executionID
	}
	if cp, ok := provider.(llm.CapabilityProvider); ok && cp.Capabilities().StructuredOutput {
		opts.OutputSchema = loopOutcomeSchema
	}

	result, execErr := provider.Execute(iterCtx, loopPrompt, opts)

	cost = resultCost(result, provider, model)
	duration := resultDuration(result)
	failed = iterationFailed(result, execErr, iterCtx)

	tokens := 0
	if result != nil {
		tokens = result.InputTokens + result.OutputTokens
	}

	status := "completed"
	if failed {
		status = "failed"
	}
	summary := fmt.Sprintf("cost=$%.4f duration=%s", cost, duration)
	if parsed := parseLoopOutcome(result); parsed != nil {
		outcome = parsed
		summary = fmt.Sprintf("outcome=%s %s — %s", parsed.Outcome, summary, parsed.Summary)
	}
	if warning := budgetWarning(spentBefore+cost, cfg.BudgetUSD, cost, sessionCap); warning != "" {
		// The loop feed's execution rows are where the operator actually
		// looks between iterations — the warning must live there, not only
		// in the runner's stdout.
		summary = summary + " — " + warning
		slog.Warn("loop mode: "+warning, "board_id", m.boardID, "iteration", iteration)
	}
	m.completeExecutionWithMetrics(ctx, executionID, status, summary, tokens, cost, duration.Seconds())

	return failed, cost, outcome
}

// stopReasonSummaryLimit bounds how much of a session's own prose reaches
// disabled_reason. The reason is a one-line account read off a board chip, not
// a transcript — and the field is stored, not streamed.
const stopReasonSummaryLimit = 300

// objectiveCompleteReason renders the truthful stop reason for a run the
// session declared finished. Naming the iteration matters: the operator
// reconstructing the run needs to know WHICH session called it, and a rail
// name ("max_iterations reached") in place of this is exactly the lie that
// made three runs unreadable after the fact.
// completionQuerySatisfied evaluates the board's declarative run-complete
// condition (card d223a0ec): true = zero cards match, the run is over.
//
// The bool is only meaningful when ok is true. A probe outage returns ok=false
// rather than a guess, and the two call sites then take OPPOSITE safe
// directions: the pre-flight runs the iteration anyway (a search outage must
// never end a run), while the objective_complete verify declines to honor the
// claim (an unverifiable completion is not a completion). Both err toward the
// reversible outcome — keep working.
func (m *LoopMode) completionQuerySatisfied(ctx context.Context, query *valaris.LoopCompletionQuery) (satisfied, ok bool) {
	cards, err := m.client.SearchCards(ctx, m.workspaceSlug, m.boardID, valaris.SearchCardsParams{
		Label:             query.Label,
		ExcludeColumnType: query.ExcludeColumnType,
		Limit:             1, // presence, not a census: one match already means work remains
	})
	if err != nil {
		slog.Warn("loop mode: completion_query probe failed",
			"board_id", m.boardID, "label", query.Label, "error", err)
		return false, false
	}
	return len(cards) == 0, true
}

func completionQueryReason(query *valaris.LoopCompletionQuery) string {
	return fmt.Sprintf("run complete: completion_query returned 0 (%s)", query.Label)
}

func objectiveCompleteReason(iteration int, summary string) string {
	reason := fmt.Sprintf("run complete (reported by iteration %d)", iteration)
	if s := truncateSummary(summary); s != "" {
		reason += ": " + s
	}
	return reason
}

// blockedOnHumanReason names the blocker the sessions kept reporting, so the
// operator reads what to unblock rather than that a counter tripped.
func blockedOnHumanReason(streak int, summary string) string {
	reason := fmt.Sprintf("%d consecutive iterations reported blocked_on_human", streak)
	if s := truncateSummary(summary); s != "" {
		reason += ": " + s
	}
	return reason
}

func truncateSummary(summary string) string {
	s := strings.TrimSpace(summary)
	if len(s) <= stopReasonSummaryLimit {
		return s
	}
	return s[:stopReasonSummaryLimit] + "…"
}

// offSwitchTool is the loop's designed exit path: the agent disables the board
// loop itself with a truthful reason. Without it the loop can only be stopped
// by a safety rail, which records the rail — not the truth — as the reason.
const offSwitchTool = "mcp__valaris__set_board_loop"

// offSwitchPreflightWarning is asserted verbatim by the pre-flight tests, so it
// lives as a constant rather than an inline literal.
const offSwitchPreflightWarning = "loop mode: the board's tool allowlist does not grant " + offSwitchTool +
	" — the loop cannot self-disable, so a safety rail (max_iterations or budget_usd) will be the only stop"

// toolManifest renders the granted allowlist as a prompt suffix. Appended after
// template rendering so operator templates can neither omit it nor need editing
// to get it. The escape-hatch line exists because keyword tool search can miss a
// granted tool entirely: sixteen consecutive loop iterations (field report
// 2026-08-07) reported
// set_board_loop as unavailable while it was allowlisted the whole time — and it
// is emitted even for an empty allowlist, which is exactly the case where an
// agent is likeliest to mistake "not surfaced" for "does not exist".
func toolManifest(tools []string) string {
	var b strings.Builder
	b.WriteString("\n\n## Tools available\n\n")
	if len(tools) == 0 {
		b.WriteString("(the board granted no explicit allowlist)\n")
	}
	for _, tool := range tools {
		b.WriteString(tool)
		b.WriteString("\n")
	}
	b.WriteString("\nIf keyword search misses a tool listed here, load it with ToolSearch(\"select:<name>\").\n")
	return b.String()
}

// warnMissingOffSwitch reports whether the board's allowlist omits the loop's
// off-switch. Callers gate it behind a once-per-run latch: the condition is
// run-scoped config, so re-warning every iteration would be log spam.
func warnMissingOffSwitch(tools []string) bool {
	for _, tool := range tools {
		if tool == offSwitchTool {
			return false
		}
	}
	return true
}

// offSwitchUncallableWarning covers the failure the allowlist check cannot see:
// the tool IS granted and still does not work. Card ba778abd traced three runs
// of "No such tool available" to a gate past the allowlist — the board's grant
// was correct the whole time — so this message deliberately does NOT tell the
// operator to edit the tool list, which is where the other warning sends them.
const offSwitchUncallableWarning = "loop mode: " + offSwitchTool +
	" is allowlisted but NOT callable by this session's identity — the loop cannot self-disable, " +
	"so a safety rail (max_iterations or budget_usd) will be the only stop"

// offSwitchCallable probes whether this session's identity may actually drive
// the loop-state endpoint, by re-asserting the state the loop is ALREADY in.
// PATCH /loop/state is idempotent, so enabled=true against a running loop is a
// no-op write that still traverses the full authz path the off-switch uses —
// the cheapest honest answer to "would the stop have worked?".
//
// Verifying the off-switch must never USE it: the probe asserts enabled=true
// precisely because the loop is running, and a probe that sent false would end
// the run it was checking.
func (m *LoopMode) offSwitchCallable(ctx context.Context) bool {
	err := m.client.SetBoardLoopState(ctx, m.workspaceSlug, m.boardID, true, "")
	if err != nil {
		slog.Debug("loop mode: off-switch callability probe failed",
			"board_id", m.boardID, "error", err)
	}
	return err == nil
}

// budgetWarning returns a non-empty message when cumulative spend reached 80%
// of the board budget, or this session's cost reached 80% of its cap — the
// operator learns they are one iteration from a rail BEFORE it trips.
func budgetWarning(totalSpent, boardBudget, sessionCost, sessionCap float64) string {
	if boardBudget > 0 && totalSpent >= 0.8*boardBudget {
		return fmt.Sprintf("budget warning: $%.2f of $%.2f board budget (%.0f%%)",
			totalSpent, boardBudget, 100*totalSpent/boardBudget)
	}
	if sessionCap > 0 && sessionCost >= 0.8*sessionCap {
		return fmt.Sprintf("budget warning: session cost $%.2f of $%.2f cap (%.0f%%)",
			sessionCost, sessionCap, 100*sessionCost/sessionCap)
	}
	return ""
}

// resultCost mirrors Loop.execute's cost accounting: prefer the provider's
// reported dollar cost; when it reports tokens but no dollars (subscription
// auth, or any cost-blind backend), estimate from the (provider, model) rate
// sheet. nil result (a pre-execute error) costs 0.
func resultCost(result *llm.Result, provider llm.Provider, model string) float64 {
	if result == nil {
		return 0
	}
	cost := result.CostUSD
	if cost == 0 && (result.InputTokens > 0 || result.OutputTokens > 0) {
		cost = estimateCostWith(priceFor(provider.Name(), model), result.InputTokens, result.OutputTokens, result.CacheCreationTokens, result.CacheReadTokens)
	}
	return cost
}

func resultDuration(result *llm.Result) time.Duration {
	if result == nil {
		return 0
	}
	return result.Duration
}

// iterationFailed applies spec point 4's failure definition: an exec error,
// a non-nil Result.Error, a non-zero exit code, the per-iteration timeout
// firing, or a result with neither output text nor output tokens (an empty
// LLM response — see Loop's emptyLLMHalted for the analogous pipeline-mode
// signal).
func iterationFailed(result *llm.Result, execErr error, iterCtx context.Context) bool {
	if execErr != nil {
		return true
	}
	if errors.Is(iterCtx.Err(), context.DeadlineExceeded) {
		return true
	}
	if result == nil {
		return true
	}
	if result.Error != nil {
		return true
	}
	if result.ExitCode != 0 {
		return true
	}
	if result.Output == "" && result.OutputTokens == 0 {
		return true
	}
	return false
}

// completeExecution patches the execution's outcome with status+summary only
// — no metrics. Non-fatal (spec point 7): a failed PATCH only logs. Skipped
// entirely when executionID is empty (startExecution's own logging already
// failed for this iteration). Used by the early-failure paths in
// runIteration (template render, working dir) that never reach the provider
// and so have no real Result to report tokens/cost/duration from — sending
// fabricated zeros there would misrepresent "we don't know" as "this cost
// nothing".
func (m *LoopMode) completeExecution(ctx context.Context, executionID, status, outputSummary string) {
	if executionID == "" {
		return
	}
	if err := m.client.LogExecutionUpdate(ctx, m.agentID, executionID, status, outputSummary); err != nil {
		slog.Warn("loop mode: failed to log execution update", "board_id", m.boardID, "execution_id", executionID, "error", err)
	}
}

// completeExecutionWithMetrics patches the execution's outcome along with the
// structured tokens/cost/duration the provider session actually produced.
// Used by runIteration's post-execute completion path — success or failure,
// as long as a real Result came back — so the metrics reflect real spend
// either way. Same non-fatal/skip-when-empty semantics as completeExecution.
func (m *LoopMode) completeExecutionWithMetrics(ctx context.Context, executionID, status, outputSummary string, tokensUsed int, costUSD, durationSeconds float64) {
	if executionID == "" {
		return
	}
	if err := m.client.LogExecutionUpdateWithMetrics(ctx, m.agentID, executionID, status, outputSummary, tokensUsed, costUSD, durationSeconds); err != nil {
		slog.Warn("loop mode: failed to log execution update", "board_id", m.boardID, "execution_id", executionID, "error", err)
	}
}

// disable turns the loop off through the API with a machine-readable reason
// so the board shows why it stopped. The error is returned rather than
// swallowed: a stop that never reached the board leaves the loop ENABLED, so
// the caller must not report the exit as clean.
func (m *LoopMode) disable(ctx context.Context, reason string) error {
	return m.persistDisabledState(ctx, reason, nil)
}

func (m *LoopMode) disableWithStructuredReason(
	ctx context.Context,
	reason string,
	structuredReason valaris.BoardLoopStructuredReason,
) error {
	return m.persistDisabledState(ctx, reason, &structuredReason)
}

func (m *LoopMode) persistDisabledState(
	ctx context.Context,
	reason string,
	structuredReason *valaris.BoardLoopStructuredReason,
) error {
	slog.Info("loop mode: disabling loop", "board_id", m.boardID, "reason", reason)
	var err error
	if structuredReason == nil {
		err = m.client.SetBoardLoopState(ctx, m.workspaceSlug, m.boardID, false, reason)
	} else {
		err = m.client.SetBoardLoopStateWithStructuredReason(ctx, m.workspaceSlug, m.boardID, reason, *structuredReason)
	}
	if err != nil {
		slog.Warn("loop mode: failed to disable loop via API", "board_id", m.boardID, "reason", reason, "error", err)
		return fmt.Errorf("loop mode: stop not persisted — board loop is still enabled after %q: %w", reason, err)
	}
	return nil
}

// materializeBoardSkills copies the board's bound skills into the loop's
// working dir at the provider's own discovery path, so a loop agent reaches
// them exactly like a pipeline agent does. Best-effort by design: a skills
// outage degrades the iteration to "no skills", it never ends the loop, whose
// actual work has nothing to do with skills.
//
// Unlike the pipeline path there is no git hazard here — the loop working dir
// is a plain directory, never a clone — so no exclude/cleanup wrapping.
//
// v1 accepts one wart: a skill later UNBOUND from the board leaves its stale
// directory behind, because materialization only ever adds. Harmless here (the
// workdir is not a repo, so nothing can commit it) and the agent reads whatever
// is present, so a stale skill is at worst ignored guidance. Reconciling the
// dir against the manifest is the fix when that stops being acceptable.
func (m *LoopMode) materializeBoardSkills(ctx context.Context, provider llm.Provider, workDir string) {
	locator, ok := provider.(llm.SkillsLocator)
	if !ok {
		return
	}
	skills, err := m.client.GetBoardEffectiveSkills(ctx, m.workspaceSlug, m.boardID)
	if err != nil {
		slog.Warn("loop mode: could not fetch board skills — continuing without them",
			"board_id", m.boardID, "error", err)
		return
	}
	if len(skills) == 0 {
		return
	}
	dirs, err := newSkillsMaterializer(m.client).Materialize(
		ctx, m.workspaceSlug, skills, workDir, locator.SkillsRelDir())
	if err != nil {
		slog.Warn("loop mode: skills materialization failed — continuing without them",
			"board_id", m.boardID, "error", err)
		return
	}
	slog.Info("loop mode: materialized board skills",
		"board_id", m.boardID, "dir", locator.SkillsRelDir(), "count", len(dirs))
}
