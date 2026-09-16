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
)

// Run must poll IMMEDIATELY on startup, not wait a full PollInterval for the
// first ticker tick. time.NewTicker does not fire at t=0, so without an explicit
// initial pollCycle the runner sits idle for the whole interval (2m in prod)
// before it ever looks for work — a real, repeated waste every launch. With no
// TriggerPoll and a PollInterval long enough that the ticker can't fire during
// the test, a tick must still happen shortly after Run starts.
func TestRun_PollsImmediatelyOnStartup(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agents/me/config" {
			json.NewEncoder(w).Encode(map[string]any{"agent_id": "agent-1", "workspace_config": map[string]any{"pipeline_config": DefaultPipelineConfig}})
			return
		}
		w.WriteHeader(http.StatusOK)
		json.NewEncoder(w).Encode(map[string]any{
			"id": "agent-1", "name": "test", "agent_type": "coding", "is_active": true,
		})
	}))
	defer server.Close()

	cfg := testConfig()
	// Long enough that the ticker cannot fire during the test window — the only
	// way a tick happens is the startup poll under test.
	cfg.WorkLoop.PollInterval = 10 * time.Minute

	client := testClientWithURL(server.URL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	mock := llm.NewMockProvider()

	cs := &countingStrategy{}
	loop := mustNewLoop(t, client, mock, gitMgr, cfg)
	loop.strategy = cs
	loop.scheduler = nil // pin to the counting strategy; bypass multi-role dispatch
	loop.ownedStrategies = nil

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- loop.Run(ctx, ctx) }()

	// Give the startup poll a moment. No TriggerPoll is sent and the ticker
	// (10m) cannot fire, so any tick proves the immediate startup poll.
	time.Sleep(200 * time.Millisecond)
	got := cs.TickCount()

	cancel()
	<-done

	if got < 1 {
		t.Errorf("Run did not poll on startup: tick count = %d, want >= 1 "+
			"(runner must not idle a full PollInterval before first looking for work)", got)
	}
}
