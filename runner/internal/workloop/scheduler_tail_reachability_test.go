// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/harness"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// recordingStrategy records every Tick invocation by role name and always
// reports no-work (it never sets l.lastTickHadWork=true). This drives the
// fast-forward walk in scheduledTick to its full length, so a test can assert
// which roles the scheduler actually reaches in one poll cycle.
type recordingStrategy struct {
	name   string
	ticked *map[string]int
}

func (s *recordingStrategy) Name() string           { return s.name }
func (s *recordingStrategy) AllowedTools() []string { return nil }
func (s *recordingStrategy) Tick(_ context.Context, _ *Loop) error {
	(*s.ticked)[s.name]++
	return nil
}

// newWalkLoop builds a minimal Loop wired only with what scheduledTick touches
// (scheduler, cfg.Git.Tokens, git.RoleToken) plus a recordingStrategy per role
// in priorityOrder. ticked maps role -> Tick-invocation count, shared across
// strategies so the walk's reach is observable.
func newWalkLoop(t *testing.T, priorityOrder []string, ticked *map[string]int) *Loop {
	t.Helper()
	strategies := make(map[string]Strategy, len(priorityOrder))
	for _, role := range priorityOrder {
		strategies[role] = &recordingStrategy{name: role, ticked: ticked}
	}
	return &Loop{
		cfg:       &config.Config{Git: config.GitConfig{Tokens: map[string]string{}}},
		git:       &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin"},
		scheduler: NewScheduler(strategies, priorityOrder, "priority"),
	}
}

// TestScheduledTick_TailRoleReachedRegardlessOfEntryCooldown locks in the
// general scheduler-reachability invariant the runner depends on: with N
// strategies registered in priority_order where every tick reports no-work,
// ONE scheduledTick walk must reach EVERY role — including the priority-order
// tail (the ui_validator analogue) — no matter how many leading roles entered
// the cycle already in idle cooldown.
//
// The non-obvious interaction this guards: scheduledTick bounds its walk at
// maxAttempts = scheduler.Len() (== N), and each no-work tick puts its role
// into cooldown via RecordTick. nextPriority returns the lowest-index role NOT
// cooling, so the walk advances monotonically toward the tail. resetAndPickFirst
// (which rewinds to index 0 and could otherwise burn attempts re-hitting early
// roles before the tail) only fires once ALL N roles are cooling — which can
// only happen AFTER the tail has been visited and cooled. Hence the tail is
// always reached within N attempts for any entry cooldown set. If a future
// change to Next()/maxAttempts breaks that, this test catches it.
func TestScheduledTick_TailRoleReachedRegardlessOfEntryCooldown(t *testing.T) {
	order := []string{"reviewer", "rework_mediator", "implementer", "planner", "documentator", "ui_validator"}
	tail := order[len(order)-1]

	for preCooled := 0; preCooled <= len(order); preCooled++ {
		t.Run("preCooled="+strings.Join(order[:preCooled], ","), func(t *testing.T) {
			ticked := map[string]int{}
			l := newWalkLoop(t, order, &ticked)

			// Pre-cool the first `preCooled` roles to simulate an arbitrary entry
			// cooldown state (e.g. earlier poll cycles in the same 4-minute window).
			for _, role := range order[:preCooled] {
				l.scheduler.RecordTick(role, false)
			}

			if err := l.scheduledTick(context.Background()); err != nil {
				t.Fatalf("scheduledTick: %v", err)
			}

			if ticked[tail] == 0 {
				t.Errorf("tail role %q never reached in one walk (preCooled=%d); ticked=%v",
					tail, preCooled, ticked)
			}
			// The whole point of the invariant: ALL roles reachable in one cycle.
			for _, role := range order {
				if ticked[role] == 0 {
					t.Errorf("role %q never reached in one walk (preCooled=%d); ticked=%v",
						role, preCooled, ticked)
				}
			}
		})
	}
}

// TestScheduledTick_FrozenSchedulerStrandsTailRole reproduces the ORIGINAL
// production bug at the walk level: when the scheduler holds fewer strategies
// than priority_order (the frozen-strategy-set: ownedStrategies pinned at New()
// without a post-launch role), scheduledTick's maxAttempts = Len() under-counts
// and the priority-order tail is NEVER ticked — exactly the observed evidence
// (4 attempts, first four roles, zero warnings). This documents WHY the tail
// was stranded; the fix is applyPlatformAuthority building the missing strategy
// (see TestApplyPlatformAuthority_BuildsRoleAddedAfterLaunch), after which a
// full Len()==N scheduler makes the walk reach the tail (test above).
func TestScheduledTick_FrozenSchedulerStrandsTailRole(t *testing.T) {
	fullOrder := []string{"reviewer", "rework_mediator", "implementer", "planner", "documentator", "ui_validator"}
	tail := fullOrder[len(fullOrder)-1]

	ticked := map[string]int{}
	// Frozen scheduler: holds only the first four roles (Len()==4), even though
	// the operator's priority_order names six. documentator + ui_validator are
	// absent — never built into the scheduler.
	l := newWalkLoop(t, fullOrder[:4], &ticked)

	if err := l.scheduledTick(context.Background()); err != nil {
		t.Fatalf("scheduledTick: %v", err)
	}

	if ticked[tail] != 0 {
		t.Fatalf("precondition broken: tail %q should be unreachable in a frozen Len()==4 scheduler; ticked=%v",
			tail, ticked)
	}
	if l.scheduler.Len() != 4 {
		t.Fatalf("expected frozen Len()==4, got %d", l.scheduler.Len())
	}
}

// TestReconcileOwnedStrategies_WarnsWhenSensorsNil closes the one silent path
// by which the frozen-strategy-set bug can recur undetected: reconcileOwnedStrategies
// early-returns when l.sensors == nil, which would re-strand a post-launch tail
// role (e.g. ui_validator) with NO log at all — the same zero-warning signature
// as the original incident. The fix emits a WARN naming the nil-sensors reason
// so the otherwise-invisible re-stranding is observable.
//
// Fails first: no such warning exists today (the early return is silent).
func TestReconcileOwnedStrategies_WarnsWhenSensorsNil(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	reviewerStage := valaris.StageConfig{
		Role:  "reviewer",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		LLM:   valaris.LLMDef{Enabled: true, Stage: "review"},
	}
	registry := harness.DefaultRegistry()
	owned := map[string]Strategy{"reviewer": NewStrategyFromConfig(reviewerStage, registry)}

	// Live pipeline carries a post-launch ui_validator the runner could not have
	// built at New(); with sensors==nil the reconcile cannot build it.
	livePipeline := &valaris.PipelineConfig{
		Version: 20,
		Stages:  []valaris.StageConfig{reviewerStage, uiValidatorStage()},
		Scheduling: valaris.SchedulingDef{
			PriorityOrder: []string{"reviewer", "ui_validator"},
		},
	}

	l := &Loop{
		sensors:               nil, // the silent early-return condition under test
		ownedStrategies:       owned,
		platformPriorityOrder: []string{"reviewer"},
		promptCache:           make(map[string]string),
		cardFailures:          make(map[string]cardFailure),
	}
	l.platformConfig = valaris.WorkspaceConfigData{PipelineConfig: livePipeline}
	l.scheduler = NewScheduler(
		map[string]Strategy{"reviewer": owned["reviewer"]},
		[]string{"reviewer"},
		"priority",
	)
	l.promptCache["reviewer:review"] = "review the thing"
	l.promptCache["ui_validator:validate_ui"] = "validate the ui"

	l.applyPlatformAuthority(context.Background())

	// Current (correct) behavior: without sensors the role can't be built.
	if _, present := l.scheduler.Strategies()["ui_validator"]; present {
		t.Fatal("ui_validator cannot be built without a sensor registry")
	}
	// New observability: the re-stranding must no longer be silent.
	out := buf.String()
	if !strings.Contains(out, "level=WARN") || !strings.Contains(out, "sensor registry is nil") {
		t.Errorf("expected a WARN naming the nil-sensors reason so the silent re-stranding is detectable; logs:\n%s", out)
	}
	if !strings.Contains(out, "ui_validator") {
		t.Errorf("expected the stranded role name in the WARN so it's actionable; logs:\n%s", out)
	}
}
