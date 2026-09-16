// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// GET /loop/status is the platform's loop truth layer — the same payload the
// web chip renders. The runner reads it so the TUI board picker speaks one
// vocabulary with the web UI instead of re-deriving its own dialect.

func TestGetLoopStatus_ReturnsServerResolvedState(t *testing.T) {
	var gotPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		_, _ = w.Write([]byte(`{
			"state":"parked",
			"enabled":true,
			"disabled_reason":null,
			"park_reason":"nothing ready",
			"actionable":false,
			"has_inflight_iteration":false,
			"last_iteration_at":"2026-08-12T10:00:00+00:00",
			"last_iteration_status":"completed",
			"bound_agent_count":2,
			"alive_agent_count":1,
			"spent_usd":3.5,
			"budget_usd":20
		}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	status, err := client.GetLoopStatus(context.Background(), "acme", "board-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if want := "/api/workspaces/acme/boards/board-1/loop/status"; gotPath != want {
		t.Errorf("path = %q, want %q", gotPath, want)
	}
	if status.State != "parked" {
		t.Errorf("State = %q, want %q", status.State, "parked")
	}
	if !status.Enabled {
		t.Error("Enabled = false, want true")
	}
	if status.ParkReason != "nothing ready" {
		t.Errorf("ParkReason = %q, want %q", status.ParkReason, "nothing ready")
	}
	if status.Actionable {
		t.Error("Actionable = true, want false")
	}
	if status.AliveAgentCount != 1 || status.BoundAgentCount != 2 {
		t.Errorf("agent counts = %d alive / %d bound, want 1/2", status.AliveAgentCount, status.BoundAgentCount)
	}
}

// A backend predating the truth layer serves FastAPI's unrouted-path 404 (no
// error_code). The picker must degrade to its own derivation, never break —
// same split GetBoardLoop already pins.
func TestGetLoopStatus_UnroutedPath404_ReturnsEndpointUnsupportedSentinel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"detail":"Not Found"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	status, err := client.GetLoopStatus(context.Background(), "acme", "board-1")
	if status != nil {
		t.Errorf("expected nil status, got %+v", status)
	}
	if !errors.Is(err, ErrLoopEndpointUnsupported) {
		t.Fatalf("expected ErrLoopEndpointUnsupported, got: %v", err)
	}
}

// An application-level 404 here can only be board-not-found: /loop/status is a
// pure board read that serves state="off" for an unconfigured loop rather than
// 404ing. It must NOT be mistaken for a pre-rollout backend.
func TestGetLoopStatus_AppLevel404_IsNotEndpointUnsupported(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"detail":"Board not found","error_code":"not_found"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	status, err := client.GetLoopStatus(context.Background(), "acme", "board-1")
	if status != nil {
		t.Errorf("expected nil status, got %+v", status)
	}
	if err == nil {
		t.Fatal("expected an error for an application-level 404")
	}
	if errors.Is(err, ErrLoopEndpointUnsupported) {
		t.Error("a board-not-found 404 must not be reported as an unsupported endpoint")
	}
}
