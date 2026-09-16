// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// platformConfigServer returns an httptest.Server that replies to
// GET /api/agents/me/config with the given pipeline embedded in
// workspace_config. Other endpoints return empty {} so unrelated
// refresh calls don't explode in downstream tests.
func platformConfigServer(t *testing.T, pipeline *valaris.PipelineConfig) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agents/me/config" {
			resp := map[string]any{
				"agent_id":   "agent-1",
				"name":       "test",
				"agent_type": "coding",
				"is_active":  true,
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

// TestNew_BuildsStrategiesFromPlatformPipeline proves the Loop picks its
// roles from the platform-supplied pipeline, not from DefaultPipelineConfig.
// A role ("researcher") that does not exist in DefaultPipelineConfig is
// served by the platform and must appear in the resulting strategies.
func TestNew_BuildsStrategiesFromPlatformPipeline(t *testing.T) {
	platformPipeline := &valaris.PipelineConfig{
		Version: 7,
		Stages: []valaris.StageConfig{
			{
				Role: "researcher",
				Claim: valaris.ClaimDef{ParticipantRole: "helper"},
				LLM:  valaris.LLMDef{Enabled: false},
			},
			{
				Role: "reviewer",
				Claim: valaris.ClaimDef{ParticipantRole: "helper"},
				LLM:  valaris.LLMDef{Enabled: false},
			},
		},
		Scheduling: valaris.SchedulingDef{
			PriorityOrder:  []string{"researcher", "reviewer"},
			MaxConsecutive: 3,
		},
	}
	srv := platformConfigServer(t, platformPipeline)
	defer srv.Close()

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
	if loop.scheduler == nil {
		t.Fatal("multi-role pipeline should build a scheduler")
	}
	strategies := loop.scheduler.Strategies()
	if _, ok := strategies["researcher"]; !ok {
		t.Errorf("scheduler missing researcher strategy built from platform pipeline (got roles: %v)", strategies)
	}
	if _, ok := strategies["reviewer"]; !ok {
		t.Errorf("scheduler missing reviewer strategy built from platform pipeline")
	}

	// The stored platform config must be observable — subsequent refreshes
	// diff against it to detect version bumps. Version lives on the workspace
	// config, not the pipeline itself.
	if loop.platformConfig.PipelineConfig == nil {
		t.Error("platformConfig.PipelineConfig should be populated after successful New")
	}
	if got := loop.platformConfig.PipelineConfig.Version; got != platformPipeline.Version {
		t.Errorf("platformConfig.PipelineConfig.Version = %d, want %d", got, platformPipeline.Version)
	}
}

// TestNew_SingleRolePipeline_BuildsStrategyDirectly verifies that a platform
// pipeline with one stage yields loop.strategy (no scheduler) — the same path
// single-role config used to take.
func TestNew_SingleRolePipeline_BuildsStrategyDirectly(t *testing.T) {
	platformPipeline := &valaris.PipelineConfig{
		Version: 1,
		Stages: []valaris.StageConfig{
			{
				Role:  "reviewer",
				Claim: valaris.ClaimDef{ParticipantRole: "helper"},
				LLM:   valaris.LLMDef{Enabled: false},
			},
		},
		Scheduling: valaris.SchedulingDef{PriorityOrder: []string{"reviewer"}},
	}
	srv := platformConfigServer(t, platformPipeline)
	defer srv.Close()

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop, err := New(context.Background(), client, llm.NewMockProvider(), gitMgr, cfg)
	if err != nil {
		t.Fatalf("New returned error: %v", err)
	}
	if loop.scheduler != nil {
		t.Error("single-stage pipeline should not build a scheduler")
	}
	if loop.strategy == nil || loop.strategy.Name() != "reviewer" {
		name := "nil"
		if loop.strategy != nil {
			name = loop.strategy.Name()
		}
		t.Errorf("loop.strategy = %q, want reviewer", name)
	}
}

// TestNew_FetchError_ReturnsError proves a misconfigured platform (HTTP 500)
// causes New to refuse to start rather than silently falling back to
// DefaultPipelineConfig.
func TestNew_FetchError_ReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agents/me/config" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte("{}"))
	}))
	defer srv.Close()

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop, err := New(context.Background(), client, llm.NewMockProvider(), gitMgr, cfg)
	if err == nil {
		t.Fatal("expected New to return error when platform config fetch fails")
	}
	if loop != nil {
		t.Error("expected New to return nil loop on fetch error")
	}
}

// TestNew_NilPipelineConfig_ReturnsError — platform responds successfully but
// pipeline_config is null. New must refuse to start instead of hiding the
// misconfiguration behind DefaultPipelineConfig.
func TestNew_NilPipelineConfig_ReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agents/me/config" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"agent_id":         "agent-1",
				"workspace_config": map[string]any{}, // pipeline_config absent => nil
			})
			return
		}
		_, _ = w.Write([]byte("{}"))
	}))
	defer srv.Close()

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop, err := New(context.Background(), client, llm.NewMockProvider(), gitMgr, cfg)
	if err == nil {
		t.Fatal("expected New to return error when pipeline_config is nil")
	}
	if loop != nil {
		t.Error("expected New to return nil loop when pipeline_config is nil")
	}
}

// TestNew_EmptyStages_ReturnsError — a present but empty pipeline is a bug
// the agent should refuse to run with.
func TestNew_EmptyStages_ReturnsError(t *testing.T) {
	srv := platformConfigServer(t, &valaris.PipelineConfig{Version: 3, Stages: nil})
	defer srv.Close()

	cfg := testConfig()
	client := testClientWithURL(srv.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop, err := New(context.Background(), client, llm.NewMockProvider(), gitMgr, cfg)
	if err == nil {
		t.Fatal("expected New to return error when pipeline_config.stages is empty")
	}
	if loop != nil {
		t.Error("expected New to return nil loop when pipeline_config.stages is empty")
	}
}

// T0.2: failureBackoffDuration reads MinFailureBackoffSeconds from the
// platform pipeline and falls back to 5s when unset.
func TestFailureBackoffDuration_HonorsPipelineSetting(t *testing.T) {
	cases := []struct {
		name     string
		seconds  int
		expected time.Duration
	}{
		{"zero uses default", 0, 5 * time.Second},
		{"negative uses default", -3, 5 * time.Second},
		{"positive honored", 12, 12 * time.Second},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			l := &Loop{
				platformConfig: valaris.WorkspaceConfigData{
					PipelineConfig: &valaris.PipelineConfig{
						Scheduling: valaris.SchedulingDef{
							MinFailureBackoffSeconds: tc.seconds,
						},
					},
				},
			}
			if got := l.failureBackoffDuration(); got != tc.expected {
				t.Errorf("seconds=%d -> duration %s, want %s", tc.seconds, got, tc.expected)
			}
		})
	}

	// No pipeline config at all still yields the default.
	empty := &Loop{}
	if got := empty.failureBackoffDuration(); got != 5*time.Second {
		t.Errorf("empty config -> %s, want 5s default", got)
	}
}
