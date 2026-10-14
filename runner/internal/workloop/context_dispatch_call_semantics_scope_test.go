// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// noteProviderFor is noteProvider queued with one verdict-less note per call
// the test intends; the mock fails any call past them.
func noteProviderFor(c *invocationCase, f *invocationHTTP, calls int) *invocationProviderRecorder {
	responses := make([]string, calls)
	for i := range responses {
		responses[i] = "Plain note prose without a verdict"
	}
	mock := llm.NewMockProvider(responses...)
	mock.NameOverride = invocationProvider
	mock.Caps.PromptChannels = llm.PromptChannels{Version: 1, FreshInput: true, FreshSystem: true, ResumeInput: true, ResumeSystem: true}
	next := &invocationProviderRecorder{MockProvider: mock, fixture: f}
	c.loop.providers[invocationProvider] = next
	return next
}

// The refresh after a release reads the runner's team-role scope from the
// same fresh /api/agents/me/config response as the pipeline. The backend
// always sends team_roles (backend/app/schemas/agents/agent.py: team_roles,
// default []), the roles of the agent's team (backend/app/services/agents/
// agent.py: team_info.roles, [] without a team). New() reads it as the scope:
// a non-empty list narrows the runner to those roles, an empty one is
// role-agnostic and claims every pipeline role (runner loop.go: New, "Empty
// team_roles is the role-agnostic default").
//
// So a fresh response that keeps the role's stage but leaves the role out of
// team_roles takes the role out of this runner's scope, though the runner's
// cached scope, from New, still names it; the same response with the role
// still listed, or with an empty list, keeps it in scope.
func TestContextDispatchCallSemanticsFreshTeamRolesScopeTheRefresh(t *testing.T) {
	for _, tc := range []struct {
		name      string
		teamRoles []string
		inScope   bool
	}{
		{"narrowed_excludes_the_role", []string{otherRole}, false},
		{"unchanged_includes_the_role", []string{runnerDispatchRole, otherRole}, true},
		{"empty_is_role_agnostic", []string{}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c, f := semanticsCase(t, "continue_project", "produces_decision")
			h := recordReleases(t, c, f)
			// As New leaves a runner whose team_roles named both roles. The
			// test never changes this cached scope: only the fresh response
			// carries the new one.
			c.loop.scopedTeamRoles = map[string]struct{}{runnerDispatchRole: {}, otherRole: {}}
			fresh := servedConfig(2, withKind(c.strategy.config, "produces_note"), otherStage())
			fresh["team_roles"] = tc.teamRoles
			h.serve(fresh)

			if err := duringRateWait(t, c, f, startedAgain(f), setFlag("post_process_kind", "produces_note"), c.loop.tick); err != nil {
				t.Errorf("a released card is a clean tick, got %v", err)
			}
			expectReleased(t, c, h, runnerDispatchOwner)

			if !tc.inScope {
				if !reportsRole(c.loop.validateConfig(), runnerDispatchRole) {
					t.Errorf("no config error tells the operator %s is excluded from this runner's scope: %v", runnerDispatchRole, c.loop.validateConfig())
				}
				before := claims(f)
				for _, step := range []string{"next tick", "tick after an authority pass", "tick after a second authority pass"} {
					if step != "next tick" {
						c.loop.applyPlatformAuthority(context.Background())
					}
					_ = nextTick(t, c, f, c.loop.tick)
					f.mu.Lock()
					prepared := len(f.payloads)
					f.mu.Unlock()
					if after := claims(f); after != before || prepared != 0 || c.current.CallCount()+c.stale.CallCount() != 0 {
						t.Errorf("%s: a role the fresh team_roles excludes still worked: %d claims, %d preparations, %d provider calls",
							step, after-before, prepared, c.current.CallCount()+c.stale.CallCount())
					}
				}
				if aborted := abortsSoFar(h); aborted != 1 {
					t.Errorf("a role out of the fresh scope ran its stale configuration again: %d aborts", aborted)
				}
				return
			}

			// Two intended note calls: the next tick and the tick after an
			// authority pass.
			next := noteProviderFor(c, f, 2)
			if err := nextTick(t, c, f, c.loop.tick); err != nil {
				t.Errorf("the next tick of a role still in scope failed: %v", err)
			}
			expectNoteCall(t, f, h, next, 1)
			c.loop.applyPlatformAuthority(context.Background())
			if err := nextTick(t, c, f, c.loop.tick); err != nil {
				t.Errorf("the tick after an authority pass failed: %v", err)
			}
			expectNoteCall(t, f, h, next, 2)
		})
	}
}
