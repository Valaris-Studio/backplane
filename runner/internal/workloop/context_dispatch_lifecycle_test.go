// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

func TestContextDispatchReworkBindsBeforeMediationAndPreparesBothCalls(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		name := "required"
		if legacy {
			name = "explicit_legacy_control"
		}
		t.Run(name, func(t *testing.T) {
			mediation, _ := json.Marshal(map[string]any{"action_plan": lifecycleActionPlan, "escalate": false})
			c, f := newLifecycleDispatchCase(t, legacy, false, string(mediation), `{"status":"done","summary":"No new changes"}`)
			c.card.GitRepoURL, c.card.GitRepoName, c.card.DefaultBranch = initBareRemote(t), "owned-rework-repo", "main"
			c.loop.sessions.Set(runnerDispatchAgent, runnerDispatchCard, "implement", lifecycleSessionID)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if err := c.strategy.tickRework(ctx, ctx, c.loop, c.card, slog.Default()); err != nil {
				t.Fatalf("actual rework path: %v", err)
			}
			if legacy {
				if c.stale.CallCount() != 2 || c.current.CallCount() != 0 || len(f.payloads) != 0 {
					t.Errorf("legacy rework changed: stale=%d current=%d preparations=%d", c.stale.CallCount(), c.current.CallCount(), len(f.payloads))
				}
				return
			}
			assertLifecyclePreparedCalls(t, c, f, []string{"mediate_rework", "rework_implement"}, []string{"mediation", "stage"}, []string{
				"mediate_rework Fresh card é\n" + runnerDispatchExecution + "\n" + invocationSource,
				"rework_implement Fresh card é\n" + runnerDispatchExecution + "\n" + invocationSource + "\nPLAN\n" + lifecycleActionPlan,
			})
			f.mu.Lock()
			defer f.mu.Unlock()
			want := []string{"start", "refresh", "prepare", "provider:" + invocationProvider, "refresh", "prepare", "provider:" + invocationProvider}
			if !reflect.DeepEqual(f.events, want) || len(f.starts) != 1 || f.starts[0]["reservation_id"] != runnerDispatchHold {
				t.Errorf("rework did not bind once before mediation: events=%v starts=%v", f.events, f.starts)
			}
			if c.current.Calls[1].Options.ResumeSessionID != "" {
				t.Error("rework reused the superseded implement session")
			}
		})
	}
}

func TestContextDispatchReworkRefusedBindingPreventsMediation(t *testing.T) {
	c, f := newLifecycleDispatchCase(t, false, false, `{"action_plan":"must never run","escalate":false}`)
	f.startStatus = http.StatusForbidden
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	err := c.strategy.tickRework(ctx, ctx, c.loop, c.card, slog.Default())
	if err == nil {
		t.Error("required rework accepted a refused execution start")
	}
	if c.current.CallCount()+c.stale.CallCount() != 0 || len(f.payloads) != 0 {
		t.Errorf("inference preceded authorization: current=%d stale=%d preparations=%d events=%v", c.current.CallCount(), c.stale.CallCount(), len(f.payloads), f.events)
	}
	if len(f.starts) != 1 {
		t.Errorf("bound start must be attempted once: %v", f.starts)
	}
	entries, readErr := os.ReadDir(c.loop.cfg.Git.BaseDir)
	if readErr != nil || len(entries) != 0 {
		t.Errorf("refused rework created checkout: %v err=%v", entries, readErr)
	}
}

func TestContextDispatchReworkEscalationClosesBoundExecutionWithoutCheckout(t *testing.T) {
	c, f := newLifecycleDispatchCase(t, false, false, `{"action_plan":"Human decision needed","escalate":true}`)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.strategy.tickRework(ctx, ctx, c.loop, c.card, slog.Default()); err != nil {
		t.Fatal(err)
	}
	assertLifecyclePreparedCalls(t, c, f, []string{"mediate_rework"}, []string{"mediation"}, []string{"mediate_rework Fresh card é\n" + runnerDispatchExecution + "\n" + invocationSource})
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.starts) != 1 || len(f.events) == 0 || f.events[0] != "start" {
		t.Errorf("escalation had no pre-mediation bound execution: %v", f.events)
	}
	terminal := false
	for _, update := range f.updates {
		switch update["status"] {
		case "failed", "aborted", "skipped", "completed":
			terminal = true
		}
	}
	if !terminal {
		t.Errorf("escalated required execution left active: updates=%v", f.updates)
	}
	entries, err := os.ReadDir(c.loop.cfg.Git.BaseDir)
	if err != nil || len(entries) != 0 {
		t.Errorf("escalation checked out a repository: entries=%v err=%v", entries, err)
	}
	if c.loop.CardFailureCount(runnerDispatchCard) == 0 {
		t.Error("existing escalation failure policy disappeared")
	}
}

func TestContextDispatchImmediateApprovalRefreshesFinalResumePrompt(t *testing.T) {
	for _, status := range []string{"approved", "auto_approved"} {
		t.Run(status, func(t *testing.T) {
			first, _ := json.Marshal(map[string]any{"status": "needs_approval", "approval_id": lifecycleApprovalID, "summary": lifecycleSummary})
			c, f := newLifecycleDispatchCase(t, false, true, string(first), `{"status":"done","summary":"Continued"}`)
			f.approvalStatus, f.refreshAfterApproval = status, true
			c.loop.sessions.Set(runnerDispatchAgent, runnerDispatchCard, "implement", lifecycleSessionID)
			if err := c.run(context.Background()); err != nil {
				t.Fatalf("actual immediate approval path: %v", err)
			}
			assertLifecyclePreparedCalls(t, c, f, []string{"main", "implement_after_approval"}, []string{"stage", "post_approval"}, []string{
				"main Fresh card é\n" + runnerDispatchExecution + "\n" + invocationSource,
				"implement_after_approval Changed during approval é\n" + runnerDispatchExecution + "\n" + invocationSource + "Approved while first call ran 🧪\n\nAPPROVAL\n" + lifecycleSummary,
			})
			f.mu.Lock()
			defer f.mu.Unlock()
			second := f.payloads[1]
			if second["resume_session_id"] != lifecycleSessionID || c.current.Calls[1].Options.ResumeSessionID != lifecycleSessionID {
				t.Errorf("approval resume session was not acknowledged exactly: payload=%v options=%+v", second, c.current.Calls[1].Options)
			}
			channel, _ := second["channel_contract"].(map[string]any)
			if channel["resume"] != true {
				t.Errorf("resume channel declaration missing: %v", channel)
			}
			if f.payloads[0]["context_revision"] == second["context_revision"] || f.payloads[0]["dispatch_revision"] == second["dispatch_revision"] {
				t.Error("second invocation reused pre-approval revisions")
			}
			if len(f.starts) != 1 {
				t.Errorf("immediate approval must share the live bound execution: %v", f.starts)
			}
		})
	}
}

func TestContextDispatchParkedApprovalPreservesStateWithoutInference(t *testing.T) {
	for _, entry := range []string{"poll", "direct"} {
		for _, policy := range []string{"required", "removed_after_bind", "activated_after_legacy_bind"} {
			for _, status := range []string{"approved", "auto_approved"} {
				t.Run(entry+"_"+policy+"_"+status, func(t *testing.T) {
					c, f := newLifecycleDispatchCase(t, policy == "activated_after_legacy_bind", true, `{"status":"done"}`, `{"status":"done"}`)
					f.approvalStatus = status
					if policy == "removed_after_bind" {
						f.base.contract["mode"], f.base.contract["minimum_version"] = "legacy", 0
					}
					if policy == "activated_after_legacy_bind" {
						f.base.contract["mode"], f.base.contract["minimum_version"] = "required", 1
					}
					token := parkLifecycleDispatchCase(c, f)
					initialStarts, initialClaims := len(f.starts), f.claims
					for range 2 {
						if entry == "poll" {
							c.loop.resumeDecidedApprovals(context.Background())
						} else {
							err := c.strategy.resumeApprovedCard(context.Background(), c.loop, token, &valaris.ApprovalStatus{ID: lifecycleApprovalID, Status: status})
							if err == nil || !strings.Contains(strings.ToLower(err.Error()), "unsupported") {
								t.Errorf("direct required parked resume needs actionable unsupported-flow error, got %v", err)
							}
						}
					}
					assertRequiredParkPreserved(t, c, f, token, initialStarts, initialClaims)
				})
			}
		}
	}
}

func parkLifecycleDispatchCase(c *invocationCase, f *lifecycleDispatchHTTP) *parkedApproval {
	c.loop.sessions.Set(runnerDispatchAgent, runnerDispatchCard, "implement", lifecycleSessionID)
	c.card.Labels = []string{awaitingApprovalLabel, "operator-label"}
	f.labels = append([]string(nil), c.card.Labels...)
	token := &parkedApproval{ApprovalID: lifecycleApprovalID, CardID: runnerDispatchCard, Role: runnerDispatchRole, ExecutionID: runnerDispatchExecution, Summary: lifecycleSummary, SessionID: lifecycleSessionID, Card: c.card, Strategy: c.strategy, ParkedAt: time.Now()}
	c.loop.parkApproval(token)
	return token
}

func assertRequiredParkPreserved(t *testing.T, c *invocationCase, f *lifecycleDispatchHTTP, token *parkedApproval, starts, claims int) {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if c.current.CallCount()+c.stale.CallCount() != 0 || len(f.starts) != starts || f.claims != claims || f.labelWrites != 0 || len(f.payloads) != 0 {
		t.Errorf("required parked resume performed work: current=%d stale=%d starts=%d→%d claims=%d→%d labels=%d preparations=%d", c.current.CallCount(), c.stale.CallCount(), starts, len(f.starts), claims, f.claims, f.labelWrites, len(f.payloads))
	}
	snapshot := c.loop.parkedApprovalSnapshot()
	if len(snapshot) != 1 || snapshot[0] != token {
		t.Errorf("parked resume token was lost/replaced: %v", snapshot)
	}
	if token.Summary != lifecycleSummary || token.SessionID != lifecycleSessionID || token.ApprovalID != lifecycleApprovalID || c.loop.sessions.Get(runnerDispatchAgent, runnerDispatchCard, "implement") != lifecycleSessionID || !reflect.DeepEqual(f.labels, []string{awaitingApprovalLabel, "operator-label"}) {
		t.Errorf("approval decision/session/label state changed: token=%+v labels=%v", token, f.labels)
	}
	if len(f.warnings) != 1 {
		t.Errorf("unsupported parked resume must report once across retries: %v", f.warnings)
	} else {
		warning := f.warnings[0]
		message, _ := warning["message"].(string)
		if warning["kind"] != "context_dispatch_unsupported_flow" || warning["card_id"] != runnerDispatchCard || !strings.Contains(strings.ToLower(message), "park") || len(message) == 0 {
			t.Errorf("warning is not actionable/typed/card-scoped: %v", warning)
		}
	}
}

func TestContextDispatchParkedApprovalExplicitLegacyStillResumes(t *testing.T) {
	c, f := newLifecycleDispatchCase(t, true, true, `{"status":"done","summary":"Legacy resumed"}`)
	parkLifecycleDispatchCase(c, f)
	c.loop.resumeDecidedApprovals(context.Background())
	c.loop.resumeDecidedApprovals(context.Background())
	if c.stale.CallCount() != 1 || c.current.CallCount() != 0 || c.loop.parkedApprovalCount() != 0 || len(f.payloads) != 0 || len(f.warnings) != 0 {
		t.Errorf("legacy resume changed: stale=%d current=%d parked=%d preparations=%d warnings=%v", c.stale.CallCount(), c.current.CallCount(), c.loop.parkedApprovalCount(), len(f.payloads), f.warnings)
	}
	if !reflect.DeepEqual(f.labels, []string{"operator-label"}) || c.stale.LastCall() == nil || c.stale.LastCall().Options.ResumeSessionID != lifecycleSessionID {
		t.Errorf("legacy resume lost label/session behavior: labels=%v call=%+v", f.labels, c.stale.LastCall())
	}
}
