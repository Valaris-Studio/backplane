// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestWizard_BrandMarkPersistsOnEveryStep(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	stops := map[string]Wizard{
		"mode":     atModeSelect(t, deps),
		"board":    atBoardPicker(t, deps),
		"workdir":  atWorkDir(t, deps),
		"provider": atProvider(t, deps),
		"review":   atReview(t, deps),
	}
	for name, w := range stops {
		if view := w.View(); !strings.Contains(view, "BACKPLANE") {
			t.Errorf("the brand mark should stay on screen at the %s step, got:\n%s", name, view)
		}
	}
}

func TestProviderStep_LeftArrowNavigatesChipsNotBack(t *testing.T) {
	defer ForcePlain()()

	w := atProvider(t, testDeps())
	w = drive(w, key("tab")) // leave the loop model selector on Follow board settings
	w = drive(w, key("left"))
	if got := w.Step(); got != StepProvider {
		t.Fatalf("left on the provider chips must move the selection, not leave the step — got %v", got)
	}
	// Two providers, cursor starts at 0: left wraps to the last chip.
	if got := w.Result().Provider; got != "codex" {
		t.Errorf("left should select the previous provider, got %q", got)
	}
	w = drive(w, key("right"))
	if got := w.Result().Provider; got != "claude" {
		t.Errorf("right should select the next provider, got %q", got)
	}

	w = drive(w, key("esc"))
	if got := w.Step(); got != StepWorkDir {
		t.Errorf("esc must still go back from the provider step, got %v", got)
	}
}

func TestReviewStep_BlockedLaunchStaysInTheTUI(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.ValidateLaunch = func(Result) error {
		return errors.New("no MCP server config — the runner cannot reach the platform")
	}

	w := atReview(t, deps)
	model, cmd := w.Update(key("enter"))
	w = model.(Wizard)

	if cmd != nil {
		t.Error("a blocked launch must not quit the program")
	}
	if w.launched {
		t.Error("a blocked launch must not count as launched")
	}
	if view := w.View(); !strings.Contains(view, "no MCP server config") {
		t.Errorf("the rejection should be visible on the review screen, got:\n%s", view)
	}

	// Stepping back clears the stale rejection; returning shows a clean review.
	w = drive(w, key("esc"))
	w = drive(w, key("enter"))
	if w.Step() != StepReview {
		t.Fatalf("expected to be back on review, got %v", w.Step())
	}
	if strings.Contains(w.View(), "launch blocked") {
		t.Error("a rejection must not survive a trip back through the steps")
	}
}

func TestReviewStep_LaunchProceedsWhenValidationPasses(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.ValidateLaunch = func(Result) error { return nil }

	w := atReview(t, deps)
	model, cmd := w.Update(key("enter"))
	w = model.(Wizard)

	if cmd == nil {
		t.Error("a validated launch must quit into the run")
	}
	if !w.launched {
		t.Error("a validated launch must be recorded as launched")
	}
}

// pipelineBoards carries distinct loop and pipeline notes so a view test can
// tell exactly which one the picker chose to show.
func pipelineBoards() []BoardChoice {
	return []BoardChoice{
		{ID: "b1", Name: "Backplane", Slug: "backplane",
			StateNote: "loop off · 3 ready", PipelineNote: "3 ready", PipelineConfigured: true},
		{ID: "b2", Name: "Meridian", Slug: "meridian",
			StateNote: "loop not set up", PipelineNote: "pipeline not set up · no repo linked"},
	}
}

func atPipelineBoardPicker(t *testing.T, deps WizardDeps) Wizard {
	t.Helper()
	w := selectMode(t, atModeSelect(t, deps), ModePipeline)
	w = drive(w, boardsLoadedMsg{boards: pipelineBoards()})
	if w.Step() != StepBoard {
		t.Fatalf("expected StepBoard, got %v", w.Step())
	}
	return w
}

func TestBoardStep_PipelineModeShowsPipelineNotesNotLoopState(t *testing.T) {
	defer ForcePlain()()

	view := atPipelineBoardPicker(t, testDeps()).View()
	for _, want := range []string{"3 ready", "pipeline not set up · no repo linked"} {
		if !strings.Contains(view, want) {
			t.Errorf("pipeline picker should surface %q, got:\n%s", want, view)
		}
	}
	if strings.Contains(view, "loop") {
		t.Errorf("loop state has nothing to do with a pipeline run and must not appear:\n%s", view)
	}
}

func TestBoardStep_PipelineModeWarnsWhenAgentHasNoTeam(t *testing.T) {
	defer ForcePlain()()

	view := atPipelineBoardPicker(t, testDeps()).View()
	if !strings.Contains(view, "no team") {
		t.Errorf("an agent without a team should be warned before picking a board, got:\n%s", view)
	}
}

func TestBoardStep_PipelineModeNamesTeamAndRole(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.Connect = func(context.Context) (Identity, error) {
		return Identity{AgentName: "runner-alpha", TeamName: "core-dev", TeamRole: "developer"}, nil
	}

	view := atPipelineBoardPicker(t, deps).View()
	for _, want := range []string{"core-dev", "developer"} {
		if !strings.Contains(view, want) {
			t.Errorf("pipeline picker should name the agent's %q, got:\n%s", want, view)
		}
	}
	if strings.Contains(view, "no team") {
		t.Errorf("a team-bound agent must not see the no-team warning:\n%s", view)
	}
}

func TestBoardStep_LoopModeStillShowsLoopNotes(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.LoadBoards = func(context.Context, string) ([]BoardChoice, error) { return pipelineBoards(), nil }
	view := atBoardPicker(t, deps).View()

	if !strings.Contains(view, "loop off · 3 ready") {
		t.Errorf("loop mode keeps its loop notes, got:\n%s", view)
	}
}

func TestHelpKey_TogglesHelpOnPickerFiltersInsteadOfSearching(t *testing.T) {
	defer ForcePlain()()

	t.Run("board picker", func(t *testing.T) {
		w := drive(atBoardPicker(t, testDeps()), key("?"))
		if !w.showHelp {
			t.Error("? on the board picker should open help, not feed the filter")
		}
		if got := w.boardStep.filter; got != "" {
			t.Errorf("? must not land in the filter, got %q", got)
		}
		w = drive(w, key("?"))
		if w.showHelp {
			t.Error("a second ? should close help again")
		}
	})

	t.Run("workspace picker", func(t *testing.T) {
		deps := testDeps()
		deps.LoadWorkspaces = func(context.Context) ([]WorkspaceChoice, error) {
			return []WorkspaceChoice{
				{ID: "w1", Name: "Valaris", Slug: "valaris"},
				{ID: "w2", Name: "Acme", Slug: "acme"},
			}, nil
		}
		w := NewWizard(deps)
		w = drive(w, splashDoneMsg{}, key("enter"))
		w = drive(w, connectedMsg{identity: mustConnect(t, deps)})
		workspaces, _ := deps.LoadWorkspaces(context.Background())
		w = drive(w, workspacesLoadedMsg{workspaces: workspaces}, key("?"))

		if !w.showHelp {
			t.Error("? on the workspace picker should open help, not feed the filter")
		}
		if got := w.workspaceStep.filter; got != "" {
			t.Errorf("? must not land in the filter, got %q", got)
		}
	})
}

func TestHelp_ExplainsEachScreenInItsOwnWords(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	stops := map[string]struct {
		w      Wizard
		phrase string // wording only this screen's story would use
		token  string // single word asserted on the rendered view — wrapping never splits a token
	}{
		"mode":           {atModeSelect(t, deps), "spend money", "spend"},
		"board":          {atBoardPicker(t, deps), "ready cards are done", "until"},
		"workdir":        {atWorkDir(t, deps), "hard-resets", "hard-resets"},
		"provider":       {atProvider(t, deps), "coding agent", "coding"},
		"review":         {atReview(t, deps), "nothing you entered is lost", "lost"},
		"pipeline board": {atPipelineBoardPicker(t, deps), "team role", "typed"},
	}
	seen := map[string]string{}
	for name, tc := range stops {
		w := drive(tc.w, key("?"))
		if help := w.stepHelp(); !strings.Contains(help, tc.phrase) {
			t.Errorf("%s help should mention %q, got: %s", name, tc.phrase, help)
		} else if prev, dup := seen[help]; dup {
			t.Errorf("%s and %s share the same help text — every screen tells its own story", name, prev)
		} else {
			seen[help] = name
		}
		if view := w.View(); !strings.Contains(view, tc.token) {
			t.Errorf("%s view should surface its help (token %q), got:\n%s", name, tc.token, view)
		}
	}
}

func TestHelpKey_StaysLiteralInsideATextEditor(t *testing.T) {
	defer ForcePlain()()

	w := drive(atWorkDir(t, testDeps()), key("e"), key("?"))
	if w.showHelp {
		t.Error("? inside the path editor must stay a literal character")
	}
	if got := w.workDirStep.input.Value(); !strings.Contains(got, "?") {
		t.Errorf("? should have reached the path input, got %q", got)
	}
}
