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

// testDeps is a wizard wired to pure in-memory answers — no network, no
// filesystem, no exec. Every test builds from this so a regression that
// reintroduces direct I/O fails to compile or hangs visibly.
func testDeps() WizardDeps {
	return WizardDeps{
		Connect: func(context.Context) (Identity, error) {
			return Identity{
				AgentName:  "runner-alpha",
				User:       "seba@valaris.dev",
				BudgetNote: "$42.00 remaining today",
			}, nil
		},
		LoadBoards: func(context.Context, string) ([]BoardChoice, error) {
			return []BoardChoice{
				{ID: "b1", Name: "Backplane", Slug: "backplane", StateNote: "loop off · 3 ready", ReadyCount: 3},
				{ID: "b2", Name: "Acme", Slug: "acme", StateNote: "loop on · 1 ready", LoopEnabled: true, ReadyCount: 1},
				{ID: "b3", Name: "Meridian", Slug: "meridian", StateNote: "no repo bound"},
			}, nil
		},
		ValidateWorkDir: func(string) error { return nil },
		Providers:       []string{"claude", "codex"},
		DefaultWorkDir:  "/home/operator/backplane-runner/repos",
		DefaultModel:    "sonnet",
		DefaultBudget:   5,
		Version:         "v1.2.3",
		// Prefilled and complete: every legacy test drives a flow whose
		// credentials step is a single Enter, matching an operator whose env
		// already works.
		Credentials: CredentialSeed{
			APIKey:          "vlr_test_key",
			APIKeySource:    "environment",
			Host:            "http://localhost:8000",
			HostSource:      "environment",
			Workspace:       "valaris",
			WorkspaceSource: "environment",
		},
	}
}

// drive applies messages in order, discarding commands (tests assert on state,
// not on the tea runtime).
func drive(w Wizard, msgs ...tea.Msg) Wizard {
	for _, m := range msgs {
		model, _ := w.Update(m)
		w = model.(Wizard)
	}
	return w
}

func key(s string) tea.KeyMsg {
	switch s {
	case "enter":
		return tea.KeyMsg{Type: tea.KeyEnter}
	case "up":
		return tea.KeyMsg{Type: tea.KeyUp}
	case "down":
		return tea.KeyMsg{Type: tea.KeyDown}
	case "left":
		return tea.KeyMsg{Type: tea.KeyLeft}
	case "right":
		return tea.KeyMsg{Type: tea.KeyRight}
	case "esc":
		return tea.KeyMsg{Type: tea.KeyEsc}
	case "ctrl+c":
		return tea.KeyMsg{Type: tea.KeyCtrlC}
	case "space":
		return tea.KeyMsg{Type: tea.KeySpace}
	case "backspace":
		return tea.KeyMsg{Type: tea.KeyBackspace}
	case "tab":
		return tea.KeyMsg{Type: tea.KeyTab}
	}
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(s)}
}

func typeRunes(w Wizard, s string) Wizard {
	for _, r := range s {
		w = drive(w, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{r}})
	}
	return w
}

// atModeSelect fast-forwards past splash, the (prefilled) credentials step and
// a successful connect. With no LoadWorkspaces dep the picker has nothing to
// offer and falls through to the resolved slug.
func atModeSelect(t *testing.T, deps WizardDeps) Wizard {
	t.Helper()
	w := NewWizard(deps)
	w = drive(w, tea.WindowSizeMsg{Width: 100, Height: 40})
	w = drive(w, splashDoneMsg{})
	w = drive(w, key("enter"))
	w = drive(w, connectedMsg{identity: mustConnect(t, deps)})
	if w.Step() != StepMode {
		t.Fatalf("expected StepMode after connect, got %v", w.Step())
	}
	return w
}

func mustConnect(t *testing.T, deps WizardDeps) Identity {
	t.Helper()
	id, err := deps.Connect(context.Background())
	if err != nil {
		t.Fatalf("test deps Connect failed: %v", err)
	}
	return id
}

// selectMode drives the mode menu to the named mode and presses enter.
func selectMode(t *testing.T, w Wizard, want Mode) Wizard {
	t.Helper()
	for i := 0; i < len(allModes)+1; i++ {
		if w.modeStep.Selected() == want {
			return drive(w, key("enter"))
		}
		w = drive(w, key("down"))
	}
	t.Fatalf("mode %q never reachable from the menu", want)
	return w
}

func TestWizard_SplashAdvancesOnKeyOrTimer(t *testing.T) {
	defer ForcePlain()()

	t.Run("timer", func(t *testing.T) {
		w := drive(NewWizard(testDeps()), splashDoneMsg{})
		if w.Step() != StepCredentials {
			t.Errorf("splash timer should advance to credentials, got %v", w.Step())
		}
	})
	t.Run("any key", func(t *testing.T) {
		w := drive(NewWizard(testDeps()), key("x"))
		if w.Step() != StepCredentials {
			t.Errorf("keypress should skip the splash, got %v", w.Step())
		}
	})
	t.Run("renders version", func(t *testing.T) {
		w := NewWizard(testDeps())
		w = drive(w, tea.WindowSizeMsg{Width: 100, Height: 40})
		if !strings.Contains(w.View(), "v1.2.3") {
			t.Errorf("splash should show the version, got:\n%s", w.View())
		}
	})
}

func TestWizard_ConnectFailureIsActionableAndDoesNotAdvance(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.Connect = func(context.Context) (Identity, error) {
		return Identity{}, errors.New("401 unauthorized: check BACKPLANE_API_KEY")
	}

	w := drive(NewWizard(deps), splashDoneMsg{}, key("enter"),
		connectFailedMsg{err: errors.New("401 unauthorized: check BACKPLANE_API_KEY")})

	if w.Step() != StepConnect {
		t.Fatalf("a failed connect must not advance, got %v", w.Step())
	}
	view := w.View()
	for _, want := range []string{"401 unauthorized", "BACKPLANE_API_KEY", "retry"} {
		if !strings.Contains(strings.ToLower(view), strings.ToLower(want)) {
			t.Errorf("connect failure view should mention %q, got:\n%s", want, view)
		}
	}
}

func TestWizard_ConnectSuccessShowsIdentityAndAdvances(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	w := drive(NewWizard(deps), splashDoneMsg{}, key("enter"))
	if w.Step() != StepConnect {
		t.Fatalf("want StepConnect, got %v", w.Step())
	}
	w = drive(w, connectedMsg{identity: mustConnect(t, deps)})

	if w.Step() != StepMode {
		t.Fatalf("successful connect should advance to mode select, got %v", w.Step())
	}
	view := w.View()
	for _, want := range []string{"runner-alpha", "valaris"} {
		if !strings.Contains(view, want) {
			t.Errorf("identity %q should stay visible after connect, got:\n%s", want, view)
		}
	}
}

func TestWizard_ConnectRetryReissuesTheRequest(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	w := drive(NewWizard(deps), splashDoneMsg{}, key("enter"), connectFailedMsg{err: errors.New("boom")})

	w2, cmd := w.Update(key("r"))
	w = w2.(Wizard)
	if w.Step() != StepConnect {
		t.Fatalf("retry stays on the connect step, got %v", w.Step())
	}
	if w.connectStep.err != nil {
		t.Errorf("retry should clear the previous error, got %v", w.connectStep.err)
	}
	if cmd == nil {
		t.Error("retry must issue a fresh connect command")
	}
}

func TestModeStep_ArrowsMoveAndWrap(t *testing.T) {
	defer ForcePlain()()

	w := atModeSelect(t, testDeps())
	last := len(allModes) - 1

	if got := w.modeStep.cursor; got != 0 {
		t.Fatalf("menu should start at the top, got %d", got)
	}

	w = drive(w, key("down"))
	if got := w.modeStep.cursor; got != 1 {
		t.Errorf("down should move to 1, got %d", got)
	}
	w = drive(w, key("up"))
	if got := w.modeStep.cursor; got != 0 {
		t.Errorf("up should move back to 0, got %d", got)
	}

	w = drive(w, key("up"))
	if got := w.modeStep.cursor; got != last {
		t.Errorf("up from the top should wrap to %d, got %d", last, got)
	}
	w = drive(w, key("down"))
	if got := w.modeStep.cursor; got != 0 {
		t.Errorf("down from the bottom should wrap to 0, got %d", got)
	}
}

func TestModeStep_VimKeysMoveToo(t *testing.T) {
	defer ForcePlain()()

	w := atModeSelect(t, testDeps())
	w = drive(w, key("j"))
	if got := w.modeStep.cursor; got != 1 {
		t.Errorf("j should move down, got %d", got)
	}
	w = drive(w, key("k"))
	if got := w.modeStep.cursor; got != 0 {
		t.Errorf("k should move up, got %d", got)
	}
}

func TestModeStep_EnterRecordsSelectedMode(t *testing.T) {
	defer ForcePlain()()

	tests := []struct {
		name     string
		mode     Mode
		wantStep Step
	}{
		{"loop needs a board", ModeLoop, StepBoard},
		{"pipeline needs a board", ModePipeline, StepBoard},
		{"discovery skips the picker", ModeDiscovery, StepWorkDir},
		{"doctor stays in the TUI on its own screen", ModeDoctor, StepDoctor},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := atModeSelect(t, testDeps())
			w = selectMode(t, w, tc.mode)

			if got := w.Result().Mode; got != tc.mode {
				t.Errorf("want mode %q, got %q", tc.mode, got)
			}
			// Boards arrive asynchronously; feed them so the picker settles.
			if tc.wantStep == StepBoard {
				boards, _ := testDeps().LoadBoards(context.Background(), "valaris")
				w = drive(w, boardsLoadedMsg{boards: boards})
			}
			if got := w.Step(); got != tc.wantStep {
				t.Errorf("mode %q should land on %v, got %v", tc.mode, tc.wantStep, got)
			}
		})
	}
}

func TestModeStep_RendersEveryModeWithDescription(t *testing.T) {
	defer ForcePlain()()

	view := atModeSelect(t, testDeps()).View()
	for _, m := range allModes {
		if !strings.Contains(view, m.Label) {
			t.Errorf("mode menu missing label %q:\n%s", m.Label, view)
		}
		if !strings.Contains(view, m.Description) {
			t.Errorf("mode menu missing description for %q:\n%s", m.Label, view)
		}
	}
}

// atBoardPicker lands on a loaded board picker.
func atBoardPicker(t *testing.T, deps WizardDeps) Wizard {
	t.Helper()
	w := selectMode(t, atModeSelect(t, deps), ModeLoop)
	boards, err := deps.LoadBoards(context.Background(), "valaris")
	if err != nil {
		w = drive(w, boardsFailedMsg{err: err})
		return w
	}
	w = drive(w, boardsLoadedMsg{boards: boards})
	if w.Step() != StepBoard {
		t.Fatalf("expected StepBoard, got %v", w.Step())
	}
	return w
}

func TestBoardStep_FilterNarrowsAndEnterPicksTheFilteredItem(t *testing.T) {
	defer ForcePlain()()

	w := atBoardPicker(t, testDeps())
	if n := len(w.boardStep.visible()); n != 3 {
		t.Fatalf("unfiltered picker should show 3 boards, got %d", n)
	}

	// "acme" matches only Acme, which is index 1 in the unfiltered slice.
	// Enter must select the *filtered* row, not boards[cursor] of the full list.
	w = typeRunes(w, "acme")
	visible := w.boardStep.visible()
	if len(visible) != 1 {
		t.Fatalf("filter %q should leave 1 board, got %d (%v)", w.boardStep.filter, len(visible), visible)
	}
	if w.boardStep.cursor != 0 {
		t.Errorf("filtering must reset the cursor into range, got %d", w.boardStep.cursor)
	}

	w = drive(w, key("enter"))
	res := w.Result()
	if res.BoardID != "b2" || res.BoardName != "Acme" {
		t.Errorf("enter selected the wrong board: %+v — the filtered row must win", res)
	}
}

func TestBoardStep_FilterMatchesSlugAndIsCaseInsensitive(t *testing.T) {
	defer ForcePlain()()

	tests := []struct {
		filter string
		wantID string
	}{
		{"BACKPLANE", "b1"},
		{"meridian", "b3"},
		{"cme", "b2"},
	}
	for _, tc := range tests {
		t.Run(tc.filter, func(t *testing.T) {
			w := typeRunes(atBoardPicker(t, testDeps()), tc.filter)
			vis := w.boardStep.visible()
			if len(vis) != 1 {
				t.Fatalf("filter %q should match exactly one board, got %d", tc.filter, len(vis))
			}
			if vis[0].ID != tc.wantID {
				t.Errorf("filter %q matched %q, want %q", tc.filter, vis[0].ID, tc.wantID)
			}
		})
	}
}

func TestBoardStep_BackspaceWidensTheFilter(t *testing.T) {
	defer ForcePlain()()

	w := typeRunes(atBoardPicker(t, testDeps()), "acme")
	w = drive(w, key("backspace"), key("backspace"), key("backspace"), key("backspace"))
	if got := w.boardStep.filter; got != "" {
		t.Errorf("backspace should clear the filter, got %q", got)
	}
	if n := len(w.boardStep.visible()); n != 3 {
		t.Errorf("cleared filter should show every board, got %d", n)
	}
}

func TestBoardStep_EnterOnEmptyFilterResultDoesNotAdvance(t *testing.T) {
	defer ForcePlain()()

	w := typeRunes(atBoardPicker(t, testDeps()), "zzzz")
	if n := len(w.boardStep.visible()); n != 0 {
		t.Fatalf("nonsense filter should match nothing, got %d", n)
	}
	w = drive(w, key("enter"))
	if w.Step() != StepBoard {
		t.Errorf("enter with no match must not advance, got %v", w.Step())
	}
	if !strings.Contains(w.View(), "No board matches") {
		t.Errorf("no-match state should explain itself, got:\n%s", w.View())
	}
}

func TestBoardStep_ShowsStateNotePerBoard(t *testing.T) {
	defer ForcePlain()()

	view := atBoardPicker(t, testDeps()).View()
	for _, note := range []string{"loop off · 3 ready", "loop on · 1 ready", "no repo bound"} {
		if !strings.Contains(view, note) {
			t.Errorf("picker should surface state note %q:\n%s", note, view)
		}
	}
}

func TestBoardStep_EmptyBoardListRendersGuidance(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.LoadBoards = func(context.Context, string) ([]BoardChoice, error) { return nil, nil }

	w := selectMode(t, atModeSelect(t, deps), ModeLoop)
	w = drive(w, boardsLoadedMsg{boards: nil})

	view := w.View()
	if !strings.Contains(view, "No boards") {
		t.Errorf("empty picker should say so, got:\n%s", view)
	}
	if !strings.Contains(strings.ToLower(view), "workspace") {
		t.Errorf("empty picker should point at the workspace, got:\n%s", view)
	}
	if w.Step() != StepBoard {
		t.Errorf("empty list must not silently advance, got %v", w.Step())
	}
}

func TestBoardStep_LoadFailureIsActionable(t *testing.T) {
	defer ForcePlain()()

	w := selectMode(t, atModeSelect(t, testDeps()), ModeLoop)
	w = drive(w, boardsFailedMsg{err: errors.New("connection refused")})

	if w.Step() != StepBoard {
		t.Fatalf("a board load failure must not advance, got %v", w.Step())
	}
	if !strings.Contains(w.View(), "connection refused") {
		t.Errorf("board load error should be visible, got:\n%s", w.View())
	}
}

func TestBoardStep_SkippedForDiscoveryAndDoctor(t *testing.T) {
	defer ForcePlain()()

	wantStep := map[Mode]Step{ModeDiscovery: StepWorkDir, ModeDoctor: StepDoctor}
	for _, mode := range []Mode{ModeDiscovery, ModeDoctor} {
		t.Run(string(mode), func(t *testing.T) {
			loaded := false
			deps := testDeps()
			deps.LoadBoards = func(context.Context, string) ([]BoardChoice, error) {
				loaded = true
				return nil, nil
			}
			w := selectMode(t, atModeSelect(t, deps), mode)
			if w.Step() != wantStep[mode] {
				t.Errorf("%s should skip the picker, got %v", mode, w.Step())
			}
			if loaded {
				t.Errorf("%s must not even fetch boards", mode)
			}
			if got := w.Result().BoardID; got != "" {
				t.Errorf("%s should leave BoardID empty, got %q", mode, got)
			}
		})
	}
}

// atWorkDir lands on the work-dir step with a board already chosen.
func atWorkDir(t *testing.T, deps WizardDeps) Wizard {
	t.Helper()
	w := drive(atBoardPicker(t, deps), key("enter"))
	if w.Step() != StepWorkDir {
		t.Fatalf("expected StepWorkDir, got %v", w.Step())
	}
	return w
}

func TestWorkDirStep_ExplainsTheConsequences(t *testing.T) {
	defer ForcePlain()()

	view := atWorkDir(t, testDeps()).View()
	// Unwrap before matching: a multi-word phrase is free to break across lines,
	// and matching the laid-out view would pin the warning to whatever column
	// the panel happens to wrap at today.
	lower := strings.ToLower(unwrapPanelProse(view))
	for _, want := range []string{"clone", "reset", "git worktree", "disk"} {
		if !strings.Contains(lower, want) {
			t.Errorf("work-dir step must warn about %q, got:\n%s", want, view)
		}
	}
}

func TestWorkDirStep_PresetsIncludeTheDefault(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	w := atWorkDir(t, deps)
	if got := w.workDirStep.Path(); got != deps.DefaultWorkDir {
		t.Errorf("work dir should start at the injected default %q, got %q", deps.DefaultWorkDir, got)
	}
	if !strings.Contains(w.View(), deps.DefaultWorkDir) {
		t.Errorf("default work dir should be visible:\n%s", w.View())
	}
}

func TestWorkDirStep_ArrowsCycleThroughPresets(t *testing.T) {
	defer ForcePlain()()

	w := atWorkDir(t, testDeps())
	first := w.workDirStep.Path()
	w = drive(w, key("down"))
	if second := w.workDirStep.Path(); second == first {
		t.Errorf("down should move to a different preset, still %q", second)
	}
}

func TestWorkDirStep_InvalidPathBlocksAdvanceAndShowsMessage(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.ValidateWorkDir = func(string) error {
		return errors.New("path is inside an existing git worktree")
	}

	w := drive(atWorkDir(t, deps), key("enter"))
	if w.Step() != StepWorkDir {
		t.Fatalf("an invalid work dir must block the step, got %v", w.Step())
	}
	if !strings.Contains(w.View(), "inside an existing git worktree") {
		t.Errorf("validator message should be shown verbatim, got:\n%s", w.View())
	}
}

func TestWorkDirStep_ValidPathAdvancesAndIsRecorded(t *testing.T) {
	defer ForcePlain()()

	var validated string
	deps := testDeps()
	deps.ValidateWorkDir = func(p string) error {
		validated = p
		return nil
	}

	w := drive(atWorkDir(t, deps), key("enter"))
	if w.Step() != StepProvider {
		t.Fatalf("a valid work dir should advance, got %v", w.Step())
	}
	if got := w.Result().WorkDir; got != deps.DefaultWorkDir {
		t.Errorf("want WorkDir %q, got %q", deps.DefaultWorkDir, got)
	}
	if validated != deps.DefaultWorkDir {
		t.Errorf("validator saw %q, want %q", validated, deps.DefaultWorkDir)
	}
}

func TestWorkDirStep_CustomEntryReplacesThePath(t *testing.T) {
	defer ForcePlain()()

	w := atWorkDir(t, testDeps())
	w = drive(w, key("e")) // enter free-text edit mode
	if !w.workDirStep.editing {
		t.Fatal("`e` should open free-text entry")
	}
	w.workDirStep.input.SetValue("/srv/runner")
	w = drive(w, key("enter")) // commit the text
	if got := w.workDirStep.Path(); got != "/srv/runner" {
		t.Errorf("custom path not committed, got %q", got)
	}
	if w.workDirStep.editing {
		t.Error("committing the text should leave edit mode")
	}
}

func TestWorkDirStep_TypingWhileEditingDoesNotTriggerGlobalKeys(t *testing.T) {
	defer ForcePlain()()

	w := atWorkDir(t, testDeps())
	w = drive(w, key("e"))
	w = typeRunes(w, "q/tmp")

	if w.Result().Cancelled {
		t.Error("typing 'q' inside a text field must not quit the wizard")
	}
	if !strings.Contains(w.workDirStep.input.Value(), "q/tmp") {
		t.Errorf("typed runes should reach the input, got %q", w.workDirStep.input.Value())
	}
}

// atProvider lands on the provider/model/budget step.
func atProvider(t *testing.T, deps WizardDeps) Wizard {
	t.Helper()
	w := drive(atWorkDir(t, deps), key("enter"))
	if w.Step() != StepProvider {
		t.Fatalf("expected StepProvider, got %v", w.Step())
	}
	return w
}

func TestProviderStep_ListsOnlyInjectedProviders(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.Providers = []string{"codex"}
	w := atProvider(t, deps)

	if got := w.Result().Provider; got != "codex" {
		t.Errorf("single provider should be preselected, got %q", got)
	}
	if strings.Contains(w.View(), "claude") {
		t.Errorf("unavailable providers must not be offered:\n%s", w.View())
	}
}

func TestProviderStep_DefaultsComeFromDeps(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	w := atProvider(t, deps)
	res := w.Result()
	if res.Provider != "claude" {
		t.Errorf("first provider should be preselected, got %q", res.Provider)
	}
	if res.Model != deps.DefaultModel {
		t.Errorf("want default model %q, got %q", deps.DefaultModel, res.Model)
	}
	if res.BudgetUSD != deps.DefaultBudget {
		t.Errorf("want default budget %v, got %v", deps.DefaultBudget, res.BudgetUSD)
	}
}

func TestProviderStep_TabCyclesFieldsAndArrowsChangeProvider(t *testing.T) {
	defer ForcePlain()()

	w := atProvider(t, testDeps())
	w = drive(w, key("tab")) // leave the loop model selector on Follow board settings
	w = drive(w, key("right"))
	if got := w.Result().Provider; got != "codex" {
		t.Errorf("right should move to the next provider, got %q", got)
	}
	w = drive(w, key("right"))
	if got := w.Result().Provider; got != "claude" {
		t.Errorf("provider selection should wrap, got %q", got)
	}

	w = drive(w, key("tab"))
	if w.providerStep.field != fieldModel {
		t.Errorf("tab should focus the model field, got %v", w.providerStep.field)
	}
}

func TestProviderStep_RejectsUnparseableBudget(t *testing.T) {
	defer ForcePlain()()

	w := atProvider(t, testDeps())
	w.providerStep.field = fieldBudget
	w.providerStep.budget.SetValue("abc")

	w = drive(w, key("enter"))
	if w.Step() != StepProvider {
		t.Fatalf("an unparseable budget must block the step, got %v", w.Step())
	}
	if !strings.Contains(strings.ToLower(w.View()), "budget") {
		t.Errorf("budget error should be explained, got:\n%s", w.View())
	}
}

func TestProviderStep_NegativeBudgetRejected(t *testing.T) {
	defer ForcePlain()()

	w := atProvider(t, testDeps())
	w.providerStep.budget.SetValue("-1")
	w = drive(w, key("enter"))
	if w.Step() != StepProvider {
		t.Errorf("a negative budget must block the step, got %v", w.Step())
	}
}

func TestProviderStep_ValidValuesAdvanceToReview(t *testing.T) {
	defer ForcePlain()()

	w := atProvider(t, testDeps())
	w.providerStep.model.SetValue("opus")
	w.providerStep.budget.SetValue("12.50")
	w = drive(w, key("enter"))

	if w.Step() != StepReview {
		t.Fatalf("valid provider settings should advance, got %v", w.Step())
	}
	res := w.Result()
	if res.Model != "opus" {
		t.Errorf("want model opus, got %q", res.Model)
	}
	if res.BudgetUSD != 12.50 {
		t.Errorf("want budget 12.50, got %v", res.BudgetUSD)
	}
}

func TestProviderStep_NoProvidersAvailableIsExplained(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.Providers = nil
	w := atProvider(t, deps)

	if !strings.Contains(strings.ToLower(w.View()), "no coding agent") {
		t.Errorf("missing providers should be explained, got:\n%s", w.View())
	}
	w = drive(w, key("enter"))
	if w.Step() != StepProvider {
		t.Errorf("cannot advance with no provider, got %v", w.Step())
	}
}

// atReview walks the whole happy path to the review step.
func atReview(t *testing.T, deps WizardDeps) Wizard {
	t.Helper()
	w := drive(atProvider(t, deps), key("enter"))
	if w.Step() != StepReview {
		t.Fatalf("expected StepReview, got %v", w.Step())
	}
	return w
}

func TestReviewStep_SummarizesEveryChoice(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	view := atReview(t, deps).View()
	for _, want := range []string{
		string(ModeLoop), "Backplane", deps.DefaultWorkDir, "claude", deps.DefaultModel,
	} {
		if !strings.Contains(view, want) {
			t.Errorf("review should restate %q, got:\n%s", want, view)
		}
	}
	if !strings.Contains(view, "5") {
		t.Errorf("review should restate the budget, got:\n%s", view)
	}
}

func TestReviewStep_SaveConfigToggles(t *testing.T) {
	defer ForcePlain()()

	w := atReview(t, testDeps())
	before := w.Result().SaveConfig

	w = drive(w, key("s"))
	if w.Result().SaveConfig == before {
		t.Error("`s` should toggle the save-config choice")
	}
	w = drive(w, key("s"))
	if w.Result().SaveConfig != before {
		t.Error("toggling twice should restore the original choice")
	}
}

func TestReviewStep_LaunchQuitsWithACompleteResult(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	w := atReview(t, deps)
	w2, cmd := w.Update(key("enter"))
	w = w2.(Wizard)

	if cmd == nil {
		t.Error("launching should quit the tea program")
	}
	if !w.launched {
		t.Error("launch should mark the wizard finished")
	}
	res := w.Result()
	if res.Cancelled {
		t.Error("launching is not a cancellation")
	}
	if res.Mode != ModeLoop || res.BoardID != "b1" || res.WorkDir != deps.DefaultWorkDir {
		t.Errorf("incomplete launch result: %+v", res)
	}
}

func TestWizard_BackNavigationWalksStepsInReverse(t *testing.T) {
	defer ForcePlain()()

	w := atReview(t, testDeps())
	want := []Step{StepProvider, StepWorkDir, StepBoard, StepMode, StepWorkspace}
	for _, step := range want {
		w = drive(w, key("esc"))
		if got := w.Step(); got != step {
			t.Fatalf("esc should land on %v, got %v", step, got)
		}
	}
}

func TestWizard_BackSkipsTheBoardPickerForDiscovery(t *testing.T) {
	defer ForcePlain()()

	w := selectMode(t, atModeSelect(t, testDeps()), ModeDiscovery)
	w = drive(w, key("esc"))
	if got := w.Step(); got != StepMode {
		t.Errorf("back from work-dir in discovery mode should skip the picker, got %v", got)
	}
}

func TestWizard_BackNeverUnderflows(t *testing.T) {
	defer ForcePlain()()

	w := atModeSelect(t, testDeps())
	for i := 0; i < 10; i++ {
		w = drive(w, key("esc"))
	}
	if got := w.Step(); got != StepWorkspace {
		t.Errorf("the workspace picker is the first reversible step, got %v", got)
	}
	if w.Result().Cancelled {
		t.Error("repeated esc must not cancel the wizard")
	}
}

func TestWizard_LeftArrowAlsoGoesBack(t *testing.T) {
	defer ForcePlain()()

	w := drive(atWorkDir(t, testDeps()), key("left"))
	if got := w.Step(); got != StepBoard {
		t.Errorf("left should go back a step, got %v", got)
	}
}

func TestWizard_QuitKeysCancel(t *testing.T) {
	defer ForcePlain()()

	tests := []struct {
		name string
		key  tea.KeyMsg
	}{
		{"ctrl+c", key("ctrl+c")},
		{"q", key("q")},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			w := atModeSelect(t, testDeps())
			w2, cmd := w.Update(tc.key)
			w = w2.(Wizard)

			if !w.Result().Cancelled {
				t.Error("quitting must set Cancelled so the caller can bail")
			}
			if cmd == nil {
				t.Error("quitting must return tea.Quit")
			}
		})
	}
}

func TestWizard_CtrlCCancelsEvenMidTextEntry(t *testing.T) {
	defer ForcePlain()()

	w := drive(atWorkDir(t, testDeps()), key("e"))
	w2, cmd := w.Update(key("ctrl+c"))
	w = w2.(Wizard)

	if !w.Result().Cancelled {
		t.Error("ctrl+c must escape a focused text field")
	}
	if cmd == nil {
		t.Error("ctrl+c must quit")
	}
}

func TestWizard_HelpToggles(t *testing.T) {
	defer ForcePlain()()

	w := atModeSelect(t, testDeps())
	if w.showHelp {
		t.Fatal("help starts hidden")
	}
	w = drive(w, key("?"))
	if !w.showHelp {
		t.Fatal("`?` should reveal help")
	}
	if !strings.Contains(w.View(), "back") {
		t.Errorf("help line should document navigation, got:\n%s", w.View())
	}
	w = drive(w, key("?"))
	if w.showHelp {
		t.Error("`?` should hide help again")
	}
}

func TestWizard_RendersAtAnyWidthWithoutOverflowOrPanic(t *testing.T) {
	defer ForcePlain()()

	widths := []int{0, 1, 20, 40, 68, 120, 300}
	steppers := map[string]func(*testing.T, WizardDeps) Wizard{
		"credentials": atCredentials,
		"mode":        atModeSelect,
		"board":       atBoardPicker,
		"workdir":     atWorkDir,
		"provider":    atProvider,
		"review":      atReview,
	}
	for name, at := range steppers {
		for _, width := range widths {
			t.Run(name+"/"+itoa(width), func(t *testing.T) {
				w := drive(at(t, testDeps()), tea.WindowSizeMsg{Width: width, Height: 24})
				view := w.View()
				if view == "" {
					t.Fatalf("%s at width %d rendered nothing", name, width)
				}
				if width > 0 && maxLineWidth(view) > width {
					t.Errorf("%s at width %d overflowed to %d cols:\n%s",
						name, width, maxLineWidth(view), view)
				}
			})
		}
	}
}

func TestWizard_ZeroValueDepsDoNotPanic(t *testing.T) {
	defer ForcePlain()()

	// A caller that forgets to wire deps should get a wizard that renders and
	// quits, never a nil-func panic inside Update.
	w := NewWizard(WizardDeps{})
	w = drive(w, tea.WindowSizeMsg{Width: 80, Height: 24}, splashDoneMsg{}, key("enter"))
	_ = w.View()

	if cmd := w.Init(); cmd == nil {
		t.Error("Init must always return a command")
	}
	w = drive(w, connectFailedMsg{err: errors.New("no connector configured")})
	if w.Step() != StepConnect {
		t.Errorf("unwired deps should stall on connect, got %v", w.Step())
	}
}

func TestWizard_InitStartsTheSplashAndSpinner(t *testing.T) {
	defer ForcePlain()()

	if cmd := NewWizard(testDeps()).Init(); cmd == nil {
		t.Fatal("Init must schedule the splash timer and spinner tick")
	}
}

func TestWizard_ResultCarriesConfigPathWhenSaving(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.ConfigPath = "/home/operator/.config/backplane/runner.yaml"
	w := atReview(t, deps)
	if !strings.Contains(w.View(), deps.ConfigPath) {
		t.Errorf("review should show where the config would be written:\n%s", w.View())
	}
	if got := w.Result().ConfigPath; got != deps.ConfigPath {
		t.Errorf("want ConfigPath %q, got %q", deps.ConfigPath, got)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf []byte
	for n > 0 {
		buf = append([]byte{byte('0' + n%10)}, buf...)
		n /= 10
	}
	if neg {
		return "-" + string(buf)
	}
	return string(buf)
}
