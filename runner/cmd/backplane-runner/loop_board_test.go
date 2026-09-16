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
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// TestResolveLoopBoardID_FlagWins proves -loop-board always wins outright,
// even when valaris.board_ids also has entries.
func TestResolveLoopBoardID_FlagWins(t *testing.T) {
	cfg := &config.Config{Valaris: config.ValarisConfig{BoardIDs: []string{"board-a", "board-b"}}}
	client := valaris.NewClient("http://unused.invalid", "vlr_test")

	got, err := resolveLoopBoardID(context.Background(), cfg, client, "board-flag")
	if err != nil {
		t.Fatalf("resolveLoopBoardID: %v", err)
	}
	if got != "board-flag" {
		t.Errorf("got %q, want %q", got, "board-flag")
	}
}

// TestResolveLoopBoardID_SoleBoardID proves a single valaris.board_ids entry
// is used when no flag is given.
func TestResolveLoopBoardID_SoleBoardID(t *testing.T) {
	cfg := &config.Config{Valaris: config.ValarisConfig{BoardIDs: []string{"board-only"}}}
	client := valaris.NewClient("http://unused.invalid", "vlr_test")

	got, err := resolveLoopBoardID(context.Background(), cfg, client, "")
	if err != nil {
		t.Fatalf("resolveLoopBoardID: %v", err)
	}
	if got != "board-only" {
		t.Errorf("got %q, want %q", got, "board-only")
	}
}

// TestResolveLoopBoardID_AmbiguousMultipleBoardIDs proves >1 board_ids
// without -loop-board is a fatal, actionable error — the runner never
// guesses which board to bind to.
func TestResolveLoopBoardID_AmbiguousMultipleBoardIDs(t *testing.T) {
	cfg := &config.Config{Valaris: config.ValarisConfig{BoardIDs: []string{"board-a", "board-b"}}}
	client := valaris.NewClient("http://unused.invalid", "vlr_test")

	_, err := resolveLoopBoardID(context.Background(), cfg, client, "")
	if err == nil {
		t.Fatal("expected an error for ambiguous board_ids")
	}
	if !strings.Contains(err.Error(), "loop-board") {
		t.Errorf("error not actionable: %q", err.Error())
	}
}

// TestResolveLoopBoardID_FallsBackToPlatformBinding proves an empty
// board_ids list falls back to GET /api/agents/me/config's board_id.
func TestResolveLoopBoardID_FallsBackToPlatformBinding(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"board_id":"platform-bound-board"}`))
	}))
	defer server.Close()

	cfg := &config.Config{}
	client := valaris.NewClient(server.URL, "vlr_test")

	got, err := resolveLoopBoardID(context.Background(), cfg, client, "")
	if err != nil {
		t.Fatalf("resolveLoopBoardID: %v", err)
	}
	if got != "platform-bound-board" {
		t.Errorf("got %q, want %q", got, "platform-bound-board")
	}
}

// TestResolveLoopBoardID_NoneAvailable_FatalActionableError proves the
// no-flag/no-board_ids/no-platform-binding case fails loudly with guidance
// on all three ways to fix it.
func TestResolveLoopBoardID_NoneAvailable_FatalActionableError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"board_id":null}`))
	}))
	defer server.Close()

	cfg := &config.Config{}
	client := valaris.NewClient(server.URL, "vlr_test")

	_, err := resolveLoopBoardID(context.Background(), cfg, client, "")
	if err == nil {
		t.Fatal("expected an error when no board can be resolved")
	}
	for _, want := range []string{"loop-board", "board_ids", "platform"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q missing actionable hint %q", err.Error(), want)
		}
	}
}
