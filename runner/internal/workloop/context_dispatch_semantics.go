// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// A call is shaped by its stage's cached configuration: the decoder, the
// default schema, the directive fetch and the approval gate. The refreshed
// snapshot names the server's current flags for the call; when they disagree
// with what the call captured, the call is refused before preparation, the
// tick releases the card for a fresh assignment, and once that release is
// recorded the role's stage is refreshed. A role whose release or refresh is
// outstanding is paused: it takes no new work until both are recorded.

// ErrDispatchSemanticsChanged is a required call refused because its stage
// configuration changed since its card was assigned.
var ErrDispatchSemanticsChanged = errors.New("context dispatch: the stage configuration changed since this card was assigned")

// callSemantics are the effective stage flags a call consumes; a nil field is
// a flag the call does not consume.
type callSemantics struct {
	stage            string
	kind             *string
	approvalEnabled  *bool
	injectDirectives *bool
	minimalPrompt    *bool
}

// captureSemantics is what a call made under llm consumes, as executeLLM
// routes it: every call its effective kind, implement its approval gate, a
// custom stage its directive fetch.
func captureSemantics(llm valaris.LLMDef) *callSemantics {
	kind := llm.EffectivePostProcessKind()
	semantics := &callSemantics{stage: llm.Stage, kind: &kind}
	switch llm.Stage {
	case "implement":
		approval := llm.ApprovalEnabled
		semantics.approvalEnabled = &approval
	case "review", "document":
	default:
		inject, minimal := llm.InjectDirectives, llm.UseMinimalPromptWhenUnauthored
		semantics.injectDirectives, semantics.minimalPrompt = &inject, &minimal
	}
	return semantics
}

type callSemanticsKey struct{}

// withCallSemantics names what the required call under ctx consumes; nil
// names nothing, for a call whose slot fixes its decoder and inputs.
func withCallSemantics(ctx context.Context, semantics *callSemantics) context.Context {
	return context.WithValue(ctx, callSemanticsKey{}, semantics)
}

func callSemanticsOf(ctx context.Context) *callSemantics {
	semantics, _ := ctx.Value(callSemanticsKey{}).(*callSemantics)
	return semantics
}

// semanticsChange is a refused call's first differing flag, and the server's
// current effective flags for the call.
type semanticsChange struct {
	flag              string
	captured, current any
	refreshed         callSemantics
	step              *string
}

func (c *semanticsChange) Error() string {
	return fmt.Sprintf("%v: %s was %v, now %v", ErrDispatchSemanticsChanged, c.flag, c.captured, c.current)
}

func (c *semanticsChange) Unwrap() error { return ErrDispatchSemanticsChanged }

// agrees reports whether stage, as refreshed, captures what the server now
// names for the call.
func (c *semanticsChange) agrees(stage valaris.StageConfig) bool {
	llm := stage.LLM
	if c.step != nil {
		step := lifecycleStep(stage.Lifecycle, *c.step)
		if step == nil {
			return false
		}
		llm = stepLLM(llm, step)
	}
	return captureSemantics(llm).equal(&c.refreshed)
}

func lifecycleStep(steps []valaris.LifecycleStep, name string) *valaris.LifecycleStep {
	for i := range steps {
		if steps[i].Name == name {
			return &steps[i]
		}
	}
	return nil
}

func sameFlag[T comparable](a, b *T) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

func (s *callSemantics) equal(other *callSemantics) bool {
	return s.stage == other.stage && sameFlag(s.kind, other.kind) && sameFlag(s.approvalEnabled, other.approvalEnabled) &&
		sameFlag(s.injectDirectives, other.injectDirectives) && sameFlag(s.minimalPrompt, other.minimalPrompt)
}

// check compares the call's captured semantics with the snapshot's flags.
// Consumed flags have exact wire types: post_process_kind a string ("" is
// unset, the stage's default), approval_enabled a bool, the directive flags
// a bool or null (unset, the runner's default false). A missing key or any
// other type is malformed and refused, but is not a configuration change.
func (s *callSemantics) check(raw json.RawMessage, invocation valaris.DispatchInvocation) error {
	var flags map[string]json.RawMessage
	if err := json.Unmarshal(raw, &flags); err != nil || flags == nil {
		return errors.New("context dispatch: the snapshot names no dispatch flags")
	}
	current := callSemantics{stage: s.stage}
	if s.kind != nil {
		value, ok := flags["post_process_kind"]
		var kind string
		if !ok || !isJSONString(value) || json.Unmarshal(value, &kind) != nil {
			return malformedFlag("post_process_kind")
		}
		effective := valaris.LLMDef{Stage: s.stage, PostProcessKind: kind}.EffectivePostProcessKind()
		current.kind = &effective
	}
	if s.approvalEnabled != nil {
		value, ok := flags["approval_enabled"]
		var enabled bool
		if !ok || !isJSONBool(value) || json.Unmarshal(value, &enabled) != nil {
			return malformedFlag("approval_enabled")
		}
		current.approvalEnabled = &enabled
	}
	for _, nullable := range []struct {
		name     string
		consumed bool
		into     **bool
	}{
		{"inject_directives", s.injectDirectives != nil, &current.injectDirectives},
		{"use_minimal_prompt_when_unauthored", s.minimalPrompt != nil, &current.minimalPrompt},
	} {
		if !nullable.consumed {
			continue
		}
		value, ok := flags[nullable.name]
		enabled := false
		switch {
		case !ok:
			return malformedFlag(nullable.name)
		case string(bytes.TrimSpace(value)) == "null":
		case isJSONBool(value):
			_ = json.Unmarshal(value, &enabled)
		default:
			return malformedFlag(nullable.name)
		}
		*nullable.into = &enabled
	}
	change := &semanticsChange{refreshed: current, step: invocation.StepName}
	switch {
	case !sameFlag(s.kind, current.kind):
		change.flag, change.captured, change.current = "post_process_kind", *s.kind, *current.kind
	case !sameFlag(s.approvalEnabled, current.approvalEnabled):
		change.flag, change.captured, change.current = "approval_enabled", *s.approvalEnabled, *current.approvalEnabled
	case !sameFlag(s.injectDirectives, current.injectDirectives):
		change.flag, change.captured, change.current = "inject_directives", *s.injectDirectives, *current.injectDirectives
	case !sameFlag(s.minimalPrompt, current.minimalPrompt):
		change.flag, change.captured, change.current = "use_minimal_prompt_when_unauthored", *s.minimalPrompt, *current.minimalPrompt
	default:
		return nil
	}
	return change
}

func malformedFlag(name string) error {
	return fmt.Errorf("context dispatch: dispatch flag %s is missing or malformed", name)
}

func isJSONString(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && trimmed[0] == '"'
}

func isJSONBool(raw json.RawMessage) bool {
	trimmed := string(bytes.TrimSpace(raw))
	return trimmed == "true" || trimmed == "false"
}

// pendingRelease is a card's owned release after its call was refused: the
// bound execution ended aborted, then the participant its claim bound
// removed, in that order, always for this original identity. A step once
// recorded is never repeated.
type pendingRelease struct {
	card        *discoverResult
	executionID string
	participant string
	summary     string
	aborted     bool
	unassigned  bool
	err         error
}

// rolePause is a role taking no new work: its release is not recorded yet
// (release set), or its refresh after a recorded release failed. A role is
// released one card at a time: it is paused within the tick that leaves its
// release unrecorded, so it never holds two.
type rolePause struct {
	release     *pendingRelease
	reason      string
	change      *semanticsChange
	lastAttempt time.Time
}

// rolePauses holds the paused roles and the released roles a refresh
// excluded from this runner. Both are only written on the loop goroutine.
type rolePauses struct {
	mu    sync.Mutex
	roles map[string]*rolePause
	// excludedRoles maps a released role its refresh found out of this
	// runner's scope, or out of the pipeline, to why. It is never cleared:
	// only a restart re-admits the role.
	excludedRoles map[string]string
}

func (p *rolePauses) set(role string, pause *rolePause) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.roles == nil {
		p.roles = map[string]*rolePause{}
	}
	p.roles[role] = pause
}

func (p *rolePauses) clear(role string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.roles, role)
}

func (p *rolePauses) paused(role string) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	_, ok := p.roles[role]
	return ok
}

func (p *rolePauses) exclude(role, reason string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.excludedRoles == nil {
		p.excludedRoles = map[string]string{}
	}
	p.excludedRoles[role] = reason
}

func (p *rolePauses) excluded(role string) (string, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	reason, ok := p.excludedRoles[role]
	return reason, ok
}

// disabled reports whether role takes no work: paused or excluded.
func (p *rolePauses) disabled(role string) bool {
	_, excluded := p.excluded(role)
	return excluded || p.paused(role)
}

// snapshot is the paused roles in name order, with copies of their pauses,
// and the excluded roles' reasons.
func (p *rolePauses) snapshot() ([]string, []rolePause, map[string]string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	roles := make([]string, 0, len(p.roles))
	for role := range p.roles {
		roles = append(roles, role)
	}
	sort.Strings(roles)
	pauses := make([]rolePause, len(roles))
	for i, role := range roles {
		pauses[i] = *p.roles[role]
	}
	excluded := make(map[string]string, len(p.excludedRoles))
	for role, reason := range p.excludedRoles {
		excluded[role] = reason
	}
	return roles, pauses, excluded
}

// releaseForSemanticsChange releases card, whose call was refused for a
// changed configuration, through the participant the claim bound, and once
// that is recorded refreshes the role. An unrecorded release is not claimed:
// the role is paused until a poll cycle records it.
func (s *DataDrivenStrategy) releaseForSemanticsChange(ctx context.Context, l *Loop, card *discoverResult, executionID string, cause error) error {
	var change *semanticsChange
	errors.As(cause, &change)
	// Hero claims bind l.client.UserID; helper claims bind the agent ID.
	participant := l.client.UserID
	if s.config.Claim.ParticipantRole == "helper" {
		participant = agentIDOf(l)
	}
	role := s.config.Role
	// The summary is persisted before the release completes, so it says what
	// is happening, never that the release is done.
	release := &pendingRelease{
		card: card, executionID: executionID, participant: participant,
		summary: cause.Error() + "; releasing the card for a fresh assignment under the current configuration",
	}
	l.lastTickHadWork = true
	// The cleanup pair outlives a tick canceled under it, within its own bound.
	if !l.advanceRelease(context.WithoutCancel(ctx), release) {
		l.pauseRole(role, &rolePause{release: release, reason: release.err.Error(), change: change})
		return fmt.Errorf("%w; release not recorded: %v", cause, release.err)
	}
	slog.Info("card released: its stage configuration changed since assignment", "role", role, "card_id", card.CardID, "execution_id", executionID)
	l.refreshRoleAfterSemanticsChange(ctx, role, change)
	return nil
}

// releaseTimeout bounds one attempt to record a release (both steps, with
// retryWithBackoff's three tries each).
const releaseTimeout = 30 * time.Second

// advanceRelease records the release's outstanding steps, abort before
// unassign, and reports whether both are recorded.
func (l *Loop) advanceRelease(parent context.Context, r *pendingRelease) bool {
	ctx, cancel := context.WithTimeout(parent, releaseTimeout)
	defer cancel()
	agentID := agentIDOf(l)
	if !r.aborted {
		if agentID != "" && r.executionID != "" {
			if err := retryWithBackoff(ctx, func() error {
				return l.client.LogExecutionUpdate(ctx, agentID, r.executionID, "aborted", r.summary)
			}); err != nil {
				r.err = fmt.Errorf("ending execution %s aborted: %w", r.executionID, err)
				return false
			}
		}
		r.aborted = true
	}
	if !r.unassigned {
		if r.participant != "" {
			if err := retryWithBackoff(ctx, func() error {
				return l.client.RemoveCardParticipant(ctx, l.cfg.Valaris.WorkspaceSlug, r.card.BoardID, r.card.CardID, r.participant)
			}); err != nil {
				r.err = fmt.Errorf("removing participant %s from card %s: %w", r.participant, r.card.CardID, err)
				return false
			}
		}
		r.unassigned = true
	}
	r.err = nil
	return true
}

// refreshRoleAfterSemanticsChange refreshes role's stage once its release is
// recorded. A failed refresh pauses the role; it is never the tick's error.
func (l *Loop) refreshRoleAfterSemanticsChange(ctx context.Context, role string, change *semanticsChange) {
	if err := l.refreshRole(ctx, role, change); err != nil {
		slog.Warn("released role paused: its configuration could not be refreshed", "role", role, "error", err)
		l.pauseRole(role, &rolePause{reason: err.Error(), change: change, lastAttempt: time.Now()})
	}
}

// restartToReadmit is the consequence every exclusion reports.
const restartToReadmit = "restart the runner to re-admit it"

// refreshRole fetches the agent's current config and replaces role's
// strategy with its current stage. A role the fresh config leaves out of the
// pipeline, or out of this runner's scope, is excluded until a restart; a
// stage that still disagrees with the call the server names is an error, as
// is a failed fetch. Only role is judged: every other role keeps its scope.
func (l *Loop) refreshRole(ctx context.Context, role string, change *semanticsChange) error {
	config, err := l.client.GetPlatformConfig(ctx, l.cfg.Valaris.WorkspaceSlug)
	if err != nil {
		return fmt.Errorf("fetching the agent's config: %w", err)
	}
	if config.WorkspaceConfig.PipelineConfig == nil {
		return errors.New("the agent's config has no pipeline")
	}
	l.platformConfigMu.Lock()
	l.platformConfig = config.WorkspaceConfig
	l.platformConfigMu.Unlock()
	l.refreshThrottleMu.Lock()
	l.lastPlatformCfgRefresh = time.Now()
	l.refreshThrottleMu.Unlock()

	stage := StageForRole(*config.WorkspaceConfig.PipelineConfig, role)
	exclusion := ""
	switch {
	case stage == nil:
		exclusion = "its stage left the pipeline"
	case !l.roleInScope(role) || !teamRolesAdmit(config.TeamRoles, role):
		exclusion = "it is out of this runner's current team scope"
	}
	if exclusion != "" {
		slog.Warn("released role disabled on this runner: "+exclusion+"; "+restartToReadmit, "role", role)
		l.pauses.exclude(role, exclusion)
		l.pauses.clear(role)
		l.disableRole(role)
		return nil
	}
	if change != nil && !change.agrees(*stage) {
		return fmt.Errorf("its refreshed stage still disagrees with the call the server names (%s now %v)", change.flag, change.current)
	}
	if l.sensors == nil {
		return errors.New("no sensor registry to build its strategy")
	}
	l.pauses.clear(role)
	l.installRole(ctx, role, NewStrategyFromConfig(*stage, l.sensors))
	slog.Info("released role refreshed to its current stage configuration", "role", role)
	return nil
}

// teamRolesAdmit reads a fresh team_roles as New does: an empty list is
// role-agnostic, a non-empty one admits only the roles it names.
func teamRolesAdmit(teamRoles []string, role string) bool {
	if len(teamRoles) == 0 {
		return true
	}
	for _, name := range teamRoles {
		if name == role {
			return true
		}
	}
	return false
}

func (l *Loop) roleInScope(role string) bool {
	if l.scopedTeamRoles == nil {
		return true
	}
	_, ok := l.scopedTeamRoles[role]
	return ok
}

// pauseRole disables role until its pause clears.
func (l *Loop) pauseRole(role string, pause *rolePause) {
	l.pauses.set(role, pause)
	l.disableRole(role)
}

// disableRole drops role's strategy from the live references: the owned
// set, the scheduler, and the single-role strategy. Parked approvals keep
// their park-time strategy; resumeDecidedApprovals never resumes work with
// it for a paused or excluded role. Other roles and strategies already
// running are untouched.
func (l *Loop) disableRole(role string) {
	delete(l.ownedStrategies, role)
	if l.scheduler != nil {
		strategies := l.scheduler.Strategies()
		delete(strategies, role)
		order := make([]string, 0, len(strategies))
		for _, name := range l.scheduler.PriorityOrder() {
			if name != role {
				order = append(order, name)
			}
		}
		l.scheduler.Reconfigure(strategies, order)
	} else if l.strategy != nil && l.strategy.Name() == role {
		l.strategy = nil
	}
	l.reportConfigErrors()
}

// installRole makes strategy role's live strategy: owned, the single-role
// strategy (the authority pass only ever removes that one), and scheduled
// through the authority pass.
func (l *Loop) installRole(ctx context.Context, role string, strategy Strategy) {
	l.ownedStrategies[role] = strategy
	if l.scheduler == nil && (l.strategy == nil || l.strategy.Name() == role) {
		l.strategy = strategy
	}
	l.applyPlatformAuthority(ctx)
}

func (l *Loop) reportConfigErrors() {
	if l.health != nil {
		l.health.SetConfigErrors(l.validateConfig())
	}
}

// resumePausedRoles advances every paused role once per poll cycle: an
// unrecorded release retries its outstanding steps and, once recorded, the
// role is refreshed at once; a failed refresh retries within refreshTTL.
// Nothing is retried once the loop is draining or stopping.
func (l *Loop) resumePausedRoles(ctx context.Context) {
	roles, pauses, _ := l.pauses.snapshot()
	for i, role := range roles {
		if l.draining() || ctx.Err() != nil {
			return
		}
		pause := pauses[i]
		if pause.release != nil {
			if !l.advanceRelease(ctx, pause.release) {
				l.pauses.set(role, &rolePause{release: pause.release, reason: pause.release.err.Error(), change: pause.change})
				l.reportConfigErrors()
				continue
			}
			slog.Info("paused release recorded", "role", role, "card_id", pause.release.card.CardID)
			l.refreshRoleAfterSemanticsChange(ctx, role, pause.change)
			continue
		}
		if time.Since(pause.lastAttempt) < l.refreshTTL {
			continue
		}
		l.refreshRoleAfterSemanticsChange(ctx, role, pause.change)
	}
}

// pausedRoleErrors reports every paused or excluded role as a config error.
func (l *Loop) pausedRoleErrors() []valaris.ConfigError {
	roles, pauses, excluded := l.pauses.snapshot()
	errs := make([]valaris.ConfigError, 0, len(roles)+len(excluded))
	for i, role := range roles {
		pause := pauses[i]
		message := fmt.Sprintf("Role %s is paused: its stage configuration changed and could not be refreshed: %s", role, pause.reason)
		if r := pause.release; r != nil {
			message = fmt.Sprintf("Role %s is paused: its stage configuration changed and the release of card %s (execution %s) is not recorded yet: %s", role, r.card.CardID, r.executionID, pause.reason)
		}
		errs = append(errs, valaris.ConfigError{Code: ConfigErrRolePaused, Message: message})
	}
	excludedRoles := make([]string, 0, len(excluded))
	for role := range excluded {
		excludedRoles = append(excludedRoles, role)
	}
	sort.Strings(excludedRoles)
	for _, role := range excludedRoles {
		errs = append(errs, valaris.ConfigError{
			Code:    ConfigErrRoleExcluded,
			Message: fmt.Sprintf("Role %s is disabled on this runner: %s; %s", role, excluded[role], restartToReadmit),
		})
	}
	return errs
}
