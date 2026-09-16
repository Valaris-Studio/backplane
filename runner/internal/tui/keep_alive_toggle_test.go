// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
)

// keep_alive in the wizard (card 5ffe97cf). The setting is loop-mode-only: in
// pipeline mode there is no board loop to wait for, so offering the toggle
// there would be a field that does nothing.

func TestKeepAliveToggle_DefaultsOffAndRoundTripsToConfig(t *testing.T) {
	r := Result{Mode: ModeLoop, BoardID: "board-1"}
	if r.KeepAlive {
		t.Fatal("Result.KeepAlive defaulted true — a wizard-built config must not silently change loop-off behaviour")
	}
	if got := r.Apply(nil); got.LoopMode.KeepAlive {
		t.Error("Apply wrote keep_alive: true from a default Result")
	}

	r.KeepAlive = true
	if got := r.Apply(nil); !got.LoopMode.KeepAlive {
		t.Error("Apply dropped KeepAlive — the wizard's choice never reaches the config")
	}
}

// Pipeline mode has no board loop, so the setting must not leak into a config
// the operator can never have asked for.
func TestKeepAliveToggle_PipelineModeNeverApplies(t *testing.T) {
	r := Result{Mode: ModePipeline, KeepAlive: true}
	if got := r.Apply(nil); got.LoopMode.KeepAlive {
		t.Error("Apply wrote keep_alive in PIPELINE mode — that mode never reads a board loop config")
	}
}

// The full persistence path an operator's choice actually travels:
// wizard → Apply → MarshalConfigYAML → config.Load. A field that survives
// Apply but not the YAML round-trip is lost the moment a profile is saved.
func TestKeepAliveToggle_SurvivesTheYAMLRoundTrip(t *testing.T) {
	base := config.Defaults()
	base.Valaris.APIKey = "vlr_test"
	base.Valaris.WorkspaceSlug = "acme"
	base.LLM.MCPConfigPath = "/tmp/mcp.json"

	cfg := Result{Mode: ModeLoop, BoardID: "board-1", KeepAlive: true}.Apply(base)
	data, err := MarshalConfigYAML(cfg)
	if err != nil {
		t.Fatalf("MarshalConfigYAML: %v", err)
	}
	if !strings.Contains(string(data), "keep_alive: true") {
		t.Fatalf("marshalled YAML has no keep_alive key — a saved profile silently loses the setting:\n%s", data)
	}
}

// The review screen is the operator's last chance to catch a wrong setting, and
// PR #126's jump-to-step needs the row to name the step that owns it.
func TestKeepAliveToggle_ReviewRowNamesTheOwningStep(t *testing.T) {
	w := loopWizardWithKeepAlive(t, true)

	var row *reviewRow
	for i, r := range w.reviewRows() {
		if r.label == "on loop off" {
			row = &w.reviewRows()[i]
			break
		}
	}
	if row == nil {
		t.Fatalf("no 'on loop off' row on the review screen; rows = %v", labelsOf(w.reviewRows()))
	}
	if row.owner != StepProvider {
		t.Errorf("review row owner = %v, want StepProvider — jump-to-step would land on the wrong screen", row.owner)
	}
	if !strings.Contains(row.value, "wait") {
		t.Errorf("review row value = %q, want it to say the runner waits", row.value)
	}
}

func TestKeepAliveToggle_ReviewRowReadsExitWhenOff(t *testing.T) {
	w := loopWizardWithKeepAlive(t, false)
	for _, r := range w.reviewRows() {
		if r.label == "on loop off" {
			if !strings.Contains(r.value, "exit") {
				t.Errorf("review row value = %q with keep-alive OFF, want it to say the runner exits", r.value)
			}
			return
		}
	}
	t.Fatalf("no 'on loop off' row; rows = %v", labelsOf(w.reviewRows()))
}

// Pipeline mode must not show the row at all — a setting with no effect on the
// review screen reads as a promise the runner does not keep.
func TestKeepAliveToggle_ReviewRowHiddenInPipelineMode(t *testing.T) {
	w := atProviderForMode(t, ModePipeline, unconfiguredLoopBoard())
	for _, r := range w.reviewRows() {
		if r.label == "on loop off" {
			t.Fatal("'on loop off' row rendered in pipeline mode, where there is no board loop to wait for")
		}
	}
}

func labelsOf(rows []reviewRow) []string {
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.label)
	}
	return out
}

// loopWizardWithKeepAlive builds a loop-mode wizard sitting on the provider
// step with the toggle in the requested position. Uses the UNCONFIGURED board
// so the step keeps all its local fields — the pinned board hides them.
func loopWizardWithKeepAlive(t *testing.T, on bool) Wizard {
	t.Helper()
	w := atLoopProviderFor(t, unconfiguredLoopBoard())
	w.providerStep.keepAlive = on
	return w
}

// A toggle the operator cannot SEE is not a toggle. These pin the render,
// which the state-only tests above are structurally blind to.
func TestKeepAliveToggle_RendersOnTheProviderStep(t *testing.T) {
	for _, tc := range []struct {
		name  string
		board BoardChoice
	}{
		{"unconfigured board", unconfiguredLoopBoard()},
		{"board pins provider and model", pinnedLoopBoard()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := atLoopProviderFor(t, tc.board)
			view := w.View()
			if !strings.Contains(view, "on loop off") {
				t.Fatalf("provider step does not render the keep-alive field:\n%s", view)
			}
			if !strings.Contains(view, "exit") {
				t.Errorf("keep-alive OFF does not render as 'exit':\n%s", view)
			}

			w.providerStep.keepAlive = true
			if on := w.View(); !strings.Contains(on, "wait for re-enable") {
				t.Errorf("keep-alive ON does not render as 'wait for re-enable':\n%s", on)
			}
		})
	}
}

func TestKeepAliveToggle_NotRenderedInPipelineMode(t *testing.T) {
	w := atProviderForMode(t, ModePipeline, unconfiguredLoopBoard())
	if view := w.View(); strings.Contains(view, "on loop off") {
		t.Errorf("pipeline mode renders a loop-only field:\n%s", view)
	}
}

// The toggle is reachable by keyboard on the provider step in loop mode: a
// field that only exists in the struct is not a feature.
func TestKeepAliveToggle_TabReachesItInLoopMode(t *testing.T) {
	w := loopWizardWithKeepAlive(t, false)

	reached := false
	model := tea.Model(w)
	for i := 0; i < 6; i++ {
		model, _ = model.(Wizard).providerKey(tea.KeyMsg{Type: tea.KeyTab})
		if model.(Wizard).providerStep.field == fieldKeepAlive {
			reached = true
			break
		}
	}
	if !reached {
		t.Fatal("tabbing never reaches the keep-alive field on the provider step in loop mode")
	}

	// Space flips it — the conventional toggle key for a boolean field.
	flipped, _ := model.(Wizard).providerKey(tea.KeyMsg{Type: tea.KeySpace})
	if !flipped.(Wizard).providerStep.keepAlive {
		t.Error("space on the keep-alive field did not turn it on")
	}
	unflipped, _ := flipped.(Wizard).providerKey(tea.KeyMsg{Type: tea.KeySpace})
	if unflipped.(Wizard).providerStep.keepAlive {
		t.Error("space did not toggle back off — the field is one-way")
	}
}

// Pipeline mode keeps the original three fields: tabbing must never land on a
// setting that mode cannot use.
func TestKeepAliveToggle_TabNeverReachesItInPipelineMode(t *testing.T) {
	w := atProviderForMode(t, ModePipeline, unconfiguredLoopBoard())

	model := tea.Model(w)
	for i := 0; i < 8; i++ {
		model, _ = model.(Wizard).providerKey(tea.KeyMsg{Type: tea.KeyTab})
		if model.(Wizard).providerStep.field == fieldKeepAlive {
			t.Fatal("tabbing reached the keep-alive field in pipeline mode, where it has no effect")
		}
	}
}
