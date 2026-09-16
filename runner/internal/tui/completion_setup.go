// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
	tea "github.com/charmbracelet/bubbletea"
)

type completionSetup struct {
	request      int
	loading      bool
	loaded       bool
	confirmed    bool
	err          error
	requirements []valaris.CompletionRequirement
	status       *valaris.CompletionWorkStatus
}

type completionSetupMsg struct {
	request      int
	requirements *valaris.CompletionRequirements
	status       *valaris.CompletionWorkStatus
	err          error
}

func (w Wizard) refreshCompletionSetup() (tea.Model, tea.Cmd) {
	if w.modeStep.Selected() != ModeLoop || w.deps.LoadCompletionRequirements == nil {
		return w, nil
	}
	request := w.completionSetup.request + 1
	w.completionSetup = completionSetup{request: request, loading: true}
	workspace, board := w.workspaceStep.chosen.Slug, w.boardStep.chosen.ID
	requirements, work := w.deps.LoadCompletionRequirements, w.deps.LoadCompletionWork
	return w, func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		response, err := requirements(ctx, workspace, board)
		msg := completionSetupMsg{request: request, requirements: response, err: err}
		if err == nil && work != nil {
			msg.status, msg.err = work(ctx, workspace, board)
		}
		return msg
	}
}

func (w Wizard) completionProviders() []string {
	var names []string
	seen := map[string]bool{}
	for _, requirement := range w.completionSetup.requirements {
		if requirement.Kind == "validation" {
			continue
		}
		name := NormalizeProvider(requirement.Provider)
		if name != "" && !seen[name] {
			names = append(names, name)
			seen[name] = true
		}
	}
	return names
}

func (w Wizard) confirmCompletionProviders() error {
	if w.modeStep.Selected() != ModeLoop || w.deps.LoadCompletionRequirements == nil {
		return nil
	}
	if w.completionSetup.loading {
		return errors.New("Completion requirements are still loading; wait before launching.")
	}
	if !w.completionSetup.loaded || w.completionSetup.err != nil {
		return errors.New("Cannot verify the selected board's completion requirements. Press r to retry, or select a different board.")
	}
	known := map[string]bool{}
	for _, name := range w.deps.Providers {
		known[NormalizeProvider(name)] = true
	}
	for _, name := range w.completionProviders() {
		if !known[name] {
			return fmt.Errorf("Completion requires provider %q, which is unavailable locally. Install or configure that provider, then restart setup; no source work has started.", name)
		}
	}
	return nil
}

func (w Wizard) completionSetupView(th Theme, width int) string {
	if w.modeStep.Selected() != ModeLoop || w.deps.LoadCompletionRequirements == nil {
		return ""
	}
	if w.completionSetup.loading {
		return th.Subtle.Render("Loading selected board completion requirements…")
	}
	if w.completionSetup.err != nil || !w.completionSetup.loaded {
		return th.Warn.Render("Completion requirements unavailable. Press r to retry.")
	}
	var lines []string
	for _, r := range w.completionSetup.requirements {
		if r.Kind == "validation" {
			lines = append(lines, r.Role+": direct checks")
			continue
		}
		lines = append(lines, fmt.Sprintf("%s: %s / %s", r.Role, r.Provider, r.Model))
	}
	if len(w.completionProviders()) > 0 {
		lines = append(lines, "Enter confirms these providers for this run; saving also retains them in this profile.")
	}
	if w.completionSetup.status != nil {
		s := w.completionSetup.status
		lines = append(lines, fmt.Sprintf("Preserved work: %d pending · %d failed", s.PendingCount, s.FailedCount))
		for _, item := range s.Workflows {
			if item.Phase == "accepted" && s.Outstanding() {
				continue
			}
			lines = append(lines, fmt.Sprintf("%s · candidate %s · next: %s", item.Phase, item.CandidateID, item.NextAction))
			break
		}
		if len(s.Workflows) > 1 || s.NextCursor != nil {
			lines = append(lines, "Doctor shows additional workflow details.")
		}
	}
	value := strings.Join(lines, "\n")
	value = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && r != '\n' {
			return -1
		}
		return r
	}, value)
	if key := w.credentialsStep.committedKey; key != "" {
		value = strings.ReplaceAll(value, key, "[redacted]")
	}
	if value == "" {
		return ""
	}
	return Panel("completion and resume", Prose(th.Subtle, value, PanelWidth(width)), PanelWidth(width))
}
