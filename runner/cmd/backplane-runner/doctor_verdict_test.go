// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/tui"
)

// "5 ok · 2 warning(s) · 0 failed" left a real operator unable to tell whether
// they had passed. Counts are evidence; the verdict has to state the outcome.
func TestDoctorVerdict_WarningsReadAsUsable(t *testing.T) {
	results := []checkResult{
		{Label: "a", State: tui.StateOK},
		{Label: "b", State: tui.StateWarn, Fix: "x"},
	}

	verdict := strings.ToLower(doctorVerdict(results))

	if !strings.Contains(verdict, "ready") {
		t.Errorf("a warnings-only verdict must say the runner can proceed: %q", verdict)
	}
	if strings.Contains(verdict, "will not run") {
		t.Errorf("warnings are not a failure: %q", verdict)
	}
	if got := doctorExitCode(results); got != 0 {
		t.Errorf("warnings must still exit 0, got %d", got)
	}
}

func TestDoctorVerdict_FailuresReadAsBlocking(t *testing.T) {
	results := []checkResult{
		{Label: "a", State: tui.StateOK},
		{Label: "b", State: tui.StateFail, Fix: "y"},
	}

	verdict := strings.ToLower(doctorVerdict(results))

	if !strings.Contains(verdict, "will not run") {
		t.Errorf("a failing verdict must say the runner will not run: %q", verdict)
	}
	if got := doctorExitCode(results); got != 1 {
		t.Errorf("a failure must exit 1, got %d", got)
	}
}

func TestDoctorVerdict_CleanRunSaysSo(t *testing.T) {
	verdict := strings.ToLower(doctorVerdict([]checkResult{{Label: "a", State: tui.StateOK}}))

	if !strings.Contains(verdict, "ready") {
		t.Errorf("an all-OK verdict must say the machine is ready: %q", verdict)
	}
	if strings.Contains(verdict, "caveat") || strings.Contains(verdict, "will not run") {
		t.Errorf("a clean run must not be hedged: %q", verdict)
	}
}

// The counts are still the evidence behind the words — losing them would cost
// the operator the ability to see how much is wrong at a glance.
func TestRenderDoctorReport_KeepsCountsAlongsideTheWords(t *testing.T) {
	defer tui.ForcePlain()()

	out := renderDoctorReport([]checkResult{
		{Label: "a", State: tui.StateOK},
		{Label: "b", State: tui.StateWarn, Fix: "x"},
	}, 80)

	for _, want := range []string{"1 ok", "1 warning", "ready"} {
		if !strings.Contains(strings.ToLower(out), want) {
			t.Errorf("verdict line should contain %q:\n%s", want, out)
		}
	}
}

// A warning that does not say what breaks is a warning the operator ignores.
// These two are the ones a real first-run hit.
func TestWarnings_NameTheConsequenceOfIgnoringThem(t *testing.T) {
	templatePath := filepath.Join(t.TempDir(), mcpConfigTemplateFilename)
	if err := os.WriteFile(templatePath, []byte(`{"mcpServers":{}}`), 0o600); err != nil {
		t.Fatal(err)
	}

	mcp := checkMCPConfig(templatePath)
	if mcp.State != tui.StateWarn {
		t.Fatalf("the shipped template must warn, got %v", mcp.State)
	}
	if !strings.Contains(strings.ToLower(mcp.Detail+mcp.Fix), "fail") {
		t.Errorf("the mcp warning must say what breaks if ignored: %q / %q", mcp.Detail, mcp.Fix)
	}

	backend := checkBackend(backendIdentity{UserID: "u1"}, nil)
	if backend.State != tui.StateWarn {
		t.Fatalf("a plain user key must warn, got %v", backend.State)
	}
	if !strings.Contains(strings.ToLower(backend.Detail), "cannot record executions") {
		t.Errorf("the backend warning must name the consequence: %q", backend.Detail)
	}

	forge := checkForgeCLI(fakeLookPath(), runCommandNever(t))
	if forge.State != tui.StateWarn {
		t.Fatalf("a missing gh must warn, got %v", forge.State)
	}
	if !strings.Contains(strings.ToLower(forge.Detail+forge.Fix), "github") {
		t.Errorf("the forge warning must say which forge is affected: %q / %q", forge.Detail, forge.Fix)
	}
}

// Doctor reached from the wizard must not dead-end: the operator walked a whole
// setup flow and needs to be told how to actually launch.
func TestInteractiveDoctorNextStep_TellsTheOperatorHowToLaunch(t *testing.T) {
	next := strings.ToLower(interactiveDoctorNextStep([]checkResult{{Label: "a", State: tui.StateOK}}))

	if !strings.Contains(next, "backplane-runner") {
		t.Errorf("the next step must name the command to rerun: %q", next)
	}
}

// A machine that will not run gets pointed at the fixes, not at a launch it
// cannot complete.
func TestInteractiveDoctorNextStep_PointsAtTheFixesWhenBlocked(t *testing.T) {
	next := strings.ToLower(interactiveDoctorNextStep([]checkResult{{Label: "a", State: tui.StateFail, Fix: "x"}}))

	if !strings.Contains(next, "fix") {
		t.Errorf("a blocked machine must be sent to the fixes: %q", next)
	}
}
