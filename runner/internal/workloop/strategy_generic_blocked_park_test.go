// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/git"
	"github.com/Valaris-Studio/backplane/runner/internal/llm"
)

// Gap #1+#2 (a live run, 2026-06-26): when an agent returns status=blocked
// (it genuinely cannot complete the card — e.g. a licensed asset that can't be
// produced in code), the old path called failWithConfig + recordFailure but did
// NOT apply the `blocked` label. The card stayed eligible in `active`, so the
// backend scheduler re-dispatched it every cycle (~8x observed), each a full
// no-op execution burning budget — until a human hand-applied the label. The
// agent couldn't self-park: its allowlist excludes update_card, so it had no
// lever; it repurposed an approval gate as an improvised brake.
//
// The cure (same failure CLASS + same park template as parkForReconcile /
// parkForRuntimeProof): the ENGINE auto-applies the `blocked` label on a blocked
// decision — a durable, backend-visible park (every discover excludes `blocked`)
// the agent needs no permission for. label load-bearing-first; note; unassign;
// execution aborted (terminal, not a dangling `running`).

func assertBlockedPark(t *testing.T, cap *dupCloseCapture) {
	t.Helper()
	if !cap.labelPatched(blockedLabel) {
		t.Errorf("blocked park must stamp the `%s` label so the card leaves discovery, patches=%v", blockedLabel, cap.patches)
	}
	if cap.unassignCount() == 0 {
		t.Errorf("blocked park must unassign the agent, unassigns=%v", cap.unassigns)
	}
	if !cap.noteTitled("Card blocked — parked for human follow-up") {
		t.Errorf("blocked park must write the human-follow-up note, notes=%v", cap.notes)
	}
	// The raising execution is closed terminally (never left dangling as
	// `running`, which 409s agent_busy on every next_assignment).
	if !cap.executionPatchedStatus("aborted") {
		t.Errorf("blocked park must close the execution as aborted, exec_patches=%v", cap.execPatches)
	}
}

func TestParkForBlocked_AppliesLabelUnassignsAndNotes(t *testing.T) {
	boardID := "b"
	srv, cap := duplicateCloseServer(t, boardID)
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := writesCodeStrategy()

	card := &discoverResult{
		CardID: "card-a3b", BoardID: boardID, Title: "Add licensed fonts",
		DefaultBranch: "main",
	}

	parked := strat.parkForBlocked(
		context.Background(), loop, card, "exec-blk",
		"licensed .ttf fonts cannot be produced in code", silentLogger(),
	)
	if !parked {
		t.Fatal("parkForBlocked must report a bound park (true)")
	}
	assertBlockedPark(t, cap)
}

// Load-bearing-first (mirrors the runtime-proof park's H2 guard): if the label
// PATCH fails, the park did NOT bind. parkForBlocked must report false so the
// caller falls back to the ordinary bounded failure path — never write a note
// claiming the card is safely parked when it is still discoverable.
func TestParkForBlocked_LabelWriteFails_ReportsUnbound(t *testing.T) {
	boardID := "b"
	srv, cap := duplicateCloseServer(t, boardID)
	cap.failCardPatch = true // label PATCH 500s
	gitMgr := &git.Manager{BaseDir: t.TempDir(), DefaultRemote: "origin", BranchPrefix: "runner/"}
	loop := mustNewLoop(t, testClientWithURL(srv.URL), llm.NewMockProvider(), gitMgr, testConfig())
	strat := writesCodeStrategy()

	card := &discoverResult{CardID: "card-bindfail", BoardID: boardID, Title: "x", DefaultBranch: "main"}

	parked := strat.parkForBlocked(
		context.Background(), loop, card, "exec-blk",
		"cannot complete", silentLogger(),
	)
	if parked {
		t.Fatal("a park that failed to bind the label must report false")
	}
	if cap.noteTitled("Card blocked — parked for human follow-up") {
		t.Error("an unbound park must NOT write the parked note (the card is not actually parked)")
	}
}
