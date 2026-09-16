// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"errors"
	"strings"
	"testing"
)

// Card 87509af1 (workdir half): the free-text path entry exists today but only
// behind the `e` key — nothing on screen says so. These tests pin an explicit
// last row in the option list ("enter a custom path…") that opens the SAME
// editor `e` opens, with the same prepend-and-select commit and the same
// ValidateWorkDir rejection path. `e` itself stays a working shortcut.

// atCustomPathRow cursors to the list's last row — one `up` from the top wraps
// there — which this design defines as the custom-path affordance.
func atCustomPathRow(t *testing.T, w Wizard) Wizard {
	t.Helper()
	if w.Step() != StepWorkDir {
		t.Fatalf("expected StepWorkDir, got %v", w.Step())
	}
	return drive(w, key("up"))
}

func TestWorkDirStep_ListsCustomPathRow(t *testing.T) {
	defer ForcePlain()()

	view := strings.ToLower(stripANSI(atWorkDir(t, testDeps()).View()))
	if !strings.Contains(view, "custom path") {
		t.Errorf("the workdir list should end with an explicit custom-path row, got:\n%s", view)
	}
}

func TestWorkDirStep_CustomPathRowOpensEditorAndCommitsTypedPath(t *testing.T) {
	defer ForcePlain()()

	w := atCustomPathRow(t, atWorkDir(t, testDeps()))
	w = drive(w, key("enter"))
	if w.Step() != StepWorkDir {
		t.Fatalf("enter on the custom-path row must open the editor, not commit a step — got %v", w.Step())
	}
	if !w.workDirStep.editing {
		t.Fatal("enter on the custom-path row should open the same editor `e` opens")
	}

	w.workDirStep.input.SetValue("/scratch/runner-clones")
	w = drive(w, key("enter"))
	if w.workDirStep.editing {
		t.Fatal("committing the typed path should close the editor")
	}
	if got := w.workDirStep.Path(); got != "/scratch/runner-clones" {
		t.Errorf("the typed path should be prepended and selected, got %q", got)
	}

	w = drive(w, key("enter"))
	if w.Step() != StepProvider {
		t.Fatalf("committing the selected custom path should advance like any preset, got %v", w.Step())
	}
	if got := w.Result().WorkDir; got != "/scratch/runner-clones" {
		t.Errorf("Result.WorkDir = %q, want the typed path", got)
	}
}

func TestWorkDirStep_CustomPathRowRejectsGitWorktreePath(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.ValidateWorkDir = func(path string) error {
		if path == "/home/seba/live-checkout" {
			return errors.New("inside a git worktree — a runner rooted here would reset your own work")
		}
		return nil
	}

	w := atCustomPathRow(t, atWorkDir(t, deps))
	w = drive(w, key("enter"))
	if !w.workDirStep.editing {
		t.Fatal("enter on the custom-path row should open the editor")
	}
	w.workDirStep.input.SetValue("/home/seba/live-checkout")
	w = drive(w, key("enter"), key("enter"))

	if w.Step() != StepWorkDir {
		t.Fatalf("a rejected path must not leave the step, got %v", w.Step())
	}
	if view := w.View(); !strings.Contains(view, "inside a git worktree") {
		t.Errorf("the ValidateWorkDir rejection should render on the step, got:\n%s", view)
	}
}

// Regression guard (green today, must stay green): `e` opens the editor from
// any cursor position, including the list's last row — which after this card
// is the custom-path affordance itself.
func TestWorkDirStep_EKeyOpensEditorFromAnyCursor(t *testing.T) {
	defer ForcePlain()()

	t.Run("from a preset row", func(t *testing.T) {
		w := drive(atWorkDir(t, testDeps()), key("down"), key("e"))
		if !w.workDirStep.editing {
			t.Fatal("`e` should open the path editor from a non-top preset")
		}
	})
	t.Run("from the last row", func(t *testing.T) {
		w := drive(atWorkDir(t, testDeps()), key("up"), key("e"))
		if !w.workDirStep.editing {
			t.Fatal("`e` should open the path editor from the list's last row too")
		}
	})
}
