// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The backend distinguishes these two 404s in the response body (see
// app/main.py's ValarisError handler and app/services/kanban/board.py's
// get_loop_config): an application-level 404 — bad -loop-board, wrong
// workspace, board deleted, or a real board that has never had loop
// configured — always carries {"detail":..., "error_code":...} via
// ValarisError. FastAPI's own unrouted-path 404 (hit when the backend
// predates the /loop route entirely) never sets error_code; its stock body
// is {"detail":"Not Found"}.

// TestGetBoardLoop_AppLevel404_ReturnsBoardNotConfiguredSentinel proves a 404
// with error_code (an application ResourceNotFoundError — bad -loop-board,
// wrong workspace, or a real, existing board that was never configured for
// loop mode) maps to the specific ErrBoardLoopNotConfigured sentinel, not the
// generic old one.
func TestGetBoardLoop_AppLevel404_ReturnsBoardNotConfiguredSentinel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"detail":"Loop mode not configured for this board","error_code":"not_found"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	cfg, err := client.GetBoardLoop(context.Background(), "acme", "board-1")
	if cfg != nil {
		t.Errorf("expected nil config, got %+v", cfg)
	}
	if !errors.Is(err, ErrBoardLoopNotConfigured) {
		t.Fatalf("expected ErrBoardLoopNotConfigured, got: %v", err)
	}
	if errors.Is(err, ErrLoopEndpointUnsupported) {
		t.Error("an application-level 404 must not also match ErrLoopEndpointUnsupported")
	}
}

// TestGetBoardLoop_UnroutedPath404_ReturnsEndpointUnsupportedSentinel proves
// a 404 with NO error_code (FastAPI's own catch-all for a path with no
// matching route — i.e. a pre-rollout backend that doesn't serve /loop at
// all) maps to the distinct ErrLoopEndpointUnsupported sentinel.
func TestGetBoardLoop_UnroutedPath404_ReturnsEndpointUnsupportedSentinel(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// FastAPI's default unrouted-path 404: no error_code key at all.
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"detail":"Not Found"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	cfg, err := client.GetBoardLoop(context.Background(), "acme", "board-1")
	if cfg != nil {
		t.Errorf("expected nil config, got %+v", cfg)
	}
	if !errors.Is(err, ErrLoopEndpointUnsupported) {
		t.Fatalf("expected ErrLoopEndpointUnsupported, got: %v", err)
	}
	if errors.Is(err, ErrBoardLoopNotConfigured) {
		t.Error("an unrouted-path 404 must not also match ErrBoardLoopNotConfigured")
	}
}

// TestGetBoardLoop_BothSentinels_StillMatchLegacyErrLoopNotConfigured proves
// existing callers that only know about the old, conflated
// ErrLoopNotConfigured sentinel (see client_loop_test.go's
// TestGetBoardLoop_NotFoundReturnsSentinel and
// workloop/loopmode_test.go's TestLoopMode_404OnFetch_FatalError, both
// already in the tree and asserting errors.Is(err, ErrLoopNotConfigured))
// keep working unchanged after the split, for BOTH new branches.
func TestGetBoardLoop_BothSentinels_StillMatchLegacyErrLoopNotConfigured(t *testing.T) {
	cases := []struct {
		name string
		body string
	}{
		{name: "app-level 404 with error_code", body: `{"detail":"not configured","error_code":"not_found"}`},
		{name: "unrouted-path 404 without error_code", body: `{"detail":"Not Found"}`},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(http.StatusNotFound)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer server.Close()

			client := NewClient(server.URL, "vlr_test")
			_, err := client.GetBoardLoop(context.Background(), "acme", "board-1")
			if !errors.Is(err, ErrLoopNotConfigured) {
				t.Fatalf("expected legacy ErrLoopNotConfigured to still match, got: %v", err)
			}
		})
	}
}

// TestGetBoardLoop_EndpointUnsupportedError_IsActionable proves the
// unrouted-path branch's message actually names the "backend too old"
// condition distinctly from "board not configured" — the entire point of
// splitting the sentinel is that an operator reading the log can tell these
// apart without reading source.
func TestGetBoardLoop_EndpointUnsupportedError_IsActionable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"detail":"Not Found"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	_, err := client.GetBoardLoop(context.Background(), "acme", "board-1")
	if err == nil {
		t.Fatal("expected an error")
	}
	msg := err.Error()
	if !containsAny(msg, "backend", "endpoint", "version", "upgrade") {
		t.Errorf("ErrLoopEndpointUnsupported message should name a backend/version/endpoint problem, got: %q", msg)
	}
}

// TestGetBoardLoop_BoardNotConfiguredError_IsActionable is the
// ErrBoardLoopNotConfigured counterpart: its message should point at
// board/workspace identity (-loop-board, wrong workspace, deleted board),
// not backend version.
func TestGetBoardLoop_BoardNotConfiguredError_IsActionable(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"detail":"Loop mode not configured for this board","error_code":"not_found"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	_, err := client.GetBoardLoop(context.Background(), "acme", "board-1")
	if err == nil {
		t.Fatal("expected an error")
	}
	msg := err.Error()
	if !containsAny(msg, "loop-board", "board", "workspace") {
		t.Errorf("ErrBoardLoopNotConfigured message should point at board/workspace identity, got: %q", msg)
	}
}

func containsAny(s string, substrs ...string) bool {
	for _, sub := range substrs {
		if strings.Contains(s, sub) {
			return true
		}
	}
	return false
}
