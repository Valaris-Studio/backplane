// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"context"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// sampleReport is a mixed-verdict diagnosis: one of each state, so a view test
// can assert rows, fixes and verdict in a single pass.
func sampleReport() DoctorReport {
	return DoctorReport{
		Checks: []DoctorCheck{
			{Label: "git", Detail: "git version 2.44.0", State: StateOK},
			{Label: "forge cli", Detail: "gh is not authenticated", Fix: "run `gh auth login`", State: StateWarn},
			{Label: "mcp config", Detail: "no MCP server config found", Fix: "rerun the wizard", State: StateFail},
		},
		Verdict: "the runner will not run — 1 ok · 1 warning(s) · 1 failed",
		Failed:  1,
		Warned:  1,
	}
}

// atDoctorRunning selects doctor mode and returns the wizard plus the command
// that carries the probes — drive() discards commands, and the whole point
// here is to control when the report lands.
func atDoctorRunning(t *testing.T, deps WizardDeps) (Wizard, tea.Cmd) {
	t.Helper()
	w := atModeSelect(t, deps)
	for i := 0; i < len(allModes) && w.modeStep.Selected() != ModeDoctor; i++ {
		w = drive(w, key("down"))
	}
	model, cmd := w.Update(key("enter"))
	w = model.(Wizard)
	if w.Step() != StepDoctor {
		t.Fatalf("doctor mode should open the doctor screen, got %v", w.Step())
	}
	return w, cmd
}

func TestDoctorStep_RunsInsideTheTUIAgainstCommittedCredentials(t *testing.T) {
	defer ForcePlain()()

	var gotHost, gotKey, gotWorkspace string
	deps := testDeps()
	deps.RunDoctor = func(_ context.Context, host, apiKey, workspace string) DoctorReport {
		gotHost, gotKey, gotWorkspace = host, apiKey, workspace
		return sampleReport()
	}

	w, cmd := atDoctorRunning(t, deps)
	if !w.doctorStep.running {
		t.Error("the doctor screen should show the probes as running")
	}
	if cmd == nil {
		t.Fatal("entering doctor must schedule the probe command")
	}

	w = drive(w, cmd())
	if gotHost != "http://localhost:8000" || gotKey != "vlr_test_key" || gotWorkspace != "valaris" {
		t.Errorf("doctor must judge the wizard's committed credentials, got %q %q %q",
			gotHost, gotKey, gotWorkspace)
	}

	view := w.View()
	for _, want := range []string{"git version 2.44.0", "no MCP server config", "gh auth login", "will not run"} {
		if !strings.Contains(view, want) {
			t.Errorf("doctor view should show %q, got:\n%s", want, view)
		}
	}
}

func TestDoctorStep_EscReturnsToModeSelectWithoutCancelling(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.RunDoctor = func(context.Context, string, string, string) DoctorReport { return sampleReport() }

	w, cmd := atDoctorRunning(t, deps)
	w = drive(w, cmd(), key("esc"))

	if got := w.Step(); got != StepMode {
		t.Errorf("esc from the doctor report should return to mode select, got %v", got)
	}
	if w.Result().Cancelled {
		t.Error("leaving the doctor screen must not cancel the wizard")
	}
}

func TestDoctorStep_RRunsTheChecksAgain(t *testing.T) {
	defer ForcePlain()()

	runs := 0
	deps := testDeps()
	deps.RunDoctor = func(context.Context, string, string, string) DoctorReport {
		runs++
		return sampleReport()
	}

	w, cmd := atDoctorRunning(t, deps)
	w = drive(w, cmd())

	model, rerun := w.Update(key("r"))
	w = model.(Wizard)
	if !w.doctorStep.running {
		t.Error("r should put the screen back into its running state")
	}
	if rerun == nil {
		t.Fatal("r must schedule a fresh probe command")
	}
	drive(w, rerun())
	if runs != 2 {
		t.Errorf("expected the probes to run twice, got %d", runs)
	}
}

func TestDoctorStep_UnwiredDepExplainsItself(t *testing.T) {
	defer ForcePlain()()

	w := selectMode(t, atModeSelect(t, testDeps()), ModeDoctor)
	if w.Step() != StepDoctor {
		t.Fatalf("expected StepDoctor, got %v", w.Step())
	}
	if w.doctorStep.running {
		t.Error("with no RunDoctor dep there is nothing to spin on")
	}
	if !strings.Contains(w.View(), "not wired") {
		t.Errorf("an unwired doctor should say so instead of stalling, got:\n%s", w.View())
	}
}

func TestDoctorStep_LateReportOffStepIsIgnored(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.RunDoctor = func(context.Context, string, string, string) DoctorReport { return sampleReport() }

	w, cmd := atDoctorRunning(t, deps)
	w = drive(w, key("esc"), cmd())

	if got := w.Step(); got != StepMode {
		t.Errorf("a report landing after esc must not yank the user back, got %v", got)
	}
}

func TestDoctorStep_UsesSelectedMCPAndProfile(t *testing.T) {
	deps := needsSetupDeps()
	legacyCalled := false
	deps.RunDoctor = func(context.Context, string, string, string) DoctorReport { legacyCalled = true; return sampleReport() }
	var got Result
	deps.RunDoctorForResult = func(_ context.Context, result Result) DoctorReport { got = result; return sampleReport() }
	w := NewWizard(deps)
	w.loadedProfileName = "undertow"
	model, _ := w.commitExistingMCP("/selected/private-mcp.json", "manual path")
	w = model.(Wizard)
	model, cmd := w.enterDoctor()
	w = model.(Wizard)
	if cmd == nil {
		t.Fatal("missing result-aware doctor command")
	}
	w = drive(w, cmd())
	if legacyCalled || got.LoadedProfileName != "undertow" || got.MCPConfigPath != "/selected/private-mcp.json" || !got.MCPConfigSelected {
		t.Fatalf("doctor did not use effective selection: profile=%q path=%q selected=%v legacy=%v", got.LoadedProfileName, got.MCPConfigPath, got.MCPConfigSelected, legacyCalled)
	}
	if !w.doctorStep.done {
		t.Fatal("doctor report not displayed")
	}
}
