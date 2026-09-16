// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// Verdict-gate tests for the orchestrator's merged-PR shortcut.
//
// Bug 511c20ca: tickCard's "card has already-merged PR, shipping directly"
// branch (strategy_generic.go ~line 138) bypasses applyApproveMergeGate. The
// reviewer's verdict must be consulted independently — without an approved
// verdict-of-record, a card with a merged PR but red CI / request_changes
// verdict would ship to Done. mergedPRShortcutBlocked is the seam.

// verdictResponderServer returns an httptest.Server that replies to the
// GET /api/workspaces/.../verdict endpoint based on the supplied handler.
// All other paths get a generic 200 OK.
func verdictResponderServer(t *testing.T, handler http.HandlerFunc) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/agents/me/config" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"agent_id": "agent-1",
				"workspace_config": map[string]any{
					"pipeline_config": DefaultPipelineConfig,
				},
			})
			return
		}
		if len(r.URL.Path) > len("/verdict") && r.URL.Path[len(r.URL.Path)-len("/verdict"):] == "/verdict" {
			handler(w, r)
			return
		}
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func newGateTestStrategy(t *testing.T, srvURL string) (*DataDrivenStrategy, *Loop) {
	t.Helper()
	cfg := testConfig()
	client := testClientWithURL(srvURL)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}

	loop := mustNewLoop(t, client, nil, gitMgr, cfg)

	stage := StageForRole(DefaultPipelineConfig, "orchestrator")
	if stage == nil {
		t.Fatal("missing default orchestrator stage")
	}
	return NewDataDrivenStrategy(*stage, nil), loop
}

func TestMergedPRShortcut_BlockedWhenNoApproveVerdict(t *testing.T) {
	srv := verdictResponderServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"detail":"No verdict found"}`))
	})

	strategy, loop := newGateTestStrategy(t, srv.URL)
	card := &discoverResult{CardID: "card-1", BoardID: "board-1"}

	blocked, reason := strategy.mergedPRShortcutBlocked(context.Background(), loop, card)
	if !blocked {
		t.Fatal("expected merged-PR shortcut to be blocked when no verdict on record")
	}
	if reason == "" {
		t.Error("expected a non-empty reason explaining the block")
	}
}

func TestMergedPRShortcut_BlockedWhenRequestChangesVerdict(t *testing.T) {
	srv := verdictResponderServer(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(valaris.CardVerdict{
			Decision:  "request_changes",
			NoteID:    "note-1",
			CreatedAt: "2026-04-25T10:00:00Z",
		})
	})

	strategy, loop := newGateTestStrategy(t, srv.URL)
	card := &discoverResult{CardID: "card-1", BoardID: "board-1"}

	blocked, reason := strategy.mergedPRShortcutBlocked(context.Background(), loop, card)
	if !blocked {
		t.Fatal("expected merged-PR shortcut to be blocked on request_changes verdict")
	}
	if reason == "" {
		t.Error("expected a reason on block")
	}
}

func TestMergedPRShortcut_AllowedOnApproveVerdict(t *testing.T) {
	srv := verdictResponderServer(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(valaris.CardVerdict{
			Decision:  "approve",
			NoteID:    "note-1",
			CreatedAt: "2026-04-25T10:00:00Z",
		})
	})

	strategy, loop := newGateTestStrategy(t, srv.URL)
	card := &discoverResult{CardID: "card-1", BoardID: "board-1"}

	blocked, reason := strategy.mergedPRShortcutBlocked(context.Background(), loop, card)
	if blocked {
		t.Fatalf("expected merged-PR shortcut to be allowed on approve verdict, got blocked with reason=%q", reason)
	}
}

func TestMergedPRShortcut_BlockedOnVerdictLookupError(t *testing.T) {
	srv := verdictResponderServer(t, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"detail":"db unreachable"}`))
	})

	strategy, loop := newGateTestStrategy(t, srv.URL)
	card := &discoverResult{CardID: "card-1", BoardID: "board-1"}

	blocked, _ := strategy.mergedPRShortcutBlocked(context.Background(), loop, card)
	if !blocked {
		t.Fatal("expected verdict-lookup transient error to BLOCK the shortcut (fail-closed)")
	}
}
