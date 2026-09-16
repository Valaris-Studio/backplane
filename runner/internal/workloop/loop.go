// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/forge"
	"github.com/Valaris-Studio/backplane/runner/internal/forge/registry"
	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/harness"
	"github.com/Valaris-Studio/backplane/runner/internal/health"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/telemetry"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// ApprovalSubscriber provides WebSocket-based approval notifications.
// When connected, the work loop can subscribe to instant approval status
// changes instead of relying solely on HTTP polling.
type ApprovalSubscriber interface {
	SubscribeApproval(approvalID string, ch chan<- struct{}) func()
	Connected() bool
}

// HeartbeatSender delivers a heartbeat over an open transport (typically the
// workspace WebSocket). Returns an error when the transport is not live so
// the loop can optionally fall back to HTTP during the deprecation window.
type HeartbeatSender interface {
	SendHeartbeat(ctx context.Context, payload any) error
	Connected() bool
}

// Loop polls for cards, claims them, and orchestrates LLM execution + git.
type Loop struct {
	client   *valaris.Client
	provider llm.Provider // default provider (runner YAML llm.provider)
	// providers is the per-stage provider registry keyed on provider string
	// (e.g. "claude-cli", "codex-cli"). A stage whose backend pipeline_config
	// declares llm.provider runs on providers[name]; an empty declaration, an
	// unbuilt provider, or a nil registry falls back to `provider`. This is how
	// one pipeline mixes coding agents — e.g. codex-cli for implementer while
	// ui_validator stays on claude-cli (it needs the Claude visual-testing skill).
	providers   map[string]llm.Provider
	git         *git.Manager
	forge       forge.Provider // forge-API seam (PR/MR open/review/merge); plain git stays on l.git
	cfg         *config.Config
	health      *health.Collector
	strategy    Strategy
	scheduler   *StrategyScheduler      // non-nil in multi-role mode
	sensors     *harness.SensorRegistry // published in heartbeat via Catalog()
	limiter     *rateLimiter
	sessions    *SessionStore
	approvalSub ApprovalSubscriber // nil when WebSocket disabled
	hbSender    HeartbeatSender    // nil => fall back to HTTP heartbeat

	// TriggerPoll allows external callers (e.g. /pollnow HTTP handler, WS events)
	// to skip the poll interval and run an immediate cycle.
	TriggerPoll chan struct{}

	// Accumulated cost/token counters for the current tick, reset per card.
	tickTokens int
	tickCost   float64

	// lastTurnTokens is the token total (in+out) of the MOST RECENT execute()
	// call only — distinct from the cumulative tickTokens. Salvage reads it to
	// tell a 0-token crash (model never ran → leftover commits, don't salvage)
	// from a real mid-pass cutoff. Set on every execute(), including failures.
	lastTurnTokens int

	// Circuit breaker: tracks consecutive failures per card to avoid infinite retries.
	cardFailures map[string]cardFailure
	cbMu         sync.Mutex

	// Prompt cache: role:stage -> rendered content from platform.
	promptCache   map[string]string
	promptCacheMu sync.RWMutex

	// lastPromptCacheLog dedupes the "prompt cache refreshed" Info log per role.
	// Maps role -> signature of the last logged config set; identical signatures
	// on subsequent refreshes emit at Debug so idle polls don't spam the log.
	lastPromptCacheLog   map[string]string
	lastPromptCacheLogMu sync.Mutex

	// Platform-managed workspace configuration (fetched from GET /api/agents/me/config).
	platformConfig   valaris.WorkspaceConfigData
	platformConfigMu sync.RWMutex

	// Refresh throttle: pollCycle runs on every ticker tick AND every WS event /
	// self-trigger, so under an active card the refresh path (6 role prompt-cache
	// GETs + 1 platform-config GET) can fire many times per second and blow the
	// backend's 100-req/min API-key budget — the 429 storm. These gate the HTTP
	// fetches to at most once per refreshTTL regardless of poll frequency; a
	// changed prompt/config is still picked up within refreshTTL.
	lastPromptCacheRefresh time.Time
	lastPlatformCfgRefresh time.Time
	refreshThrottleMu      sync.Mutex
	refreshTTL             time.Duration

	// selfTrigger rate-floor. A tick that walks a lifecycle to a clean exit is
	// marked productive (lastTickHadWork=true) even when it consumed no card —
	// e.g. a role whose discover matches a card it cannot actually advance. That
	// re-arms selfTriggerIfProductive on every tick, and since the consumer
	// drains TriggerPoll between fires the cap-1 coalescing can't damp it, so the
	// loop spins as fast as a tick completes (~13/s observed → poll storm + 429s).
	// A minimum interval between self-triggers caps that spin while still making
	// real handoffs (planner→implementer→…) feel instant. WS-driven polls are
	// unaffected; only the self-trigger path is floored.
	lastSelfTrigger        time.Time
	selfTriggerMinInterval time.Duration

	// Empty-LLM circuit breaker (run-B quota outage 2026-06-09). A provider
	// quota/credit outage makes EVERY llm call return instantly with
	// exit_code!=0 and zero tokens in/out. Treating those as per-card stage
	// failures releases + re-reserves cards forever (the participant
	// add/remove board loop) and bursts the backend rate limit, while the
	// COST breaker never fires because the calls are $0. An empty result is
	// an environment failure, not a card defect: after
	// maxConsecutiveEmptyLLM of them pollCycle pauses reservations until
	// emptyLLMHaltUntil, then lets one cycle probe. An empty probe re-trips;
	// any token-bearing result resets.
	consecutiveEmptyLLM int
	emptyLLMHaltUntil   time.Time
	emptyLLMMu          sync.Mutex

	// ownedStrategies pins the set of strategies this runner originally built
	// from the platform pipeline (one per platform role). The live scheduler
	// may temporarily drop a role when its prompt is missing; this map keeps
	// the strategy around so the next applyPlatformAuthority pass can re-add
	// it once the cache populates.
	//
	// applyPlatformAuthority reconciles this set against the live pipeline on
	// every refresh: a role added to pipeline_config (and within the runner's
	// team-role scope) AFTER process start gets a strategy built lazily here.
	// Without that, a role that did not exist at New() would be permanently
	// absent from the scheduler — the frozen-strategy-set bug that left a
	// freshly-configured ui_validator role with zero candidacy.
	ownedStrategies       map[string]Strategy
	platformPriorityOrder []string

	// scopedTeamRoles is the runner's team-role scope as resolved at New()
	// (team_roles INTERSECT pipeline_roles). nil means role-agnostic: the
	// runner claims every pipeline role. When non-nil, lazy reconciliation
	// only builds strategies for roles in this set, preserving the sharding
	// contract from feedback_runner_role_agnostic.md.
	scopedTeamRoles map[string]struct{}

	// drainSignal is the loopCtx handed to Run — cancelled the moment a drain
	// starts (SIGTERM or an operator Restart). The tick path runs under
	// tickParentCtx so in-flight work can finish, which means it cannot see the
	// drain through its own ctx; this field is how the strategy walk observes
	// it. nil until Run (or a test) calls observeDrain, and a nil signal means
	// "never draining" so non-Run callers keep the pre-drain behaviour.
	drainSignal   context.Context
	drainSignalMu sync.RWMutex

	// Idle backoff: consecutive empty discover results increase the poll interval
	// exponentially (base * 2^idleBackoff) up to MaxIdleInterval. Resets on work found or WS event.
	idleBackoff uint

	// Cumulative discover cost since startup. Discover calls don't create execution
	// records, so this tracks infrastructure overhead separately.
	discoverCostUSD float64

	// lastTickHadWork is set by strategies to signal whether the tick found work.
	// Used by the scheduler to track consecutive work ticks vs idle ticks.
	lastTickHadWork bool

	// mergeGate is the PR-merge operation invoked by the reviewer approve gate.
	// Defaults to git.Manager.MergePR in New; tests override to avoid shelling
	// to a real `gh` subprocess. Kept as a function field (not an interface)
	// because only one method is needed and *git.Manager is the only production
	// implementation — adding an interface for one call site would be debt.
	//
	// Phase 1 lives on the runner because the backend has no GitHub client
	// today. When that lands this gate moves server-side.
	mergeGate func(ctx context.Context, repoDir, prURL, strategy string) error

	// currentPRResolver looks up the live open PR for a given branch so the
	// merge gate never dispatches against a stale description-embedded URL.
	// A re-claimed card accumulates "---\nBranch:\nPR:" blocks and
	// extractPRURL returns the FIRST (stale) one.
	currentPRResolver prResolver

	// rebaseOnBase rebases <branch> against its base branch and force-pushes.
	// Invoked once between merge attempts when GitHub reports the base branch
	// was modified under us.
	rebaseOnBase func(ctx context.Context, repoDir, branch, prURL string) error

	// Per-tick assignment LLM dispatch (provider/model/prompt_slug) stashed
	// from /next-assignment so llmOpts can pick the backend-declared model
	// instead of the runner's yaml fallback. Set when discoverWithConfig
	// returns a backend-issued card; left empty when discover used the
	// legacy client-side scan or when the backend doesn't yet emit the llm
	// block. llmOpts WARNs and falls back to cfg.LLM.Model when empty
	// (one-deploy migration safety — feedback_backend_authoritative_config.md).
	currentAssignmentLLM   valaris.AssignmentLLM
	currentAssignmentLLMMu sync.RWMutex

	// Per-tick per-card budget override from /next-assignment
	// (Card.budget_usd_override). nil = no override → effectiveBudgetUSD falls
	// back to the workspace/yaml max_budget_usd. Stashed and cleared on the same
	// tick boundaries as currentAssignmentLLM, and guarded by the same mutex
	// since both are per-tick stashes read by effectiveBudgetUSD/llmOpts.
	currentCardBudgetOverride *float64

	// FIX #3: parked approval-gated cards, keyed by cardID. In-memory resume
	// tokens only — the durable park signal is the awaiting-approval label on
	// the card (see approval_park.go for the restart contract).
	parkedApprovals   map[string]*parkedApproval
	parkedApprovalsMu sync.Mutex
}

// prResolver returns the live open PR URL for a branch (or "" when none).
type prResolver interface {
	CurrentPRForBranch(ctx context.Context, repoDir, branch string) (string, error)
}

// forgePRResolver adapts a forge.Provider to prResolver so the merge gate's
// stale-URL guard routes through the configured forge instead of a direct
// git.Manager gh call. The forge op is named CurrentChangeForBranch (neutral
// vocabulary); the resolver keeps the legacy CurrentPRForBranch name its
// callers/tests already use.
type forgePRResolver struct {
	forge forge.Provider
}

func newForgePRResolver(f forge.Provider) *forgePRResolver { return &forgePRResolver{forge: f} }

func (r *forgePRResolver) CurrentPRForBranch(ctx context.Context, repoDir, branch string) (string, error) {
	return r.forge.CurrentChangeForBranch(ctx, repoDir, branch)
}

type cardFailure struct {
	count               int // transient failures (git, claim, mediation) — circuit breaker threshold
	reworkCount         int // review rejection rework cycles — attempt numbering + escalation
	noChangeReworkCount int // consecutive rework ticks that produced zero git changes — infinite-loop guard
	lastFail            time.Time
}

// Maximum consecutive no-change rework attempts before the loop forces the
// card to "blocked". Two gives one clean benign skip (e.g. sibling PR merged
// between rejection and retry) plus one tolerance for transient read-only
// executor runs, after which we assume the executor is stuck and a human
// must intervene. Each attempt costs ~$0.10-$0.50 in LLM spend, so the
// bound is tight on purpose.
const maxConsecutiveNoChangeReworks = 2

// maxConsecutiveNoChangeImplements bounds how many times a FRESH (non-rework)
// implement tick may produce zero git changes on the same card before the
// breaker blocks it. This is the generic backstop to the duplicate money-loop:
// when a stage keeps producing no diff without declaring resolution=duplicate
// (a misbehaving prompt, an already-done card the LLM won't flag), each cycle
// still burns a full implement pass (~$2 on opus). Tight on purpose — two cheap
// strikes, then a human looks. The declared-duplicate fast path terminates on
// cycle one; this only catches the undeclared case. Reuses the existing
// no-change counter (RecordNoChangeRework), which is reason-agnostic despite its
// name.
const maxConsecutiveNoChangeImplements = 2

// Default workspace config values used when the platform hasn't provided overrides.
const (
	defaultMaxReworkAttempts     = 3
	defaultCardCooldownHours     = 1.0
	defaultCommitMessageTemplate = "feat({{.CardID}}): {{.Title}}"
)

// New creates a work loop with all dependencies.
// The health collector is optional (nil disables health tracking).
//
// The platform is the authoritative source of the pipeline: New synchronously
// fetches pipeline_config from GET /api/agents/me/config and refuses to start
// when the platform omits it. A misconfigured platform must surface as a
// startup error — never be masked by a hardcoded default.
func New(ctx context.Context, client *valaris.Client, provider llm.Provider, gitMgr *git.Manager, cfg *config.Config, hc ...*health.Collector) (*Loop, error) {
	// The forge driver is config-selected (git.forge, default "github"). The
	// GitHub driver wraps the same git.Manager gh methods, so the default path is
	// behaviorally identical to the pre-config-select hardcode; gitea routes
	// through HTTP. An unknown forge is a loud startup error, never a silent
	// github fallback.
	forgeProvider, err := registry.New(cfg, gitMgr)
	if err != nil {
		return nil, fmt.Errorf("selecting forge: %w", err)
	}
	platformConfig, err := client.GetPlatformConfig(ctx, cfg.Valaris.WorkspaceSlug)
	if err != nil {
		return nil, fmt.Errorf("fetching platform config: %w", err)
	}
	if platformConfig == nil || platformConfig.WorkspaceConfig.PipelineConfig == nil {
		return nil, fmt.Errorf("platform returned no pipeline_config — agent refuses to start")
	}
	pipelineCfg := *platformConfig.WorkspaceConfig.PipelineConfig
	if len(pipelineCfg.Stages) == 0 {
		return nil, fmt.Errorf("platform pipeline_config has no stages — agent refuses to start")
	}

	pipelineRoles := make(map[string]struct{}, len(pipelineCfg.Stages))
	pipelineRoleOrder := make([]string, 0, len(pipelineCfg.Stages))
	for _, stage := range pipelineCfg.Stages {
		if stage.Role == "" {
			continue
		}
		if _, dup := pipelineRoles[stage.Role]; dup {
			continue
		}
		pipelineRoles[stage.Role] = struct{}{}
		pipelineRoleOrder = append(pipelineRoleOrder, stage.Role)
	}
	if len(pipelineRoleOrder) == 0 {
		return nil, fmt.Errorf("platform pipeline_config stages have no roles — agent refuses to start")
	}

	// Scope owned roles to the agent's team_roles intersected with the pipeline.
	// Empty team_roles is the role-agnostic default: the runner claims every
	// pipeline role. A non-empty team_roles narrows the runner to that subset
	// — useful for sharding a workspace across multiple agents but also a
	// footgun, because pipeline stages outside the subset silently never run
	// (the "platform pipeline becomes a lie" hazard from
	// feedback_runner_role_agnostic.md). When scoping drops roles, emit a
	// loud Warn so the dropped roles surface in operator logs.
	var roles []string
	if len(platformConfig.TeamRoles) > 0 {
		for _, role := range platformConfig.TeamRoles {
			if _, ok := pipelineRoles[role]; ok {
				roles = append(roles, role)
			} else {
				slog.Warn("team role not present in pipeline_config — skipping", "role", role)
			}
		}
		claimed := make(map[string]struct{}, len(roles))
		for _, r := range roles {
			claimed[r] = struct{}{}
		}
		var dropped []string
		for _, r := range pipelineRoleOrder {
			if _, ok := claimed[r]; !ok {
				dropped = append(dropped, r)
			}
		}
		if len(dropped) > 0 {
			slog.Warn(
				"team_roles excludes pipeline roles",
				"dropped_roles", dropped,
				"team_roles", platformConfig.TeamRoles,
				"pipeline_roles", pipelineRoleOrder,
				"remedy", "set team_roles=[] to claim all pipeline roles",
			)
		}
	} else {
		roles = pipelineRoleOrder
	}
	if len(roles) == 0 {
		return nil, fmt.Errorf("agent has no team_roles that intersect pipeline_config — refusing to start")
	}

	l := &Loop{
		client:                 client,
		provider:               provider,
		git:                    gitMgr,
		cfg:                    cfg,
		TriggerPoll:            make(chan struct{}, 1),
		cardFailures:           make(map[string]cardFailure),
		parkedApprovals:        make(map[string]*parkedApproval),
		promptCache:            make(map[string]string),
		lastPromptCacheLog:     make(map[string]string),
		platformConfig:         platformConfig.WorkspaceConfig,
		refreshTTL:             30 * time.Second,
		selfTriggerMinInterval: 3 * time.Second,
		forge:                  forgeProvider,
		mergeGate: func(ctx context.Context, repoDir, prURL, strategy string) error {
			return forgeProvider.Merge(ctx, repoDir, prURL, forge.MergeStrategy(strategy))
		},
		currentPRResolver: newForgePRResolver(forgeProvider),
		rebaseOnBase: func(ctx context.Context, repoDir, branch, prURL string) error {
			base, err := forgeProvider.TargetBranchFor(ctx, repoDir, prURL)
			if err != nil {
				return err
			}
			return gitMgr.RebaseOnBase(ctx, repoDir, branch, base)
		},
	}

	// Pin the team-role scope so lazy reconciliation in applyPlatformAuthority
	// builds newly-added pipeline roles only when they're inside this runner's
	// shard. Empty team_roles is the role-agnostic default → nil scope → every
	// pipeline role is claimable.
	if len(platformConfig.TeamRoles) > 0 {
		l.scopedTeamRoles = make(map[string]struct{}, len(platformConfig.TeamRoles))
		for _, r := range platformConfig.TeamRoles {
			l.scopedTeamRoles[r] = struct{}{}
		}
	}

	// Route the pr-overlap sensor through the configured forge's ListOpenChanges
	// instead of the default gh-CLI lister, so non-github forges work and the
	// harness package never imports workloop (no layer inversion).
	registry := harness.DefaultRegistryWithForge(forgeProvider)
	l.sensors = registry
	strategies := buildStrategies(roles, pipelineCfg, registry)
	l.ownedStrategies = make(map[string]Strategy, len(strategies))
	for k, v := range strategies {
		l.ownedStrategies[k] = v
	}
	// Snapshot the post-seatbelt priority order so future authority passes can
	// re-add roles that were temporarily dropped due to missing prompts.
	l.platformPriorityOrder = appendMissingRoles(pipelineCfg.Scheduling.PriorityOrder, roles)

	if len(roles) == 1 {
		l.strategy = strategies[roles[0]]
		slog.Info("single-role mode", "role", roles[0])
	} else {
		// Platform-authoritative scheduling. YAML may tune the selection mode
		// but MUST NOT replace the platform's priority_order — that would
		// re-introduce the silent-override bug where local defaults shadow
		// platform-defined roles.
		scheduling := pipelineCfg.Scheduling
		if cfg.WorkLoop.Scheduling.Mode != "" {
			scheduling.Mode = cfg.WorkLoop.Scheduling.Mode
		}
		// Seatbelt: a platform-known role missing from priority_order would
		// otherwise be loaded into strategies but never selected by Next().
		// Append it in stage-definition order with a WARN so the operator can
		// fix the platform config without losing the role in the meantime.
		scheduling.PriorityOrder = appendMissingRoles(scheduling.PriorityOrder, roles)
		l.scheduler = NewScheduler(
			strategies,
			scheduling.PriorityOrder,
			scheduling.Mode,
		)
		// Set strategy to first priority so prompt cache and llmOpts work before first tick.
		if len(scheduling.PriorityOrder) > 0 {
			if s, ok := strategies[scheduling.PriorityOrder[0]]; ok {
				l.strategy = s
			}
		}
		slog.Info("multi-role mode", "roles", roles, "priority", scheduling.PriorityOrder)
	}

	if len(hc) > 0 {
		l.health = hc[0]
	}
	// Initialize rate limiter from agent config.
	if client.Agent != nil && client.Agent.MaxRequestsPerMinute > 0 {
		l.limiter = newRateLimiter(client.Agent.MaxRequestsPerMinute)
	}
	// Initialize session store for LLM session persistence.
	if cfg.LLM.SessionPersistence {
		home, err := os.UserHomeDir()
		if err == nil {
			l.sessions = NewPersistentSessionStore(filepath.Join(home, ".backplane-runner", "sessions.json"))
		} else {
			l.sessions = NewSessionStore()
		}
	}
	return l, nil
}

// SetApprovalSubscriber attaches a WebSocket-backed approval subscriber
// to the loop. When set, approval polling uses event-driven wakeups.
func (l *Loop) SetApprovalSubscriber(sub ApprovalSubscriber) {
	l.approvalSub = sub
}

// SetHeartbeatSender attaches a heartbeat transport (typically the WebSocket
// client). When set and connected, pollCycle delivers heartbeats as WS frames
// instead of HTTP POST. WS-2 migration; HTTP remains available as a fallback.
func (l *Loop) SetHeartbeatSender(s HeartbeatSender) {
	l.hbSender = s
}

// RefreshPromptCache fetches prompt configs from the platform and populates
// the in-memory cache keyed by role:stage. Iterates the platform-known
// (owned) role set so that a role temporarily disabled by
// applyPlatformAuthority still gets a refresh — that's the path back to
// re-enabling it once an operator authors the missing prompt.
func (l *Loop) RefreshPromptCache(ctx context.Context) {
	// Throttle: pollCycle fires on every tick + WS event + self-trigger. Without
	// this gate an active card's mutation storm drives one full prompt-cache
	// sweep (one GET per owned role) per poll, blowing the 100-req/min budget.
	// A prompt edited on the platform is still seen within refreshTTL.
	l.refreshThrottleMu.Lock()
	if !l.lastPromptCacheRefresh.IsZero() && time.Since(l.lastPromptCacheRefresh) < l.refreshTTL {
		l.refreshThrottleMu.Unlock()
		return
	}
	l.lastPromptCacheRefresh = time.Now()
	l.refreshThrottleMu.Unlock()

	if len(l.ownedStrategies) > 0 {
		for role := range l.ownedStrategies {
			l.refreshPromptCacheForRole(ctx, role)
		}
		return
	}
	if l.strategy != nil {
		l.refreshPromptCacheForRole(ctx, l.strategy.Name())
	}
}

// appendMissingRoles returns priorityOrder with any role from `known` not
// already present appended in `known` order. Stable: the explicit operator
// ordering wins; the seatbelt only fills the tail.
func appendMissingRoles(priorityOrder, known []string) []string {
	present := make(map[string]struct{}, len(priorityOrder))
	for _, r := range priorityOrder {
		present[r] = struct{}{}
	}
	out := append([]string(nil), priorityOrder...)
	for _, r := range known {
		if _, ok := present[r]; ok {
			continue
		}
		slog.Warn("scheduler seatbelt: appending platform role missing from priority_order", "role", r)
		out = append(out, r)
		present[r] = struct{}{}
	}
	return out
}

// applyPlatformAuthority enforces the contract: a role whose owned LLM stages
// have no prompt in the platform cache is unschedulable. The role is dropped
// from the live scheduler/strategy so the runtime path never reaches a
// compiled-in prompt fallback. The decision is reversible — once the operator
// authors the missing prompt, the next refresh + authority pass re-enables it.
//
// In single-role mode, an unschedulable role nils l.strategy so Tick() exits
// early with no work; the runner stays alive and reports the gap in
// health_config_errors.
func (l *Loop) applyPlatformAuthority(ctx context.Context) {
	if len(l.ownedStrategies) == 0 {
		return
	}
	pipelineCfg := PipelineConfigForAgent(l.WorkspaceConfig())
	l.reconcileOwnedStrategies(pipelineCfg)

	enabled := make(map[string]Strategy, len(l.ownedStrategies))
	for role, strat := range l.ownedStrategies {
		stage := StageForRole(pipelineCfg, role)
		if stage == nil {
			// Role no longer in pipeline — drop.
			slog.Warn("platform-authority: dropping role not in pipeline", "role", role)
			continue
		}
		if !roleHasRequiredPrompt(stage, role, l.promptCacheSnapshot()) {
			slog.Warn("platform-authority: dropping role with missing prompt", "role", role, "stage", stage.LLM.Stage)
			continue
		}
		enabled[role] = strat
	}

	if l.scheduler != nil {
		// Preserve operator order: keep platformPriorityOrder entries that are
		// still enabled, in the same sequence.
		order := make([]string, 0, len(enabled))
		for _, role := range l.platformPriorityOrder {
			if _, ok := enabled[role]; ok {
				order = append(order, role)
			}
		}
		l.scheduler.Reconfigure(enabled, order)
	} else if l.strategy != nil {
		if _, ok := enabled[l.strategy.Name()]; !ok {
			slog.Warn("platform-authority: single role disabled — runner will idle", "role", l.strategy.Name())
			l.strategy = nil
		}
	}

	if l.health != nil {
		l.health.SetConfigErrors(l.validateConfig())
	}
}

// reconcileOwnedStrategies builds a strategy for any pipeline role that appeared
// AFTER process start and is within this runner's team-role scope. ownedStrategies
// is otherwise frozen at New(): the live scheduler can only drop or re-enable
// roles it already holds, so a role added to pipeline_config post-launch (e.g. a
// freshly-installed ui_validator) would have zero candidacy forever. This closes
// that gap by lazily constructing the missing strategy and extending the snapshot
// priority order so the seatbelt + authority pass can schedule it.
//
// Scope rules mirror New(): a nil scopedTeamRoles is role-agnostic (claim every
// pipeline role); a non-nil scope only admits roles inside the shard. Roles
// already owned are left untouched.
func (l *Loop) reconcileOwnedStrategies(pipelineCfg valaris.PipelineConfig) {
	if l.sensors == nil {
		// A nil sensor registry is the ONLY way this reconcile can silently
		// re-strand a post-launch role: NewStrategyFromConfig needs the registry,
		// so without it any pipeline role added after New() stays absent from the
		// scheduler forever — the exact zero-warning signature of the original
		// frozen-strategy-set incident. Surface the stranded roles so a future
		// regression that nils the registry is visible instead of invisible.
		var stranded []string
		for i := range pipelineCfg.Stages {
			role := pipelineCfg.Stages[i].Role
			if role == "" {
				continue
			}
			if _, owned := l.ownedStrategies[role]; !owned {
				stranded = append(stranded, role)
			}
		}
		if len(stranded) > 0 {
			slog.Warn("platform-authority: cannot build post-launch roles, sensor registry is nil — roles stranded",
				"roles", stranded)
		}
		return
	}
	var added []string
	for i := range pipelineCfg.Stages {
		role := pipelineCfg.Stages[i].Role
		if role == "" {
			continue
		}
		if _, owned := l.ownedStrategies[role]; owned {
			continue
		}
		if l.scopedTeamRoles != nil {
			if _, inScope := l.scopedTeamRoles[role]; !inScope {
				continue
			}
		}
		l.ownedStrategies[role] = NewStrategyFromConfig(pipelineCfg.Stages[i], l.sensors)
		added = append(added, role)
	}
	if len(added) > 0 {
		l.platformPriorityOrder = appendMissingRoles(l.platformPriorityOrder, added)
		slog.Info("platform-authority: built strategies for roles added after launch", "roles", added)
	}
}

// promptCacheSnapshot returns a shallow copy of the prompt cache for read-only
// inspection without holding the lock across calls.
func (l *Loop) promptCacheSnapshot() map[string]string {
	l.promptCacheMu.RLock()
	defer l.promptCacheMu.RUnlock()
	out := make(map[string]string, len(l.promptCache))
	for k, v := range l.promptCache {
		out[k] = v
	}
	return out
}

// roleHasRequiredPrompt returns true when the platform prompt cache contains
// the LLM stage prompt this role needs to execute. A stage with LLM.Enabled
// false has no prompt requirement (engine path doesn't call resolvePrompt).
func roleHasRequiredPrompt(stage *valaris.StageConfig, role string, cache map[string]string) bool {
	if stage == nil || !stage.LLM.Enabled || stage.LLM.Stage == "" {
		return true
	}
	_, ok := cache[role+":"+stage.LLM.Stage]
	return ok
}

func (l *Loop) refreshPromptCacheForRole(ctx context.Context, role string) {
	configs, err := l.client.GetPromptConfigs(ctx, l.cfg.Valaris.WorkspaceSlug, role)
	if err != nil {
		slog.Warn("failed to refresh prompt cache", "role", role, "error", err)
		return
	}

	l.promptCacheMu.Lock()
	defer l.promptCacheMu.Unlock()

	// Clear stale entries for this role so deleted configs don't linger.
	prefix := role + ":"
	for k := range l.promptCache {
		if strings.HasPrefix(k, prefix) {
			delete(l.promptCache, k)
		}
	}

	for _, cfg := range configs {
		key := role + ":" + cfg.Stage
		l.promptCache[key] = valaris.EffectivePromptContent(cfg)
		slog.Debug("cached prompt config", "role", role, "stage", cfg.Stage, "version", cfg.Version)
	}

	// Per-poll noise control: emit Info only when the (stage, version) tuple
	// for this role changes. Repeat refreshes against an unchanged platform
	// fall through to Debug so idle polling doesn't spam operator logs.
	signature := promptConfigsSignature(configs)
	l.lastPromptCacheLogMu.Lock()
	prev, seen := l.lastPromptCacheLog[role]
	changed := !seen || prev != signature
	l.lastPromptCacheLog[role] = signature
	l.lastPromptCacheLogMu.Unlock()

	if changed {
		slog.Info("prompt cache refreshed", "role", role, "count", len(configs))
	} else {
		slog.Debug("prompt cache refreshed", "role", role, "count", len(configs))
	}
}

// promptConfigsSignature builds a stable fingerprint of the prompt set for a
// role. Sorted by stage so map-iteration order from the server doesn't flip
// the signature between identical refreshes.
func promptConfigsSignature(configs []valaris.PromptConfig) string {
	parts := make([]string, len(configs))
	for i, cfg := range configs {
		parts[i] = fmt.Sprintf("%s@%d", cfg.Stage, cfg.Version)
	}
	sort.Strings(parts)
	return strings.Join(parts, ",")
}

// getPrompt returns the cached prompt template for a stage, or empty string
// if no override exists (caller falls back to hardcoded prompt).
// Looks up role:stage first (multi-role safe), then bare stage for backward compat.
func (l *Loop) getPrompt(stage string) string {
	l.promptCacheMu.RLock()
	defer l.promptCacheMu.RUnlock()

	if l.strategy != nil {
		if content, ok := l.promptCache[l.strategy.Name()+":"+stage]; ok {
			return content
		}
	}
	return l.promptCache[stage]
}

// resolvePrompt checks the prompt cache for a stage override. If found,
// renders it with Go templates. Falls back to the hardcoded prompt on
// cache miss or template error.
func (l *Loop) resolvePrompt(stage string, pctx PromptContext, fallback func() string) string {
	tmpl := l.getPrompt(stage)
	if tmpl == "" {
		slog.Debug("using hardcoded prompt", "stage", stage)
		return fallback()
	}
	rendered, err := renderPrompt(tmpl, pctx)
	if err != nil {
		slog.Warn("template render failed, using hardcoded prompt", "stage", stage, "error", err)
		return fallback()
	}
	// Defense-in-depth observability for the silent context-source wiring trap:
	// a source the backend assembled but this prompt never references via the
	// index form renders to nothing. The author-time lint is the primary
	// signal; this WARN surfaces it in runner logs during smokes.
	role := ""
	if l.strategy != nil {
		role = l.strategy.Name()
	}
	for _, alias := range unreferencedContextSources(tmpl, pctx.ContextSources) {
		slog.Warn("context source declared but not referenced by prompt",
			"stage", stage, "role", role, "alias", alias)
	}
	slog.Debug("using cached prompt", "stage", stage)
	return rendered
}

// persistPrompt saves the rendered prompt to the execution record.
// Best-effort: logs a warning on failure but never aborts the tick.
func (l *Loop) persistPrompt(ctx context.Context, executionID, prompt string) {
	if executionID == "" || prompt == "" {
		return
	}
	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}
	if agentID == "" {
		return
	}
	if err := l.client.UpdateExecutionPrompt(ctx, agentID, executionID, prompt); err != nil {
		slog.Warn("failed to persist rendered prompt", "execution_id", executionID, "error", err)
	}
}

// RefreshPlatformConfig fetches workspace config from the platform and stores it.
// Skips the update when the version hasn't changed (avoids redundant work on idle polls).
//
// Hot-reload of strategies is intentionally out of scope: when the pipeline
// version bumps we log a loud WARN telling operators to restart. Strategies
// wired at New() keep serving the old pipeline until the process recycles.
func (l *Loop) RefreshPlatformConfig(ctx context.Context) {
	// Throttle for the same reason as RefreshPromptCache: this GET runs every
	// pollCycle and the version short-circuit below happens only AFTER the HTTP
	// round-trip, so without this gate it still costs one request per poll.
	l.refreshThrottleMu.Lock()
	if !l.lastPlatformCfgRefresh.IsZero() && time.Since(l.lastPlatformCfgRefresh) < l.refreshTTL {
		l.refreshThrottleMu.Unlock()
		return
	}
	l.lastPlatformCfgRefresh = time.Now()
	l.refreshThrottleMu.Unlock()

	config, err := l.client.GetPlatformConfig(ctx, l.cfg.Valaris.WorkspaceSlug)
	if err != nil {
		slog.Warn("failed to refresh platform config", "error", err)
		return
	}

	l.platformConfigMu.Lock()
	oldVersion := l.platformConfig.Version
	if config.WorkspaceConfig.Version > 0 && config.WorkspaceConfig.Version == oldVersion {
		l.platformConfigMu.Unlock()
		slog.Debug("platform config unchanged", "version", oldVersion)
		return
	}
	l.platformConfig = config.WorkspaceConfig
	l.platformConfigMu.Unlock()

	if oldVersion > 0 && config.WorkspaceConfig.Version != oldVersion {
		slog.Warn("pipeline_config version changed — restart required to pick up new strategies",
			"prev_version", oldVersion,
			"new_version", config.WorkspaceConfig.Version,
		)
	}
	slog.Info("platform config refreshed", "version", config.WorkspaceConfig.Version, "prev_version", oldVersion)
}

// WorkspaceConfig returns the current workspace config with defaults as fallback for zero values.
func (l *Loop) WorkspaceConfig() valaris.WorkspaceConfigData {
	l.platformConfigMu.RLock()
	cfg := l.platformConfig
	l.platformConfigMu.RUnlock()

	if cfg.MaxReworkAttempts == 0 {
		cfg.MaxReworkAttempts = defaultMaxReworkAttempts
	}
	if cfg.CardCooldownHours == 0 {
		cfg.CardCooldownHours = defaultCardCooldownHours
	}
	if cfg.CommitMessageTemplate == "" {
		cfg.CommitMessageTemplate = defaultCommitMessageTemplate
	}
	return cfg
}

// Run starts the polling loop.
// loopCtx controls the polling select — cancelled on first signal to stop picking new work.
// tickParentCtx is the parent for in-flight tick operations — allows draining before force shutdown.
func (l *Loop) Run(loopCtx, tickParentCtx context.Context) error {
	// The tick path runs under tickParentCtx so in-flight work survives the
	// drain window; register loopCtx separately so it can still tell that a
	// drain has STARTED and stop reserving new cards (card 5edd3609).
	l.observeDrain(loopCtx)

	slog.Info("work loop starting",
		"workspace", l.cfg.Valaris.WorkspaceSlug,
		"poll_interval", l.cfg.WorkLoop.PollInterval,
	)

	// Populate prompt cache and workspace config at startup, then enforce
	// platform authority: roles whose owned prompts are missing get dropped
	// from the live scheduler so the runtime path never reaches a compiled-in
	// fallback. The runner stays alive and reports the gap in
	// health_config_errors; an authored prompt restores the role on the next
	// refresh.
	l.RefreshPromptCache(loopCtx)
	l.RefreshPlatformConfig(loopCtx)
	l.applyPlatformAuthority(loopCtx)

	// FIX #3 restart contract: the parked-approval registry is in-memory, so a
	// restart forgets any in-flight approval parks. That is safe-but-manual:
	// the awaiting-approval label keeps such cards invisible to every discover;
	// a human unparks one by deciding the approval and removing the label (or
	// re-triggering the card). The runner cannot enumerate them here without a
	// board scan, so just be loud about the contract.
	slog.Info("approval-park registry starts empty (in-memory); cards still labeled awaiting-approval from a previous run stay parked until a human decides/unparks them")

	// Check agent is still active before entering loop.
	if l.client.Agent != nil && !l.client.Agent.IsActive {
		slog.Warn("agent is deactivated, exiting")
		return nil
	}

	// Enforce allowed_workspaces — refuse to operate on unauthorized workspaces.
	if l.client.Agent != nil && len(l.client.Agent.AllowedWorkspaces) > 0 {
		allowed := false
		for _, ws := range l.client.Agent.AllowedWorkspaces {
			if ws == l.cfg.Valaris.WorkspaceSlug {
				allowed = true
				break
			}
		}
		if !allowed {
			return fmt.Errorf("agent not authorized for workspace %q (allowed: %v)", l.cfg.Valaris.WorkspaceSlug, l.client.Agent.AllowedWorkspaces)
		}
	}

	ticker := time.NewTicker(l.cfg.WorkLoop.PollInterval)
	defer ticker.Stop()

	// Poll once immediately. time.NewTicker doesn't fire at t=0, so without this
	// the runner would sit idle for a full PollInterval (2m in prod) before ever
	// looking for work — dead time on every launch.
	if shutdown := l.pollCycle(loopCtx, tickParentCtx); shutdown {
		return nil
	}
	l.selfTriggerIfProductive()

	for {
		select {
		case <-loopCtx.Done():
			slog.Info("work loop stopped", "reason", loopCtx.Err())
			return nil
		case <-ticker.C:
			if shutdown := l.pollCycle(loopCtx, tickParentCtx); shutdown {
				return nil
			}
			l.selfTriggerIfProductive()
			// Adjust ticker to the backoff-adjusted interval.
			ticker.Reset(l.PollInterval())
		case <-l.TriggerPoll:
			slog.Info("poll triggered via event")
			l.ResetIdleBackoff()
			ticker.Reset(l.cfg.WorkLoop.PollInterval)
			if shutdown := l.pollCycle(loopCtx, tickParentCtx); shutdown {
				return nil
			}
			l.selfTriggerIfProductive()
		}
	}
}

// pollCycle runs heartbeat + prompt refresh + tick. Returns true if the agent was deactivated remotely.
func (l *Loop) pollCycle(loopCtx, tickCtx context.Context) bool {
	var report *valaris.HealthReport
	if l.health != nil {
		report = l.health.Report()
		report.DiscoverCostUSD = l.discoverCostUSD
		report.BlockedCards = l.BlockedCardDetails()
		if l.sensors != nil {
			report.SensorCatalog = l.sensors.Catalog()
		}
	}
	if err := l.sendHeartbeat(loopCtx, report); err != nil {
		slog.Warn("heartbeat failed", "error", err)
	}
	if l.client.Agent != nil && !l.client.Agent.IsActive {
		slog.Warn("agent deactivated remotely, shutting down")
		return true
	}
	// Empty-LLM breaker open: pause everything but the heartbeat. Skipping
	// the refresh calls too keeps the outage from burning API budget; the
	// operator sees the runner alive-but-paused via the heartbeat above.
	if l.emptyLLMHalted() {
		slog.Warn("empty-LLM circuit breaker open — skipping this cycle, will probe after cooldown")
		return false
	}
	// Refresh prompt cache and workspace config each cycle, then re-evaluate
	// platform authority so a freshly-authored prompt re-enables a previously
	// dropped role (and vice versa: a deleted prompt disables it).
	l.RefreshPromptCache(loopCtx)
	l.RefreshPlatformConfig(loopCtx)
	l.applyPlatformAuthority(loopCtx)
	// FIX #3: check parked approval-gated cards before ticking. This is the
	// poll-fallback resume trigger; the approval-decided WS event wakes this
	// same cycle via TriggerPoll, so both paths converge here.
	l.resumeDecidedApprovals(tickCtx)
	if err := l.tick(tickCtx); err != nil {
		slog.Error("tick failed", "error", err)
		// T0.2: after a failed tick, enforce a minimum wait before the next
		// poll cycle retries. Without this, pre-LLM errors (budget 429, git
		// clone failures) burn API quota in a tight loop because the outer
		// ticker fires every poll_interval regardless of tick outcome.
		l.applyFailureBackoff(loopCtx)
	}
	return false
}

// selfTriggerIfProductive wakes the loop again immediately after a tick that
// did work, so a multi-role runner advances a card through its own role
// handoffs (e.g. planner→implementer) within seconds instead of idling until
// poll_interval. Card 4f8d88aa: a self-generated board mutation (move_card,
// ship) used to leave the next role waiting for the 2m timer or an incidental
// WS reconnect.
//
// Non-blocking send on the cap=1 TriggerPoll channel: if a trigger is already
// pending the extra signal is dropped (the pending one will re-poll anyway), so
// this coalesces and never busy-loops. An idle tick (lastTickHadWork=false)
// does not re-trigger, which is what lets the handoff chain terminate.
func (l *Loop) selfTriggerIfProductive() {
	if !l.lastTickHadWork {
		return
	}
	// Rate-floor the self-trigger so a "productive but card-not-advanced" tick
	// can't spin the loop. A real handoff advances one stage per tick and tolerates
	// a few seconds between re-polls; a stuck role that keeps marking itself
	// productive is capped to one re-poll per selfTriggerMinInterval instead of
	// hundreds per second. selfTriggerMinInterval=0 disables the floor (tests).
	if l.selfTriggerMinInterval > 0 {
		l.refreshThrottleMu.Lock()
		if !l.lastSelfTrigger.IsZero() && time.Since(l.lastSelfTrigger) < l.selfTriggerMinInterval {
			l.refreshThrottleMu.Unlock()
			return
		}
		l.lastSelfTrigger = time.Now()
		l.refreshThrottleMu.Unlock()
	}
	select {
	case l.TriggerPoll <- struct{}{}:
	default:
	}
}

// sendHeartbeat delivers the health report over the preferred transport:
// WebSocket when the configured sender is connected, falling back to HTTP
// otherwise. The backend treats missing heartbeats as offline, so failed
// WS sends deliberately do NOT retry over HTTP — the next poll cycle will
// send another heartbeat in 30s regardless.
//
// Agent identity (ID, IsActive) is refreshed via HTTP GetAgentConfig when
// WS is used, because the WS frame is fire-and-forget; the loop still
// needs the deactivation check.
func (l *Loop) sendHeartbeat(ctx context.Context, report *valaris.HealthReport) error {
	if l.hbSender != nil && l.hbSender.Connected() {
		var payload any
		if report != nil {
			payload = report
		} else {
			payload = map[string]any{}
		}
		if err := l.hbSender.SendHeartbeat(ctx, payload); err != nil {
			return err
		}
		// Refresh agent config so the deactivation-shutdown check stays accurate.
		// This is one HTTP call per poll (same cost as before WS-2); when the
		// future GetAgentConfig path moves to WS, this line collapses.
		if agent, err := l.client.GetAgentConfig(ctx); err == nil && agent != nil {
			l.client.Agent = agent
		}
		return nil
	}
	return l.client.Heartbeat(ctx, report)
}

// applyFailureBackoff sleeps for the configured min_failure_backoff_seconds
// so the next poll can't hammer the platform immediately after a failure.
// Honours loopCtx cancellation so shutdown stays responsive.
func (l *Loop) applyFailureBackoff(loopCtx context.Context) {
	backoff := l.failureBackoffDuration()
	if backoff <= 0 {
		return
	}
	slog.Warn("enforcing post-failure backoff", "duration", backoff)
	select {
	case <-time.After(backoff):
	case <-loopCtx.Done():
	}
}

// failureBackoffDuration reads scheduling.min_failure_backoff_seconds from the
// live platform config. Zero or negative falls back to the 5-second default.
func (l *Loop) failureBackoffDuration() time.Duration {
	l.platformConfigMu.RLock()
	defer l.platformConfigMu.RUnlock()
	if l.platformConfig.PipelineConfig == nil {
		return 5 * time.Second
	}
	s := l.platformConfig.PipelineConfig.Scheduling.MinFailureBackoffSeconds
	if s <= 0 {
		return 5 * time.Second
	}
	return time.Duration(s) * time.Second
}

// observeDrain registers the drain-cancelled context so the tick path can tell
// a drain has begun even though it runs under the separate in-flight context.
func (l *Loop) observeDrain(loopCtx context.Context) {
	l.drainSignalMu.Lock()
	l.drainSignal = loopCtx
	l.drainSignalMu.Unlock()
}

// draining reports whether a drain has started. Card 5edd3609: the drain
// boundary is "take no NEW work", not "wait for the next poll cycle" — a
// strategy walk that keeps reserving cards mid-drain either fails them
// spuriously or gets force-killed at drain_timeout with a card still claimed.
func (l *Loop) draining() bool {
	l.drainSignalMu.RLock()
	sig := l.drainSignal
	l.drainSignalMu.RUnlock()
	return sig != nil && sig.Err() != nil
}

// tick runs one iteration, delegating to the configured strategy.
// In multi-role mode, the scheduler selects which strategy ticks.
func (l *Loop) tick(ctx context.Context) error {
	if l.draining() {
		slog.Info("drain under way — skipping tick, no new work will be reserved")
		return nil
	}

	role := ""
	if l.strategy != nil {
		role = l.strategy.Name()
	}

	ctx, span := telemetry.StartTickSpan(ctx, role)
	defer span.End()

	if l.scheduler != nil {
		return l.scheduledTick(ctx)
	}

	if l.strategy == nil {
		// Platform-authority dropped the only role (missing prompt). Stay
		// alive so health surfaces the gap; the next refresh will re-enable
		// the role once the operator authors the prompt.
		return nil
	}

	// Single-role token injection (same logic as scheduledTick for multi-role).
	if token, ok := l.cfg.Git.Tokens[role]; ok && token != "" {
		l.git.RoleToken = token
	} else {
		l.git.RoleToken = ""
	}

	return l.strategy.Tick(ctx, l)
}

// scheduledTick lets the scheduler pick a strategy, runs its tick,
// then records whether the tick found work for scheduling decisions.
// When a strategy finds no work, it fast-forwards to the next strategy
// in the same poll cycle instead of waiting for the next poll interval.
//
// Strategies run sequentially, one per tick — work across roles is
// interleaved via the Scheduler's round-robin, not parallel.
func (l *Loop) scheduledTick(ctx context.Context) error {
	maxAttempts := l.scheduler.Len()

	for attempt := 0; attempt < maxAttempts; attempt++ {
		// Re-checked every iteration, not just at entry: the walk fast-forwards
		// through every role inside ONE poll cycle, so a drain that starts while
		// an earlier role is ticking must stop the roles behind it from
		// reserving fresh cards (card 5edd3609).
		if l.draining() {
			slog.Info("drain under way — halting strategy walk, no new work will be reserved",
				"strategies_skipped", maxAttempts-attempt)
			return nil
		}

		strategy := l.scheduler.Next()
		if strategy == nil {
			slog.Warn("no strategy available from scheduler")
			return nil
		}

		// Update the tick span with the scheduler-selected role.
		span := trace.SpanFromContext(ctx)
		span.SetAttributes(attribute.String("gen_ai.agent.role", strategy.Name()))

		// Set l.strategy so that llmOpts(), getPrompt(), discoverOpts() etc.
		// use the correct role's configuration during this tick.
		l.strategy = strategy
		l.lastTickHadWork = false

		// Inject per-role GH_TOKEN so gh CLI uses the correct identity
		// (e.g. reviewer token != orchestrator token to avoid self-review).
		if token, ok := l.cfg.Git.Tokens[strategy.Name()]; ok && token != "" {
			l.git.RoleToken = token
		} else {
			l.git.RoleToken = ""
		}

		err := strategy.Tick(ctx, l)
		l.scheduler.RecordTick(strategy.Name(), l.lastTickHadWork)

		if err != nil {
			return err
		}

		// Strategy found work — done for this poll cycle.
		if l.lastTickHadWork {
			return nil
		}

		// No work found — fast-forward to the next strategy immediately.
		slog.Debug("fast-forward: no work for role, trying next", "role", strategy.Name(), "attempt", attempt+1)
	}

	// All strategies checked, none had work.
	return nil
}

// IncrementIdleBackoff increases the idle backoff counter.
// Called after a "no work found" discover to slow down polling.
func (l *Loop) IncrementIdleBackoff() {
	l.idleBackoff++
}

// ResetIdleBackoff resets the backoff counter to zero.
// Called when work is found or an external event triggers a poll.
func (l *Loop) ResetIdleBackoff() {
	l.idleBackoff = 0
}

// WakeRole resets a role's idle cooldown in the scheduler so it gets picked
// on the next tick. No-op when running in single-role mode.
func (l *Loop) WakeRole(role string) {
	if l.scheduler != nil {
		l.scheduler.ResetIdle(role)
	}
}

// PollInterval returns the current poll interval accounting for idle backoff.
// Formula: min(baseInterval * 2^idleBackoff, maxIdleInterval).
func (l *Loop) PollInterval() time.Duration {
	base := l.cfg.WorkLoop.PollInterval
	max := l.cfg.WorkLoop.MaxIdleInterval
	if l.idleBackoff == 0 {
		return base
	}
	shift := l.idleBackoff
	// base << 30 ≈ 36h at base=2m; well past any sane max, prevents int64 overflow.
	const safeShift = uint(30)
	if shift > safeShift {
		shift = safeShift
	}
	interval := base << shift
	// interval <= 0 catches the residual overflow case where base itself is large
	// enough that base<<safeShift still wraps negative — load-bearing guard, not
	// a redundant check.
	if interval <= 0 || (max > 0 && interval > max) {
		if max > 0 {
			return max
		}
		// Uncapped + overflow shouldn't happen at safeShift=30 with realistic
		// base values, but if it ever does, fall back to base instead of panicking.
		return base
	}
	return interval
}

// AccumulateDiscoverCost adds the current tick cost to the cumulative discover cost.
// Called after discover() returns, before resetTickCost().
func (l *Loop) AccumulateDiscoverCost() {
	l.discoverCostUSD += l.tickCost
}

// DiscoverCostUSD returns the cumulative discover cost since startup.
func (l *Loop) DiscoverCostUSD() float64 {
	return l.discoverCostUSD
}

// providerFor selects the LLM provider for the current stage. Precedence:
//
//  1. TIER REMAP — when the backend forwarded an abstract tier (premium/mid/low)
//     as AssignmentLLM.Tier and the runner's llm.tier_providers maps it, run on
//     the first provider in that preference list the runner actually built. This
//     makes the backend model a suggestion: each host owns which local coding
//     agent serves a tier.
//  2. RESOLVED PROVIDER — the backend-resolved AssignmentLLM.Provider, if built.
//  3. DEFAULT — the runner's yaml default provider.
//
// A nil registry behaves as before — the single default handles every stage.
// All fallbacks are silent-but-safe: the startup preflight is where a genuinely
// missing provider is caught, not here mid-card.
func (l *Loop) providerFor(dispatch valaris.AssignmentLLM) llm.Provider {
	return resolveProvider(l.cfg, l.providers, l.provider, dispatch, l.strategyName())
}

// providerForTier returns the first built provider in the runner's preference
// list for an abstract tier, or nil when the tier is empty, unmapped, or maps
// only to providers the runner didn't build (the caller then falls back to the
// resolved provider).
func (l *Loop) providerForTier(tier string) llm.Provider {
	return resolveProviderForTier(l.cfg, l.providers, tier, l.strategyName())
}

// modelForProvider reconciles the model with the resolved provider. The backend
// ships (provider, model) as ONE coherent pair: assignment.Model was resolved
// FOR assignment.Provider. When the runner overrides the provider — a tier remap
// or an extra-provider stage selecting a different local agent — that backend
// model is for the wrong agent and would be unrunnable (field run 2026-07-25:
// premium remapped to codex-cli but the backend model `opus` rode along, so
// `codex exec --model opus` failed every attempt). In that case send the runner's
// own configured model instead; the backend model is just a suggestion once the
// provider diverges. When the provider matches (or no registry/divergence),
// backend authority over the model is preserved unchanged.
func (l *Loop) modelForProvider(provider llm.Provider, dispatch valaris.AssignmentLLM, backendModel string) string {
	return resolveModelForProvider(l.cfg, provider, dispatch, backendModel, l.strategyName())
}

// resolveProvider is providerFor's pure core, extracted so loop mode (which
// has no Loop/strategy) can reuse the exact same dispatch-routing rules.
// role is only for the warn-log attr; pass "" outside a strategy context.
func resolveProvider(cfg *config.Config, providers map[string]llm.Provider, defaultProvider llm.Provider, dispatch valaris.AssignmentLLM, role string) llm.Provider {
	if providers == nil {
		return defaultProvider
	}
	if p := resolveProviderForTier(cfg, providers, dispatch.Tier, role); p != nil {
		return p
	}
	if name := dispatch.Provider; name != "" {
		if p, ok := providers[name]; ok {
			return p
		}
		slog.Warn("stage declared an llm.provider the runner did not build — using default",
			"declared_provider", name, "default_provider", defaultProvider.Name(), "role", role,
		)
	}
	return defaultProvider
}

// resolveProviderForTier is providerForTier's pure core.
func resolveProviderForTier(cfg *config.Config, providers map[string]llm.Provider, tier string, role string) llm.Provider {
	if tier == "" || cfg == nil {
		return nil
	}
	prefs := cfg.LLM.ProvidersForTier(tier)
	for _, name := range prefs {
		if p, ok := providers[name]; ok {
			return p
		}
	}
	if len(prefs) > 0 {
		slog.Warn("tier maps only to providers the runner did not build — falling back to the resolved provider",
			"tier", tier, "tier_providers", prefs, "role", role,
		)
	}
	return nil
}

// resolveModelForProvider is modelForProvider's pure core.
func resolveModelForProvider(cfg *config.Config, provider llm.Provider, dispatch valaris.AssignmentLLM, backendModel string, role string) string {
	if provider == nil || cfg == nil {
		return backendModel
	}
	// A remap only happens when a registry routed us somewhere other than the
	// backend-resolved provider. dispatch.Provider == "" means the backend named
	// no provider, so any registry pick is a divergence from the (empty) default.
	resolvedName := provider.Name()
	if dispatch.Provider == "" || resolvedName == dispatch.Provider {
		return backendModel
	}
	runnerModel := cfg.LLM.Model
	if runnerModel == "" {
		// No runner model to substitute — keep the backend model and let the
		// provider/preflight surface the mismatch rather than send an empty model.
		return backendModel
	}
	slog.Warn("provider remapped away from the backend-resolved provider — substituting the runner's configured model",
		"resolved_provider", resolvedName, "backend_provider", dispatch.Provider,
		"backend_model", backendModel, "runner_model", runnerModel,
		"tier", dispatch.Tier, "role", role,
	)
	return runnerModel
}

// resolvedProviderModel returns the (provider name, model) the runner will
// ACTUALLY run for a dispatch — the same resolution execute() applies — so
// execution-start logging records what executed, not the backend's suggestion.
// Returns ("", dispatch.Model) when no registry is configured (the single
// default provider handles everything and its name isn't meaningful to log).
func (l *Loop) resolvedProviderModel(dispatch valaris.AssignmentLLM) (provider, model string) {
	if l.providers == nil {
		return "", dispatch.Model
	}
	p := l.providerFor(dispatch)
	if p == nil {
		return "", dispatch.Model
	}
	return p.Name(), l.modelForProvider(p, dispatch, dispatch.Model)
}

// strategyName returns the current strategy's name, or "" when no strategy is
// set (e.g. in focused unit tests that drive execute directly).
func (l *Loop) strategyName() string {
	if l.strategy == nil {
		return ""
	}
	return l.strategy.Name()
}

// execute wraps provider.Execute with rate limiting, cost logging, and telemetry.
func (l *Loop) execute(ctx context.Context, prompt string, opts llm.Options) (*llm.Result, error) {
	if l.limiter != nil {
		if err := l.limiter.wait(ctx); err != nil {
			return nil, fmt.Errorf("rate limit wait: %w", err)
		}
	}

	dispatch := l.assignmentLLM()
	provider := l.providerFor(dispatch)
	opts.Model = l.modelForProvider(provider, dispatch, opts.Model)

	ctx, llmSpan := telemetry.StartLLMSpan(ctx, opts.Model)
	defer llmSpan.End()

	result, err := provider.Execute(ctx, prompt, opts)
	if err != nil {
		llmSpan.RecordError(err)
	}
	l.lastTurnTokens = 0 // overwritten below when a result is present
	if result != nil {
		l.tickTokens += result.InputTokens + result.OutputTokens
		l.lastTurnTokens = result.InputTokens + result.OutputTokens

		cost := result.CostUSD
		if cost == 0 && (result.InputTokens > 0 || result.OutputTokens > 0) {
			// The provider reported tokens but no dollars (Claude Code Max
			// subscription auth, or any cost-blind backend). Estimate from the
			// (provider, model) rate sheet, falling back to the Sonnet default.
			cost = estimateCostWith(priceFor(provider.Name(), opts.Model),
				result.InputTokens, result.OutputTokens,
				result.CacheCreationTokens, result.CacheReadTokens)
			result.CostUSD = cost
		}
		l.tickCost += cost

		if result.InputTokens > 0 || result.OutputTokens > 0 {
			slog.Info("llm cost",
				"cost_usd", cost,
				"tokens_in", result.InputTokens,
				"tokens_out", result.OutputTokens,
				"cache_create", result.CacheCreationTokens,
				"cache_read", result.CacheReadTokens,
				"turns", result.NumTurns,
			)
		}

		telemetry.RecordLLMResult(llmSpan, result.InputTokens, result.OutputTokens,
			result.CacheCreationTokens, result.CacheReadTokens, result.CostUSD)
	}
	l.recordLLMOutcome(ctx, result)
	return result, err
}

// tokenPrice is a per-million-token rate sheet. Cost is only ever ESTIMATED
// from token counts when a provider doesn't report dollars itself (Claude Code
// Max subscription auth, and any future cost-blind backend); a provider that
// reports CostUSD bypasses this entirely.
type tokenPrice struct {
	inputPer1M       float64
	outputPer1M      float64
	cacheCreatePer1M float64
	cacheReadPer1M   float64
}

// defaultTokenPrice is the historical Claude Sonnet rate sheet. It is the
// fallback for any (provider, model) not in priceTable, so an unknown backend
// is costed conservatively rather than appearing free.
var defaultTokenPrice = tokenPrice{inputPer1M: 3.0, outputPer1M: 15.0, cacheCreatePer1M: 3.75, cacheReadPer1M: 0.30}

// priceTable maps a (provider, model) to its rate sheet. Keyed on the model
// substring so "claude-opus-4-8"/"opus" both resolve. Provider-agnostic by
// construction: a new backend registers its rates here, no code branch needed.
// Cache columns are 0 for providers without prompt caching (the cache token
// counts are also 0 there, so the column is moot).
var priceTable = map[string]tokenPrice{
	"opus":   {inputPer1M: 15.0, outputPer1M: 75.0, cacheCreatePer1M: 18.75, cacheReadPer1M: 1.50},
	"sonnet": defaultTokenPrice,
	"haiku":  {inputPer1M: 0.80, outputPer1M: 4.0, cacheCreatePer1M: 1.0, cacheReadPer1M: 0.08},
}

// priceFor resolves the rate sheet for a (provider, model). It matches the
// model against priceTable keys by substring (case-insensitive) and falls back
// to defaultTokenPrice when nothing matches. provider is accepted for future
// per-provider tables but is not yet needed to disambiguate.
func priceFor(provider, model string) tokenPrice {
	m := strings.ToLower(model)
	for key, price := range priceTable {
		if strings.Contains(m, key) {
			return price
		}
	}
	return defaultTokenPrice
}

// estimateCostWith computes approximate cost from token counts using an
// explicit rate sheet. Zero tokens cost zero regardless of price.
func estimateCostWith(p tokenPrice, inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens int) float64 {
	return float64(inputTokens)*p.inputPer1M/1_000_000 +
		float64(outputTokens)*p.outputPer1M/1_000_000 +
		float64(cacheCreateTokens)*p.cacheCreatePer1M/1_000_000 +
		float64(cacheReadTokens)*p.cacheReadPer1M/1_000_000
}

// estimateCost computes approximate cost using the default (Claude Sonnet) rate
// sheet. Retained for callers/tests that don't carry provider/model context;
// the cost-reporting path in execute uses estimateCostWith(priceFor(...)).
func estimateCost(inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens int) float64 {
	return estimateCostWith(defaultTokenPrice, inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens)
}

const (
	// maxConsecutiveEmptyLLM trips the empty-LLM breaker. Three in a row is
	// unambiguous: a real card failure consumes tokens, and three distinct
	// stages all returning instantly with zero tokens means the provider
	// (quota, credits, auth) is down, not the work.
	maxConsecutiveEmptyLLM = 3
	// emptyLLMHaltDuration is the pause before the next probe. Long enough
	// to stop the reserve→fail→re-reserve burn, short enough to self-heal
	// promptly once quota/credits return.
	emptyLLMHaltDuration = 15 * time.Minute
)

// recordLLMOutcome feeds the empty-LLM circuit breaker from every provider
// result that flows through execute. A failure with zero tokens in AND out is
// the provider-down signature; anything token-bearing (success or real stage
// failure) proves the provider is alive and resets the streak. A locally
// cancelled context (drain/shutdown killed the CLI) never counts.
func (l *Loop) recordLLMOutcome(ctx context.Context, result *llm.Result) {
	if result == nil || ctx.Err() != nil {
		return
	}
	failed := result.ExitCode != 0 || result.Error != nil
	empty := result.InputTokens == 0 && result.OutputTokens == 0

	l.emptyLLMMu.Lock()
	defer l.emptyLLMMu.Unlock()
	if !failed || !empty {
		l.consecutiveEmptyLLM = 0
		return
	}
	l.consecutiveEmptyLLM++
	if l.consecutiveEmptyLLM >= maxConsecutiveEmptyLLM {
		l.emptyLLMHaltUntil = time.Now().Add(emptyLLMHaltDuration)
		slog.Error("empty-LLM circuit breaker tripped — provider/quota failure suspected, pausing reservations",
			"consecutive_empty_failures", l.consecutiveEmptyLLM,
			"resume_at", l.emptyLLMHaltUntil.Format(time.RFC3339),
		)
	}
}

// emptyLLMHalted reports whether pollCycle must skip reservations because the
// empty-LLM breaker is open. Expiry IS the probe permit: the first cycle after
// emptyLLMHaltUntil runs normally, and its LLM outcome either resets the
// breaker or re-trips it for another window.
func (l *Loop) emptyLLMHalted() bool {
	l.emptyLLMMu.Lock()
	defer l.emptyLLMMu.Unlock()
	return time.Now().Before(l.emptyLLMHaltUntil)
}

// SetAssignmentLLM stashes the per-stage LLM dispatch the backend returned
// with the current /next-assignment so llmOpts can prefer it over the
// runner's yaml. Cleared between ticks; concurrent reads via llmOpts are
// guarded by an RWMutex because the heartbeat goroutine also calls llmOpts
// for budget bookkeeping.
// SetProviders registers the per-stage provider registry (keyed on provider
// string). Call once at startup after New. A nil/empty map leaves the loop on
// single-provider behavior (every stage uses the default provider).
func (l *Loop) SetProviders(providers map[string]llm.Provider) {
	l.providers = providers
}

func (l *Loop) SetAssignmentLLM(llm valaris.AssignmentLLM) {
	l.currentAssignmentLLMMu.Lock()
	l.currentAssignmentLLM = llm
	l.currentAssignmentLLMMu.Unlock()
}

func (l *Loop) assignmentLLM() valaris.AssignmentLLM {
	l.currentAssignmentLLMMu.RLock()
	defer l.currentAssignmentLLMMu.RUnlock()
	return l.currentAssignmentLLM
}

// SetCardBudgetOverride stashes the per-card budget ceiling the backend issued
// with the current /next-assignment (Card.budget_usd_override). Cleared between
// ticks alongside the assignment stash. Pass nil to clear.
func (l *Loop) SetCardBudgetOverride(override *float64) {
	l.currentAssignmentLLMMu.Lock()
	l.currentCardBudgetOverride = override
	l.currentAssignmentLLMMu.Unlock()
}

// effectiveBudgetUSD resolves the budget ceiling for this card: the per-card
// override when present, else the workspace/yaml max_budget_usd. It is the
// single source of truth shared by the CLI ceiling (llmOpts) and the SUSPEND
// classifier, so they can never disagree about which wall was hit.
func (l *Loop) effectiveBudgetUSD() float64 {
	l.currentAssignmentLLMMu.RLock()
	override := l.currentCardBudgetOverride
	l.currentAssignmentLLMMu.RUnlock()
	if override != nil && *override > 0 {
		return *override
	}
	return l.cfg.LLM.MaxBudgetUSD
}

// llmOpts builds the common LLM options from config.
// llmOpts returns base LLM options. An optional phase name selects a
// per-phase model override (e.g. "discover" → haiku, "implement" → opus).
//
// Model resolution priority (Wave 2 / CRIT-2):
//  1. The /next-assignment payload's llm.model (backend-authoritative —
//     stashed via SetAssignmentLLM at tick start).
//  2. cfg.LLM.ModelForPhase(phase) yaml override (legacy per-phase config).
//  3. cfg.LLM.Model yaml default.
//
// Falling through to (2)/(3) logs a CRITICAL warning because the backend
// failed to declare the model — the desired steady state is that every
// stage's pipeline_config.llm.{provider,model} populates the assignment
// payload. The yaml fallback is a one-deploy safety net and will be
// converted to a hard error in the follow-up deploy.
func (l *Loop) llmOpts(phase ...string) llm.Options {
	assignment := l.assignmentLLM()
	var model string
	switch {
	case assignment.Model != "":
		model = assignment.Model
	case len(phase) > 0 && phase[0] != "":
		model = l.cfg.LLM.ModelForPhase(phase[0])
		slog.Warn("falling back to runner yaml model — backend did not declare a model for this stage",
			"phase", phase[0], "yaml_model", model, "role", l.strategy.Name(),
		)
	default:
		model = l.cfg.LLM.Model
		slog.Warn("falling back to runner yaml model — backend did not declare a model for this stage",
			"yaml_model", model, "role", l.strategy.Name(),
		)
	}
	deny, denySource := resolveToolDeny(assignment.ToolPolicy.Deny)
	enforcement := describeDenyEnforcement(l.providerFor(assignment), deny)
	slog.Log(context.Background(), enforcement.logLevel(), "resolved tool deny-list for stage",
		append([]any{"deny", deny, "deny_source", denySource, "role", l.strategy.Name()}, enforcement.logAttrs()...)...,
	)
	return llm.Options{
		Model:                      model,
		MCPConfigPath:              l.cfg.LLM.MCPConfigPath,
		MaxBudgetUSD:               l.effectiveBudgetUSD(),
		PermissionMode:             l.cfg.LLM.PermissionMode,
		DangerouslySkipPermissions: l.cfg.LLM.DangerouslySkipPermissions,
		DisallowedTools:            deny,
		AllowedTools:               l.strategy.AllowedTools(),
		ContextDirs:                l.cfg.LLM.ContextDirs,
		AnthropicAPIKey:            l.cfg.LLM.AnthropicAPIKey,
		// Backend-authored per-stage decision schema (empty for most stages →
		// the produces_decision dispatch falls back to decisionOutputSchema).
		OutputSchema: assignment.OutputSchema,
	}
}

// resolveToolDeny picks the effective tool deny-list: the backend-authoritative
// per-stage list when non-empty, otherwise the SafeToolDenyFloor security floor.
// Returns the list and a source label for the launch log (principle 3: loud).
func resolveToolDeny(backendDeny []string) (deny []string, source string) {
	if len(backendDeny) > 0 {
		return backendDeny, "backend"
	}
	return llm.SafeToolDenyFloor, "floor-fallback"
}

// discoverOpts returns LLM options restricted to read-only MCP tools.
// Discover calls should not log executions or mutate cards — doing so generates
// WebSocket events that trigger other agents into hot poll loops.
func (l *Loop) discoverOpts() llm.Options {
	opts := l.llmOpts("discover")
	readOnly := make([]string, 0, len(opts.AllowedTools))
	for _, tool := range opts.AllowedTools {
		switch tool {
		case "mcp__valaris__log_execution_start",
			"mcp__valaris__log_execution_update",
			"mcp__valaris__claim_card",
			"mcp__valaris__update_card",
			"mcp__valaris__move_card",
			"mcp__valaris__add_card_participant",
			"mcp__valaris__remove_card_participant",
			"mcp__valaris__request_approval":
			continue // skip write tools during discover
		default:
			readOnly = append(readOnly, tool)
		}
	}
	opts.AllowedTools = readOnly
	return opts
}

// isCardPRMerged checks if a discovered card has a PR that's already merged.
// Returns true if the PR exists and is in MERGED state. Returns false on any
// error or if there's no PR URL -- callers should proceed normally.
func (l *Loop) isCardPRMerged(ctx context.Context, card *discoverResult) bool {
	if card.PRURL == "" || card.GitRepoURL == "" {
		return false
	}
	repoDir, err := l.git.CloneOrOpen(ctx, card.GitRepoURL, card.GitRepoName)
	if err != nil {
		slog.Debug("merged PR check: clone failed, proceeding normally", "error", err)
		return false
	}
	status, err := l.forge.ChangeStatusFor(ctx, repoDir, card.PRURL)
	if err != nil {
		slog.Debug("merged PR check: status check failed, proceeding normally", "error", err)
		return false
	}
	return status.State == forge.StateMerged
}

// --- Stage methods ---

type discoverResult struct {
	CardID      string `json:"card_id"`
	BoardID     string `json:"board_id"`
	Title       string `json:"title"`
	PRURL       string `json:"pr_url"`
	PRBranch    string `json:"pr_branch"`
	GitRepoID   string `json:"git_repo_id,omitempty"`
	GitRepoURL  string `json:"git_repo_url"`
	GitRepoName string `json:"git_repo_name"`
	// GitRepoSlug is the card's REGISTERED repo slug (never the display
	// name). Source precedence: the card's own git_repo_slug verbatim, else
	// the resolved repo's registered slug. Fix cards filed off this card
	// inherit it so they route to the same repo on multi-repo boards — an
	// unknown/name-echoed slug silently misroutes to the board's first repo.
	GitRepoSlug             string `json:"git_repo_slug,omitempty"`
	GitRepoProvider         string `json:"git_repo_provider"`
	RequireBranchProtection bool   `json:"require_branch_protection"`
	DefaultBranch           string `json:"default_branch"`
	// Optional staging branch the repo opted into. Empty means the runner
	// uses DefaultBranch as before.
	IntegrationBranch string `json:"integration_branch,omitempty"`
	Rework            bool   `json:"rework"`
	// Backend-rendered context_sources bundle from /next-assignment, keyed by
	// operator alias. Carried here so every construction site that builds a
	// PromptContext can populate the templated map without re-fetching.
	ContextSources map[string]string `json:"-"`
	// Backend-authoritative per-stage LLM dispatch from /next-assignment.
	// Empty means a pre-rollout backend didn't emit it; llmOpts falls back
	// to cfg.LLM.Model with a WARN for one deploy cycle.
	AssignmentLLM valaris.AssignmentLLM `json:"-"`
	// Card labels from the assignment bundle. Carried so the SUSPEND path can
	// read/park via labels without an extra GetCard round-trip.
	Labels []string `json:"-"`
	// Per-card budget ceiling override (Card.budget_usd_override). nil = use the
	// workspace/yaml max_budget_usd.
	BudgetUSDOverride *float64 `json:"-"`
	// Skills the board binds, resolved backend-side on the assignment. Carried
	// here so skills_setup can materialize them without a second fetch. Nil on
	// a pre-registry backend, which makes the step a no-op.
	Skills []valaris.AssignmentSkill `json:"-"`
}

func defaultBranchOrMain(branch string) string {
	if branch == "" {
		return "main"
	}
	return branch
}

// resolveBaseRef picks the git ref CreateBranch should fork off given the
// stage's GitDef.BaseRef and the card's resolved repo metadata. Empty / unknown
// / "default_branch" all map to card.DefaultBranch — pre-PAR-1 behavior. Only
// "integration_branch" with a non-empty card.IntegrationBranch returns the
// staging ref.
func resolveBaseRef(git valaris.GitDef, card *discoverResult) string {
	if git.BaseRef == "integration_branch" && card.IntegrationBranch != "" {
		return card.IntegrationBranch
	}
	return card.DefaultBranch
}

// newDiscoverResultFromRepo builds a discoverResult from a card + an optional
// linked git repo. Pass nil for repo when the stage is configured with
// require_git_repo=false; the repo fields and DefaultBranch stay zero in that
// case. Callers that set Rework mutate the returned struct after the call.
func newDiscoverResultFromRepo(cardID, boardID, title, prURL, prBranch string, repo *valaris.GitRepo) *discoverResult {
	r := &discoverResult{
		CardID:   cardID,
		BoardID:  boardID,
		Title:    title,
		PRURL:    prURL,
		PRBranch: prBranch,
	}
	if repo != nil {
		r.GitRepoID = repo.ID
		r.GitRepoURL = repo.URL
		r.GitRepoName = repo.Name
		r.GitRepoSlug = repo.Slug // registered slug, never the display name
		r.GitRepoProvider = repo.Provider
		r.RequireBranchProtection = repo.RequireBranchProtection
		r.DefaultBranch = defaultBranchOrMain(repo.DefaultBranch)
	}
	return r
}

// resolveDiscoveredCardRepo picks the clone-target repo and the result slug
// for a legacy-discovered card (M3 adversarial review — mirrors
// discoverResultFromAssignment's rule). The card's own registered
// git_repo_slug is authoritative: when it names a registered repo, that repo
// is used outright. When it names NO registered repo the slug stays EMPTY —
// never invented — while repos[0] remains the clone target as before; the
// backend's repo-slug-unresolved park catches the misroute on the next hop. A
// card with no slug of its own keeps the historic first-repo behavior.
// repos must be non-empty.
func resolveDiscoveredCardRepo(cardSlug string, repos []valaris.GitRepo) (repo *valaris.GitRepo, slug string) {
	if cardSlug == "" {
		return &repos[0], repos[0].Slug
	}
	for i := range repos {
		if repos[i].Slug == cardSlug {
			return &repos[i], cardSlug
		}
	}
	return &repos[0], ""
}

type claimResult struct {
	ExecutionID string `json:"execution_id"`
	Error       string `json:"error"`
}

type implementResult struct {
	Status     string `json:"status"`
	Summary    string `json:"summary"`
	ApprovalID string `json:"approval_id"`
	// Resolution names WHY a writes_code stage produced no diff, distinguishing a
	// sanctioned no-op from a genuine failure (the runner otherwise reads a clean
	// tree as "produced no changes" and re-reserves — the duplicate money-loop).
	// "duplicate" = the requested change already exists (sibling PR / already on
	// base); consumed as a terminal close-as-duplicate. Empty = no claim; the
	// existing no-changes failure handling applies unchanged. Generic across every
	// code-writing role — never keyed on role or project.
	Resolution string `json:"resolution"`
	// Output is the verbatim LLM stdout. Not part of the JSON envelope the LLM
	// emits — populated by the caller before returning so the strategy layer
	// can carry it onto llmStageResult.rawOutput / WalkState.LLMRawOutput.
	Output string `json:"-"`
}

// resolutionDuplicate is the Resolution value a writes_code stage emits when the
// requested change already exists on the base branch (a sibling PR shipped it).
// A no-diff outcome carrying this is the CORRECT result, not a failure.
const resolutionDuplicate = "duplicate"

// resolutionNeedsRuntimeProof is the Resolution value a writes_code stage emits
// when the card's Done condition is a runtime observation the stage cannot
// perform (run the built artifact and observe). The card parks human-gated —
// blocked label + unassign + note — instead of failing into the re-reserve loop.
const resolutionNeedsRuntimeProof = "needs_runtime_proof"

// statusRuntimeProofParked is the sentinel implementResult.Status the
// runtime-proof park sets once the park has BOUND (blocked label written,
// execution closed). Mirrors statusAwaitingApproval: lifecycleLLM keys on it
// to stop the walk via ErrSuspended so no downstream step (create_pr, ship,
// or an on_failure fail-move) can run against the just-parked card.
const statusRuntimeProofParked = "runtime_proof_parked"

// statusDuplicateClosed is the sentinel implementResult.Status closeAsDuplicate
// sets once the close is done (card in done + `duplicate` label, participant
// dropped, execution completed). Same walk-stopping treatment as
// statusRuntimeProofParked — the walk must not continue to create_pr/ship (a PR
// for a closed card) nor reach an on_failure fail-move (dragging the closed
// card back to active) — but the terminal is a SUCCESS: the execution stays
// "completed", never "aborted".
const statusDuplicateClosed = "duplicate_closed"

// needsRuntimeProofLabel is the card-side verification label: it marks a card
// whose acceptance is a runtime observation, so a no-diff implement is the
// correct outcome and routes to the human-gated park rather than failure.
const needsRuntimeProofLabel = "needs-runtime-proof"

// runtimeProofMarkerRe is the body-marker form of the same signal, mirroring
// the backend's anchored, whitespace/case-tolerant line regex. Anchored on
// purpose: a mid-prose mention of the phrase must NOT mark a card as a
// verification card — only a dedicated `Acceptance: runtime-proof` line does.
var runtimeProofMarkerRe = regexp.MustCompile(`(?im)^\s*acceptance:\s*runtime-proof\s*$`)

// duplicateLabel marks a card closed because its work was already shipped
// elsewhere — distinct on the board from "built and merged here".
const duplicateLabel = "duplicate"

// resolutionNeedsReconcile is the Resolution value a writes_code stage emits
// when it SUSPECTS its scope was already delivered by a DIFFERENT card/PR (the
// A1b cross-card case) but is NOT confident enough to self-close as a duplicate
// (resolutionDuplicate is the SURE case — change already on the base branch).
// Instead of looping, the card is parked with the needs-reconcile label for the
// board_reconciler role to verify and dispose of. Generic across every
// code-writing role; keyed strictly on the declared resolution.
const resolutionNeedsReconcile = "needs_reconcile"

// statusReconcileParked is the sentinel implementResult.Status parkForReconcile
// sets once the park has BOUND (needs-reconcile label written, participant
// dropped, execution closed). Mirrors statusRuntimeProofParked: lifecycleLLM
// keys on it to stop the walk via ErrSuspended so no downstream step (create_pr,
// ship, or an on_failure fail-move) runs against the just-parked card.
const statusReconcileParked = "reconcile_parked"

// resolutionCannotProceed is the Resolution value a writes_code stage emits when
// the card CANNOT be completed in code because it needs a HUMAN decision or
// EXTERNAL input the stage cannot supply — an architecture choice + a provisioned
// secret, data that lives in a different/legacy repo, a licensed asset. The
// correct outcome is a no-diff, but unlike duplicate/runtime-proof/reconcile it
// is neither already-shipped nor a routable cross-card suspicion: a HUMAN must
// act. Instead of looping (the live I6/B6c money-loop), the card parks
// human-gated via the existing parkForBlocked (durable `blocked` label) — reusing
// the blocked machinery, no new label/config. Generic across every code-writing
// role; keyed strictly on the declared resolution.
const resolutionCannotProceed = "cannot_proceed"

// statusBlockedParked is the sentinel implementResult.Status a blocked park sets
// once it has BOUND (blocked label written, execution aborted). Mirrors
// statusReconcileParked / statusRuntimeProofParked: lifecycleLLM keys on it to
// stop the walk via ErrSuspended so no downstream step (create_pr, ship, or an
// on_failure fail-move) runs against the just-parked card.
const statusBlockedParked = "blocked_parked"

// needsReconcileLabel is the LOAD-BEARING routing signal for the A1b cure: the
// backend implementer/planner discover EXCLUDES it (breaking the re-hand loop)
// and the board_reconciler discover INCLUDES it (arming the disposal lane). The
// card stays in its current column (active) — board_reconciler scans by label,
// not column — so unlike the runtime-proof park this writes no blocked label and
// moves no card. Idempotent via addLabel.
const needsReconcileLabel = "needs-reconcile"

// blockedLabel is the durable, backend-visible force-block signal. The
// in-memory breaker (IsCardBlocked) is process-local — lost on restart and
// invisible to the backend scheduler — and the move-to-blocked-column is a
// no-op on boards without a `blocked` column, so neither can be the
// load-bearing de-reservation. The label is: every runner-side discover
// excludes it unconditionally, and pipeline configs exclude it for build
// roles. Idempotent via addLabel.
const blockedLabel = "blocked"

// repoSlugUnresolvedLabel is the backend's park signal for a card whose
// git_repo_slug names no registered repo (assignment_service.py
// REPO_SLUG_UNRESOLVED_LABEL — keep the strings identical). The backend
// scheduler excludes it; every legacy discover must treat it as the same
// built-in hard exclusion so a fallback never works a card the backend parked.
const repoSlugUnresolvedLabel = "repo-slug-unresolved"

// discover finds a card for the default unassigned_or_rework strategy.
//
// includeLabel (I.1.i): when non-empty, scopes both the rework and unassigned
// searches to cards carrying this label. Pushed server-side via
// SearchCardsParams.Label. Empty string preserves pre-I.1.i behavior bit-for-bit
// — the default 3-role pipeline does not set include_label.
//
// allDependenciesDone (card e6d468ab): when true, both searches push the
// scheduler's dependency gate server-side so a dependency-blocked card is
// never reserved via this legacy fallback. False preserves the pre-fix wire
// shape bit-for-bit for stages that don't declare the filter.
func (l *Loop) discover(ctx context.Context, includeLabel string, allDependenciesDone bool) (*discoverResult, error) {
	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}

	ws := l.cfg.Valaris.WorkspaceSlug
	boardIDs := l.cfg.Valaris.BoardIDs

	// If no boards configured, list all boards in the workspace.
	if len(boardIDs) == 0 {
		boards, err := l.client.ListBoards(ctx, ws)
		if err != nil {
			return nil, fmt.Errorf("listing boards: %w", err)
		}
		for _, b := range boards {
			boardIDs = append(boardIDs, b.ID)
		}
	}

	// PRIORITY 1 — Rework cards: assigned to this agent, in Active column.
	for _, boardID := range boardIDs {
		if agentID == "" {
			break
		}
		cards, err := l.client.SearchCards(ctx, ws, boardID, valaris.SearchCardsParams{
			AssigneeID:          agentID,
			ColumnType:          "active",
			Label:               includeLabel,
			Limit:               10,
			AllDependenciesDone: allDependenciesDone,
		})
		if err != nil {
			slog.Warn("discover: rework search failed", "board_id", boardID, "error", err)
			continue
		}
		for _, c := range cards {
			if l.IsCardBlocked(c.ID) {
				continue
			}
			// `blocked`/`awaiting-approval` labels are built-in hard
			// exclusions (see cardIntrinsicallyParked).
			if cardIntrinsicallyParked(c) {
				continue
			}
			repos, err := l.client.ListGitRepos(ctx, ws, boardID)
			if err != nil || len(repos) == 0 {
				continue
			}
			repo, slug := resolveDiscoveredCardRepo(c.GitRepoSlug, repos)
			result := newDiscoverResultFromRepo(c.ID, boardID, c.Title,
				extractPRURL(c.Description), extractPRBranch(c.Description), repo)
			result.GitRepoSlug = slug
			result.Rework = true
			return result, nil
		}
	}

	// PRIORITY 2 — New unassigned cards: pick highest priority.
	hasAssignee := false
	for _, boardID := range boardIDs {
		cards, err := l.client.SearchCards(ctx, ws, boardID, valaris.SearchCardsParams{
			HasAssignee:         &hasAssignee,
			ExcludeColumnType:   "done",
			Label:               includeLabel,
			Limit:               50,
			AllDependenciesDone: allDependenciesDone,
		})
		if err != nil {
			slog.Warn("discover: new card search failed", "board_id", boardID, "error", err)
			continue
		}

		var best *valaris.Card
		for i := range cards {
			c := &cards[i]
			if l.IsCardBlocked(c.ID) {
				continue
			}
			// `blocked`/`awaiting-approval` labels are built-in hard
			// exclusions (see cardIntrinsicallyParked).
			if cardIntrinsicallyParked(*c) {
				continue
			}
			if best == nil || priorityRank(c.Priority) > priorityRank(best.Priority) {
				best = c
			}
		}

		if best == nil {
			continue
		}

		repos, err := l.client.ListGitRepos(ctx, ws, boardID)
		if err != nil || len(repos) == 0 {
			continue
		}

		// Cluster II Gap 4: the repo-WIDE open-PR gate is RETIRED. The
		// backend `next_assignment` scheduler owns stale-baseline prevention
		// with a CARD-scoped open-PR precondition (excludes the card's own
		// branch); this legacy fallback fails-open rather than wedging the
		// whole repo on one unrelated/abandoned PR (client pilot 2026-05-27).
		repo, slug := resolveDiscoveredCardRepo(best.GitRepoSlug, repos)
		return &discoverResult{
			CardID:        best.ID,
			BoardID:       boardID,
			Title:         best.Title,
			GitRepoURL:    repo.URL,
			GitRepoName:   repo.Name,
			GitRepoSlug:   slug,
			DefaultBranch: defaultBranchOrMain(repo.DefaultBranch),
		}, nil
	}

	return &discoverResult{}, nil
}

func (l *Loop) claim(ctx context.Context, card *discoverResult, stage valaris.StageConfig) (string, error) {
	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}
	ws := l.cfg.Valaris.WorkspaceSlug

	// Atomically assign agent as hero and move to In Progress.
	if err := l.client.ClaimCard(ctx, ws, card.BoardID, card.CardID, agentID); err != nil {
		return "", fmt.Errorf("claim_card: %w", err)
	}

	// Start execution tracking. Action, description, and role all come from the
	// strategy's StageConfig so backend `executions` reflects the pipeline stage
	// (e.g. "researcher" auditing) rather than assuming every hero implements.
	// Prompt slug is stamped from the /next-assignment payload (Wave 2 / CRIT-2);
	// provider+model are the RESOLVED coding agent the runner will actually run
	// (post tier_providers remap), so the row records what executed, not the
	// backend's tier suggestion.
	resolvedProvider, resolvedModel := l.resolvedProviderModel(card.AssignmentLLM)
	execID, err := l.client.LogExecutionStartWithSkills(
		ctx, agentID, ws, stage.Claim.ExecutionAction, card.BoardID, card.CardID,
		fmt.Sprintf("%s: %s", executionLogDescription(stage), card.CardID), stage.Role,
		card.AssignmentLLM.PromptSlug, resolvedModel, resolvedProvider, card.Skills,
	)
	if err != nil {
		return "", fmt.Errorf("log_execution_start: %w", err)
	}

	return execID, nil
}

func (l *Loop) implement(ctx context.Context, card *discoverResult, executionID, repoDir string) (*implementResult, error) {
	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}

	// Fetch project directives via REST and inject into the prompt so the LLM
	// treats them as mandatory instructions (not optional tool-call context).
	directivesText := l.fetchDirectives(ctx, card.BoardID)

	pctx := PromptContext{
		Workspace:         l.cfg.Valaris.WorkspaceSlug,
		AgentID:           agentID,
		BoardID:           card.BoardID,
		CardID:            card.CardID,
		ExecutionID:       executionID,
		ProjectDirectives: directivesText,
		ContextSources:    card.ContextSources,
		// Cluster I: when this card was budget-suspended, tell the agent to resume
		// from the WIP checkpoint on the branch instead of re-implementing.
		ResumeBrief: buildResumeBrief(card.Labels),
	}
	// context_sources kinds replace runner-side fetchers (board_definition →
	// fetchDirectives, review_history → fetchReviewHistory); aliasing keeps
	// existing templates referencing {{.ProjectDirectives}}/{{.ReviewHistory}}
	// rendering unchanged (CTX-2, CTX-5).
	applyContextSourceAliases(&pctx)
	prompt := l.resolvePrompt("implement", pctx, func() string {
		return implementPrompt(pctx)
	})
	// The hardcoded fallback renders {{.ResumeBrief}}, but the backend-cached
	// implement template (the prod path) won't reference it — so the brief would
	// be silently dropped and the agent would re-implement from scratch, re-
	// burning the budget the suspend was meant to save. Prepend it to whichever
	// template won so resume instructions survive regardless of backend config.
	prompt = prependResumeBrief(prompt, pctx.ResumeBrief)

	opts := l.llmOpts("implement")
	opts.WorkingDir = repoDir

	// Resume existing session if available (avoids re-reading codebase).
	if l.sessions != nil {
		opts.ResumeSessionID = l.sessions.Get(agentID, card.CardID, "implement")
	}

	costBefore := l.tickCost
	result, err := l.execute(ctx, prompt, opts)
	l.persistPrompt(ctx, executionID, prompt)

	// Store session for potential retry regardless of outcome.
	if result != nil && l.sessions != nil {
		l.sessions.Set(agentID, card.CardID, "implement", result.SessionID)
	}

	if err != nil {
		// Cluster I: a budget cutoff costs ~the full ceiling and errors with an
		// empty/aborted output. Tag it as a SUSPEND candidate so the lifecycle
		// catch site can checkpoint+resume instead of wiping the branch. The
		// "is there work to save" gate is applied there (it owns the repo dir);
		// here we only test the cost signal against the SAME effective budget the
		// CLI enforced. Cost is measured as the implement-pass delta so discover/
		// mediation spend in this tick can't inflate it.
		delta := l.tickCost - costBefore
		if classifyBudgetSuspend(delta, l.effectiveBudgetUSD(), l.cfg.LLM.SuspendThreshold(), true) {
			return nil, &budgetSuspendError{costDelta: delta, budget: l.effectiveBudgetUSD(), cause: err}
		}
		return nil, err
	}

	var impl implementResult
	if !decodeLLMEnvelope(result, &impl) {
		// Coding stages routinely end with a prose summary rather than a JSON
		// envelope; that's expected, not an error. The real success signal is
		// whether the branch advanced (commits-ahead guard downstream), so
		// treat prose as "done" and carry it as the summary.
		slog.Info("implement returned prose, treating as done",
			"output_prefix", truncate(result.Output, 200),
		)
		impl.Status = "done"
		impl.Summary = truncate(result.Output, 500)
	}
	impl.Output = result.Output

	return &impl, nil
}

func (l *Loop) implementAfterApproval(ctx context.Context, card *discoverResult, executionID, repoDir, approvalSummary string) (*implementResult, error) {
	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}

	directivesText := l.fetchDirectives(ctx, card.BoardID)

	pctx := PromptContext{
		Workspace:         l.cfg.Valaris.WorkspaceSlug,
		AgentID:           agentID,
		BoardID:           card.BoardID,
		CardID:            card.CardID,
		ExecutionID:       executionID,
		ApprovalSummary:   approvalSummary,
		ProjectDirectives: directivesText,
		ContextSources:    card.ContextSources,
	}
	applyContextSourceAliases(&pctx)
	prompt := l.resolvePrompt("implement_after_approval", pctx, func() string {
		return implementAfterApprovalPrompt(pctx)
	})

	opts := l.llmOpts("implement")
	opts.WorkingDir = repoDir

	// Resume the implement session — post-approval continues the same context.
	if l.sessions != nil {
		opts.ResumeSessionID = l.sessions.Get(agentID, card.CardID, "implement")
	}

	result, err := l.execute(ctx, prompt, opts)
	l.persistPrompt(ctx, executionID, prompt)

	if result != nil && l.sessions != nil {
		l.sessions.Set(agentID, card.CardID, "implement", result.SessionID)
	}

	if err != nil {
		return nil, err
	}

	var impl implementResult
	if !decodeLLMEnvelope(result, &impl) {
		slog.Info("post-approval returned prose, treating as done",
			"output_prefix", truncate(result.Output, 200),
		)
		impl.Status = "done"
		impl.Summary = truncate(result.Output, 500)
	}
	impl.Output = result.Output

	return &impl, nil
}

type mediationResult struct {
	ActionPlan string `json:"action_plan"`
	Escalate   bool   `json:"escalate"`
}

// mediateRework analyzes review history and produces a structured action plan.
// This runs between discover and reworkImplement to synthesize context from
// prior review cycles into clear, actionable instructions.
func (l *Loop) mediateRework(ctx context.Context, card *discoverResult, reworkAttempt int) (*mediationResult, error) {
	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}

	// Fetch review history via REST and inject into the prompt so the LLM
	// doesn't need to call list_notes and mentally filter by card ID.
	reviewHistory := l.fetchReviewHistory(ctx, card.BoardID, card.CardID)

	pctx := PromptContext{
		Workspace:         l.cfg.Valaris.WorkspaceSlug,
		AgentID:           agentID,
		BoardID:           card.BoardID,
		CardID:            card.CardID,
		ReviewHistory:     reviewHistory,
		ReworkAttempt:     reworkAttempt,
		MaxReworkAttempts: l.WorkspaceConfig().MaxReworkAttempts,
		ContextSources:    card.ContextSources,
	}
	applyContextSourceAliases(&pctx)
	prompt := l.resolvePrompt("mediate_rework", pctx, func() string {
		return mediateReworkPrompt(pctx)
	})
	result, err := l.execute(ctx, prompt, l.llmOpts("mediate"))
	if err != nil {
		return nil, err
	}

	var mediation mediationResult
	if !decodeLLMEnvelope(result, &mediation) {
		// Defense-in-depth: if the mediator returns prose instead of JSON,
		// use the raw output as the action plan rather than failing entirely,
		// and recover an escalation signal the lost JSON would have carried.
		prose := mediationFromProse(result.Output)
		slog.Warn("mediation returned prose, using raw output as action plan",
			"card_id", card.CardID,
			"escalate_heuristic_fired", prose.Escalate,
			"output_prefix", truncate(result.Output, 200),
		)
		return prose, nil
	}

	return &mediation, nil
}

// escalationProseMarkers are the phrases a mediator uses when it wants a human,
// scanned case-insensitively over the whole reply. Deliberately narrow: a false
// positive blocks a card that could have been reworked, so ambiguous words like
// "stuck" or "blocked" (which appear in ordinary action plans) are excluded.
var escalationProseMarkers = []string{
	"escalate",
	"escalation",
	"cannot proceed",
	"can not proceed",
	"can't proceed",
	"human intervention",
}

// mediationFromProse salvages a mediation result from a non-JSON mediator reply.
// Without it, Escalate silently defaults to false and a mediator that asked for
// a human in prose is reworked anyway until MaxReworkAttempts trips.
func mediationFromProse(output string) *mediationResult {
	lowered := strings.ToLower(output)
	escalate := false
	for _, marker := range escalationProseMarkers {
		if containsAtWordStart(lowered, marker) {
			escalate = true
			break
		}
	}
	return &mediationResult{
		ActionPlan: truncate(output, 3000),
		Escalate:   escalate,
	}
}

// containsAtWordStart reports whether marker occurs in lowered as the start of
// a word. Every occurrence is checked, not just the first: "de-escalation" must
// not mask a genuine "escalate" later in the same reply.
func containsAtWordStart(lowered, marker string) bool {
	for offset := 0; ; {
		idx := strings.Index(lowered[offset:], marker)
		if idx == -1 {
			return false
		}
		abs := offset + idx
		if abs == 0 || !isWordChar(lowered[abs-1]) {
			return true
		}
		offset = abs + 1
	}
}

func isWordChar(b byte) bool {
	return b == '-' || b == '_' ||
		(b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || (b >= '0' && b <= '9')
}

// reworkClaim starts a new execution for a rework card via REST.
// Unlike claim(), the agent is already the hero — only execution tracking is needed.
// Role is threaded from the strategy's StageConfig (see claim() comment).
func (l *Loop) reworkClaim(ctx context.Context, card *discoverResult, role string) (string, error) {
	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}

	resolvedProvider, resolvedModel := l.resolvedProviderModel(card.AssignmentLLM)
	execID, err := l.client.LogExecutionStartWithSkills(
		ctx, agentID, l.cfg.Valaris.WorkspaceSlug, "rework_card", card.BoardID, card.CardID,
		fmt.Sprintf("Reworking card after review rejection: %s", card.CardID), role,
		card.AssignmentLLM.PromptSlug, resolvedModel, resolvedProvider, card.Skills,
	)
	if err != nil {
		return "", fmt.Errorf("log_execution_start: %w", err)
	}
	return execID, nil
}

// reworkImplement instructs the LLM to fix issues based on the mediator's action plan.
func (l *Loop) reworkImplement(ctx context.Context, card *discoverResult, executionID, repoDir, actionPlan string) (*implementResult, error) {
	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}

	directivesText := l.fetchDirectives(ctx, card.BoardID)

	pctx := PromptContext{
		Workspace:         l.cfg.Valaris.WorkspaceSlug,
		AgentID:           agentID,
		BoardID:           card.BoardID,
		CardID:            card.CardID,
		ExecutionID:       executionID,
		ActionPlan:        actionPlan,
		ProjectDirectives: directivesText,
		ContextSources:    card.ContextSources,
	}
	applyContextSourceAliases(&pctx)
	prompt := l.resolvePrompt("rework_implement", pctx, func() string {
		return reworkImplementPrompt(pctx)
	})

	opts := l.llmOpts("implement")
	opts.WorkingDir = repoDir

	// Clear prior session — rework has new context from mediator that may contradict stale session memory.
	if l.sessions != nil {
		l.sessions.Clear(agentID, card.CardID)
	}

	result, err := l.execute(ctx, prompt, opts)
	l.persistPrompt(ctx, executionID, prompt)

	if result != nil && l.sessions != nil {
		l.sessions.Set(agentID, card.CardID, "implement", result.SessionID)
	}

	if err != nil {
		return nil, err
	}

	var impl implementResult
	if !decodeLLMEnvelope(result, &impl) {
		slog.Info("rework returned prose, treating as done",
			"output_prefix", truncate(result.Output, 200),
		)
		impl.Status = "done"
		impl.Summary = truncate(result.Output, 500)
	}
	impl.Output = result.Output

	return &impl, nil
}

// fetchDirectives fetches definition coding standards and pinned board notes
// via REST. Returns formatted text for prompt injection. Non-fatal: returns
// empty string on error so the implement phase can still proceed.
func (l *Loop) fetchDirectives(ctx context.Context, boardID string) string {
	directives, err := l.client.GetProjectDirectives(ctx, l.cfg.Valaris.WorkspaceSlug, boardID)
	if err != nil {
		slog.Warn("failed to fetch project directives, proceeding without", "error", err)
		return ""
	}
	return directives.Format()
}

// Deprecated: as of CTX-5, review_history is served by the backend
// context_sources system (kind="review_history"). This runner-side
// fetcher remains as a fallback during the transition; remove after
// one full production deploy + manual confirmation that the backend
// path is producing identical strings.
//
// fetchReviewHistory fetches card-specific review notes via REST and formats
// them as a text block for prompt injection. Non-fatal: returns empty on error.
func (l *Loop) fetchReviewHistory(ctx context.Context, boardID, cardID string) string {
	notes, err := l.client.GetCardReviewNotes(ctx, l.cfg.Valaris.WorkspaceSlug, boardID, cardID)
	if err != nil {
		slog.Warn("failed to fetch review notes, mediator will operate without history", "card_id", cardID, "error", err)
		return ""
	}
	if len(notes) == 0 {
		return ""
	}

	var parts []string
	for _, n := range notes {
		parts = append(parts, fmt.Sprintf("--- %s (created %s) ---\n%s", n.Title, n.CreatedAt, n.Content))
	}
	return strings.Join(parts, "\n\n")
}

// failExecution cleans up a failed execution via direct REST calls.
// Each step is independent — failures in one don't block the others.
// REST calls retry up to 3 times with exponential backoff for transient errors.
// Uses a dedicated context so cleanup succeeds even when the parent is cancelled
// (e.g. SIGTERM during a tick).
func (l *Loop) failExecution(ctx context.Context, card *discoverResult, executionID, errorMsg string) {
	l.failExecutionTo(ctx, card, executionID, errorMsg, "backlog")
}

// failExecutionTo is the configurable variant used by strategy-driven failure
// paths. The target column_type is resolved against the board's columns; the
// function no-ops the move if the board has no column of that type.
func (l *Loop) failExecutionTo(_ context.Context, card *discoverResult, executionID, errorMsg, targetColumnType string) {
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}

	// 1. Mark execution as failed.
	if agentID != "" && executionID != "" {
		if err := retryWithBackoff(cleanupCtx, func() error {
			return l.client.FailExecution(cleanupCtx, agentID, executionID, errorMsg)
		}); err != nil {
			slog.Warn("failed to mark execution as failed", "execution_id", executionID, "error", err)
		}
	}

	// 2. M2: the in-memory breaker and the durable label must travel together.
	// Every force-block routing (generic failure threshold included) stamps the
	// `blocked` label here, BEFORE the cosmetic move — otherwise a breaker-
	// blocked card whose fail-move the move_card guard suppresses would strand
	// in an active column with no backend-visible signal (split-brain).
	if targetColumnType == blockedLabel {
		if err := retryWithBackoff(cleanupCtx, func() error {
			return l.addCardLabel(cleanupCtx, card.BoardID, card.CardID, blockedLabel)
		}); err != nil {
			slog.Warn("failed to stamp blocked label on force-block",
				"card_id", card.CardID, "error", err)
		}
	}

	// 3. Move card to the configured target column — requires resolving column ID.
	if targetColumnType != "" {
		if err := retryWithBackoff(cleanupCtx, func() error {
			columns, err := l.client.GetBoard(cleanupCtx, l.cfg.Valaris.WorkspaceSlug, card.BoardID)
			if err != nil {
				return err
			}
			for _, col := range columns {
				if col.ColumnType == targetColumnType {
					return l.client.MoveCard(cleanupCtx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID, col.ID, 1024.0)
				}
			}
			slog.Warn("failure move skipped: board has no column of target type",
				"card_id", card.CardID, "target_column_type", targetColumnType)
			return nil
		}); err != nil {
			slog.Warn("failed to move card on failure",
				"card_id", card.CardID, "target_column_type", targetColumnType, "error", err)
		}
	}

	// 4. Unassign agent from card (API expects the agent owner's user_id, not agent_id).
	if l.client.UserID != "" {
		if err := retryWithBackoff(cleanupCtx, func() error {
			return l.client.RemoveCardParticipant(cleanupCtx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID, l.client.UserID)
		}); err != nil {
			slog.Warn("failed to remove agent from card", "card_id", card.CardID, "error", err)
		}
	}

	// 5. Clear cached sessions for this card.
	if l.sessions != nil && agentID != "" {
		l.sessions.Clear(agentID, card.CardID)
	}
}

// addCardLabel appends a label to the card's labels via REST — idempotent when
// already present. The Loop-level primitive behind DataDrivenStrategy.addLabel,
// also used by failExecutionTo so force-block paths can stamp without a
// strategy in hand. Returns the first GET/PATCH error so load-bearing callers
// (the runtime-proof park) can detect a label that failed to BIND.
func (l *Loop) addCardLabel(ctx context.Context, boardID, cardID, label string) error {
	if label == "" {
		return nil
	}
	ws := l.cfg.Valaris.WorkspaceSlug
	current, err := l.client.GetCard(ctx, ws, boardID, cardID)
	if err != nil {
		slog.Warn("add_label: failed to get card", "card_id", cardID, "label", label, "error", err)
		return err
	}
	for _, existing := range current.Labels {
		if existing == label {
			return nil // already present, nothing to do
		}
	}
	updated := append(append([]string{}, current.Labels...), label)
	if err := l.client.UpdateCard(ctx, ws, boardID, cardID, map[string]any{"labels": updated}); err != nil {
		slog.Warn("add_label: failed to update labels", "card_id", cardID, "label", label, "error", err)
		return err
	}
	return nil
}

// failDocExecution handles documentator failures without moving the card.
// Unlike failExecution, it leaves the card in its current column (Done) because
// the implementation is already approved — only documentation needs retry.
func (l *Loop) failDocExecution(_ context.Context, card *discoverResult, executionID, errorMsg string) {
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}

	// 1. Mark execution as failed.
	if agentID != "" && executionID != "" {
		if err := retryWithBackoff(cleanupCtx, func() error {
			return l.client.FailExecution(cleanupCtx, agentID, executionID, errorMsg)
		}); err != nil {
			slog.Warn("failed to mark execution as failed", "execution_id", executionID, "error", err)
		}
	}

	// 2. DO NOT move card — leave in Done. Next documentator tick rediscovers it.

	// 3. Unassign agent from card so next tick can re-claim.
	if l.client.UserID != "" {
		if err := retryWithBackoff(cleanupCtx, func() error {
			return l.client.RemoveCardParticipant(cleanupCtx, l.cfg.Valaris.WorkspaceSlug, card.BoardID, card.CardID, l.client.UserID)
		}); err != nil {
			slog.Warn("failed to remove agent from card", "card_id", card.CardID, "error", err)
		}
	}

	// 4. Clear cached sessions for this card.
	if l.sessions != nil && agentID != "" {
		l.sessions.Clear(agentID, card.CardID)
	}
}

// retryWithBackoff retries fn up to 3 times with exponential backoff (1s, 2s, 4s).
// Permanent errors (4xx except 429) are not retried.
func retryWithBackoff(ctx context.Context, fn func() error) error {
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		if err = fn(); err == nil {
			return nil
		}
		if !isTransientError(err) || ctx.Err() != nil {
			return err
		}
		backoff := time.Duration(1<<uint(attempt)) * time.Second
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return err
		}
	}
	return err
}

// isTransientError returns true for errors that may resolve on retry:
// network errors, 429 (rate limit), 5xx (server errors).
// Returns false for 4xx (client errors) which are permanent.
func isTransientError(err error) bool {
	if err == nil {
		return false
	}
	var apiErr *valaris.APIError
	if !errors.As(err, &apiErr) {
		return true // network errors, timeouts → transient
	}
	if apiErr.StatusCode == 429 {
		return true // rate limited → transient
	}
	return apiErr.StatusCode >= 500 // 5xx → transient, 4xx → permanent
}

// ship moves a card to moveToColumnType after the hero stage runs, appending
// branch/PR metadata to the card description. Pass "" for moveToColumnType to
// fall back to "review" (the pre-T1.4 default, preserved for callers that do
// not have a configured stage target such as the merged-PR shortcut).
//
// shipWarnings carries non-fatal issues captured earlier in the stage (e.g.
// auto-merge arming failed because branch protection is missing). They're
// forwarded on the final execution-update PATCH so the frontend can surface
// them on the execution row — before B16, those warnings died in slog and
// never reached platform telemetry.
func (l *Loop) ship(ctx context.Context, card *discoverResult, executionID, branch, prURL, moveToColumnType string, shipWarnings []string) error {
	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}
	ws := l.cfg.Valaris.WorkspaceSlug

	// Append branch/PR info to card description (skip if already present).
	existing, err := l.client.GetCard(ctx, ws, card.BoardID, card.CardID)
	if err != nil {
		return fmt.Errorf("get_card: %w", err)
	}
	// UX-3 dual-write: the legacy "---\nBranch: ...\nPR: ..." footer stays for
	// one deploy cycle so historical readers (and the description-parsing
	// fallback in older frontends) keep working. The first-class `pr_url` and
	// `branch_name` columns are the new authoritative surface; even when the
	// footer didn't change we still push the columns so cards re-claimed onto
	// the same branch backfill the new fields on the first ship pass.
	newDesc, descChanged := upsertBranchPRBlock(existing.Description, branch, prURL)
	patch := map[string]any{
		"pr_url":      prURL,
		"branch_name": branch,
	}
	if descChanged {
		patch["description"] = newDesc
	}
	if err := l.client.UpdateCard(ctx, ws, card.BoardID, card.CardID, patch); err != nil {
		slog.Warn("ship: failed to update card pr_url/branch_name", "error", err)
	}

	targetColumn := moveToColumnType
	if targetColumn == "" {
		targetColumn = "review"
	}
	if err := l.moveCardToColumnType(ctx, ws, card.BoardID, card.CardID, targetColumn); err != nil {
		return fmt.Errorf("move_card to %s: %w", targetColumn, err)
	}

	// Mark execution as completed and forward any non-fatal warnings.
	if agentID != "" && executionID != "" {
		summary := fmt.Sprintf("Shipped: branch=%s pr=%s", branch, prURL)
		if err := l.client.LogExecutionUpdateWithShipWarnings(ctx, agentID, executionID, "completed", summary, shipWarnings); err != nil {
			slog.Warn("ship: failed to update execution", "error", err)
		}
	}

	return nil
}

// reworkShip always returns the card to the Review column by design: rework
// exists to address reviewer-requested changes, so completion means "back for
// another review pass." Unlike ship, there's no stage-configurable target —
// the rework flow is not a user-facing pipeline stage.
func (l *Loop) reworkShip(ctx context.Context, card *discoverResult, executionID, branch, prURL string) error {
	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}
	ws := l.cfg.Valaris.WorkspaceSlug

	if err := l.moveCardToColumnType(ctx, ws, card.BoardID, card.CardID, "review"); err != nil {
		return fmt.Errorf("move_card to review: %w", err)
	}

	// Remove stale helper participants from prior review cycles.
	existing, err := l.client.GetCard(ctx, ws, card.BoardID, card.CardID)
	if err != nil {
		slog.Warn("rework ship: failed to get card for participant cleanup", "error", err)
	} else {
		for _, p := range existing.Participants {
			if p.Role == "helper" {
				if err := l.client.RemoveCardParticipant(ctx, ws, card.BoardID, card.CardID, p.UserID); err != nil {
					slog.Warn("rework ship: failed to remove helper", "user_id", p.UserID, "error", err)
				}
			}
		}
	}

	// Mark execution as completed.
	if agentID != "" && executionID != "" {
		if err := l.client.LogExecutionUpdate(ctx, agentID, executionID, "completed", fmt.Sprintf("Rework shipped: branch=%s pr=%s", branch, prURL)); err != nil {
			slog.Warn("rework ship: failed to update execution", "error", err)
		}
	}

	return nil
}

// resetTickCost clears accumulated cost counters for the current card.
func (l *Loop) resetTickCost() {
	l.tickTokens = 0
	l.tickCost = 0
}

// reportCost sends accumulated cost/token data to the backend for a completed execution.
func (l *Loop) reportCost(ctx context.Context, executionID string) {
	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}
	if agentID == "" || executionID == "" || (l.tickTokens == 0 && l.tickCost == 0) {
		return
	}
	if err := l.client.UpdateExecutionCost(ctx, agentID, executionID, l.tickTokens, l.tickCost); err != nil {
		slog.Warn("failed to report execution cost", "execution_id", executionID, "error", err)
	}
}

// IsCardBlocked returns true if the card has exceeded either the transient failure
// or rework attempt threshold and is still within the cooldown window.
func (l *Loop) IsCardBlocked(cardID string) bool {
	l.cbMu.Lock()
	defer l.cbMu.Unlock()
	f, ok := l.cardFailures[cardID]
	if !ok {
		return false
	}
	wsCfg := l.WorkspaceConfig()
	withinCooldown := time.Since(f.lastFail) < time.Duration(wsCfg.CardCooldownHours*float64(time.Hour))
	if !withinCooldown {
		return false
	}
	return f.reworkCount >= wsCfg.MaxReworkAttempts || f.count >= wsCfg.MaxReworkAttempts
}

// RecordCardFailure increments the failure count for a card.
// Safe to call from any strategy.
func (l *Loop) RecordCardFailure(cardID string) {
	l.cbMu.Lock()
	defer l.cbMu.Unlock()
	f := l.cardFailures[cardID]
	f.count++
	f.lastFail = time.Now()
	l.cardFailures[cardID] = f
	wsCfg := l.WorkspaceConfig()
	slog.Warn("card failure recorded", "card_id", cardID, "count", f.count, "blocked", f.count >= wsCfg.MaxReworkAttempts)
}

// CardFailureCount returns the current transient failure count for a card.
func (l *Loop) CardFailureCount(cardID string) int {
	l.cbMu.Lock()
	defer l.cbMu.Unlock()
	return l.cardFailures[cardID].count
}

// RecordCardRework increments the rework-specific counter (review rejections only).
func (l *Loop) RecordCardRework(cardID string) {
	l.cbMu.Lock()
	defer l.cbMu.Unlock()
	f := l.cardFailures[cardID]
	f.reworkCount++
	f.lastFail = time.Now()
	l.cardFailures[cardID] = f
	slog.Info("card rework recorded", "card_id", cardID, "rework_count", f.reworkCount)
}

// CardReworkCount returns the rework-specific failure count for a card.
func (l *Loop) CardReworkCount(cardID string) int {
	l.cbMu.Lock()
	defer l.cbMu.Unlock()
	return l.cardFailures[cardID].reworkCount
}

// ClearCardFailure resets the failure count after a successful completion.
func (l *Loop) ClearCardFailure(cardID string) {
	l.cbMu.Lock()
	defer l.cbMu.Unlock()
	delete(l.cardFailures, cardID)
}

// RecordNoChangeRework increments the consecutive no-change rework counter
// and returns the new value. The caller uses the return value to decide
// whether the infinite-loop threshold has been reached. `lastFail` is NOT
// updated — no-change reworks don't represent a card-level failure; they
// only indicate the rework pipeline made zero progress and we must not
// burn budget forever.
func (l *Loop) RecordNoChangeRework(cardID string) int {
	l.cbMu.Lock()
	defer l.cbMu.Unlock()
	f := l.cardFailures[cardID]
	f.noChangeReworkCount++
	l.cardFailures[cardID] = f
	return f.noChangeReworkCount
}

// ClearNoChangeRework resets the consecutive no-change counter without
// touching the transient or rework failure counts. Called whenever a
// rework tick does make progress (commits pushed, card shipped to review),
// so a future benign skip doesn't inherit stale counter state.
func (l *Loop) ClearNoChangeRework(cardID string) {
	l.cbMu.Lock()
	defer l.cbMu.Unlock()
	f, ok := l.cardFailures[cardID]
	if !ok {
		return
	}
	f.noChangeReworkCount = 0
	l.cardFailures[cardID] = f
}

// NoChangeReworkCount returns the current consecutive no-change rework count.
func (l *Loop) NoChangeReworkCount(cardID string) int {
	l.cbMu.Lock()
	defer l.cbMu.Unlock()
	return l.cardFailures[cardID].noChangeReworkCount
}

// BlockedCardDetails returns structured info about all cards currently blocked by the circuit breaker.
func (l *Loop) BlockedCardDetails() []valaris.BlockedCardInfo {
	l.cbMu.Lock()
	defer l.cbMu.Unlock()

	wsCfg := l.WorkspaceConfig()
	cooldownDur := time.Duration(float64(time.Hour) * wsCfg.CardCooldownHours)
	threshold := wsCfg.MaxReworkAttempts

	// T0.4: start non-nil so empty reports serialize as `[]` (lets the
	// backend clear previously-blocked cards on a clean heartbeat).
	result := []valaris.BlockedCardInfo{}
	for cardID, f := range l.cardFailures {
		elapsed := time.Since(f.lastFail)
		if elapsed >= cooldownDur {
			continue // cooldown expired, not blocked
		}
		if f.count < threshold && f.reworkCount < threshold {
			continue // not enough failures to be blocked
		}
		remaining := cooldownDur - elapsed
		result = append(result, valaris.BlockedCardInfo{
			CardID:            cardID,
			FailCount:         f.count,
			ReworkCount:       f.reworkCount,
			LastFailAt:        f.lastFail.UTC().Format(time.RFC3339),
			CooldownRemaining: remaining.Round(time.Second).String(),
		})
	}
	return result
}

// BlockedCardIDList returns a comma-separated list of currently blocked card IDs.
// Returns empty string if no cards are blocked.
func (l *Loop) BlockedCardIDList() string {
	l.cbMu.Lock()
	defer l.cbMu.Unlock()
	wsCfg := l.WorkspaceConfig()
	var ids []string
	for cardID, f := range l.cardFailures {
		withinCooldown := time.Since(f.lastFail) < time.Duration(wsCfg.CardCooldownHours*float64(time.Hour))
		blocked := (f.reworkCount >= wsCfg.MaxReworkAttempts || f.count >= wsCfg.MaxReworkAttempts) && withinCooldown
		if blocked {
			ids = append(ids, cardID)
		}
	}
	return strings.Join(ids, ", ")
}

// recordFailure records a failure in the health collector and circuit breaker.
// If cardID is provided, the circuit breaker tracks consecutive failures for that card.
//
// recordFailure is the single common tail of every stage release path, so it
// also wakes the work loop: a failed stage releases the card back to its
// column, and without a wake the still-eligible card would sit unconsidered
// until the (exponentially backed-off) idle timer fired — the runner deadlocked
// into permanent idle for 30+ minutes on a no-git-changes release. We reset the
// idle backoff so the next poll is prompt and fire a coalescing TriggerPoll so
// the card is reconsidered within seconds. This can't spin forever: the circuit
// breaker (RecordCardFailure / IsCardBlocked) blocks a card after
// MaxReworkAttempts, and IsCardBlocked gates every discover loop, so a poisoned
// card is skipped and the re-poll idles out.
func (l *Loop) recordFailure(msg string, cardID ...string) {
	if l.health != nil {
		l.health.RecordFailure(msg)
	}
	id := ""
	if len(cardID) > 0 {
		id = cardID[0]
	}
	// Surface the reason on the line operators already watch. Without this the
	// sibling "card failure recorded" log shows only a count, which made the
	// implement commit-then-fail loop un-diagnosable for three sessions (was it
	// push? commit? no-changes?). The reason is the field that decides the fix.
	slog.Warn("card failure", "card_id", id, "reason", msg)
	if id != "" {
		l.RecordCardFailure(id)
	}
	l.ResetIdleBackoff()
	if l.TriggerPoll != nil {
		select {
		case l.TriggerPoll <- struct{}{}:
		default:
		}
	}
}

// WarningKind is a stable enum of typed, board-visible runner warnings.
// Backend-authoritative: the same string is reused as the kind on the
// `execution.warning` WebSocket payload and is what HealthCard /
// AgentStatusBar switch on. Add a new kind here before emitting it.
type WarningKind string

const (
	// WarningApprovalPollDeadline fires once per ApprovalMaxWait window while
	// the human approver has not responded. The card stays PARKED (FIX #3 —
	// the lapse never converts into a failure); this signal is purely so the
	// operator can see the stall. The kind string is kept stable for the
	// frontend switches that already consume it.
	WarningApprovalPollDeadline WarningKind = "approval_poll_deadline"
)

// recordApprovalPollWarning publishes a typed warning for a long-pending
// approval. Best-effort: POST failures are logged and swallowed — surfacing
// the warning must never alter the park.
func (l *Loop) recordApprovalPollWarning(ctx context.Context, card *discoverResult, executionID, approvalID string, waited time.Duration) {
	if l.client == nil || l.client.Agent == nil || executionID == "" {
		return
	}
	agentID := l.client.Agent.ID
	cardID := ""
	if card != nil {
		cardID = card.CardID
	}
	msg := fmt.Sprintf("approval %s still pending after %s; card remains parked awaiting a human decision", approvalID, waited)
	if err := l.client.PostExecutionWarning(ctx, agentID, executionID, string(WarningApprovalPollDeadline), msg, cardID); err != nil {
		slog.Warn("posting approval-poll warning failed", "error", err, "card_id", cardID, "approval_id", approvalID)
	}
}

// --- Reviewer stage methods ---

type reviewResult struct {
	Decision string `json:"decision"` // approve, request_changes
	Summary  string `json:"summary"`
	// Findings is flexString: the schema declares a string and Claude obeys, but
	// Codex may emit an array/object. flexString flattens any shape so a valid
	// verdict still decodes (else a parse miss coerces approve→request_changes).
	Findings flexString `json:"findings"`
	// FixCards is the optional follow-up work an auditor role (ui_validator)
	// emits alongside a request_changes verdict on an already-done card. The
	// create_fix_cards lifecycle kind reads this and files one board card per
	// entry. Empty/absent on a normal reviewer verdict (the field is not in the
	// required set of decisionOutputSchema, so plain approve/request_changes
	// decisions still validate).
	FixCards []FixCardSpec `json:"fix_cards,omitempty"`
	// SupersededByCardID is the delivering card the board_reconciler cites when
	// it decides `supersede` (this card's scope was already shipped there). It is
	// the LOAD-BEARING evidence for an autonomous close-to-Done: the schema only
	// describes the "must cite" rule in prose, which structured-output validators
	// (Codex) don't enforce, so decodeDecisionEnvelope coerces an un-cited
	// supersede to no_action. Empty for every non-reconcile decision.
	SupersededByCardID string `json:"superseded_by_card_id"`
	// Output is the verbatim LLM stdout. Not part of the wire envelope —
	// set by reviewCode before returning so the strategy layer can propagate
	// it onto llmStageResult.rawOutput.
	Output string `json:"-"`
}

// FixCardSpec is one follow-up card an auditor role asks the engine to create.
// The engine owns column/labels/priority (the create_fix_cards step params);
// the LLM supplies only the human content. Per the anti-pollution directive in
// the ui_validator prompt, each entry should be a substantial umbrella (a
// checklist of related fixes), not a micro-scoped one-liner per nit.
type FixCardSpec struct {
	Title       string `json:"title"`
	Description string `json:"description"`
}

// decisionOutputSchema is the JSON Schema passed to claude --json-schema for
// ANY produces_decision stage so the model is offered the StructuredOutput
// tool and emits a routable verdict rather than prose. It is the single source
// of truth for the decision envelope: wired into reviewCode() (the reviewer)
// and into runLLMStage() (every custom produces_decision role, e.g.
// ui_validator) via llm.Options.OutputSchema. The shape decodes cleanly into
// both genericLLMOutput and reviewResult (identical decision/summary/findings
// json field names).
// NOTE on fix_cards: it is logically OPTIONAL (only an auditor role like
// ui_validator emits it; a normal reviewer returns it null). But Codex's
// --output-schema enforces OpenAI structured-output rules: with
// additionalProperties:false, `required` MUST list every key in `properties`.
// So fix_cards is expressed as nullable (`["array","null"]`) AND included in
// `required` — the OpenAI-sanctioned way to say "optional". Claude's
// --json-schema accepts this identically. A normal verdict sends fix_cards:null,
// which decodes to a nil []FixCardSpec. (Field run 2026-07-25: a partial `required`
// crashed review with 400 invalid_json_schema / exit 1 / 0 tokens.)
const decisionOutputSchema = `{"type":"object","properties":{"decision":{"type":"string","enum":["approve","request_changes"]},"summary":{"type":"string","description":"One-line verdict"},"findings":{"type":"string","description":"Detailed review notes; for request_changes include file:line refs"},"fix_cards":{"type":["array","null"],"description":"For an auditor role (e.g. ui_validator) failing an already-merged card: follow-up fix cards to create. null for a normal reviewer verdict. Group related fixes into substantial umbrella cards with a checklist body — do NOT file one card per trivial nit.","items":{"type":"object","properties":{"title":{"type":"string"},"description":{"type":"string","description":"Full fix brief: the defect, the location (file:line), and the concrete fix."}},"required":["title","description"],"additionalProperties":false}}},"required":["decision","summary","findings","fix_cards"],"additionalProperties":false}`

// decodeDecisionEnvelope is the shared decode+fail-safe seam for every
// produces_decision stage. It decodes the structured envelope (structured-
// output-first, prose-JSON fallback) and applies the load-bearing guarantee:
// a parse miss OR a blank decision NEVER silently approves — it coerces to
// request_changes, putting the raw output into Findings so the card gets
// reworked rather than lost. Both reviewCode and the generic produces_decision
// path call this, so the never-silently-approve guarantee is identical for the
// reviewer and for custom roles (ui_validator cannot-drive-app → request_changes).
//
// A non-empty, non-enum decision (e.g. an operator's "escalate") is preserved
// verbatim: coercion fires ONLY on an empty decision, never on a present one.
func decodeDecisionEnvelope(result *llm.Result) reviewResult {
	var review reviewResult
	rawOutput := ""
	if result != nil {
		rawOutput = result.Output
	}
	if !decodeLLMEnvelope(result, &review) || review.Decision == "" {
		slog.Warn("decision stage carried no decision, treating as request_changes",
			"output_prefix", truncate(rawOutput, 200),
		)
		review.Decision = "request_changes"
		review.Summary = "Review output could not be parsed as a decision"
		review.Findings = flexString(truncate(rawOutput, 2000))
	}

	// Never-silently-supersede-without-evidence (the irreversible-mistake
	// firewall): the board_reconciler `supersede` decision closes a card to Done
	// autonomously, justified ONLY by a cited delivering card. The "must cite"
	// rule lives in the schema description prose, which structured-output
	// validators (Codex's --output-schema) do NOT enforce — so an un-cited
	// supersede passes the schema. Enforce it here, at the shared decode seam: an
	// empty/whitespace superseded_by_card_id coerces supersede → no_action (return
	// the card to the implementer), the safe reversible default. Scoped to
	// supersede only, so reviewer/ui_validator (approve/request_changes, no
	// citation field) are untouched. Mirrors the never-silently-approve guarantee
	// above (blank decision → request_changes).
	if review.Decision == "supersede" && strings.TrimSpace(review.SupersededByCardID) == "" {
		slog.Warn("supersede decision carried no delivering card id — coercing to no_action (refusing to close a card without verifiable evidence)",
			"output_prefix", truncate(rawOutput, 200),
		)
		review.Decision = "no_action"
		review.Summary = "supersede rejected: no delivering card cited; returned to active for re-implementation"
		review.Findings = flexString("The reconcile stage chose supersede but cited no delivering card id. " +
			"A card is never closed as already-delivered without verifiable evidence, so it is returned to the " +
			"implementer instead. Original summary: " + truncate(string(review.Findings), 1000))
	}

	review.Output = rawOutput
	return review
}

func (l *Loop) discoverReview(ctx context.Context) (*discoverResult, error) {
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

	for _, boardID := range boardIDs {
		cards, err := l.client.SearchCards(ctx, ws, boardID, valaris.SearchCardsParams{
			ColumnType: "review",
			Limit:      50,
		})
		if err != nil {
			slog.Warn("discover review: search failed", "board_id", boardID, "error", err)
			continue
		}

		for _, c := range cards {
			if l.IsCardBlocked(c.ID) {
				continue
			}

			prURL := extractPRURL(c.Description)
			if prURL == "" {
				continue
			}

			// Role-aware self-review guard: skip cards where this agent already
			// participated AS A REVIEWER. Same agent implementing + reviewing is
			// valid — different persona, different prompts, different criteria.
			alreadyReviewed := false
			for _, p := range c.Participants {
				if (p.AgentID == agentID || p.UserID == agentID || p.UserID == l.client.UserID) && p.Role == "reviewer" {
					alreadyReviewed = true
					break
				}
			}
			if alreadyReviewed {
				continue
			}

			repos, err := l.client.ListGitRepos(ctx, ws, boardID)
			if err != nil || len(repos) == 0 {
				continue
			}

			return newDiscoverResultFromRepo(c.ID, boardID, c.Title,
				prURL, extractPRBranch(c.Description), &repos[0]), nil
		}
	}

	return &discoverResult{}, nil
}

func (l *Loop) reviewCode(ctx context.Context, card *discoverResult, executionID, repoDir string) (*reviewResult, error) {
	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}

	pctx := PromptContext{
		Workspace:      l.cfg.Valaris.WorkspaceSlug,
		AgentID:        agentID,
		BoardID:        card.BoardID,
		CardID:         card.CardID,
		ExecutionID:    executionID,
		ContextSources: card.ContextSources,
	}
	applyContextSourceAliases(&pctx)
	prompt := l.resolvePrompt("review", pctx, func() string {
		return reviewCodePrompt(pctx)
	})

	opts := l.llmOpts("review")
	opts.WorkingDir = repoDir
	opts.OutputSchema = decisionOutputSchema

	result, err := l.execute(ctx, prompt, opts)
	l.persistPrompt(ctx, executionID, prompt)
	if err != nil {
		return nil, err
	}

	// Shared decode + never-silently-approve fail-safe (see decodeDecisionEnvelope).
	review := decodeDecisionEnvelope(result)
	return &review, nil
}

// completeReviewExecution marks the reviewer's execution record as completed
// with a decision-bearing summary. Move/unassign/cleanup now live in the
// generic ActionDef flag handler (see applyActionFlags).
func (l *Loop) completeReviewExecution(ctx context.Context, card *discoverResult, executionID string, review *reviewResult) error {
	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}
	if agentID == "" || executionID == "" {
		return nil
	}
	if err := l.client.LogExecutionUpdate(ctx, agentID, executionID, "completed", fmt.Sprintf("Review: %s", review.Decision)); err != nil {
		slog.Warn("post review: failed to update execution", "error", err)
	}
	return nil
}

// --- Documentator stage methods ---

type docResult struct {
	Status  string `json:"status"` // done, skipped
	Summary string `json:"summary"`
	// Output is the verbatim LLM stdout. Not part of the wire envelope — set
	// by generateDocs before returning so the strategy layer can propagate
	// it onto llmStageResult.rawOutput.
	Output string `json:"-"`
}

func (l *Loop) discoverShipped(ctx context.Context) (*discoverResult, error) {
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

	for _, boardID := range boardIDs {
		cards, err := l.client.SearchCards(ctx, ws, boardID, valaris.SearchCardsParams{
			ColumnType: "done",
			Limit:      50,
		})
		if err != nil {
			slog.Warn("discover shipped: search failed", "board_id", boardID, "error", err)
			continue
		}

		for _, c := range cards {
			if l.IsCardBlocked(c.ID) {
				continue
			}
			// Skip cards already documented.
			documented := false
			for _, label := range c.Labels {
				if label == "documented" {
					documented = true
					break
				}
			}
			if documented {
				continue
			}

			repos, err := l.client.ListGitRepos(ctx, ws, boardID)
			if err != nil || len(repos) == 0 {
				continue
			}

			return newDiscoverResultFromRepo(c.ID, boardID, c.Title,
				extractPRURL(c.Description), extractPRBranch(c.Description), &repos[0]), nil
		}
	}

	return &discoverResult{}, nil
}

func (l *Loop) generateDocs(ctx context.Context, card *discoverResult, executionID, repoDir string) (*docResult, error) {
	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}

	pctx := PromptContext{
		Workspace:      l.cfg.Valaris.WorkspaceSlug,
		AgentID:        agentID,
		BoardID:        card.BoardID,
		CardID:         card.CardID,
		ExecutionID:    executionID,
		ContextSources: card.ContextSources,
	}
	applyContextSourceAliases(&pctx)
	prompt := l.resolvePrompt("document", pctx, func() string {
		return generateDocsPrompt(pctx)
	})

	opts := l.llmOpts("document")
	opts.WorkingDir = repoDir

	result, err := l.execute(ctx, prompt, opts)
	l.persistPrompt(ctx, executionID, prompt)
	if err != nil {
		return nil, err
	}

	var doc docResult
	if !decodeLLMEnvelope(result, &doc) {
		return nil, fmt.Errorf("parsing generate docs response: no valid JSON envelope (output: %.200s)", result.Output)
	}
	doc.Output = result.Output

	return &doc, nil
}

func (l *Loop) tagDocumented(ctx context.Context, card *discoverResult, executionID string) {
	agentID := ""
	if l.client.Agent != nil {
		agentID = l.client.Agent.ID
	}
	ws := l.cfg.Valaris.WorkspaceSlug

	// Add "documented" label to existing labels.
	existing, err := l.client.GetCard(ctx, ws, card.BoardID, card.CardID)
	if err != nil {
		slog.Warn("tag documented: failed to get card", "card_id", card.CardID, "error", err)
		return
	}

	labels := existing.Labels
	for _, lbl := range labels {
		if lbl == "documented" {
			goto complete // already tagged
		}
	}
	labels = append(labels, "documented")
	if err := l.client.UpdateCard(ctx, ws, card.BoardID, card.CardID, map[string]any{"labels": labels}); err != nil {
		slog.Warn("tag documented: failed to update card labels", "card_id", card.CardID, "error", err)
	}

complete:
	if agentID != "" && executionID != "" {
		if err := l.client.LogExecutionUpdate(ctx, agentID, executionID, "completed", "Card documented"); err != nil {
			slog.Warn("tag documented: failed to update execution", "error", err)
		}
	}
}

// moveCardToColumnType finds the column with the given type and moves the card to it.
func (l *Loop) moveCardToColumnType(ctx context.Context, ws, boardID, cardID, columnType string) error {
	columns, err := l.client.GetBoard(ctx, ws, boardID)
	if err != nil {
		return fmt.Errorf("get_board: %w", err)
	}
	for _, col := range columns {
		if col.ColumnType == columnType {
			return l.client.MoveCard(ctx, ws, boardID, cardID, col.ID, 1024.0)
		}
	}
	return fmt.Errorf("no column with type %q found", columnType)
}

// extractPRURL extracts a GitHub PR URL from card description text.
func extractPRURL(desc string) string {
	for _, line := range strings.Split(desc, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "PR: ") {
			return strings.TrimPrefix(line, "PR: ")
		}
		// Also check for raw GitHub PR URLs.
		if strings.Contains(line, "github.com") && strings.Contains(line, "/pull/") {
			idx := strings.Index(line, "https://github.com")
			if idx >= 0 {
				url := line[idx:]
				if spaceIdx := strings.IndexByte(url, ' '); spaceIdx > 0 {
					url = url[:spaceIdx]
				}
				return url
			}
		}
	}
	return ""
}

// upsertBranchPRBlock removes every existing "---\nBranch: <branch>\nPR: <url>"
// block for the target branch and appends exactly one fresh block at the end.
// Historical card descriptions can carry multiple stale blocks for the same
// branch (older runner versions appended without deduping); leaving even one
// stale block in place makes extractPRURL return the wrong URL and the next
// merge attempt dispatches against a closed PR. Blocks for other branches are
// preserved in their original order so history across branches stays intact.
// Returns the new description and whether it changed.
func upsertBranchPRBlock(desc, branch, prURL string) (string, bool) {
	block := fmt.Sprintf("---\nBranch: %s\nPR: %s", branch, prURL)
	targetBranchLine := "Branch: " + branch
	targetPRLine := "PR: " + prURL
	lines := strings.Split(desc, "\n")

	// Walk the description and drop every "---\nBranch: <target>\nPR: ..."
	// block. Count how many matched the target PR URL exactly so we can
	// detect the no-op case (single pre-existing block already up to date).
	out := make([]string, 0, len(lines))
	totalBlocks := 0
	matchingBlocks := 0
	i := 0
	for i < len(lines) {
		if strings.TrimSpace(lines[i]) == "---" &&
			i+1 < len(lines) && strings.TrimSpace(lines[i+1]) == targetBranchLine &&
			i+2 < len(lines) && strings.HasPrefix(strings.TrimSpace(lines[i+2]), "PR: ") {
			totalBlocks++
			if strings.TrimSpace(lines[i+2]) == targetPRLine {
				matchingBlocks++
			}
			// Skip the three block lines plus a trailing blank separator so
			// we don't accumulate blank lines across successive upserts.
			i += 3
			if i < len(lines) && strings.TrimSpace(lines[i]) == "" {
				i++
			}
			continue
		}
		out = append(out, lines[i])
		i++
	}

	// No-op: exactly one existing block for this branch and its PR matches.
	if totalBlocks == 1 && matchingBlocks == 1 {
		return desc, false
	}

	for len(out) > 0 && strings.TrimSpace(out[len(out)-1]) == "" {
		out = out[:len(out)-1]
	}
	trimmed := strings.Join(out, "\n")
	if trimmed == "" {
		return block, true
	}
	return trimmed + "\n\n" + block, true
}

// extractPRBranch extracts the branch name from card description text.
func extractPRBranch(desc string) string {
	for _, line := range strings.Split(desc, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "Branch: ") {
			return strings.TrimPrefix(line, "Branch: ")
		}
	}
	return ""
}

// priorityRank returns a numeric rank for priority sorting (higher = more urgent).
func priorityRank(p string) int {
	switch p {
	case "urgent":
		return 4
	case "high":
		return 3
	case "medium":
		return 2
	case "low":
		return 1
	default:
		return 0
	}
}

// sanitizeBranch creates a git-safe branch name from card ID and title.
func sanitizeBranch(cardID, title string) string {
	// Take first 40 chars of title, lowercase, replace non-alphanumeric with hyphens.
	safe := make([]byte, 0, 50)
	for i, c := range []byte(title) {
		if i >= 40 {
			break
		}
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' {
			safe = append(safe, c)
		} else if c >= 'A' && c <= 'Z' {
			safe = append(safe, c+32) // lowercase
		} else {
			if len(safe) > 0 && safe[len(safe)-1] != '-' {
				safe = append(safe, '-')
			}
		}
	}
	// Trim trailing hyphen.
	for len(safe) > 0 && safe[len(safe)-1] == '-' {
		safe = safe[:len(safe)-1]
	}

	if len(safe) == 0 {
		return cardID
	}
	return string(safe)
}

// newCmd creates an exec.Command with the hardened git environment — extracted
// for test access, where it builds git fixtures. Scrubbed so an ambient GIT_DIR
// cannot redirect a fixture into some other repository and leave a test
// measuring the wrong tree.
func newCmd(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.Env = git.SubprocessEnv("")
	return cmd
}
