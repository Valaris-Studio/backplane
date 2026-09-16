// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// Card a84d48f3: in LOOP mode the board's loop config is what actually runs —
// loopmode rebuilds dispatch from the board's provider/model every iteration,
// and the session budget is min(board remaining, yaml llm.max_budget_usd).
// These tests pin the provider step (and review) telling that truth instead of
// re-asking questions whose answers are then ignored.

// pinnedLoopBoard is a board whose loop config pins a CONCRETE provider and
// model. Every value differs from testDeps' defaults (provider "claude" first,
// model "sonnet", budget 5) so a board-sourced value on screen is always
// distinguishable from a defaulted one.
func pinnedLoopBoard() BoardChoice {
	return BoardChoice{
		ID: "lb1", Name: "Fulcrum", Slug: "fulcrum",
		LoopConfigured: true, LoopEnabled: true,
		Actionable: true, ReadyCount: 2, RepoCount: 1,
		StateNote:          "loop on · 2 ready",
		LoopProvider:       "codex",
		LoopModel:          "gpt-5-codex",
		LoopBudgetUSD:      50,
		LoopBudgetLimitUSD: 50,
		BudgetHistory:      &valaris.LoopHistory{LifetimeSpentUSD: 4},
	}
}

// tierLoopBoard pins a TIER ALIAS instead of a concrete model. An alias is
// provider-routing intent, never a runnable model id, so the local fallback
// (yaml llm.provider/llm.model) is what actually runs — the one loop-mode case
// where the local choice still matters.
func tierLoopBoard() BoardChoice {
	b := pinnedLoopBoard()
	b.LoopProvider = ""
	b.LoopModel = "premium"
	return b
}

// unconfiguredLoopBoard has no loop config at all — a loop being set up for
// the first time, which still needs every local answer.
func unconfiguredLoopBoard() BoardChoice {
	return BoardChoice{ID: "lb0", Name: "Fulcrum", Slug: "fulcrum", RepoCount: 1}
}

// atLoopProviderFor walks loop mode onto the provider step with exactly one
// board on offer, so boardStep.chosen carries that board's loop config.
func atLoopProviderFor(t *testing.T, board BoardChoice) Wizard {
	t.Helper()
	return atProviderForMode(t, ModeLoop, board)
}

func atProviderForMode(t *testing.T, mode Mode, board BoardChoice) Wizard {
	t.Helper()
	w := selectMode(t, atModeSelect(t, testDeps()), mode)
	w = drive(w, boardsLoadedMsg{boards: []BoardChoice{board}})
	if w.Step() != StepBoard {
		t.Fatalf("expected StepBoard, got %v", w.Step())
	}
	w = drive(w, key("enter")) // pick the only board
	if w.Step() != StepWorkDir {
		t.Fatalf("expected StepWorkDir after picking the board, got %v", w.Step())
	}
	w = drive(w, key("enter")) // accept the default work dir
	if w.Step() != StepProvider {
		t.Fatalf("expected StepProvider, got %v", w.Step())
	}
	if mode == ModeLoop {
		if w.providerStep.field != fieldRunModel {
			t.Fatal("loop entry must focus model-selection choice")
		}
		// These legacy follow-board tests exercise the original fields after the new selector.
		w = drive(w, key("tab"))
	}
	return w
}

// hasLineWithAll reports whether some rendered line carries every want,
// case-insensitively — the "these facts appear together" assertion, without
// pinning which column anything sits in.
func hasLineWithAll(view string, wants ...string) bool {
	for _, line := range strings.Split(strings.ToLower(stripANSI(view)), "\n") {
		ok := true
		for _, want := range wants {
			if !strings.Contains(line, strings.ToLower(want)) {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}

// Pin (1)+(2a): a chosen board carrying loop config renders the board's
// provider, model and budget on the loop-mode provider step, each visibly
// labelled as the BOARD's — not offered as if they were still a question.
func TestProviderStep_LoopBoardPinned_ShowsBoardValuesLabelledBoard(t *testing.T) {
	defer ForcePlain()()

	view := atLoopProviderFor(t, pinnedLoopBoard()).View()
	for _, want := range []string{"codex", "gpt-5-codex", "50.00"} {
		if !hasLineWithAll(view, want, "board") {
			t.Errorf("the board's %q should render labelled as the board's, got:\n%s", want, view)
		}
	}
}

// Pin (2b): when the board pins concrete values, the chip list and model text
// are not interactable — arrows and stray typing change nothing, and the
// committed Result carries the BOARD's provider and model, because that is
// what will actually run.
func TestProviderStep_LoopBoardPinned_CommitsBoardProviderAndModel(t *testing.T) {
	defer ForcePlain()()

	w := atLoopProviderFor(t, pinnedLoopBoard())

	// Two rights would wrap claude→codex→claude in the editable step; a digit
	// is harmless to a budget field but would reach an editable model field.
	w = drive(w, key("right"), key("right"))
	w = typeRunes(w, "7")

	res := w.Result()
	if res.Provider != "codex" {
		t.Errorf("board pins the provider: Result.Provider = %q, want %q", res.Provider, "codex")
	}
	if res.Model != "gpt-5-codex" {
		t.Errorf("board pins the model: Result.Model = %q, want %q", res.Model, "gpt-5-codex")
	}

	w = drive(w, key("enter"))
	if w.Step() != StepReview {
		t.Fatalf("enter should commit and advance to review, got %v", w.Step())
	}
	res = w.Result()
	if res.Provider != "codex" || res.Model != "gpt-5-codex" {
		t.Errorf("committed Result must carry the board's provider/model, got %q/%q",
			res.Provider, res.Model)
	}
}

// Pin (2c): the one editable field is the per-session budget ceiling. It is
// prefilled from the base config's llm.max_budget_usd and commits to
// Result.BudgetUSD without disturbing the board-pinned provider/model.
func TestProviderStep_LoopBoardPinned_BudgetCeilingIsTheOneEditableField(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	w := atLoopProviderFor(t, pinnedLoopBoard())

	// Untouched, the ceiling is the injected default.
	w2 := drive(w, key("enter"))
	if got := w2.Result().BudgetUSD; got != deps.DefaultBudget {
		t.Errorf("ceiling should prefill from llm.max_budget_usd: got %v, want %v", got, deps.DefaultBudget)
	}

	w.providerStep.budget.SetValue("10.00")
	w = drive(w, key("enter"))
	res := w.Result()
	if res.BudgetUSD != 10 {
		t.Errorf("edited ceiling should commit to Result.BudgetUSD: got %v, want 10", res.BudgetUSD)
	}
	if res.Provider != "codex" || res.Model != "gpt-5-codex" {
		t.Errorf("editing the ceiling must not disturb the board's provider/model, got %q/%q",
			res.Provider, res.Model)
	}
}

// Pin (2c) copy: the step states the effective-budget rule — the session gets
// min(board remaining, ceiling) — in words the operator can act on. "board
// remaining" is the pinned phrase, matching the runner's own cap_source log.
func TestProviderStep_LoopBoardPinned_ExplainsEffectiveBudgetRule(t *testing.T) {
	defer ForcePlain()()

	view := unwrapPanelProse(atLoopProviderFor(t, pinnedLoopBoard()).View())
	if !strings.Contains(strings.ToLower(view), "board remaining") {
		t.Errorf("the step should state the min(board remaining, ceiling) rule, got:\n%s", view)
	}
}

// Pin (2d): the effective preview is live and is the MIN, pinned from both
// sides: a ceiling below the board's budget wins, a ceiling above it loses.
func TestProviderStep_LoopBoardPinned_EffectivePreviewIsTheMin(t *testing.T) {
	defer ForcePlain()()

	t.Run("ceiling below board budget", func(t *testing.T) {
		w := atLoopProviderFor(t, pinnedLoopBoard()) // board budget 50
		w.providerStep.budget.SetValue("10.00")
		if view := w.View(); !hasLineWithAll(view, "effective", "10.00") {
			t.Errorf("board 50 with ceiling 10 should preview an effective 10.00, got:\n%s", view)
		}
	})
	t.Run("ceiling above board budget", func(t *testing.T) {
		w := atLoopProviderFor(t, pinnedLoopBoard())
		w.providerStep.budget.SetValue("80.00")
		if view := w.View(); !hasLineWithAll(view, "effective", "50.00") {
			t.Errorf("board 50 with ceiling 80 should preview an effective 50.00, got:\n%s", view)
		}
	})
}

// Pin (3): a tier alias (premium/mid/low) is not runnable — the local
// provider/model become active again as the FALLBACK, labelled as such, and
// the committed Result carries the operator's local choice.
func TestProviderStep_LoopBoardTierAlias_OffersLabelledLocalFallback(t *testing.T) {
	defer ForcePlain()()

	w := atLoopProviderFor(t, tierLoopBoard())

	view := w.View()
	if !hasLineWithAll(view, "premium", "board") {
		t.Errorf("the board's tier alias should render as the board's, got:\n%s", view)
	}
	if !strings.Contains(strings.ToLower(unwrapPanelProse(view)), "fallback") {
		t.Errorf("the local provider/model should be labelled as the fallback, got:\n%s", view)
	}

	// Chips are interactable in the alias case: right moves claude → codex.
	w = drive(w, key("right"))
	if got := w.Result().Provider; got != "codex" {
		t.Errorf("with a tier-alias board the provider chips must move, got %q", got)
	}

	w.providerStep.model.SetValue("local-fallback-model")
	w = drive(w, key("enter"))
	if w.Step() != StepReview {
		t.Fatalf("enter should commit the fallback and advance, got %v", w.Step())
	}
	res := w.Result()
	if res.Model != "local-fallback-model" {
		t.Errorf("the committed model must be the operator's local fallback, got %q", res.Model)
	}
	if res.Provider != "codex" {
		t.Errorf("the committed provider must be the operator's local choice, got %q", res.Provider)
	}
}

// Pin (4): loop mode against a board with NO loop config behaves exactly like
// today's editable step — a loop configured for the first time still needs
// every local answer. Deliberately green before the change and it must stay so.
func TestProviderStep_LoopBoardUnconfigured_StaysFullyEditable(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	w := atLoopProviderFor(t, unconfiguredLoopBoard())

	w = drive(w, key("right"))
	if got := w.Result().Provider; got != "codex" {
		t.Errorf("unconfigured board: provider chips must stay interactable, got %q", got)
	}

	w = drive(w, key("enter"))
	res := w.Result()
	if res.Model != deps.DefaultModel {
		t.Errorf("unconfigured board: model should stay the local default, got %q", res.Model)
	}
	if res.BudgetUSD != deps.DefaultBudget {
		t.Errorf("unconfigured board: budget should stay the local default, got %v", res.BudgetUSD)
	}
	if view := w.View(); strings.Contains(view, "(board)") {
		t.Errorf("unconfigured board: nothing should claim board provenance, got:\n%s", view)
	}
}

// Pipeline-mode guard: the pipeline scheduler resolves tiers server-side and
// never reads the board's loop config, so the provider step must render
// byte-identically whether or not the chosen board carries loop-config values,
// and the flow stays fully editable. Deliberately green before the change.
func TestProviderStep_PipelineMode_IgnoresBoardLoopConfig(t *testing.T) {
	defer ForcePlain()()

	plain := pinnedLoopBoard()
	plain.LoopProvider, plain.LoopModel, plain.LoopBudgetUSD = "", "", 0

	withLoop := atProviderForMode(t, ModePipeline, pinnedLoopBoard())
	without := atProviderForMode(t, ModePipeline, plain)
	if withLoop.View() != without.View() {
		t.Errorf("pipeline provider step must be byte-identical with and without board loop config:\n--- with ---\n%s\n--- without ---\n%s",
			withLoop.View(), without.View())
	}

	w := drive(withLoop, key("right"))
	if got := w.Result().Provider; got != "codex" {
		t.Errorf("pipeline mode: provider chips must stay interactable, got %q", got)
	}
	w = drive(w, key("enter"))
	res := w.Result()
	if res.Model != testDeps().DefaultModel {
		t.Errorf("pipeline mode: model should stay the local answer, got %q", res.Model)
	}

	view := w.View()
	if strings.Contains(view, "(board)") {
		t.Errorf("pipeline review must carry no board provenance marker, got:\n%s", view)
	}
	if strings.Contains(strings.ToLower(view), "effective") {
		t.Errorf("pipeline review must not show an effective-budget line, got:\n%s", view)
	}
}

// Pin (5): the loop-mode review screen marks provider and model as the
// board's — "(board)" is the pinned marker — and the budget line shows both
// the ceiling and the effective min.
func TestReviewStep_LoopBoardPinned_ShowsBoardProvenanceAndEffectiveBudget(t *testing.T) {
	defer ForcePlain()()

	w := atLoopProviderFor(t, pinnedLoopBoard())
	w.providerStep.budget.SetValue("80.00")
	w = drive(w, key("enter"))
	if w.Step() != StepReview {
		t.Fatalf("expected the review step, got %v", w.Step())
	}

	view := w.View()
	if !hasLineWithAll(view, "codex", "(board)") {
		t.Errorf("review should mark the provider as the board's, got:\n%s", view)
	}
	if !hasLineWithAll(view, "gpt-5-codex", "(board)") {
		t.Errorf("review should mark the model as the board's, got:\n%s", view)
	}
	// Ceiling 80 against board budget 50: both numbers belong on the budget
	// line, effective named as such.
	if !hasLineWithAll(view, "80.00", "50.00", "effective") {
		t.Errorf("review budget line should show ceiling 80.00 with effective 50.00, got:\n%s", view)
	}
}
