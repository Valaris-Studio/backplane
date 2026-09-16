// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/tui"
)

func TestDoctorResumeShowsPreservedCandidateAndExplicitRetryWithoutMutation(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "GET" || !strings.HasSuffix(r.URL.Path, "/completion/work") {
			t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		w.Write([]byte(`{"pending_count":0,"actionable_count":0,"failed_count":1,"revision":"revision","workflows":[{"card_id":"card-1","candidate_id":"preserved-candidate","phase":"failed","source_sha":"aaaaaaaa","policy_hash":"policy","attempt":{"id":"attempt-1","status":"rejected","kind":"review","role":"custom-arbiter","provider":"codex-cli","model":"review-model","lease_state":"closed"},"failure":{"code":"completion_context_changed","retryable":true},"next_action":"retry_completion","summary":"fixture-secret mandatory context changed"}]}`))
	}))
	defer server.Close()
	cfg := config.Defaults()
	cfg.Valaris.BoardIDs = []string{"board-1"}
	cfg.LLM.Provider = "unavailable-source-runtime"
	creds := Credentials{APIURL: server.URL, APIKey: "fixture-secret", Workspace: "default"}
	row := checkCompletionResume(context.Background(), cfg, creds)
	if row.State != tui.StateWarn || calls != 1 {
		t.Fatalf("resume state unavailable: %#v calls=%d", row, calls)
	}
	for _, want := range []string{"preserved-candidate", "attempt-1", "custom-arbiter", "retry_completion", "completion_context_changed"} {
		if !strings.Contains(row.Detail, want) {
			t.Errorf("missing %q: %s", want, row.Detail)
		}
	}
	if strings.Contains(row.Detail, "fixture-secret") {
		t.Fatal("secret leaked")
	}
}
