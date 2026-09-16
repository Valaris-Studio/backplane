// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// FIX #5 regression (run-B): the no-change backstop's enforcement was
// "move the card to a `blocked` column". On a board WITHOUT one the move
// no-ops, the card stays in `active`, and the implementer's discover
// re-reserves it 4s later — the production money-loop. De-reservation must be
// INTRINSIC to the card: a durable `blocked` label (backend-visible, survives
// restart) in addition to the participant removal. The column move stays a
// cosmetic best-effort.
//
// duplicateCloseServer's board deliberately has NO `blocked` column — that
// absence is the exact regression that would have caught this live.
func TestGitCommitAndPush_ForceBlockAppliesBlockedLabelWithoutBlockedColumn(t *testing.T) {
	boardID := "b"
	srv, cap := duplicateCloseServer(t, boardID)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := writesCodeStrategy()

	card := &discoverResult{CardID: "card-loop", BoardID: boardID, Title: "Phantom", DefaultBranch: "main"}
	llmResult := &llmStageResult{
		implResult: &implementResult{Status: "done", Summary: "nothing to change"},
	}

	runOnce := func() {
		bare := initBareRemote(t)
		repoDir, err := gitMgr.CloneOrOpen(context.Background(), bare, card.CardID)
		if err != nil {
			t.Fatalf("clone: %v", err)
		}
		branch, _, err := gitMgr.CreateBranch(context.Background(), repoDir, card.CardID, "main")
		if err != nil {
			t.Fatalf("branch: %v", err)
		}
		if _, err := strat.gitCommitAndPush(
			context.Background(), context.Background(),
			loop, card, "exec", repoDir, branch, false,
			func() {}, silentLogger(), llmResult,
		); err != nil {
			t.Fatalf("gitCommitAndPush: %v", err)
		}
	}

	// Drive up to the limit tick, snapshotting moves just before it so we can
	// assert the limit tick itself performs NO move on a blocked-column-less
	// board (the pre-limit ticks legitimately bounce to backlog).
	for i := 0; i < maxConsecutiveNoChangeImplements-1; i++ {
		runOnce()
	}
	movesBeforeLimit := cap.moveCount()
	unassignsBeforeLimit := cap.unassignCount()
	runOnce()

	// (a) participant removed on the limit tick.
	if cap.unassignCount() <= unassignsBeforeLimit {
		t.Errorf("force-block must remove the participant, unassigns=%v", cap.unassigns)
	}
	// (b) durable `blocked` label applied — the intrinsic, restart-proof signal.
	if !cap.labelPatched("blocked") {
		t.Errorf("force-block must stamp the `blocked` label (the durable de-reservation signal), patches=%v", cap.patches)
	}
	// (d) no move performed on the limit tick: the board has no blocked column,
	// and correctness must not depend on one.
	if cap.moveCount() != movesBeforeLimit {
		t.Errorf("limit tick must not move the card on a board with no blocked column, moves=%v", cap.moves)
	}
	if !loop.IsCardBlocked(card.CardID) {
		t.Error("in-memory breaker must also engage (existing behavior)")
	}
}

// (c) of the FIX #5 TDD target: the `blocked` label alone must keep a card out
// of the legacy column scan even when the role's configured exclude_label list
// doesn't mention it, and even in a FRESH process (the in-memory breaker is
// lost on restart — the label is the durable exclusion).
func TestDiscoverColumnScan_BlockedLabelIsBuiltInHardExclusion(t *testing.T) {
	cards := []valaris.Card{
		{ID: "card-parked", BoardID: "board-1", Title: "Force-blocked", ColumnType: "active", Labels: []string{"blocked"}},
	}
	server := newLabelAwareScanServer(t, cards, true)
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "implementer",
		Discover: valaris.DiscoverDef{
			Strategy:   "column_scan",
			ColumnType: "active",
			// No exclude_label filter at all — the exclusion must be built in.
			Filters: map[string]any{"require_git_repo": true},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverColumnScan(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverColumnScan: %v", err)
	}
	if res.CardID != "" {
		t.Errorf("a `blocked`-labeled card must never be reserved by the legacy scan, got %q", res.CardID)
	}
}

// Same hard exclusion for the other legacy fallback: Loop.discover
// (unassigned_or_rework) must skip `blocked`-labeled cards in both its rework
// and unassigned passes.
func TestLegacyDiscover_BlockedLabelIsBuiltInHardExclusion(t *testing.T) {
	cards := []valaris.Card{
		{ID: "card-parked", BoardID: "board-1", Title: "Force-blocked", ColumnType: "active", Labels: []string{"blocked"}},
	}
	server := newLabelAwareScanServer(t, cards, true)
	defer server.Close()

	loop := mustNewLoop(t, testClientWithURL(server.URL), llm.NewMockProvider(),
		&git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}, testConfig())

	res, err := loop.discover(context.Background(), "", false)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if res.CardID != "" {
		t.Errorf("a `blocked`-labeled card must never be reserved by legacy discover, got %q", res.CardID)
	}
}

// H1 (run-2 adversarial review): the backend parks a card whose git_repo_slug
// names no registered repo with the `repo-slug-unresolved` label
// (assignment_service.py REPO_SLUG_UNRESOLVED_LABEL). The legacy-discover
// fallback must treat that label as the same built-in hard exclusion as
// `blocked`/`awaiting-approval` — otherwise a backend outage flips the runner
// onto the fallback and it happily works the very card the backend parked.
func TestDiscoverColumnScan_RepoSlugUnresolvedLabelIsBuiltInHardExclusion(t *testing.T) {
	cards := []valaris.Card{
		{ID: "card-unrouted", BoardID: "board-1", Title: "Unknown repo slug", ColumnType: "active", Labels: []string{"repo-slug-unresolved"}},
	}
	server := newLabelAwareScanServer(t, cards, true)
	defer server.Close()

	stage := valaris.StageConfig{
		Role: "implementer",
		Discover: valaris.DiscoverDef{
			Strategy:   "column_scan",
			ColumnType: "active",
			// No exclude_label filter at all — the exclusion must be built in.
			Filters: map[string]any{"require_git_repo": true},
		},
	}
	loop, s := buildFilterScanLoop(t, server.URL, stage)

	res, err := s.discoverColumnScan(context.Background(), loop)
	if err != nil {
		t.Fatalf("discoverColumnScan: %v", err)
	}
	if res.CardID != "" {
		t.Errorf("a `repo-slug-unresolved`-labeled card must never be reserved by the legacy scan, got %q", res.CardID)
	}
}

func TestLegacyDiscover_RepoSlugUnresolvedLabelIsBuiltInHardExclusion(t *testing.T) {
	cards := []valaris.Card{
		{ID: "card-unrouted", BoardID: "board-1", Title: "Unknown repo slug", ColumnType: "active", Labels: []string{"repo-slug-unresolved"}},
	}
	server := newLabelAwareScanServer(t, cards, true)
	defer server.Close()

	loop := mustNewLoop(t, testClientWithURL(server.URL), llm.NewMockProvider(),
		&git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}, testConfig())

	res, err := loop.discover(context.Background(), "", false)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if res.CardID != "" {
		t.Errorf("a `repo-slug-unresolved`-labeled card must never be reserved by legacy discover, got %q", res.CardID)
	}
}

// FIX #5 part 3: once a card is force-blocked, a configured fail-move (e.g. a
// lifecycle on_failure step `kind: move_card → active`) must NOT re-assert it
// into a discoverable column — in production that step RACED the park and
// undid it every cycle. The move_card kind skips the move for a blocked card
// unless the target is the blocked parking bay itself.
func TestLifecycleMoveCard_SkipsFailMoveWhenCardForceBlocked(t *testing.T) {
	boardID := "board-mc"
	srv, rec := kindHandlersServer(t, boardID)
	loop := newLoopForKindTest(t, srv.URL)

	card := &discoverResult{CardID: "card-1", BoardID: boardID, Title: "t"}
	// Engage the breaker the same way the no-change limit path does.
	for i := 0; i < loop.WorkspaceConfig().MaxReworkAttempts; i++ {
		loop.RecordCardFailure(card.CardID)
	}
	if !loop.IsCardBlocked(card.CardID) {
		t.Fatal("setup invariant: card must be force-blocked")
	}

	strat := NewDataDrivenStrategy(valaris.StageConfig{Role: "x"}, nil)
	ws := makeWalkState(t, loop, strat, card)
	step := &valaris.LifecycleStep{
		Name: "fail_move_back", Kind: "move_card",
		Params: map[string]any{"to_column_type": "active"},
	}

	if _, _, err := lifecycleMoveCard(context.Background(), ws, step); err != nil {
		t.Fatalf("move_card on a blocked card must skip cleanly, got: %v", err)
	}
	if rec.any("/cards/card-1/move", "PATCH") {
		t.Errorf("fail-move must NOT re-assert a force-blocked card into a discoverable column, hits=%v", rec.hits)
	}
}

// M2 (adversarial review): the kind_move_card guard keys on IsCardBlocked, so
// the in-memory block and the durable `blocked` label MUST travel together —
// otherwise a card blocked by the GENERIC failure threshold gets its fail-move
// suppressed with no label stamped: stranded in an active column, invisible
// split-brain with the backend. Every failExecutionTo("blocked") routing
// (the generic threshold force-block included) must stamp the label.
func TestFailWithConfig_GenericThresholdForceBlock_StampsBlockedLabel(t *testing.T) {
	boardID := "b"
	srv, cap := duplicateCloseServer(t, boardID)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := writesCodeStrategy()

	card := &discoverResult{CardID: "card-thresh", BoardID: boardID, Title: "Flaky", DefaultBranch: "main"}
	// One failure short of the threshold: the NEXT failure force-blocks.
	for i := 0; i < loop.WorkspaceConfig().MaxReworkAttempts-1; i++ {
		loop.RecordCardFailure(card.CardID)
	}

	strat.failWithConfig(context.Background(), loop, card, "exec-thresh", "git push: transient boom")
	loop.recordFailure("git push: transient boom", card.CardID) // the caller's contract

	if !loop.IsCardBlocked(card.CardID) {
		t.Fatal("setup invariant: threshold crossing must engage the in-memory breaker")
	}
	if !cap.labelPatched("blocked") {
		t.Errorf("generic-threshold force-block must stamp the `blocked` label so the in-memory block and durable label travel together, patches=%v", cap.patches)
	}
}

// H1 (adversarial review): production discover is backend /next-assignment, and
// a live workspace whose stored pipeline config predates the park labels will
// happily hand out an intrinsically parked card. The runner must refuse to work
// it — treat the tick as no-work (reservation TTL-drains), never fail the card.
func TestDiscoverWithConfig_NextAssignmentReturnsParkedCard_NotWorked(t *testing.T) {
	for _, parkLabel := range []string{"blocked", "awaiting-approval", "repo-slug-unresolved"} {
		t.Run(parkLabel, func(t *testing.T) {
			cards := map[string]any{
				"card": map[string]any{
					"id": "card-parked", "title": "Parked", "labels": []string{parkLabel},
				},
				"board": map[string]any{"id": "board-1", "name": "B"},
			}
			server := nextAssignmentStubServer(t, cards)

			stage := valaris.StageConfig{
				Role:     "implementer",
				Discover: valaris.DiscoverDef{Strategy: "column_scan", ColumnType: "active"},
			}
			loop, s := buildFilterScanLoop(t, server.URL, stage)

			res, err := s.discoverWithConfig(context.Background(), loop)
			if err != nil {
				t.Fatalf("discoverWithConfig: %v", err)
			}
			if res.CardID != "" {
				t.Errorf("an intrinsically parked card handed out by /next-assignment must not be worked, got %q", res.CardID)
			}
		})
	}

	// Control: an unparked assignment flows through unchanged.
	t.Run("unparked_control", func(t *testing.T) {
		cards := map[string]any{
			"card":  map[string]any{"id": "card-free", "title": "Ready", "labels": []string{"frontend"}},
			"board": map[string]any{"id": "board-1", "name": "B"},
		}
		server := nextAssignmentStubServer(t, cards)
		stage := valaris.StageConfig{
			Role:     "implementer",
			Discover: valaris.DiscoverDef{Strategy: "column_scan", ColumnType: "active"},
		}
		loop, s := buildFilterScanLoop(t, server.URL, stage)

		res, err := s.discoverWithConfig(context.Background(), loop)
		if err != nil {
			t.Fatalf("discoverWithConfig: %v", err)
		}
		if res.CardID != "card-free" {
			t.Errorf("an unparked assignment must be worked, got %q", res.CardID)
		}
	})
}

// nextAssignmentStubServer serves the platform config plus a fixed
// /next-assignment payload — the minimal backend-scheduler stub.
func nextAssignmentStubServer(t *testing.T, assignment map[string]any) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if serveDefaultPlatformConfig(w, r) {
			return
		}
		if strings.Contains(r.URL.Path, "/next-assignment") {
			_ = json.NewEncoder(w).Encode(assignment)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("{}"))
	}))
	t.Cleanup(srv.Close)
	return srv
}
