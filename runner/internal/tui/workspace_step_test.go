// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"context"
	"errors"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// atWorkspacePicker lands on a loaded workspace picker, which sits between the
// connect step and the mode menu.
func atWorkspacePicker(t *testing.T, deps WizardDeps) Wizard {
	t.Helper()
	w := NewWizard(deps)
	w = drive(w, tea.WindowSizeMsg{Width: 100, Height: 40})
	w = drive(w, splashDoneMsg{})
	w = drive(w, key("enter")) // commit the (prefilled) credentials
	w = drive(w, connectedMsg{identity: mustConnect(t, deps)})

	if deps.LoadWorkspaces != nil {
		workspaces, err := deps.LoadWorkspaces(context.Background())
		if err != nil {
			return drive(w, workspacesFailedMsg{err: err})
		}
		return drive(w, workspacesLoadedMsg{workspaces: workspaces})
	}
	return w
}

func threeWorkspaces() []WorkspaceChoice {
	return []WorkspaceChoice{
		{ID: "w1", Name: "Valaris Internal", Slug: "valaris"},
		{ID: "w2", Name: "Acme", Slug: "acme"},
		{ID: "w3", Name: "Meridian", Slug: "meridian"},
	}
}

func TestWorkspaceStep_ListsNamesWithSlugsAndFilters(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.LoadWorkspaces = func(context.Context) ([]WorkspaceChoice, error) { return threeWorkspaces(), nil }
	// No resolved workspace: the operator genuinely has a choice to make.
	deps.Credentials.Workspace = ""

	w := atWorkspacePicker(t, deps)
	if w.Step() != StepWorkspace {
		t.Fatalf("expected StepWorkspace, got %v", w.Step())
	}

	view := w.View()
	for _, want := range []string{"Valaris Internal", "valaris", "Acme", "acme"} {
		if !strings.Contains(view, want) {
			t.Errorf("picker should list %q:\n%s", want, view)
		}
	}

	w = typeRunes(w, "acme")
	visible := w.workspaceStep.visible()
	if len(visible) != 1 || visible[0].Slug != "acme" {
		t.Fatalf("filter %q should leave exactly Acme, got %+v", w.workspaceStep.filter, visible)
	}

	w = drive(w, key("enter"))
	if got := w.Result().Workspace; got != "acme" {
		t.Errorf("enter should select the filtered row, got %q", got)
	}
}

// AllowedWorkspaces narrower than what the user can see: the extras are visible
// (so the operator understands why their workspace is absent from the run) but
// cannot be chosen with this key.
func TestWorkspaceStep_MarksAndBlocksWorkspacesOutsideAllowedList(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.LoadWorkspaces = func(context.Context) ([]WorkspaceChoice, error) { return threeWorkspaces(), nil }
	deps.AllowedWorkspaces = []string{"acme"}
	deps.Credentials.Workspace = ""

	w := atWorkspacePicker(t, deps)

	view := w.View()
	if !strings.Contains(strings.ToLower(view), "not allowed") {
		t.Errorf("a workspace outside the key's allow-list must be marked:\n%s", view)
	}

	// The cursor starts on "valaris", which this key cannot operate in.
	if got := w.workspaceStep.visible()[0].Slug; got != "valaris" {
		t.Fatalf("expected the cursor on valaris, got %q", got)
	}
	w = drive(w, key("enter"))
	if w.Step() != StepWorkspace {
		t.Fatalf("selecting a disallowed workspace must not advance, got %v", w.Step())
	}
	if got := w.Result().Workspace; got == "valaris" {
		t.Errorf("a disallowed workspace must never be committed, got %q", got)
	}

	w = typeRunes(w, "acme")
	w = drive(w, key("enter"))
	if w.Step() == StepWorkspace {
		t.Fatal("an allowed workspace must be selectable")
	}
	if got := w.Result().Workspace; got != "acme" {
		t.Errorf("want acme, got %q", got)
	}
}

// An empty allowed_workspaces means UNRESTRICTED — the same semantics
// validateAgentConfig already enforces. Reading it as "none allowed" would lock
// every unrestricted agent out of its own picker.
func TestWorkspaceStep_EmptyAllowedListMeansEverythingSelectable(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.LoadWorkspaces = func(context.Context) ([]WorkspaceChoice, error) { return threeWorkspaces(), nil }
	deps.AllowedWorkspaces = nil
	deps.Credentials.Workspace = ""

	w := atWorkspacePicker(t, deps)

	if strings.Contains(strings.ToLower(w.View()), "not allowed") {
		t.Errorf("an unrestricted key must mark nothing as blocked:\n%s", w.View())
	}
	for _, ws := range w.workspaceStep.visible() {
		if !w.workspaceStep.selectable(ws) {
			t.Errorf("workspace %q must be selectable for an unrestricted key", ws.Slug)
		}
	}

	w = drive(w, key("enter"))
	if got := w.Result().Workspace; got != "valaris" {
		t.Errorf("want the first workspace committed, got %q", got)
	}
}

func TestWorkspaceStep_SingleWorkspaceAutoSkips(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.LoadWorkspaces = func(context.Context) ([]WorkspaceChoice, error) {
		return []WorkspaceChoice{{ID: "w1", Name: "Valaris Internal", Slug: "valaris"}}, nil
	}
	deps.Credentials.Workspace = ""

	w := atWorkspacePicker(t, deps)

	if w.Step() != StepMode {
		t.Fatalf("a lone workspace needs no picking, got %v", w.Step())
	}
	if got := w.Result().Workspace; got != "valaris" {
		t.Errorf("the lone workspace should be committed anyway, got %q", got)
	}
}

// Auto-skipping must not make the step unreachable: an operator who wants a
// different workspace than the resolved one walks back into it.
func TestWorkspaceStep_ReachableByBackNavigationAfterASkip(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.LoadWorkspaces = func(context.Context) ([]WorkspaceChoice, error) { return threeWorkspaces(), nil }
	deps.Credentials = CredentialSeed{APIKey: "vlr_k", Host: "http://localhost:8000", Workspace: "meridian"}

	w := atWorkspacePicker(t, deps)
	if w.Step() != StepMode {
		t.Fatalf("a resolved, valid workspace should skip the picker, got %v", w.Step())
	}
	if got := w.Result().Workspace; got != "meridian" {
		t.Errorf("the resolved workspace should be committed, got %q", got)
	}

	w = drive(w, key("esc"))
	if w.Step() != StepWorkspace {
		t.Fatalf("esc from mode select must reach the workspace picker, got %v", w.Step())
	}
}

// A resolved slug that is NOT among the caller's workspaces is a
// misconfiguration the picker exists to fix — it must stop rather than skip.
func TestWorkspaceStep_ResolvedButUnknownSlugDoesNotSkip(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.LoadWorkspaces = func(context.Context) ([]WorkspaceChoice, error) { return threeWorkspaces(), nil }
	deps.Credentials = CredentialSeed{APIKey: "vlr_k", Host: "http://localhost:8000", Workspace: "typo-slug"}

	w := atWorkspacePicker(t, deps)

	if w.Step() != StepWorkspace {
		t.Errorf("an unrecognized resolved slug must be corrected, not obeyed, got %v", w.Step())
	}
}

func TestWorkspaceStep_ZeroWorkspacesShowsGuidance(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.LoadWorkspaces = func(context.Context) ([]WorkspaceChoice, error) { return nil, nil }
	deps.Credentials.Workspace = ""

	w := atWorkspacePicker(t, deps)

	if w.Step() != StepWorkspace {
		t.Fatalf("an empty list must not silently advance, got %v", w.Step())
	}
	view := strings.ToLower(w.View())
	for _, want := range []string{"no workspace", "backplane"} {
		if !strings.Contains(view, want) {
			t.Errorf("the empty state should say what to do (missing %q):\n%s", want, w.View())
		}
	}
}

// A backend too old for the endpoint, or a transient failure, must not strand
// an operator whose env already names a workspace.
func TestWorkspaceStep_ListFailureFallsBackToTheResolvedSlug(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.LoadWorkspaces = func(context.Context) ([]WorkspaceChoice, error) {
		return nil, errors.New("connection refused")
	}
	deps.Credentials = CredentialSeed{APIKey: "vlr_k", Host: "http://localhost:8000", Workspace: "valaris"}

	w := atWorkspacePicker(t, deps)

	if w.Step() != StepMode {
		t.Fatalf("a failed list with a resolved slug should fall through, got %v", w.Step())
	}
	if got := w.Result().Workspace; got != "valaris" {
		t.Errorf("the resolved slug must survive the failure, got %q", got)
	}
}

func TestWorkspaceStep_ListFailureWithNoResolvedSlugIsActionable(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.LoadWorkspaces = func(context.Context) ([]WorkspaceChoice, error) {
		return nil, errors.New("connection refused")
	}
	deps.Credentials = CredentialSeed{APIKey: "vlr_k", Host: "http://localhost:8000"}

	w := atWorkspacePicker(t, deps)

	if w.Step() != StepWorkspace {
		t.Fatalf("with nothing to fall back to, the step must hold, got %v", w.Step())
	}
	if !strings.Contains(w.View(), "connection refused") {
		t.Errorf("the failure should be visible:\n%s", w.View())
	}
}

// The whole reason the picker exists: the board list must come from the
// workspace the operator just chose, not from a globally-resolved slug.
func TestBoardLoadUsesTheSelectedWorkspaceSlug(t *testing.T) {
	defer ForcePlain()()

	var loadedFor string
	deps := testDeps()
	deps.LoadWorkspaces = func(context.Context) ([]WorkspaceChoice, error) { return threeWorkspaces(), nil }
	deps.Credentials = CredentialSeed{APIKey: "vlr_k", Host: "http://localhost:8000", Workspace: "valaris"}
	deps.LoadBoards = func(_ context.Context, workspaceSlug string) ([]BoardChoice, error) {
		loadedFor = workspaceSlug
		return nil, nil
	}

	w := atWorkspacePicker(t, deps)
	// The resolved "valaris" auto-skipped the picker; walk back and pick another.
	w = drive(w, key("esc"))
	w = typeRunes(w, "meri")
	if got := len(w.workspaceStep.visible()); got != 1 {
		t.Fatalf("the filter must narrow to the one workspace being selected, got %d matches", got)
	}
	w = drive(w, key("enter"))

	// Entering the board step returns the load command; running it is what a
	// real tea runtime would do. The bound turns a step that refuses to advance
	// into a fast failure — an unbounded loop here once wedged the whole
	// package until the test-binary timeout.
	const maxAdvances = 10 // more than the wizard has steps
	for i := 0; w.Step() != StepBoard; i++ {
		if i == maxAdvances {
			t.Fatalf("wizard stopped advancing at %v — it never reached the board step", w.Step())
		}
		next, cmd := w.Update(key("enter"))
		w = next.(Wizard)
		if cmd != nil {
			_ = cmd()
		}
		if w.modeStep.Selected() != ModeLoop && w.Step() == StepMode {
			t.Fatalf("mode menu should start on loop, got %q", w.modeStep.Selected())
		}
	}

	if loadedFor != "meridian" {
		t.Errorf("boards must load for the SELECTED workspace, got %q", loadedFor)
	}
}
