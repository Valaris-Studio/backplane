// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"context"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ------------------------------------------------------- panels in context --

// Every line inside a panel must occupy the same number of display cells, or
// the right border stops forming a straight column. The step views are where
// this actually broke: the component was fine in isolation and wrong once a
// step handed it real prose at a real terminal width.
func TestSteps_PanelBordersStayStraight(t *testing.T) {
	restore := forceProfileTrueColor()
	defer restore()

	steppers := map[string]func(*testing.T, WizardDeps) Wizard{
		"workdir": atWorkDir,
		"review":  atReview,
	}
	for name, at := range steppers {
		for _, width := range []int{40, 60, 84, 120} {
			t.Run(name+"/"+itoa(width), func(t *testing.T) {
				view := drive(at(t, testDeps()), tea.WindowSizeMsg{Width: width, Height: 40}).View()
				assertPanelBordersAreStraight(t, view)
			})
		}
	}
}

// assertPanelBordersAreStraight checks every run of box-drawing rows in a view:
// from a ╭ row through the matching ╰ row, all lines must be the same width.
func assertPanelBordersAreStraight(t *testing.T, view string) {
	t.Helper()
	lines := strings.Split(view, "\n")

	var panel []string
	inPanel := false
	for _, line := range lines {
		plain := stripANSI(line)
		switch {
		case strings.HasPrefix(plain, "╭"):
			inPanel, panel = true, []string{line}
		case inPanel && strings.HasPrefix(plain, "╰"):
			panel = append(panel, line)
			inPanel = false
			want := lipgloss.Width(panel[0])
			for i, l := range panel {
				if got := lipgloss.Width(l); got != want {
					t.Errorf("panel line %d is %d cells, want %d — the right border drifts:\n%s",
						i, got, want, stripANSI(strings.Join(panel, "\n")))
				}
			}
		case inPanel:
			panel = append(panel, line)
		}
	}
	if len(panel) == 0 {
		t.Fatal("expected the view to contain a panel")
	}
}

// A panel must not stretch to the terminal edge while the content beneath it
// sits narrow — the box then reads as unrelated to the step it belongs to.
func TestSteps_PanelsDoNotStretchToAWideTerminal(t *testing.T) {
	defer ForcePlain()()

	view := drive(atWorkDir(t, testDeps()), tea.WindowSizeMsg{Width: 200, Height: 40}).View()
	for _, line := range strings.Split(view, "\n") {
		if !strings.HasPrefix(line, "╭") {
			continue
		}
		if got := lipgloss.Width(line); got > maxPanelCols {
			t.Errorf("panel grew to %d cells on a 200-column terminal, cap is %d", got, maxPanelCols)
		}
		return
	}
	t.Fatal("expected the work-dir step to render a panel")
}

// --------------------------------------------------------- board two-column --

// The defect: name and state note were joined by a bare two-space gap, so the
// notes started at a different column on every row.
func TestBoardPicker_StateNotesShareOneColumn(t *testing.T) {
	defer forceProfileTrueColor()()

	w := drive(atBoardPicker(t, testDeps()), tea.WindowSizeMsg{Width: 84, Height: 40})

	columns := noteStartColumns(t, w.View(), testBoardNotes(t))
	for i, col := range columns {
		if col != columns[0] {
			t.Errorf("note %d starts at column %d, first note starts at %d — the column is ragged:\n%s",
				i, col, columns[0], stripANSI(w.View()))
		}
	}
}

// The same alignment must hold with color on: padding a STYLED name would count
// its escape bytes as columns and shift every note.
func TestBoardPicker_AlignmentSurvivesStyling(t *testing.T) {
	restore := forceProfileTrueColor()
	defer restore()

	// The cursor row is styled differently from the rest, which is exactly where
	// a byte-measured pad would drift.
	w := drive(atBoardPicker(t, testDeps()), tea.WindowSizeMsg{Width: 84, Height: 40})
	styled := noteStartColumns(t, w.View(), testBoardNotes(t))
	restore()

	defer ForcePlain()()
	plainW := drive(atBoardPicker(t, testDeps()), tea.WindowSizeMsg{Width: 84, Height: 40})
	plain := noteStartColumns(t, plainW.View(), testBoardNotes(t))

	for i := range plain {
		if styled[i] != plain[i] {
			t.Errorf("note %d starts at column %d styled but %d plain — escapes were measured as cells",
				i, styled[i], plain[i])
		}
	}
}

func TestBoardPicker_LongNameIsEllipsizedNotStretched(t *testing.T) {
	defer ForcePlain()()

	const long = "A-board-name-far-longer-than-any-sane-column-would-allocate-for-it"
	deps := testDeps()
	deps.LoadBoards = func(_ context.Context, _ string) ([]BoardChoice, error) {
		return []BoardChoice{
			{ID: "b1", Name: long, Slug: "long", StateNote: "loop on · 2 ready"},
			{ID: "b2", Name: "Tiny", Slug: "tiny", StateNote: "loop off · nothing ready"},
		}, nil
	}

	view := drive(atBoardPicker(t, deps), tea.WindowSizeMsg{Width: 84, Height: 40}).View()

	if strings.Contains(view, long) {
		t.Errorf("a name past the clamp must be ellipsized, got:\n%s", view)
	}
	if !strings.Contains(view, "…") {
		t.Errorf("the truncated name should carry an ellipsis, got:\n%s", view)
	}
	// The clamp exists so one long name cannot push the notes off the screen.
	for _, note := range []string{"loop on · 2 ready", "loop off · nothing ready"} {
		if !strings.Contains(view, note) {
			t.Errorf("state note %q was pushed off the row:\n%s", note, view)
		}
	}
}

func TestBoardPicker_NarrowWidthKeepsNotesOnScreen(t *testing.T) {
	defer ForcePlain()()

	for _, width := range []int{20, 30, 40, 50} {
		view := drive(atBoardPicker(t, testDeps()), tea.WindowSizeMsg{Width: width, Height: 40}).View()
		if view == "" {
			t.Fatalf("width %d rendered nothing", width)
		}
		if got := maxLineWidth(view); got > width {
			t.Errorf("width %d overflowed to %d cols:\n%s", width, got, view)
		}
	}
}

func TestBoardNameColumn_ClampsBothWays(t *testing.T) {
	short := []BoardChoice{{Name: "Api"}, {Name: "Web"}}
	long := []BoardChoice{{Name: strings.Repeat("x", 200)}}

	if got := boardNameColumn(short, 84); got != boardNameMinCols {
		t.Errorf("names shorter than the floor should still get %d cols, got %d", boardNameMinCols, got)
	}
	if got := boardNameColumn(long, 84); got != boardNameMaxCols {
		t.Errorf("a runaway name should clamp to %d cols, got %d", boardNameMaxCols, got)
	}
	// A terminal too narrow to seat both columns gives up the clamp rather than
	// pushing the note past the edge.
	if got := boardNameColumn(long, 24); got >= boardNameMaxCols {
		t.Errorf("a narrow terminal should shrink the name column, got %d", got)
	}
	if got := boardNameColumn(long, 4); got < boardNameMinCols {
		t.Errorf("the column must never go below the %d-cell floor, got %d", boardNameMinCols, got)
	}
}

// unwrapPanelProse flattens a rendered view back into one line of words, with
// panel borders removed — so an assertion can match a phrase without caring
// which column the text wrapped at.
func unwrapPanelProse(view string) string {
	plain := strings.Map(func(r rune) rune {
		if strings.ContainsRune("│╭╮╰╯─", r) {
			return ' '
		}
		return r
	}, stripANSI(view))
	return strings.Join(strings.Fields(plain), " ")
}

// noteStartColumns finds the display column each state note begins at.
func noteStartColumns(t *testing.T, view string, notes []string) []int {
	t.Helper()
	plain := stripANSI(view)
	columns := make([]int, 0, len(notes))
	for _, note := range notes {
		var found bool
		for _, line := range strings.Split(plain, "\n") {
			idx := strings.Index(line, note)
			if idx < 0 {
				continue
			}
			columns = append(columns, lipgloss.Width(line[:idx]))
			found = true
			break
		}
		if !found {
			t.Fatalf("state note %q never rendered:\n%s", note, plain)
		}
	}
	return columns
}

func testBoardNotes(t *testing.T) []string {
	t.Helper()
	boards, err := testDeps().LoadBoards(context.Background(), "valaris")
	if err != nil {
		t.Fatalf("test deps LoadBoards failed: %v", err)
	}
	notes := make([]string, 0, len(boards))
	for _, b := range boards {
		notes = append(notes, b.StateNote)
	}
	return notes
}
