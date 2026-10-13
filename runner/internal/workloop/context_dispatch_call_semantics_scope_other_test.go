// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"testing"
)

// The fresh team_roles a released role's refresh reads scope that role only:
// every other role keeps the scope the runner started with. Here the other
// role is one New() scoped in (its team_roles named it) before the pipeline
// had its stage; the fresh response adds that stage, so the next authority
// pass builds and schedules it, whatever the fresh team_roles say about it.
// A refresh that rewrote the runner's shared scope from the fresh list
// would leave it unbuilt when that list leaves it out.
func TestContextDispatchCallSemanticsFreshTeamRolesLeaveOtherRolesToTheirStartupScope(t *testing.T) {
	for _, tc := range []struct {
		name      string
		teamRoles []string
	}{
		{"fresh_excludes_the_released_role", []string{otherRole}},
		{"fresh_excludes_the_other_role", []string{runnerDispatchRole}},
		{"fresh_includes_both", []string{runnerDispatchRole, otherRole}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, f := semanticsCase(t, "continue_project", "produces_decision")
			h := recordReleases(t, c, f)
			role := c.strategy.config.Role
			c.loop.scopedTeamRoles = map[string]struct{}{role: {}, otherRole: {}}
			c.loop.scheduler = NewScheduler(map[string]Strategy{role: c.strategy}, []string{role}, "priority")
			fresh := servedConfig(2, withKind(c.strategy.config, "produces_note"), otherStage())
			fresh["team_roles"] = tc.teamRoles
			h.serve(fresh)

			if err := duringRateWait(t, c, f, startedAgain(f), setFlag("post_process_kind", "produces_note"), c.loop.tick); err != nil {
				t.Errorf("a released card is a clean tick, got %v", err)
			}
			expectReleased(t, c, h, runnerDispatchOwner)
			for pass := 1; pass <= 2; pass++ {
				c.loop.applyPlatformAuthority(context.Background())
				if _, owned := c.loop.ownedStrategies[otherRole]; !owned {
					t.Errorf("authority pass %d: the other role, in the runner's startup scope, was not built", pass)
				}
				if _, scheduled := c.loop.scheduler.Strategies()[otherRole]; !scheduled {
					t.Errorf("authority pass %d: the other role, in the runner's startup scope, is not scheduled", pass)
				}
			}
		})
	}
}

// Multi-role: with the released role excluded by its fresh team_roles, a
// later authority pass must not rebuild it from the runner's startup scope
// (which still names it) and hand it back to the scheduler. The scheduler
// keeps ticking the other role, and the released role claims nothing.
func TestContextDispatchCallSemanticsSchedulerKeepsAnExcludedRoleDisabled(t *testing.T) {
	c, f := semanticsCase(t, "continue_project", "produces_decision")
	h := recordReleases(t, c, f)
	role := c.strategy.config.Role
	other := &untouchedRole{}
	c.loop.scopedTeamRoles = map[string]struct{}{role: {}, otherRole: {}}
	c.loop.ownedStrategies[otherRole] = other
	c.loop.platformPriorityOrder = []string{role, otherRole}
	c.loop.platformConfig.PipelineConfig.Stages = append(c.loop.platformConfig.PipelineConfig.Stages, otherStage())
	c.loop.scheduler = NewScheduler(map[string]Strategy{role: c.strategy, otherRole: other}, []string{role, otherRole}, "priority")
	fresh := servedConfig(2, withKind(c.strategy.config, "produces_note"), otherStage())
	fresh["team_roles"] = []string{otherRole}
	h.serve(fresh)

	if err := duringRateWait(t, c, f, startedAgain(f), setFlag("post_process_kind", "produces_note"), c.loop.tick); err != nil {
		t.Errorf("a released card is a clean tick, got %v", err)
	}
	expectReleased(t, c, h, runnerDispatchOwner)
	if !reportsRole(c.loop.validateConfig(), role) {
		t.Errorf("no config error tells the operator %s is excluded from this runner's scope: %v", role, c.loop.validateConfig())
	}
	before := claims(f)
	for pass := 1; pass <= 2; pass++ {
		c.loop.applyPlatformAuthority(context.Background())
		other.mu.Lock()
		ticksBefore := other.ticks
		other.mu.Unlock()
		_ = nextTick(t, c, f, c.loop.tick)
		if after := claims(f); after != before {
			t.Errorf("authority pass %d: the excluded role was rebuilt and claimed again (%d assignment requests and starts)", pass, after-before)
		}
		other.mu.Lock()
		ticked := other.ticks > ticksBefore
		other.mu.Unlock()
		if !ticked {
			t.Errorf("authority pass %d: the other role was not ticked", pass)
		}
		if !reportsRole(c.loop.validateConfig(), role) {
			t.Errorf("authority pass %d: the config error naming the excluded role %s is gone", pass, role)
		}
	}
	if aborted := abortsSoFar(h); aborted != 1 {
		t.Errorf("the excluded role ran its stale configuration again: %d aborts", aborted)
	}
}

// fencedRole is a pipeline role outside the runner's startup scope.
const fencedRole = "operator-fenced-49"

// The fresh team_roles of the released role may name a pipeline role the
// runner started without; that does not widen the runner's scope: the
// fenced role stays unbuilt and unscheduled across later authority passes,
// while the released role, still in scope, runs its refreshed stage and
// the other in-scope role stays owned and scheduled as it was.
func TestContextDispatchCallSemanticsFreshTeamRolesNeverWidenTheRunnersScope(t *testing.T) {
	c, f := semanticsCase(t, "continue_project", "produces_decision")
	h := recordReleases(t, c, f)
	role := c.strategy.config.Role
	other := &untouchedRole{}
	c.loop.scopedTeamRoles = map[string]struct{}{role: {}, otherRole: {}}
	c.loop.ownedStrategies[otherRole] = other
	c.loop.platformPriorityOrder = []string{role, otherRole}
	c.loop.platformConfig.PipelineConfig.Stages = append(c.loop.platformConfig.PipelineConfig.Stages, otherStage())
	c.loop.scheduler = NewScheduler(map[string]Strategy{role: c.strategy, otherRole: other}, []string{role, otherRole}, "priority")
	fenced := otherStage()
	fenced.Role = fencedRole
	fresh := servedConfig(2, withKind(c.strategy.config, "produces_note"), otherStage(), fenced)
	fresh["team_roles"] = []string{role, fencedRole}
	h.serve(fresh)

	if err := duringRateWait(t, c, f, startedAgain(f), setFlag("post_process_kind", "produces_note"), c.loop.tick); err != nil {
		t.Errorf("a released card is a clean tick, got %v", err)
	}
	expectReleased(t, c, h, runnerDispatchOwner)
	next := noteProvider(c, f)
	for pass := 1; pass <= 2; pass++ {
		c.loop.applyPlatformAuthority(context.Background())
		if _, owned := c.loop.ownedStrategies[fencedRole]; owned {
			t.Errorf("authority pass %d: a role outside the startup scope was built", pass)
		}
		if _, scheduled := c.loop.scheduler.Strategies()[fencedRole]; scheduled {
			t.Errorf("authority pass %d: a role outside the startup scope was scheduled", pass)
		}
		if owned, ok := c.loop.ownedStrategies[otherRole]; !ok || owned != Strategy(other) {
			t.Errorf("authority pass %d: the other in-scope role is no longer the one the runner started with", pass)
		}
		if _, scheduled := c.loop.scheduler.Strategies()[otherRole]; !scheduled {
			t.Errorf("authority pass %d: the other in-scope role is no longer scheduled", pass)
		}
	}
	if err := nextTick(t, c, f, c.loop.tick); err != nil {
		t.Errorf("the released role's next tick failed: %v", err)
	}
	expectNoteCall(t, f, h, next, 1)
}
