// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"strconv"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// blockedNote marks a workspace the signed-in USER can see but this AGENT KEY
// may not operate in. Hiding those rows would leave an operator hunting for a
// workspace that is right there in the web app.
const blockedNote = "not allowed for this key"

type workspaceStep struct {
	workspaces []WorkspaceChoice
	// allowed is the agent key's allowed_workspaces. EMPTY MEANS UNRESTRICTED,
	// matching validateAgentConfig — see WizardDeps.AllowedWorkspaces.
	allowed []string

	filter  string
	cursor  int
	loading bool
	err     error
	chosen  WorkspaceChoice
}

func newWorkspaceStep(allowed []string) workspaceStep {
	return workspaceStep{allowed: allowed}
}

// selectable reports whether this key can actually work in ws.
func (s workspaceStep) selectable(ws WorkspaceChoice) bool {
	if len(s.allowed) == 0 {
		return true
	}
	for _, slug := range s.allowed {
		if slug == ws.Slug {
			return true
		}
	}
	return false
}

// filtering reports whether raw runes should narrow the list rather than reach
// the global key bindings, matching the board picker's filter-first behavior.
func (s workspaceStep) filtering() bool {
	return !s.loading && s.err == nil && len(s.workspaces) > 0
}

// visible is the list narrowed by the current filter, matched case-insensitively
// across name and slug.
func (s workspaceStep) visible() []WorkspaceChoice {
	if s.filter == "" {
		return s.workspaces
	}
	needle := strings.ToLower(s.filter)
	matches := make([]WorkspaceChoice, 0, len(s.workspaces))
	for _, ws := range s.workspaces {
		if strings.Contains(strings.ToLower(ws.Name), needle) ||
			strings.Contains(strings.ToLower(ws.Slug), needle) {
			matches = append(matches, ws)
		}
	}
	return matches
}

// find locates a workspace by slug, which is how a resolved env/config value is
// checked against what the caller can actually see.
func (s workspaceStep) find(slug string) (WorkspaceChoice, bool) {
	for _, ws := range s.workspaces {
		if ws.Slug == slug {
			return ws, true
		}
	}
	return WorkspaceChoice{}, false
}

func (w Wizard) workspaceKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if w.workspaceStep.err != nil && msg.String() == "r" {
		return w.enterWorkspace()
	}

	visible := w.workspaceStep.visible()

	switch msg.Type {
	case tea.KeyUp:
		w.workspaceStep.cursor = wrapIndex(w.workspaceStep.cursor-1, len(visible))
		return w, nil
	case tea.KeyDown:
		w.workspaceStep.cursor = wrapIndex(w.workspaceStep.cursor+1, len(visible))
		return w, nil
	case tea.KeyBackspace:
		if n := len(w.workspaceStep.filter); n > 0 {
			w.workspaceStep.filter = w.workspaceStep.filter[:n-1]
			w.workspaceStep.cursor = 0
		}
		return w, nil
	case tea.KeyEnter:
		if w.workspaceStep.cursor < 0 || w.workspaceStep.cursor >= len(visible) {
			return w, nil
		}
		return w.commitWorkspace(visible[w.workspaceStep.cursor])
	case tea.KeyRunes, tea.KeySpace:
		runes := msg.Runes
		if msg.Type == tea.KeySpace {
			runes = []rune{' '}
		}
		w.workspaceStep.filter += string(runes)
		w.workspaceStep.cursor = 0
		return w, nil
	}
	return w, nil
}

// commitWorkspace records the choice and moves on, refusing a workspace this
// key cannot operate in — accepting it would only move the failure to the first
// backend call, after the operator believed the setup was done.
func (w Wizard) commitWorkspace(ws WorkspaceChoice) (tea.Model, tea.Cmd) {
	if !w.workspaceStep.selectable(ws) {
		return w, nil
	}
	w.workspaceStep.chosen = ws
	w.step = StepMode
	return w, nil
}

func (w Wizard) workspaceView(th Theme, width int) string {
	s := w.workspaceStep
	title := th.Title.Render("Which workspace?")

	switch {
	case s.loading:
		return title + "\n\n" + w.spin.View() + " " + th.Subtle.Render("loading workspaces")

	case s.err != nil:
		pw := PanelWidth(width)
		body := Prose(th.Error, "Could not list your workspaces", pw) + "\n" +
			Prose(th.Subtitle, s.err.Error(), pw) + "\n\n" +
			Prose(th.Subtle, "Press r to retry, or esc to correct the backend url and key.", pw)
		return title + "\n\n" + Panel("workspace list failed", body, pw)

	case len(s.workspaces) == 0:
		pw := PanelWidth(width)
		body := Prose(th.Subtitle, "No workspace is visible to this key.", pw) + "\n\n" +
			Prose(th.Subtle, "Create one in the Backplane web app — or ask an admin to add you to theirs — "+
				"then rerun this wizard. A runner always works inside a workspace.", pw)
		return title + "\n\n" + Panel("nowhere to run", body, pw)
	}

	visible := s.visible()
	rows := []string{th.Subtle.Render("filter: ") + renderFilter(th, s.filter)}

	if len(visible) == 0 {
		rows = append(rows, "", th.Warn.Render("No workspace matches "+strconv.Quote(s.filter))+
			"\n"+th.Subtle.Render("Backspace to widen the search."))
		return title + "\n\n" + joinStrings(rows, "\n")
	}

	rows = append(rows, "")
	nameCol := workspaceNameColumn(visible, width)
	for i, ws := range visible {
		marker := "  "
		// Pad and truncate the PLAIN name before styling — a styled string
		// measures its escape bytes as columns, so the notes would not line up.
		name := truncateCells(ws.Name, nameCol)
		pad := strings.Repeat(" ", nameCol-lipgloss.Width(name))
		styled := th.Subtitle.Render(name)
		if i == s.cursor {
			marker = th.Accent.Render("▸") + " "
			styled = th.Selected.Render(name)
		}

		note := ws.Slug
		noteStyle := th.Subtle
		if !s.selectable(ws) {
			note = ws.Slug + " · " + blockedNote
			noteStyle = th.Warn
		}
		rows = append(rows, truncateCells(marker+styled+pad+boardNoteGap+noteStyle.Render(note), width))
	}
	return title + "\n\n" + joinStrings(rows, "\n")
}

// workspaceNameColumn mirrors the board picker's column geometry so both
// pickers read as the same control.
func workspaceNameColumn(workspaces []WorkspaceChoice, width int) int {
	longest := 0
	for _, ws := range workspaces {
		if w := lipgloss.Width(ws.Name); w > longest {
			longest = w
		}
	}

	col := min(longest, boardNameMaxCols)
	if budget := width - boardMarkerCols - len(boardNoteGap) - boardNameMinCols; col > budget {
		col = budget
	}
	return max(col, boardNameMinCols)
}
