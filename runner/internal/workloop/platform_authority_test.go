// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/health"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// platformConfigPlusPromptsServer serves both /api/agents/me/config and the
// per-role prompt-config endpoint so Loop startup can populate the prompt
// cache. promptsByRole maps role -> map(stage -> content).
func platformConfigPlusPromptsServer(t *testing.T, pipeline *valaris.PipelineConfig, promptsByRole map[string]map[string]string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agents/me/config" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"agent_id":   "agent-1",
				"name":       "test",
				"agent_type": "coding",
				"is_active":  true,
				"workspace_config": map[string]any{
					"pipeline_config": pipeline,
				},
			})
			return
		}
		if strings.HasSuffix(r.URL.Path, "/prompt-configs") {
			role := r.URL.Query().Get("team_role")
			out := []map[string]any{}
			for stage, content := range promptsByRole[role] {
				out = append(out, map[string]any{
					"id":      role + "-" + stage,
					"role":    role,
					"stage":   stage,
					"content": content,
					"version": 1,
				})
			}
			_ = json.NewEncoder(w).Encode(out)
			return
		}
		_, _ = w.Write([]byte("{}"))
	}))
}

// TestSchedulerSeatbelt_AppendsKnownRoleMissingFromPriorityOrder proves the
// platform contract: a role that has a stage in pipeline_config but is absent
// from scheduling.priority_order must still be schedulable. The runner's
// seatbelt appends it in stage order so a misconfigured priority list never
// silently drops a real role.
func TestSchedulerSeatbelt_AppendsKnownRoleMissingFromPriorityOrder(t *testing.T) {
	platformPipeline := &valaris.PipelineConfig{
		Version: 1,
		Stages: []valaris.StageConfig{
			{
				Role:  "secretario",
				Claim: valaris.ClaimDef{ParticipantRole: "helper"},
				LLM: valaris.LLMDef{
					Enabled:         true,
					Stage:           "secretary",
					PostProcessKind: "produces_note",
				},
			},
			{
				Role:  "reviewer",
				Claim: valaris.ClaimDef{ParticipantRole: "helper"},
				LLM:   valaris.LLMDef{Enabled: false},
			},
		},
		Scheduling: valaris.SchedulingDef{
			// Missing "secretario" — the operator forgot to add it.
			PriorityOrder:  []string{"reviewer"},
			MaxConsecutive: 3,
		},
	}
	prompts := map[string]map[string]string{
		"secretario": {"secretary": "do the thing"},
		"reviewer":   {"review": "review the thing"},
	}
	srv := platformConfigPlusPromptsServer(t, platformPipeline, prompts)
	defer srv.Close()

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	hc := health.NewCollector(0, 0, 0)

	loop, err := New(context.Background(), client, llm.NewMockProvider(), gitMgr, cfg, hc)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if loop.scheduler == nil {
		t.Fatal("multi-role pipeline must build a scheduler")
	}

	loop.RefreshPromptCache(context.Background())
	loop.applyPlatformAuthority(context.Background())

	got := loop.scheduler.PriorityOrder()
	foundSecretario := false
	for _, r := range got {
		if r == "secretario" {
			foundSecretario = true
			break
		}
	}
	if !foundSecretario {
		t.Errorf("seatbelt failed to append missing role; got priority order %v", got)
	}
}

// TestPlatformAuthority_RefusesScheduleWhenPromptMissing proves the contract:
// a role whose owned LLM stage has no platform prompt becomes unschedulable.
// The runner stays alive, drops the role from the scheduler, and reports a
// typed health_config_errors entry. It does NOT fall back to a compiled-in
// template.
func TestPlatformAuthority_RefusesScheduleWhenPromptMissing(t *testing.T) {
	platformPipeline := &valaris.PipelineConfig{
		Version: 1,
		Stages: []valaris.StageConfig{
			{
				Role:  "secretario",
				Claim: valaris.ClaimDef{ParticipantRole: "helper"},
				LLM: valaris.LLMDef{
					Enabled:         true,
					Stage:           "secretary",
					PostProcessKind: "produces_note",
				},
			},
			{
				Role:  "reviewer",
				Claim: valaris.ClaimDef{ParticipantRole: "helper"},
				LLM:   valaris.LLMDef{Enabled: true, Stage: "review"},
			},
		},
		Scheduling: valaris.SchedulingDef{
			PriorityOrder:  []string{"reviewer", "secretario"},
			MaxConsecutive: 3,
		},
	}
	// reviewer has its prompt; secretario does NOT.
	prompts := map[string]map[string]string{
		"reviewer": {"review": "review the thing"},
	}
	srv := platformConfigPlusPromptsServer(t, platformPipeline, prompts)
	defer srv.Close()

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	hc := health.NewCollector(0, 0, 0)

	loop, err := New(context.Background(), client, llm.NewMockProvider(), gitMgr, cfg, hc)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	loop.RefreshPromptCache(context.Background())
	loop.applyPlatformAuthority(context.Background())

	if _, present := loop.scheduler.Strategies()["secretario"]; present {
		t.Error("secretario must be dropped from scheduler when its prompt is missing")
	}
	if _, present := loop.scheduler.Strategies()["reviewer"]; !present {
		t.Error("reviewer must remain schedulable when its prompt is present")
	}

	errs := hc.ConfigErrors()
	foundMissing := false
	for _, e := range errs {
		if e.Code == ConfigErrMissingPrompts && e.Stage == "secretario:secretary" {
			foundMissing = true
		}
	}
	if !foundMissing {
		t.Errorf("expected health_config_errors entry for secretario:secretary, got %v", errs)
	}
}

// TestPlatformAuthority_ScopesValidationToOwnedRoles proves the runner only
// reports missing_prompts for stages it has roles for. A pipeline that
// references reviewer/documentator/orchestrator but where the runner only
// owns "secretario" must NOT surface noise about the unowned roles.
func TestPlatformAuthority_ScopesValidationToOwnedRoles(t *testing.T) {
	pipelineCfg := DefaultPipelineConfig // 3 default roles
	stage := valaris.StageConfig{
		Role:  "secretario",
		Claim: valaris.ClaimDef{ParticipantRole: "helper"},
		LLM: valaris.LLMDef{
			Enabled:         true,
			Stage:           "secretary",
			PostProcessKind: "produces_note",
		},
	}
	pipelineCfg.Stages = append([]valaris.StageConfig{stage}, pipelineCfg.Stages...)

	l := &Loop{
		strategy:     NewStrategyFromConfig(stage, nil),
		promptCache:  make(map[string]string),
		cardFailures: make(map[string]cardFailure),
	}
	l.platformConfig = valaris.WorkspaceConfigData{PipelineConfig: &pipelineCfg}
	// Only seed the secretario prompt (the role the runner owns).
	l.promptCache["secretario:secretary"] = "do the thing"

	errs := l.validateConfig()
	for _, e := range errs {
		if e.Code != ConfigErrMissingPrompts {
			continue
		}
		switch e.Stage {
		case "orchestrator:implement", "reviewer:review", "documentator:document":
			t.Errorf("unowned role surfaced in missing_prompts: %v", e)
		}
	}
}

// TestSchedulerReconfigure_DropsRoleAtomically locks in the small mutation
// surface added to the scheduler so platform-authority logic can disable a
// role at startup or on refresh. The map+priorityOrder swap must happen
// under the same mutex Next() uses.
func TestSchedulerReconfigure_DropsRoleAtomically(t *testing.T) {
	strategies := makeStrategies("alpha", "beta", "gamma")
	sched := NewScheduler(strategies, []string{"alpha", "beta", "gamma"}, "priority")

	sched.Reconfigure(map[string]Strategy{
		"beta":  strategies["beta"],
		"gamma": strategies["gamma"],
	}, []string{"beta", "gamma"})

	if _, ok := sched.Strategies()["alpha"]; ok {
		t.Error("alpha should be removed after Reconfigure")
	}
	got := sched.PriorityOrder()
	if len(got) != 2 || got[0] != "beta" || got[1] != "gamma" {
		t.Errorf("PriorityOrder() = %v, want [beta gamma]", got)
	}
}
