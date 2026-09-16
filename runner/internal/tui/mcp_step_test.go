// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"errors"
	"fmt"
	tea "github.com/charmbracelet/bubbletea"
	"strings"
	"testing"
)

// needsSetupDeps is testDeps with an MCP situation that demands the step: no
// config found anywhere, uvx present, any checkout path accepted.
func needsSetupDeps() WizardDeps {
	deps := testDeps()
	deps.MCPStatus = func() MCPConfigStatus {
		return MCPConfigStatus{WriteTo: "/home/seba/.config/backplane/mcp-config.json"}
	}
	deps.UvxAvailable = func() bool { return true }
	deps.ValidateMCPServerDir = func(string) error { return nil }
	return deps
}

// atMCP walks the happy path to the MCP step. It asserts placement too: the
// provider step must hand off here, not straight to review.
func atMCP(t *testing.T, deps WizardDeps) Wizard {
	t.Helper()
	w := drive(atProvider(t, deps), key("enter"))
	if w.Step() != StepMCP {
		t.Fatalf("expected StepMCP after the provider step, got %v", w.Step())
	}
	return w
}

func TestMCPConfigStatus_NeedsSetup(t *testing.T) {
	tests := []struct {
		name   string
		status MCPConfigStatus
		want   bool
	}{
		{"nothing found", MCPConfigStatus{}, true},
		{"only the shipped template", MCPConfigStatus{Path: "/repo/configs/mcp-config.example.json", IsTemplate: true}, true},
		{"a real config", MCPConfigStatus{Path: "/home/seba/.config/backplane/mcp-config.json"}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.status.NeedsSetup(); got != tc.want {
				t.Errorf("NeedsSetup() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestMCPStep_ShownWhenSetupIsNeeded(t *testing.T) {
	defer ForcePlain()()

	tests := []struct {
		name   string
		status MCPConfigStatus
	}{
		{"no config discovered", MCPConfigStatus{WriteTo: "/cfg/mcp-config.json"}},
		{"discovered only the shipped template", MCPConfigStatus{
			Path:       "/repo/configs/mcp-config.example.json",
			IsTemplate: true,
			WriteTo:    "/cfg/mcp-config.json",
		}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			deps := needsSetupDeps()
			deps.MCPStatus = func() MCPConfigStatus { return tc.status }

			w := drive(atProvider(t, deps), key("enter"))
			if w.Step() != StepMCP {
				t.Fatalf("an unconfigured MCP must stop at the step, got %v", w.Step())
			}
		})
	}
}

func TestMCPStep_ExistingConfigIsExplicitlyConfirmed(t *testing.T) {
	defer ForcePlain()()

	deps := needsSetupDeps()
	deps.MCPStatus = func() MCPConfigStatus {
		return MCPConfigStatus{Path: "/home/seba/.config/backplane/mcp-config.json"}
	}

	w := drive(atProvider(t, deps), key("enter"))
	if w.Step() != StepMCP {
		t.Fatalf("a discovered config must remain editable, got %v", w.Step())
	}
	w = drive(w, key("enter"))
	res := w.Result()
	if res.MCPWrite {
		t.Error("a skipped step must not ask for a write")
	}
	if res.MCPConfigPath != "/home/seba/.config/backplane/mcp-config.json" {
		t.Errorf("the discovered config should be carried through, got %q", res.MCPConfigPath)
	}
}

func TestMCPStep_BackFromReviewRespectsTheSkip(t *testing.T) {
	defer ForcePlain()()

	t.Run("configured: back lands on mcp", func(t *testing.T) {
		deps := needsSetupDeps()
		deps.MCPStatus = func() MCPConfigStatus {
			return MCPConfigStatus{Path: "/cfg/mcp-config.json"}
		}
		w := drive(atProvider(t, deps), key("enter"), key("enter"))
		if w.Step() != StepReview {
			t.Fatalf("setup: expected StepReview, got %v", w.Step())
		}
		w = drive(w, key("esc"))
		if w.Step() != StepMCP {
			t.Errorf("back must return to the editable MCP selection, got %v", w.Step())
		}
	})

	t.Run("shown: back lands on mcp", func(t *testing.T) {
		w := atMCP(t, needsSetupDeps())
		w = drive(w, key("enter")) // "write one for me" → review
		if w.Step() != StepReview {
			t.Fatalf("setup: expected StepReview, got %v", w.Step())
		}
		w = drive(w, key("esc"))
		if w.Step() != StepMCP {
			t.Errorf("back should return to the MCP step, got %v", w.Step())
		}
		w = drive(w, key("esc"))
		if w.Step() != StepProvider {
			t.Errorf("back from the MCP step is the provider step, got %v", w.Step())
		}
	})
}

func TestMCPStep_WriteOneForMeIsTheDefaultChoice(t *testing.T) {
	defer ForcePlain()()

	deps := needsSetupDeps()
	w := drive(atMCP(t, deps), key("enter"))

	if w.Step() != StepReview {
		t.Fatalf("choosing a write should advance, got %v", w.Step())
	}
	res := w.Result()
	if !res.MCPWrite {
		t.Error("the write choice must record MCPWrite")
	}
	if got, want := res.MCPConfigPath, deps.MCPStatus().WriteTo; got != want {
		t.Errorf("want write path %q, got %q", want, got)
	}
	if got, want := res.MCPLaunch, MCPLaunchUvx(); got.Command != want.Command || strings.Join(got.Args, " ") != strings.Join(want.Args, " ") {
		t.Errorf("want the uvx launch %+v, got %+v", want, got)
	}
}

func TestMCPStep_CheckoutPathIsValidatedBeforeAdvancing(t *testing.T) {
	defer ForcePlain()()

	t.Run("rejects an invalid directory", func(t *testing.T) {
		deps := needsSetupDeps()
		deps.ValidateMCPServerDir = func(string) error {
			return errors.New("no pyproject.toml in that directory")
		}
		w := drive(atMCP(t, deps), key("down"), key("enter")) // choose "I have a checkout"
		w = typeRunes(w, "/nope")
		w = drive(w, key("enter"))

		if w.Step() != StepMCP {
			t.Fatalf("an invalid checkout must block the step, got %v", w.Step())
		}
		if !strings.Contains(w.View(), "no pyproject.toml in that directory") {
			t.Errorf("the validator message should be shown verbatim, got:\n%s", w.View())
		}
		if w.Result().MCPWrite {
			t.Error("a rejected path must not record a write")
		}
	})

	t.Run("accepts a valid directory", func(t *testing.T) {
		const dir = "/home/seba/Programming/valaris/internal/mcp-server"
		var validated string
		deps := needsSetupDeps()
		deps.ValidateMCPServerDir = func(p string) error {
			validated = p
			return nil
		}
		w := drive(atMCP(t, deps), key("down"), key("enter"))
		w = typeRunes(w, dir)
		w = drive(w, key("enter"))

		if w.Step() != StepReview {
			t.Fatalf("a valid checkout should advance, got %v", w.Step())
		}
		if validated != dir {
			t.Errorf("validator saw %q, want %q", validated, dir)
		}
		res := w.Result()
		if !res.MCPWrite {
			t.Error("a checkout choice still writes a config")
		}
		want := MCPLaunchCheckout(dir)
		if res.MCPLaunch.Command != want.Command || strings.Join(res.MCPLaunch.Args, " ") != strings.Join(want.Args, " ") {
			t.Errorf("want the checkout launch %+v, got %+v", want, res.MCPLaunch)
		}
		if res.MCPConfigPath != deps.MCPStatus().WriteTo {
			t.Errorf("the config still goes to WriteTo, got %q", res.MCPConfigPath)
		}
	})
}

func TestMCPStep_SkipIsARealChoiceAndWarnsOnReview(t *testing.T) {
	defer ForcePlain()()

	w := drive(atMCP(t, needsSetupDeps()), key("up"), key("enter")) // wrap up to "Skip"
	if w.Step() != StepReview {
		t.Fatalf("skipping should advance to review, got %v", w.Step())
	}
	res := w.Result()
	if res.MCPWrite {
		t.Error("skipping must not schedule a write")
	}
	if res.MCPConfigPath != "" {
		t.Errorf("skipping leaves no config path, got %q", res.MCPConfigPath)
	}

	view := unwrapPanelProse(w.View())
	lower := strings.ToLower(view)
	for _, want := range []string{"loop mode", "mcp"} {
		if !strings.Contains(lower, want) {
			t.Errorf("the review must warn that a skip breaks %q, got:\n%s", want, w.View())
		}
	}
	if !strings.Contains(lower, "fail") {
		t.Errorf("a skip must not look benign on the review screen, got:\n%s", w.View())
	}
}

func TestMCPStep_ReviewRestatesTheOutcome(t *testing.T) {
	defer ForcePlain()()

	t.Run("write", func(t *testing.T) {
		deps := needsSetupDeps()
		w := drive(atMCP(t, deps), key("enter"))
		view := unwrapPanelProse(w.View())
		if !strings.Contains(view, "will write") {
			t.Errorf("review should say a config will be written, got:\n%s", w.View())
		}
		if !strings.Contains(view, deps.MCPStatus().WriteTo) {
			t.Errorf("review should name the write path, got:\n%s", w.View())
		}
	})

	t.Run("existing", func(t *testing.T) {
		const existing = "/home/seba/.config/backplane/mcp-config.json"
		deps := needsSetupDeps()
		deps.MCPStatus = func() MCPConfigStatus { return MCPConfigStatus{Path: existing} }

		w := drive(atProvider(t, deps), key("enter"))
		view := unwrapPanelProse(w.View())
		if !strings.Contains(view, existing) {
			t.Errorf("review should name the existing config, got:\n%s", w.View())
		}
		if strings.Contains(view, "will write") {
			t.Errorf("an existing config is not a pending write, got:\n%s", w.View())
		}
	})
}

func TestMCPStep_UvxUnavailableIsAnnotatedAndUnselectable(t *testing.T) {
	defer ForcePlain()()

	deps := needsSetupDeps()
	deps.UvxAvailable = func() bool { return false }
	w := atMCP(t, deps)

	view := unwrapPanelProse(w.View())
	if !strings.Contains(strings.ToLower(view), "uvx") {
		t.Errorf("the unavailable option should name the missing tool, got:\n%s", w.View())
	}

	w = drive(w, key("enter"))
	if w.Step() != StepMCP {
		t.Fatalf("an unavailable option must not advance, got %v", w.Step())
	}
	if w.Result().MCPWrite {
		t.Error("an unavailable option must not record a write")
	}
	// The other two choices still work.
	w.mcpStep.choose(mcpChoiceSkip)
	w = drive(w, key("enter")) // explicit skip
	if w.Step() != StepReview {
		t.Errorf("skip must stay reachable when uvx is missing, got %v", w.Step())
	}
}

// The wizard is a pure state machine: every MCP fact reaches it through
// WizardDeps, so a regression that reintroduces a direct probe or a disk read
// shows up as an un-injected call here.
func TestMCPStep_PerformsNoIO(t *testing.T) {
	defer ForcePlain()()

	var statusCalls, uvxCalls, validateCalls int
	deps := needsSetupDeps()
	deps.MCPStatus = func() MCPConfigStatus {
		statusCalls++
		return MCPConfigStatus{WriteTo: "/cfg/mcp-config.json"}
	}
	deps.UvxAvailable = func() bool {
		uvxCalls++
		return true
	}
	deps.ValidateMCPServerDir = func(string) error {
		validateCalls++
		return nil
	}

	w := drive(atMCP(t, deps), key("down"), key("enter"))
	w = typeRunes(w, "/srv/mcp-server")
	w = drive(w, key("enter"))
	_ = w.View()

	if statusCalls == 0 || uvxCalls == 0 || validateCalls == 0 {
		t.Errorf("the step must read every MCP fact through deps (status=%d uvx=%d validate=%d)",
			statusCalls, uvxCalls, validateCalls)
	}
}

// A caller that wires nothing must still reach review: an unknown MCP situation
// is not a reason to strand the operator.
func TestMCPStep_UnwiredDepsSkipTheStep(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps() // no MCPStatus, no UvxAvailable, no ValidateMCPServerDir
	w := drive(atProvider(t, deps), key("enter"))
	if w.Step() != StepReview {
		t.Fatalf("unwired MCP deps should not block the flow, got %v", w.Step())
	}
	if w.Result().MCPWrite {
		t.Error("unwired deps must not schedule a write")
	}
}

func TestMCPStep_GenerationCollisionRequiresNewDestination(t *testing.T) {
	deps := needsSetupDeps()
	deps.ValidateMCPWritePath = func(path string) error {
		if path == deps.MCPStatus().WriteTo {
			return ErrMCPConfigExists
		}
		return nil
	}
	w := drive(atMCP(t, deps), key("enter"))
	if w.Step() != StepMCP || w.Result().MCPWrite {
		t.Fatal("existing config silently reused or overwritten")
	}
	if !w.mcpStep.typingPath {
		t.Fatal("collision must offer a new destination")
	}
	w.mcpStep.input.SetValue("/private/new-mcp.json")
	w = drive(w, key("enter"))
	if w.Step() != StepReview || !w.Result().MCPWrite || w.Result().MCPConfigPath != "/private/new-mcp.json" {
		t.Fatalf("new destination did not preserve generation intent: %+v", w.Result())
	}
}

func TestMCPStep_AutoFindRequiresExplicitSelectionAndValidation(t *testing.T) {
	deps := needsSetupDeps()
	validated := ""
	deps.DiscoverMCPConfigs = func() []MCPConfigCandidate {
		return []MCPConfigCandidate{{Path: "/other/mcp.json", Origin: "working directory"}, {Path: "/chosen/mcp.json", Origin: "saved profile"}}
	}
	deps.ValidateMCPConfig = func(path string) error { validated = path; return nil }
	w := atMCP(t, deps)
	for i, c := range mcpChoices {
		if c.choice == mcpChoiceDiscover {
			w.mcpStep.cursor = i
		}
	}
	w = drive(w, key("enter"))
	if w.Result().MCPConfigSelected {
		t.Fatal("discovery selected a config without user choice")
	}
	w = drive(w, key("down"), key("enter"))
	result := w.Result()
	if w.Step() != StepReview || validated != "/chosen/mcp.json" || result.MCPConfigOrigin != "saved profile" || !result.MCPConfigSelected {
		t.Fatalf("picker selection not committed: %+v validated=%s", result, validated)
	}
}

func TestMCPStep_ChangingTemplateClearsOldDiagnosis(t *testing.T) {
	deps := needsSetupDeps()
	deps.MCPStatus = func() MCPConfigStatus {
		return MCPConfigStatus{Path: "/template/example.json", IsTemplate: true, Issue: "old template issue"}
	}
	w := NewWizard(deps)
	model, _ := w.commitExistingMCP("/configured/selected.json", "manual path")
	w = model.(Wizard)
	w.step = StepMCP
	if w.mcpStep.status.IsTemplate || strings.Contains(w.View(), "old template issue") {
		t.Fatal("selected valid config retained stale template diagnosis")
	}
}

func TestMCPStep_RevisitPendingGenerationRetainsIntent(t *testing.T) {
	deps := needsSetupDeps()
	deps.ValidateMCPConfig = func(string) error { return errors.New("pending file does not exist yet") }
	w := drive(atMCP(t, deps), key("enter"))
	w = drive(w, key("esc"))
	w.mcpStep.choose(mcpChoiceUse)
	w = drive(w, key("enter"))
	if w.Step() != StepReview || !w.Result().MCPWrite {
		t.Fatal("revisiting pending generation attempted to read uncreated file")
	}
}

func TestMCPStep_FitsTerminalWhileKeepingSelectionAndErrorsVisible(t *testing.T) {
	defer ForcePlain()()
	for _, size := range [][2]int{{80, 24}, {100, 30}} {
		for _, discovery := range []bool{false, true} {
			t.Run(fmt.Sprintf("%dx%d/discovery=%v", size[0], size[1], discovery), func(t *testing.T) {
				deps := needsSetupDeps()
				deps.MCPStatus = func() MCPConfigStatus {
					return MCPConfigStatus{Path: "/opt/runner-fixture/profiles/undertow/mcp.json", Origin: "profile undertow"}
				}
				w := atMCP(t, deps)
				w = drive(w, tea.WindowSizeMsg{Width: size[0], Height: size[1]})
				w.mcpStep.err = errors.New("Configuration is invalid; choose another file.")
				if discovery {
					w.mcpStep.discovering = true
					for i := 0; i < 20; i++ {
						w.mcpStep.candidates = append(w.mcpStep.candidates, MCPConfigCandidate{Path: fmt.Sprintf("/opt/runner-fixture/configs/candidate-%d.json", i), Origin: "saved profile"})
					}
					w.mcpStep.candidateCursor = 10
				}
				view := w.View()
				if lines := strings.Count(view, "\n") + 1; lines > size[1] {
					t.Fatalf("screen needs %d lines in %d-row terminal:\n%s", lines, size[1], view)
				}
				for _, want := range []string{"/opt/runner-fixture/profiles/undertow/mcp.json", "profile undertow", "Configuration is invalid"} {
					if !strings.Contains(view, want) {
						t.Errorf("missing %q", want)
					}
				}
				if discovery && !strings.Contains(view, "candidate-10.json") {
					t.Fatal("selected discovery candidate offscreen")
				}
			})
		}
	}
}
