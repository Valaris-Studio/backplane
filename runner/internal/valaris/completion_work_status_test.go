// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCompletionWorkStatusPreservesAuthoritativeResumeState(t *testing.T) {
	payload := `{"pending_count":1,"actionable_count":0,"failed_count":0,"revision":"revision-1","workflows":[{"card_id":"card-1","candidate_id":"candidate-1","phase":"awaiting_review","source_sha":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","merge_sha":null,"policy_hash":"policy-1","attempt":{"id":"attempt-1","status":"claimed","kind":"review","role":"operator-arbiter","provider":"codex-cli","model":"independent-model","expires_at":"2026-09-17T00:00:00Z","lease_state":"active"},"failure":null,"next_action":"wait_for_lease","summary":"Independent assessment is running"}],"next_cursor":null}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/workspaces/default/boards/board-1/completion/work" {
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(payload))
	}))
	defer server.Close()
	state, err := NewClient(server.URL, "fixture").GetCompletionWork(context.Background(), "default", "board-1")
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	var actual map[string]any
	if err := json.Unmarshal(encoded, &actual); err != nil {
		t.Fatal(err)
	}
	if actual["revision"] != "revision-1" {
		t.Fatalf("backend revision discarded: %s", encoded)
	}
	workflows, ok := actual["workflows"].([]any)
	if !ok || len(workflows) != 1 {
		t.Fatalf("backend workflow discarded: %s", encoded)
	}
	workflow := workflows[0].(map[string]any)
	if workflow["next_action"] != "wait_for_lease" || workflow["candidate_id"] != "candidate-1" {
		t.Fatalf("resume identity/action lost: %v", workflow)
	}
	attempt := workflow["attempt"].(map[string]any)
	if attempt["role"] != "operator-arbiter" || attempt["model"] != "independent-model" {
		t.Fatalf("arbitrary dispatch identity lost: %v", attempt)
	}
}

func TestCompletionWorkStatusErrorNeverEchoesControlPlaneBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte(`{"detail":"upstream-secret-fixture"}`))
	}))
	defer server.Close()
	_, err := NewClient(server.URL, "fixture").GetCompletionWork(context.Background(), "default", "board")
	if err == nil || strings.Contains(err.Error(), "upstream-secret-fixture") {
		t.Fatalf("unsafe error: %v", err)
	}
}
