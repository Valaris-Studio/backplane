// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

func TestRefreshPromptCache_PrefersResolvedContentOverContent(t *testing.T) {
	// B11: operator-edited prompts ship with `content` (operator text) and
	// `resolved_content` (content + post_process imperative). Runner must
	// cache the resolved variant so the LLM sees the imperative.
	configs := []valaris.PromptConfig{
		{
			ID:              "1",
			Slug:            "secretary-inform",
			Stage:           "inform",
			Content:         "Summarize standup.",
			ResolvedContent: "Summarize standup.\n\nYou MUST create a note.",
			Version:         1,
		},
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(configs)
	}))
	defer server.Close()

	loop := newTestLoop(server.URL)
	loop.RefreshPromptCache(context.Background())

	got := loop.getPrompt("inform")
	want := "Summarize standup.\n\nYou MUST create a note."
	if got != want {
		t.Errorf("getPrompt = %q, want resolved_content %q", got, want)
	}
}

func TestRefreshPromptCache_FallsBackToContentWhenResolvedEmpty(t *testing.T) {
	// Pre-upgrade backend: only `content` is populated, `resolved_content`
	// field is empty. Runner must fall back so older deploys don't break.
	configs := []valaris.PromptConfig{
		{
			ID:      "1",
			Slug:    "legacy",
			Stage:   "implement",
			Content: "Do the work.",
			Version: 1,
		},
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(configs)
	}))
	defer server.Close()

	loop := newTestLoop(server.URL)
	loop.RefreshPromptCache(context.Background())

	if got := loop.getPrompt("implement"); got != "Do the work." {
		t.Errorf("getPrompt = %q, want fallback to content %q", got, "Do the work.")
	}
}

func TestEffectivePromptContent_PrefersResolved(t *testing.T) {
	pc := valaris.PromptConfig{Content: "raw", ResolvedContent: "raw + imperative"}
	if got := valaris.EffectivePromptContent(pc); got != "raw + imperative" {
		t.Errorf("got %q, want %q", got, "raw + imperative")
	}
}

func TestEffectivePromptContent_FallsBackToContent(t *testing.T) {
	pc := valaris.PromptConfig{Content: "raw"}
	if got := valaris.EffectivePromptContent(pc); got != "raw" {
		t.Errorf("got %q, want %q", got, "raw")
	}
}

func TestRefreshPromptCache_PopulatesCache(t *testing.T) {
	configs := []valaris.PromptConfig{
		{ID: "1", Slug: "discover", Stage: "discover", Content: "Find work in {{.Workspace}}", Version: 1},
		{ID: "2", Slug: "claim", Stage: "claim", Content: "Claim card {{.CardID}}", Version: 2},
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workspaces/test-workspace/prompt-configs" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.URL.Query().Get("team_role") != "orchestrator" {
			t.Errorf("unexpected team_role: %s", r.URL.Query().Get("team_role"))
		}
		json.NewEncoder(w).Encode(configs)
	}))
	defer server.Close()

	loop := newTestLoop(server.URL)
	loop.RefreshPromptCache(context.Background())

	got := loop.getPrompt("discover")
	if got != "Find work in {{.Workspace}}" {
		t.Errorf("discover prompt = %q, want template content", got)
	}
	got = loop.getPrompt("claim")
	if got != "Claim card {{.CardID}}" {
		t.Errorf("claim prompt = %q, want template content", got)
	}
}

func TestRefreshPromptCache_ClearsStaleEntries(t *testing.T) {
	callCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		if callCount == 1 {
			// First call returns two configs
			json.NewEncoder(w).Encode([]valaris.PromptConfig{
				{Stage: "discover", Content: "v1"},
				{Stage: "claim", Content: "v1"},
			})
		} else {
			// Second call returns only one — claim was deleted on platform
			json.NewEncoder(w).Encode([]valaris.PromptConfig{
				{Stage: "discover", Content: "v2"},
			})
		}
	}))
	defer server.Close()

	loop := newTestLoop(server.URL)

	loop.RefreshPromptCache(context.Background())
	if loop.getPrompt("claim") != "v1" {
		t.Fatal("claim should be cached after first refresh")
	}

	loop.RefreshPromptCache(context.Background())
	if loop.getPrompt("claim") != "" {
		t.Error("claim should be cleared after second refresh (deleted on platform)")
	}
	if loop.getPrompt("discover") != "v2" {
		t.Error("discover should be updated to v2")
	}
}

// TestRefreshPromptCache_ThrottlesWithinTTL pins the storm fix: with a non-zero
// refreshTTL, rapid successive calls hit the network only once. This is what
// prevents the per-poll prompt-cache sweep from blowing the backend's
// 100-req/min API-key budget under an active card's WS-event/self-trigger flurry.
func TestRefreshPromptCache_ThrottlesWithinTTL(t *testing.T) {
	var calls int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&calls, 1)
		_ = json.NewEncoder(w).Encode([]valaris.PromptConfig{{Stage: "discover", Content: "v1"}})
	}))
	defer server.Close()

	loop := newTestLoop(server.URL)
	loop.refreshTTL = time.Minute // production-like throttle

	for i := 0; i < 10; i++ {
		loop.RefreshPromptCache(context.Background())
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("expected exactly 1 fetch within TTL across 10 calls, got %d", got)
	}
}

func TestRefreshPromptCache_ServerError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"detail":"server error"}`))
	}))
	defer server.Close()

	loop := newTestLoop(server.URL)
	// Pre-populate cache
	loop.promptCache["discover"] = "existing"

	// Refresh should fail gracefully, keeping existing cache
	loop.RefreshPromptCache(context.Background())

	// Cache was cleared before fetch, so on error the cache is empty.
	// This is by design — stale cache is worse than fallback to hardcoded.
	// Actually: the clear happens inside the lock AFTER the fetch succeeds.
	// Let me check the implementation...
	// The implementation clears then repopulates — on error it returns early
	// BEFORE the clear. So existing cache should remain.
	if loop.getPrompt("discover") != "existing" {
		t.Error("cache should remain unchanged on server error")
	}
}

func TestGetPrompt_CacheHit(t *testing.T) {
	loop := newTestLoop("http://unused")
	loop.promptCache["discover"] = "cached content"

	got := loop.getPrompt("discover")
	if got != "cached content" {
		t.Errorf("got %q, want %q", got, "cached content")
	}
}

func TestGetPrompt_CacheMiss(t *testing.T) {
	loop := newTestLoop("http://unused")

	got := loop.getPrompt("nonexistent")
	if got != "" {
		t.Errorf("got %q, want empty string", got)
	}
}

func TestResolvePrompt_UsesCachedTemplate(t *testing.T) {
	loop := newTestLoop("http://unused")
	loop.promptCache["discover"] = "Find work in {{.Workspace}} for {{.AgentID}}"

	result := loop.resolvePrompt("discover", PromptContext{
		Workspace: "internal",
		AgentID:   "agent-1",
	}, func() string {
		return "hardcoded fallback"
	})

	expected := "Find work in internal for agent-1"
	if result != expected {
		t.Errorf("got %q, want %q", result, expected)
	}
}

func TestResolvePrompt_FallsBackOnCacheMiss(t *testing.T) {
	loop := newTestLoop("http://unused")

	result := loop.resolvePrompt("discover", PromptContext{}, func() string {
		return "hardcoded fallback"
	})

	if result != "hardcoded fallback" {
		t.Errorf("got %q, want %q", result, "hardcoded fallback")
	}
}

func TestResolvePrompt_FallsBackOnTemplateError(t *testing.T) {
	loop := newTestLoop("http://unused")
	loop.promptCache["discover"] = "Bad template {{.NonExistent}}"

	result := loop.resolvePrompt("discover", PromptContext{}, func() string {
		return "hardcoded fallback"
	})

	if result != "hardcoded fallback" {
		t.Errorf("got %q, want %q", result, "hardcoded fallback")
	}
}

// newTestLoop constructs a Loop pinned to the orchestrator strategy for
// prompt-cache tests. serverURL answers the prompt-configs endpoint the test
// cares about; Loop.New's platform config fetch is satisfied by a separate
// stub server so the caller's serverURL doesn't need to handle it.
func newTestLoop(serverURL string) *Loop {
	// Stub server that only answers /api/agents/me/config so Loop.New can
	// start up. The prompt-cache endpoint is served by serverURL below.
	stubPlatform := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agents/me/config" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"agent_id": "agent-1",
				"workspace_config": map[string]any{
					"pipeline_config": DefaultPipelineConfig,
				},
			})
			return
		}
		_, _ = w.Write([]byte("{}"))
	}))

	client := valaris.NewClient(stubPlatform.URL, "vlr_test")
	client.UserID = "user-1"
	client.Agent = &valaris.AgentConfig{
		ID:        "agent-1",
		Name:      "test-runner",
		AgentType: "coding",
		IsActive:  true,
	}

	cfg := &config.Config{
		Valaris: config.ValarisConfig{
			WorkspaceSlug: "test-workspace",
		},
		LLM: config.LLMConfig{
			Model:                      "sonnet",
			MCPConfigPath:              "/tmp/mcp.json",
			MaxBudgetUSD:               1.0,
			DangerouslySkipPermissions: true,
		},
		Git: config.GitConfig{
			DefaultRemote: "origin",
			BranchPrefix:  "runner/",
		},
		WorkLoop: config.WorkLoopConfig{
			PollInterval: 100 * time.Millisecond,
			CardTimeout:  30 * time.Minute,
		},
	}

	mock := llm.NewMockProvider(`{"card_id":""}`)
	gitMgr := &git.Manager{BaseDir: "/tmp", DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop, err := New(context.Background(), client, mock, gitMgr, cfg)
	if err != nil {
		panic("newTestLoop: " + err.Error())
	}

	// Repoint the client at the caller's serverURL so RefreshPromptCache hits
	// the test's prompt-configs handler. Pin strategy to orchestrator so the
	// prompt-cache test's expected team_role=orchestrator matches.
	loop.client = valaris.NewClient(serverURL, "vlr_test")
	loop.client.UserID = client.UserID
	loop.client.Agent = client.Agent
	loop.strategy = NewStrategyFromConfig(*StageForRole(DefaultPipelineConfig, "orchestrator"), loop.sensors)
	loop.scheduler = nil
	// Match owned-roles to the pinned strategy so RefreshPromptCache fetches
	// only the role this helper exposes; the platform-authority pass uses the
	// same set to decide which roles need a prompt.
	loop.ownedStrategies = map[string]Strategy{"orchestrator": loop.strategy}
	// Disable the refresh throttle in unit tests: these exercise the per-call
	// refresh/clear/log behavior directly by invoking RefreshPromptCache
	// repeatedly. The 30s production TTL (storm mitigation) is covered separately.
	loop.refreshTTL = 0
	// Disable the self-trigger rate-floor in unit tests for the same reason;
	// the floor (poll-storm mitigation) is covered by a dedicated test.
	loop.selfTriggerMinInterval = 0
	return loop
}
