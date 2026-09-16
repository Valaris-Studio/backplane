// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// platformConfigServerWithTeamRoles mirrors platformConfigServer but also
// projects an explicit team_roles list onto /api/agents/me/config. The runner
// uses team_roles to scope which pipeline roles it claims; surfacing dropped
// roles is the north-star contract this test enforces.
func platformConfigServerWithTeamRoles(t *testing.T, pipeline *valaris.PipelineConfig, teamRoles []string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agents/me/config" {
			resp := map[string]any{
				"agent_id":   "agent-1",
				"name":       "test",
				"agent_type": "coding",
				"is_active":  true,
				"team_roles": teamRoles,
				"workspace_config": map[string]any{
					"pipeline_config": pipeline,
				},
			}
			_ = json.NewEncoder(w).Encode(resp)
			return
		}
		_, _ = w.Write([]byte("{}"))
	}))
}

// TestLoop_New_WarnsOnRoleExclusion: when team_roles narrows the pipeline
// (e.g., team_roles=[orchestrator] vs pipeline=[orchestrator, reviewer,
// documentator]), the silently-dropped roles must surface as a slog.Warn so
// operators can see why pipeline stages never run. Without this warning the
// platform pipeline silently becomes a lie — see
// feedback_runner_role_agnostic.md.
func TestLoop_New_WarnsOnRoleExclusion(t *testing.T) {
	platformPipeline := &valaris.PipelineConfig{
		Version: 1,
		Stages: []valaris.StageConfig{
			{Role: "orchestrator", Claim: valaris.ClaimDef{ParticipantRole: "helper"}, LLM: valaris.LLMDef{Enabled: false}},
			{Role: "reviewer", Claim: valaris.ClaimDef{ParticipantRole: "helper"}, LLM: valaris.LLMDef{Enabled: false}},
			{Role: "documentator", Claim: valaris.ClaimDef{ParticipantRole: "helper"}, LLM: valaris.LLMDef{Enabled: false}},
		},
		Scheduling: valaris.SchedulingDef{
			PriorityOrder: []string{"orchestrator", "reviewer", "documentator"},
		},
	}
	srv := platformConfigServerWithTeamRoles(t, platformPipeline, []string{"orchestrator"})
	defer srv.Close()

	// Capture slog output for assertions. Restoring the default at test exit
	// keeps unrelated tests from inheriting our handler.
	var buf bytes.Buffer
	prevLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prevLogger) })

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop, err := New(context.Background(), client, llm.NewMockProvider(), gitMgr, cfg)
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	if loop == nil {
		t.Fatal("New returned nil loop")
	}

	output := buf.String()
	if !strings.Contains(output, "team_roles excludes pipeline roles") {
		t.Errorf("expected warn about excluded pipeline roles; got: %s", output)
	}
	// The dropped roles must be enumerated so the operator can act.
	for _, dropped := range []string{"reviewer", "documentator"} {
		if !strings.Contains(output, dropped) {
			t.Errorf("warn output should mention dropped role %q; got: %s", dropped, output)
		}
	}
	// The remediation hint pins users to the runner-agnostic default.
	if !strings.Contains(output, "set team_roles=[] to claim all pipeline roles") {
		t.Errorf("warn output should suggest the empty-team_roles remedy; got: %s", output)
	}
	// Sanity check: at WARN level, the line must be tagged WARN (not INFO).
	if !strings.Contains(output, "level=WARN") {
		t.Errorf("exclusion message should be slog.Warn (level=WARN); got: %s", output)
	}
}

// TestLoop_New_NoWarn_WhenTeamRolesEmpty: the empty-team_roles default is the
// role-agnostic case — no exclusion warning should fire because nothing is
// dropped.
func TestLoop_New_NoWarn_WhenTeamRolesEmpty(t *testing.T) {
	platformPipeline := &valaris.PipelineConfig{
		Version: 1,
		Stages: []valaris.StageConfig{
			{Role: "orchestrator", Claim: valaris.ClaimDef{ParticipantRole: "helper"}, LLM: valaris.LLMDef{Enabled: false}},
			{Role: "reviewer", Claim: valaris.ClaimDef{ParticipantRole: "helper"}, LLM: valaris.LLMDef{Enabled: false}},
		},
		Scheduling: valaris.SchedulingDef{PriorityOrder: []string{"orchestrator", "reviewer"}},
	}
	srv := platformConfigServerWithTeamRoles(t, platformPipeline, []string{})
	defer srv.Close()

	var buf bytes.Buffer
	prevLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prevLogger) })

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	if _, err := New(context.Background(), client, llm.NewMockProvider(), gitMgr, cfg); err != nil {
		t.Fatalf("New returned error: %v", err)
	}

	if got := buf.String(); strings.Contains(got, "team_roles excludes pipeline roles") {
		t.Errorf("empty team_roles is role-agnostic — no exclusion warn should fire; got: %s", got)
	}
}
