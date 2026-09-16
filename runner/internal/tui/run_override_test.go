// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"fmt"
	"github.com/Valaris-Studio/backplane/runner/internal/config"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunOverridePinnedBoardOffersExplicitChoice(t *testing.T) {
	defer ForcePlain()()
	w := atLoopProviderFor(t, pinnedLoopBoard())
	for _, text := range []string{"Follow board settings", "Choose a model for this run"} {
		if !strings.Contains(stripANSI(w.View()), text) {
			t.Fatalf("missing %q in model selection: %s", text, w.View())
		}
	}
	// The loop selector precedes the pinned budget in the tab cycle.
	w = drive(w, tea.KeyMsg{Type: tea.KeyShiftTab}, key("right"), key("tab"), key("right"), key("tab"))
	if !w.providerStep.model.Focused() {
		t.Fatal("explicit selection must expose a keyboard-focusable model even when the board pins a pair")
	}
	w.providerStep.model.SetValue("future-concrete-model-id")
	w = drive(w, key("enter"))
	if !hasLineWithAll(w.View(), "future-concrete-model-id", "per-run") {
		t.Fatalf("review must show effective per-run model: %s", w.View())
	}
	if !hasLineWithAll(w.View(), "gpt-5-codex", "board") {
		t.Fatalf("review must retain board request: %s", w.View())
	}
}

func chooseRunModel(t *testing.T, board BoardChoice, model string) Wizard {
	t.Helper()
	w := atLoopProviderFor(t, board)
	w.providerStep.field = fieldRunModel
	w = drive(w, key("right"), key("tab"))
	w.providerStep.model.SetValue(model)
	return drive(w, key("enter"))
}

func TestRunOverrideApplyAndSavePreserveDefaults(t *testing.T) {
	w := chooseRunModel(t, pinnedLoopBoard(), "custom-future-model")
	r := w.Result()
	if r.RunOverride == nil || r.RunOverride.Model != "custom-future-model" {
		t.Fatalf("missing override: %+v", r.RunOverride)
	}
	base := config.Defaults()
	base.LLM.Provider = "codex-cli"
	base.LLM.Model = "saved-concrete-model"
	applied := r.Apply(base)
	if applied.LLM.Provider != base.LLM.Provider || applied.LLM.Model != base.LLM.Model {
		t.Fatal("override leaked into saved defaults")
	}
	if applied.LLM.RunOverride == nil || applied.LLM.RunOverride.Model != "custom-future-model" {
		t.Fatal("runtime override lost")
	}
	applied.LLM.RunOverride.Model = "mutated-copy"
	if r.RunOverride.Model != "custom-future-model" {
		t.Fatal("Apply aliases Result selection")
	}
	path := filepath.Join(t.TempDir(), "config.yaml")
	if err := SaveConfig(path, r.Apply(base)); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "custom-future-model") || strings.Contains(string(data), "run_override") {
		t.Fatalf("per-run pair persisted: %s", data)
	}
	if !strings.Contains(string(data), "saved-concrete-model") {
		t.Fatal("saved default lost")
	}
}

func TestRunOverrideRejectsTierAndBlankModel(t *testing.T) {
	for _, model := range []string{"premium", "mid", "low", "", "   ", " model-id", "model-id "} {
		t.Run(model, func(t *testing.T) {
			w := chooseRunModel(t, pinnedLoopBoard(), model)
			if w.Step() != StepProvider || w.providerStep.err == nil || w.Result().RunOverride != nil {
				t.Fatalf("invalid model accepted: %q", model)
			}
		})
	}
}

func TestRunOverrideReviewEditsPreserveSelectionAndRowTargets(t *testing.T) {
	for _, label := range []string{"work dir", "budget"} {
		t.Run(label, func(t *testing.T) {
			w := chooseRunModel(t, pinnedLoopBoard(), "one-run-model")
			index := 0
			var target Step
			for i, row := range w.reviewRows() {
				if row.label == label {
					index = i + 1
					target = row.owner
				}
			}
			next, _ := w.jumpToReviewRow(index)
			w = next.(Wizard)
			if w.Step() != target {
				t.Fatalf("jump %s reached %v, want %v", label, w.Step(), target)
			}
			if w.Result().RunOverride == nil {
				t.Fatal("ordinary review edit discarded explicit intent")
			}
			w = drive(w, key("esc"))
			if w.Step() != StepReview || w.Result().RunOverride == nil {
				t.Fatal("return from edit lost override")
			}
		})
	}
}

func TestRunOverrideFollowAndScopeChangesClearSelection(t *testing.T) {
	w := chooseRunModel(t, pinnedLoopBoard(), "one-run-model")
	w = drive(w, key("esc"))
	w.providerStep.field = fieldRunModel
	w = drive(w, key("left"), key("enter"))
	if w.Result().RunOverride != nil || w.Result().Model != pinnedLoopBoard().LoopModel {
		t.Fatal("follow-board did not restore board behavior")
	}
	w = chooseRunModel(t, pinnedLoopBoard(), "one-run-model")
	w.step = StepMode
	w = drive(w, key("down"))
	if w.providerStep.chooseRunModel || w.Result().RunOverride != nil {
		t.Fatal("mode change retained override")
	}
	w = chooseRunModel(t, pinnedLoopBoard(), "one-run-model")
	w.step = StepBoard
	w.boardStep.setBoards([]BoardChoice{unconfiguredLoopBoard()})
	w = drive(w, key("enter"))
	if w.providerStep.chooseRunModel || w.Result().RunOverride != nil {
		t.Fatal("board change retained override")
	}
}

func TestRunOverrideUnavailableProviderAndNonLoopGuard(t *testing.T) {
	w := atLoopProviderFor(t, pinnedLoopBoard())
	w.providerStep.providers = nil
	w.providerStep.field = fieldRunModel
	w = drive(w, key("right"), key("enter"))
	if w.Step() != StepProvider || w.providerStep.err == nil {
		t.Fatal("override without discovered agent accepted")
	}
	w = atProviderForMode(t, ModePipeline, pinnedLoopBoard())
	if strings.Contains(w.View(), "Choose a model for this run") {
		t.Fatal("pipeline exposes loop-only override")
	}
	r := Result{Mode: ModePipeline, RunOverride: &config.ModelSelection{Provider: "claude-cli", Model: "custom-model"}}
	if r.Apply(config.Defaults()).LLM.RunOverride != nil {
		t.Fatal("non-loop override applied")
	}
}

func TestRunOverrideRenderedWidths(t *testing.T) {
	defer ForcePlain()()
	for _, width := range []int{80, 48} {
		t.Run(fmt.Sprint(width), func(t *testing.T) {
			w := atLoopProviderFor(t, pinnedLoopBoard())
			w.width = width
			for _, label := range []string{"Follow board settings", "Choose a model for this run"} {
				if !strings.Contains(w.View(), label) {
					t.Fatalf("choice %q inaccessible at %d", label, width)
				}
			}
			for _, line := range strings.Split(w.runModelLine(New()), "\n") {
				if lipgloss.Width(line) > width {
					t.Fatalf("selector overflows %d: %q", width, line)
				}
			}
			w = chooseRunModel(t, pinnedLoopBoard(), "future-model")
			w.width = width
			view := unwrapPanelProse(w.View())
			if !strings.Contains(view, "future-model") || !strings.Contains(view, "per-run") || !strings.Contains(view, "gpt-5-codex") {
				t.Fatalf("review loses provenance at %d: %s", width, view)
			}
		})
	}
}

func TestRunOverrideLongModelRemainsFullyReadable(t *testing.T) {
	defer ForcePlain()()
	model := strings.Repeat("abcdefghij", 10)
	for _, width := range []int{48, 80} {
		w := chooseRunModel(t, pinnedLoopBoard(), model)
		w.width = width
		plain := strings.ReplaceAll(unwrapPanelProse(w.View()), " ", "")
		if !strings.Contains(plain, model) {
			t.Fatalf("100-character model clipped at width %d: %s", width, w.View())
		}
	}
}

func TestRunOverrideFitsStandardTerminalHeight(t *testing.T) {
	defer ForcePlain()()
	for _, width := range []int{48, 80} {
		for _, choose := range []bool{false, true} {
			w := atLoopProviderFor(t, pinnedLoopBoard())
			w = drive(w, tea.WindowSizeMsg{Width: width, Height: 24})
			w.providerStep.field = fieldRunModel
			if choose {
				w = drive(w, key("right"))
			}
			view := w.View()
			if lines := strings.Count(view, "\n") + 1; lines > 24 {
				t.Fatalf("%dx24 choose=%v has %d lines: %s", width, choose, lines, view)
			}
			if !strings.Contains(view, "Follow board settings") || !strings.Contains(view, "Choose a model for this run") {
				t.Fatal("selector lost in short terminal")
			}
		}
	}
}
