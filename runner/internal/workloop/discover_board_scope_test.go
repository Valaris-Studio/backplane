// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// FOLLOWUP-7: when the runner is configured for a single board, the
// /next-assignment call must pass that board_id so the backend scheduler
// restricts to it. Without this, the documentator on a smoke pipeline
// picks up done-column cards from any other board in the same workspace.
func TestDiscoverWithConfig_NextAssignment_PassesSingleConfiguredBoardID(t *testing.T) {
	var (
		mu         sync.Mutex
		seenBoard  string
		seenCalled bool
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		if r.URL.Path == "/api/workspaces/test-workspace/agents/agent-1/next-assignment" {
			body, _ := io.ReadAll(r.Body)
			var req valaris.NextAssignmentRequest
			_ = json.Unmarshal(body, &req)
			mu.Lock()
			seenBoard = req.BoardID
			seenCalled = true
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Write([]byte("{}"))
	}))
	defer server.Close()

	cfg := &config.Config{
		Valaris: config.ValarisConfig{
			WorkspaceSlug: "test-workspace",
			BoardIDs:      []string{"smoke-board-id"},
		},
	}
	client := valaris.NewClient(server.URL, "vlr_test")
	client.UserID = "user-1"
	client.Agent = &valaris.AgentConfig{ID: "agent-1", Name: "test", AgentType: "coding", IsActive: true}
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop, err := New(context.Background(), client, llm.NewMockProvider(), gitMgr, cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	stage := valaris.StageConfig{
		Role: "documentator",
		Discover: valaris.DiscoverDef{
			Strategy:   "column_scan",
			ColumnType: "done",
		},
	}
	s := NewDataDrivenStrategy(stage, nil)
	loop.strategy = s

	_, err = s.discoverWithConfig(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverWithConfig: %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if !seenCalled {
		t.Fatalf("next-assignment endpoint was not called")
	}
	if seenBoard != "smoke-board-id" {
		t.Errorf("next-assignment board_id = %q, want %q", seenBoard, "smoke-board-id")
	}
}

// Multi-board (or zero-board) config: pass empty board_id and let the backend
// scheduler decide across the workspace. Mirrors legacy column_scan, which
// iterates BoardIDs client-side or falls back to ListBoards when unset.
func TestDiscoverWithConfig_NextAssignment_NoBoardIDWhenMultipleConfigured(t *testing.T) {
	var (
		mu        sync.Mutex
		seenBoard string
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		if r.URL.Path == "/api/workspaces/test-workspace/agents/agent-1/next-assignment" {
			body, _ := io.ReadAll(r.Body)
			var req valaris.NextAssignmentRequest
			_ = json.Unmarshal(body, &req)
			mu.Lock()
			seenBoard = req.BoardID
			mu.Unlock()
			w.WriteHeader(http.StatusNoContent)
			return
		}
		w.Write([]byte("{}"))
	}))
	defer server.Close()

	cfg := &config.Config{
		Valaris: config.ValarisConfig{
			WorkspaceSlug: "test-workspace",
			BoardIDs:      []string{"board-a", "board-b"},
		},
	}
	client := valaris.NewClient(server.URL, "vlr_test")
	client.UserID = "user-1"
	client.Agent = &valaris.AgentConfig{ID: "agent-1", Name: "test", AgentType: "coding", IsActive: true}
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop, err := New(context.Background(), client, llm.NewMockProvider(), gitMgr, cfg)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	stage := valaris.StageConfig{Role: "documentator", Discover: valaris.DiscoverDef{Strategy: "column_scan", ColumnType: "done"}}
	s := NewDataDrivenStrategy(stage, nil)
	loop.strategy = s

	_, _ = s.discoverWithConfig(context.Background(), loop)

	mu.Lock()
	defer mu.Unlock()
	if seenBoard != "" {
		t.Errorf("next-assignment board_id = %q, want empty (multi-board runner)", seenBoard)
	}
}
