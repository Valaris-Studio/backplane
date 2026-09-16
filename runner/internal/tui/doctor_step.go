// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"context"

	tea "github.com/charmbracelet/bubbletea"
)

// DoctorCheck is one diagnostic row as the wizard's doctor screen renders it.
// Fix is the actionable remedy, expected on anything that is not OK.
type DoctorCheck struct {
	Label  string
	Detail string
	Fix    string
	State  CheckState
}

// DoctorReport is a finished diagnosis, presentation-ready: the caller runs
// the probes and words the verdict, the wizard only draws.
type DoctorReport struct {
	Checks  []DoctorCheck
	Verdict string
	Failed  int
	Warned  int
}

// doctorStep shows the machine diagnosis without leaving the wizard — the
// report used to print-and-exit, which threw the operator out of the TUI they
// had just walked a whole setup flow in.
type doctorStep struct {
	running bool
	done    bool
	report  DoctorReport
}

// enterDoctor opens the screen and starts the probes. With no RunDoctor dep
// there is nothing to run, so the view explains itself instead of spinning
// forever — the wizard never blocks on an unwired effect.
func (w Wizard) enterDoctor() (tea.Model, tea.Cmd) {
	w.step = StepDoctor
	if w.deps.RunDoctor == nil && w.deps.RunDoctorForResult == nil {
		w.doctorStep.running = false
		return w, nil
	}
	w.doctorStep.running = true
	w.doctorStep.done = false
	if run := w.deps.RunDoctorForResult; run != nil {
		result := w.Result()
		return w, func() tea.Msg { return doctorDoneMsg{report: run(context.Background(), result)} }
	}
	// The checks judge what the operator settled in THIS wizard — host, key,
	// workspace — not whatever happened to be lying around at startup.
	return w, runDoctorCmd(w.deps.RunDoctor,
		w.credentialsStep.committedHost, w.credentialsStep.committedKey, w.workspaceStep.chosen.Slug)
}

func runDoctorCmd(run func(ctx context.Context, host, apiKey, workspace string) DoctorReport, host, apiKey, workspace string) tea.Cmd {
	return func() tea.Msg {
		return doctorDoneMsg{report: run(context.Background(), host, apiKey, workspace)}
	}
}

func (w Wizard) doctorKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if w.doctorStep.running {
		return w, nil
	}
	if msg.String() == "r" {
		return w.enterDoctor()
	}
	return w, nil
}

func (w Wizard) doctorView(th Theme, width int) string {
	s := w.doctorStep
	title := th.Title.Render("Doctor — would a runner work here?")

	switch {
	case w.deps.RunDoctor == nil && w.deps.RunDoctorForResult == nil:
		return title + "\n\n" + th.Subtle.Render("Diagnostics are not wired up in this build.")
	case s.running:
		return title + "\n\n" + w.spin.View() + " " + th.Subtle.Render("checking this machine")
	case !s.done:
		return title
	}

	pw := PanelWidth(width)
	inner := PanelBodyWidth(pw)

	items := make([]ChecklistItem, 0, len(s.report.Checks))
	for _, c := range s.report.Checks {
		items = append(items, ChecklistItem{Label: c.Label, State: c.State, Detail: c.Detail})
	}
	body := ChecklistWrapped(items, inner)
	if fixes := doctorFixLines(th, s.report.Checks, inner); fixes != "" {
		body += "\n\n" + fixes
	}

	verdict := StatusLine(doctorVerdictIcon(s.report), "verdict", s.report.Verdict)
	return title + "\n\n" + Panel("this machine", body, pw) + "\n" + verdict
}

// doctorFixBullet leads each remedy; the indent hangs a wrapped fix under its
// bullet rather than at the left margin, where it would read as another fix.
const (
	doctorFixBullet        = "→ "
	doctorFixHangingIndent = "  "
)

// doctorFixLines lists the remedy for every not-OK check, in check order.
func doctorFixLines(th Theme, checks []DoctorCheck, width int) string {
	var lines []string
	for _, c := range checks {
		if c.State != StateOK && c.Fix != "" {
			lines = append(lines,
				renderWrapped(th.Subtle, doctorFixBullet+c.Label+": "+c.Fix, width, doctorFixHangingIndent))
		}
	}
	return joinStrings(lines, "\n")
}

func doctorVerdictIcon(r DoctorReport) string {
	switch {
	case r.Failed > 0:
		return glyphFail
	case r.Warned > 0:
		return glyphWarn
	}
	return glyphOK
}
