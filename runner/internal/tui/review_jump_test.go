// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"context"
	"reflect"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/profile"
)

// Card 87509af1 (review half): number keys on the review screen jump straight
// to the owning step, and that step — however it commits or escapes — returns
// DIRECTLY to review instead of walking forward through the rest of the flow.
//
// Numbering contract these tests pin: every summary row the review renders is
// numbered in render order starting at 1, and the number jumps to the step
// that owns the row. A new "backend" row (the committed API URL, owned by the
// credentials step) is appended as the LAST numbered row — the review renders
// no credentials line today, and credentials must be jump-reachable.
//
// Default loop flow (testDeps: board step ran, MCP already usable):
//   1 mode → StepMode          4 agent  → StepProvider
//   2 board → StepBoard        5 model  → StepProvider
//   3 work dir → StepWorkDir   6 budget → StepProvider
//                              7 backend → StepCredentials
// A row the flow skipped is not rendered, not numbered, and not reachable:
// discovery drops the board row (everything after shifts up one), a flow that
// went through the MCP step numbers its row 7 and backend 8.
//
// Result carries NO new fields — this is navigation only.

func TestReviewStep_NumbersEverySummaryRow(t *testing.T) {
	defer ForcePlain()()

	t.Run("loop flow", func(t *testing.T) {
		view := atReview(t, testDeps()).View()
		// Each pin is number+label+value on ONE line. The value disambiguates:
		// the chrome line already carries "agent" next to the digits of the
		// budget note, so label alone could match the wrong line.
		for _, wants := range [][]string{
			{"1", "mode", "loop"},
			{"2", "board", "backplane"},
			{"3", "work dir"},
			{"4", "agent", "claude"},
			{"5", "model", "sonnet"},
			{"6", "budget"},
			// Loop-only row (card 5ffe97cf) — it renumbers everything after it,
			// which is exactly why the jump targets below moved too.
			{"7", "on loop off"},
			{"8", "localhost:8000"},
		} {
			if !hasLineWithAll(view, wants...) {
				t.Errorf("review should render a line carrying all of %v, got:\n%s", wants, view)
			}
		}
	})

	t.Run("discovery flow renumbers past the skipped board", func(t *testing.T) {
		view := atDiscoveryReview(t, testDeps()).View()
		if hasLineWithAll(view, "board") {
			t.Fatalf("discovery review must render no board line, got:\n%s", view)
		}
		for _, wants := range [][]string{
			{"1", "mode", "discovery"},
			{"2", "work dir"},
			{"6", "localhost:8000"},
		} {
			if !hasLineWithAll(view, wants...) {
				t.Errorf("discovery review should render a line carrying all of %v, got:\n%s", wants, view)
			}
		}
	})
}

// Pin (a): jump to workdir, change the directory, commit — and land back on
// review, NOT on the provider step the workdir commit normally advances to.
// This is the no-fall-through rule in its plainest form.
func TestReviewStep_JumpToWorkDir_CommitReturnsDirectlyToReview(t *testing.T) {
	defer ForcePlain()()

	w := atReview(t, testDeps())
	w = drive(w, key("3"))
	if w.Step() != StepWorkDir {
		t.Fatalf("3 on review should jump to the workdir step, got %v", w.Step())
	}

	w = drive(w, key("e"))
	w.workDirStep.input.SetValue("/fresh/scratch")
	w = drive(w, key("enter"), key("enter"))

	if w.Step() != StepReview {
		t.Fatalf("committing a jumped-to workdir must return to review, not advance to %v", w.Step())
	}
	if got := w.Result().WorkDir; got != "/fresh/scratch" {
		t.Errorf("Result.WorkDir = %q, want the directory changed via the jump", got)
	}
	if view := w.View(); !strings.Contains(view, "/fresh/scratch") {
		t.Errorf("review should show the new directory, got:\n%s", view)
	}
}

// Pin (b): jump to the provider step from a pipeline-mode review, change the
// model, commit — review shows the new model.
func TestReviewStep_JumpToProvider_PipelineModelChangeShowsOnReview(t *testing.T) {
	defer ForcePlain()()

	board := BoardChoice{ID: "pb1", Name: "Meridian", Slug: "meridian", RepoCount: 1, PipelineConfigured: true}
	w := drive(atProviderForMode(t, ModePipeline, board), key("enter"))
	if w.Step() != StepReview {
		t.Fatalf("expected StepReview, got %v", w.Step())
	}

	w = drive(w, key("5"))
	if w.Step() != StepProvider {
		t.Fatalf("5 on review should jump to the provider step (model row), got %v", w.Step())
	}

	w.providerStep.model.SetValue("refreshed-model")
	w = drive(w, key("enter"))
	if w.Step() != StepReview {
		t.Fatalf("committing a jumped-to provider step must return to review, got %v", w.Step())
	}
	if got := w.Result().Model; got != "refreshed-model" {
		t.Errorf("Result.Model = %q, want the model changed via the jump", got)
	}
	if view := w.View(); !strings.Contains(view, "refreshed-model") {
		t.Errorf("review should show the new model, got:\n%s", view)
	}
}

// Pin (c) + the esc-from-jumped-step semantics: esc on a jumped-to step
// returns DIRECTLY to review with nothing changed — it does not walk further
// back through the flow. Once back, the jump is spent: review's own esc walks
// back normally.
func TestReviewStep_JumpToCredentials_EscReturnsToReviewUnchanged(t *testing.T) {
	defer ForcePlain()()

	w := atReview(t, testDeps())
	before := w.Result()

	w = drive(w, key("8"))
	if w.Step() != StepCredentials {
		t.Fatalf("8 on review should jump to the credentials step, got %v", w.Step())
	}

	w = drive(w, key("esc"))
	if w.Step() != StepReview {
		t.Fatalf("esc on a jumped-to step must return to review, got %v", w.Step())
	}
	if after := w.Result(); !reflect.DeepEqual(after, before) {
		t.Errorf("an escaped jump must change nothing:\nbefore %+v\nafter  %+v", before, after)
	}

	w = drive(w, key("esc"))
	if w.Step() != StepProvider {
		t.Errorf("after the jump is spent, esc from review must walk back as always, got %v", w.Step())
	}
}

// A flow that really went through the MCP step numbers its row and keeps the
// no-fall-through rule: a jumped provider commit normally advances into
// StepMCP (its status still needs setup), and after a jump it must not.
func TestReviewStep_JumpedProviderCommit_DoesNotFallThroughToMCP(t *testing.T) {
	defer ForcePlain()()

	w := atReviewThroughMCP(t)

	view := w.View()
	for _, wants := range [][]string{
		{"7", "on loop off"},
		{"8", "mcp", "will write"},
		{"9", "localhost:8000"},
	} {
		if !hasLineWithAll(view, wants...) {
			t.Errorf("review after an MCP flow should render a line carrying all of %v, got:\n%s", wants, view)
		}
	}

	w2 := drive(w, key("8"))
	if w2.Step() != StepMCP {
		t.Fatalf("8 should jump to the MCP step this flow ran, got %v", w2.Step())
	}
	w2 = drive(w2, key("esc"))
	if w2.Step() != StepReview {
		t.Fatalf("esc on the jumped-to MCP step must return to review, got %v", w2.Step())
	}

	w = drive(w, key("4"))
	if w.Step() != StepProvider {
		t.Fatalf("4 on review should jump to the provider step, got %v", w.Step())
	}
	w = drive(w, key("enter"))
	if w.Step() != StepReview {
		t.Fatalf("a jumped provider commit must return to review, not fall through to %v", w.Step())
	}
}

// Skip-aware guard: no number may reach a step the flow never showed. Green
// today (digits are inert) — its value is holding once digits DO jump.
func TestReviewStep_SkippedStepNumbersNeverReachTheirSteps(t *testing.T) {
	defer ForcePlain()()

	w := atDiscoveryReview(t, testDeps())
	for _, digit := range []string{"1", "2", "3", "4", "5", "6", "7", "8", "9"} {
		forked := drive(w, key(digit))
		if got := forked.Step(); got == StepBoard || got == StepMCP {
			t.Errorf("digit %s reached %v, a step the discovery flow skipped", digit, got)
		}
	}
}

// Scoping guard: with the profile name editor open, digits are characters,
// not jumps. Green today — pins the resolution of the keybinding collision.
func TestReviewStep_NumbersStayLiteralInProfileNameEditor(t *testing.T) {
	defer ForcePlain()()

	w := drive(atReviewWithEmptyStore(t), key("e"))
	if !w.reviewStep.editingName {
		t.Fatal("`e` with a wired profile store should open the name editor")
	}
	w = typeRunes(w, "3")
	if w.Step() != StepReview {
		t.Fatalf("a digit typed into the name editor must not jump, got %v", w.Step())
	}
	if got := w.reviewStep.nameInput.Value(); !strings.Contains(got, "3") {
		t.Errorf("the digit should land in the name input, got %q", got)
	}
}

// Constraint 3 regression guard (green today, must stay green): esc from
// review itself — no jump in flight — still walks to the previous step.
func TestReviewStep_EscWithoutJumpStillWalksBack(t *testing.T) {
	defer ForcePlain()()

	w := drive(atReview(t, testDeps()), key("esc"))
	if w.Step() != StepProvider {
		t.Errorf("esc from review must keep walking back through the flow, got %v", w.Step())
	}
}

// ------------------------------------------------------------------ helpers --

// atDiscoveryReview walks discovery mode — no board step — to the review.
func atDiscoveryReview(t *testing.T, deps WizardDeps) Wizard {
	t.Helper()
	w := selectMode(t, atModeSelect(t, deps), ModeDiscovery)
	if w.Step() != StepWorkDir {
		t.Fatalf("discovery should skip the board picker, got %v", w.Step())
	}
	w = drive(w, key("enter"), key("enter"))
	if w.Step() != StepReview {
		t.Fatalf("expected StepReview, got %v", w.Step())
	}
	return w
}

// atReviewThroughMCP walks a loop flow whose machine has no usable MCP config,
// choosing "write one for me" on the MCP step, so the review renders the mcp
// row and needsMCPStep stays true — the fall-through hazard under test.
func atReviewThroughMCP(t *testing.T) Wizard {
	t.Helper()
	deps := testDeps()
	deps.MCPStatus = func() MCPConfigStatus {
		return MCPConfigStatus{WriteTo: "/mcp-target/config.json"}
	}
	deps.UvxAvailable = func() bool { return true }

	w := drive(atProvider(t, deps), key("enter"))
	if w.Step() != StepMCP {
		t.Fatalf("a machine needing MCP setup should reach StepMCP, got %v", w.Step())
	}
	w = drive(w, key("enter")) // top choice: write one for me
	if w.Step() != StepReview {
		t.Fatalf("expected StepReview after the MCP choice, got %v", w.Step())
	}
	return w
}

// atReviewWithEmptyStore walks to review with a wired-but-empty profile store,
// declining the post-connect registration offer on the way.
func atReviewWithEmptyStore(t *testing.T) Wizard {
	t.Helper()
	deps := testDeps()
	deps.Profiles = profile.NewStore(t.TempDir())

	w := drive(NewWizard(deps), splashDoneMsg{}, key("enter"))
	w = drive(w, connectedMsg{identity: mustConnect(t, deps)})
	if !w.profileOffer.active {
		t.Fatalf("unknown credentials with a wired store should trigger the registration offer, got step %v", w.Step())
	}
	w = drive(w, key("n"))
	if w.Step() != StepMode {
		t.Fatalf("declining the offer should land on mode select, got %v", w.Step())
	}
	w = selectMode(t, w, ModeLoop)
	boards, err := deps.LoadBoards(context.Background(), "valaris")
	if err != nil {
		t.Fatalf("test deps LoadBoards failed: %v", err)
	}
	w = drive(w, boardsLoadedMsg{boards: boards}, key("enter"), key("enter"), key("enter"))
	if w.Step() != StepReview {
		t.Fatalf("expected StepReview, got %v", w.Step())
	}
	return w
}
