// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

func TestCompletionProgressReportsChangesAndRestartWithoutRepeatedWaiting(t *testing.T) {
	revision, phase, action := "revision1", "awaiting_review", "wait_for_lease"
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "GET" {
			t.Errorf("inspection mutated backend: %s", r.Method)
		}
		fmt.Fprintf(w, `{"pending_count":1,"actionable_count":0,"failed_count":0,"revision":%q,"workflows":[{"card_id":"card-1","candidate_id":"candidate-1","phase":%q,"source_sha":"aaaa","policy_hash":"policy","summary":"fixture-private-secret needs attention","next_action":%q}],"next_cursor":null}`, revision, phase, action)
	}))
	defer server.Close()
	var output bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&output, nil)))
	defer slog.SetDefault(old)
	cfg := config.Defaults()
	cfg.Valaris.APIKey = "fixture-private-secret"
	policy := &valaris.BoardLoopConfig{CompletionPolicy: &valaris.CompletionPolicy{Version: 1}}
	newLoop := func() *LoopMode {
		return NewLoopMode(valaris.NewClient(server.URL, "fixture"), cfg, nil, nil, "default", "board-1", "agent-1")
	}
	loop := newLoop()
	for i := 0; i < 2; i++ {
		if _, _, _, err := loop.runCompletionWork(context.Background(), policy, 5); err != nil {
			t.Fatal(err)
		}
	}
	if got := strings.Count(output.String(), "candidate-1"); got != 1 {
		t.Fatalf("unchanged workflow should log once, got %d: %s", got, output.String())
	}
	revision, phase, action = "revision2", "failed", "retry_completion"
	if _, _, _, err := loop.runCompletionWork(context.Background(), policy, 5); err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(output.String(), "candidate-1"); got != 2 {
		t.Fatalf("changed workflow invisible: %s", output.String())
	}
	if _, _, _, err := newLoop().runCompletionWork(context.Background(), policy, 5); err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(output.String(), "candidate-1"); got != 3 {
		t.Fatalf("restart must redisplay workflow: %s", output.String())
	}
	if calls != 4 {
		t.Fatalf("dedup skipped authoritative reads: %d", calls)
	}
	if strings.Contains(output.String(), "fixture-private-secret") {
		t.Fatal("configured secret leaked")
	}
	if !strings.Contains(output.String(), "retry_completion") {
		t.Fatal("next action missing")
	}
}

func TestCompletionPrerequisitesRepeatChecksButNotUnchangedSuccessLogs(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.Write([]byte(`{"policy_hash":"policy","requirements":[]}`))
	}))
	defer server.Close()
	var output bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&output, nil)))
	defer slog.SetDefault(old)
	loop := NewLoopMode(valaris.NewClient(server.URL, "fixture"), config.Defaults(), nil, nil, "default", "board", "agent")
	cfg := &valaris.BoardLoopConfig{CompletionPolicy: &valaris.CompletionPolicy{Version: 1}, CompletionPolicyHash: "policy", CompletionContext: "mandatory"}
	for i := 0; i < 2; i++ {
		if err := loop.preflightCompletionWorkflow(context.Background(), cfg); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 2 {
		t.Fatalf("prerequisite requests were cached: %d", calls)
	}
	if got := strings.Count(output.String(), "Completion workflow prerequisite unverified"); got != 1 {
		t.Fatalf("unchanged logs repeated (%d): %s", got, output.String())
	}
}

func TestParkReasonDistinguishesExplicitBlockedCards(t *testing.T) {
	var readiness valaris.LoopReadiness
	if err := json.Unmarshal([]byte(`{"blocked_count":1,"explicitly_blocked_count":2,"explicitly_blocked_card_ids":["card-a","card-b"]}`), &readiness); err != nil {
		t.Fatal(err)
	}
	got := parkReason(&readiness)
	if !strings.Contains(got, "2 cards in Blocked") || !strings.Contains(got, "1 blocked") {
		t.Fatalf("explicit vs dependency blocks hidden: %q", got)
	}
}
