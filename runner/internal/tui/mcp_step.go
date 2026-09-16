// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/bubbles/filepicker"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
)

// MCPConfigCandidate contains display-safe metadata, never config contents.
type MCPConfigCandidate struct {
	Path       string
	Origin     string
	Issue      string
	IsTemplate bool
}

type MCPConfigStatus struct {
	Path       string
	Origin     string
	Issue      string
	IsTemplate bool
	WriteTo    string
}

func (s MCPConfigStatus) NeedsSetup() bool { return s.Path == "" || s.IsTemplate || s.Issue != "" }

type mcpChoice int

const (
	mcpChoiceWrite mcpChoice = iota
	mcpChoiceCheckout
	mcpChoiceUse
	mcpChoiceDiscover
	mcpChoiceManual
	mcpChoiceBrowse
	mcpChoiceSkip
)

var mcpChoices = []struct {
	choice             mcpChoice
	Label, Description string
}{
	{mcpChoiceWrite, "Write one for me", "create a compatible published server configuration with uvx"},
	{mcpChoiceCheckout, "I have a checkout", "create a configuration for a local Backplane source tree"},
	{mcpChoiceUse, "Use selected config", "keep the path shown above after checking its configuration"},
	{mcpChoiceDiscover, "Auto-find MCP configs", "list discovered paths and their origins; choose one explicitly"},
	{mcpChoiceManual, "Enter a config path", "use an existing configuration anywhere on this machine"},
	{mcpChoiceBrowse, "Browse for a config", "navigate directories and select an existing configuration"},
	{mcpChoiceSkip, "Skip", "continue without MCP — loop mode will not work"},
}

type mcpPathPurpose int

const (
	mcpPathCheckout mcpPathPurpose = iota
	mcpPathConfig
	mcpPathDestination
)

type mcpStep struct {
	status          MCPConfigStatus
	uvxOK           bool
	cursor          int
	typingPath      bool
	pathPurpose     mcpPathPurpose
	input           textinput.Model
	err             error
	discovering     bool
	candidates      []MCPConfigCandidate
	candidateCursor int
	browsing        bool
	picker          filepicker.Model
	decided         bool
	write           bool
	launch          MCPLaunch
	pendingLaunch   MCPLaunch
	path            string
	origin          string
}

func newMCPStep() mcpStep {
	input := textinput.New()
	input.Prompt = "› "
	input.Placeholder = "/path/to/backplane/mcp-server"
	input.CharLimit = 4096
	picker := filepicker.New()
	picker.ShowPermissions = false
	picker.ShowSize = false
	picker.ShowHidden = true
	return mcpStep{input: input, picker: picker}
}

func (s mcpStep) selected() mcpChoice {
	if s.cursor < 0 || s.cursor >= len(mcpChoices) {
		return mcpChoiceSkip
	}
	return mcpChoices[s.cursor].choice
}
func (s *mcpStep) choose(choice mcpChoice) {
	for i, c := range mcpChoices {
		if c.choice == choice {
			s.cursor = i
			return
		}
	}
}
func (s mcpStep) mcpConfigPath() string {
	if s.decided {
		return s.path
	}
	return s.status.Path
}
func (s mcpStep) mcpConfigOrigin() string {
	if s.decided {
		return s.origin
	}
	return s.status.Origin
}
func (s mcpStep) skipped() bool { return s.decided && !s.write && s.path == "" }
func (w Wizard) needsMCPStep() bool {
	return w.deps.MCPStatus != nil || w.deps.DiscoverMCPConfigs != nil || w.loadedProfileName != ""
}
func (w Wizard) enterMCP() (tea.Model, tea.Cmd) {
	if !w.needsMCPStep() {
		w.step = StepReview
		return w, nil
	}
	w.step = StepMCP
	w.mcpStep.err = nil
	return w, nil
}

func absoluteMCPPath(path string) (string, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return "", errors.New("enter a configuration path")
	}
	if path == "~" || strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", errors.New("cannot resolve your home directory; enter an absolute path")
		}
		if path == "~" {
			path = home
		} else {
			path = filepath.Join(home, path[2:])
		}
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", errors.New("cannot resolve this path; enter an absolute path")
	}
	return filepath.Clean(absolute), nil
}

func (w Wizard) mcpKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if w.mcpStep.typingPath {
		return w.mcpPathKey(msg)
	}
	if w.mcpStep.browsing {
		return w.mcpBrowseUpdate(msg)
	}
	if w.mcpStep.discovering {
		switch msg.String() {
		case "esc":
			w.mcpStep.discovering = false
			w.mcpStep.err = nil
		case "up", "k":
			if len(w.mcpStep.candidates) > 0 {
				w.mcpStep.candidateCursor = wrapIndex(w.mcpStep.candidateCursor-1, len(w.mcpStep.candidates))
			}
		case "down", "j":
			if len(w.mcpStep.candidates) > 0 {
				w.mcpStep.candidateCursor = wrapIndex(w.mcpStep.candidateCursor+1, len(w.mcpStep.candidates))
			}
		case "enter":
			if len(w.mcpStep.candidates) > 0 {
				candidate := w.mcpStep.candidates[w.mcpStep.candidateCursor]
				if candidate.IsTemplate {
					w.mcpStep.err = errors.New("this is an example template; create a configuration or select a configured file")
					return w, nil
				}
				return w.commitExistingMCP(candidate.Path, candidate.Origin)
			}
		}
		return w, nil
	}
	switch msg.String() {
	case "up", "k":
		w.mcpStep.cursor = wrapIndex(w.mcpStep.cursor-1, len(mcpChoices))
		w.mcpStep.err = nil
	case "down", "j":
		w.mcpStep.cursor = wrapIndex(w.mcpStep.cursor+1, len(mcpChoices))
		w.mcpStep.err = nil
	case "enter":
		return w.commitMCPChoice()
	}
	return w, nil
}

func (w Wizard) commitMCPChoice() (tea.Model, tea.Cmd) {
	w.mcpStep.err = nil
	switch w.mcpStep.selected() {
	case mcpChoiceWrite:
		if !w.mcpStep.uvxOK {
			w.mcpStep.err = errors.New("uvx is not on your PATH — install uv, or point the wizard at a checkout")
			return w, nil
		}
		w.mcpStep.pendingLaunch = MCPLaunchUvx()
		return w.commitMCPDestination(w.mcpStep.status.WriteTo)
	case mcpChoiceCheckout:
		return w.openMCPPath(mcpPathCheckout, "", "/path/to/backplane/mcp-server")
	case mcpChoiceUse:
		if w.mcpStep.write {
			w.mcpStep.pendingLaunch = w.mcpStep.launch
			return w.commitMCPDestination(w.mcpStep.path)
		}
		if w.mcpStep.status.IsTemplate && !w.mcpStep.decided {
			w.mcpStep.err = errors.New("the selected file is an example template; create a configuration or choose another file")
			return w, nil
		}
		return w.commitExistingMCP(w.mcpStep.mcpConfigPath(), w.mcpStep.mcpConfigOrigin())
	case mcpChoiceDiscover:
		w.mcpStep.discovering = true
		w.mcpStep.candidateCursor = 0
		w.mcpStep.candidates = nil
		if w.deps.DiscoverMCPConfigs != nil {
			w.mcpStep.candidates = w.deps.DiscoverMCPConfigs()
		}
		for i, c := range w.mcpStep.candidates {
			if path, err := absoluteMCPPath(c.Path); err == nil {
				w.mcpStep.candidates[i].Path = path
			}
		}
	case mcpChoiceManual:
		return w.openMCPPath(mcpPathConfig, w.mcpStep.mcpConfigPath(), "/absolute/path/to/mcp-config.json")
	case mcpChoiceBrowse:
		w.mcpStep.browsing = true
		directory := "."
		if selected := w.mcpStep.mcpConfigPath(); selected != "" {
			directory = filepath.Dir(selected)
		}
		if info, err := os.Stat(directory); err != nil || !info.IsDir() {
			directory = "."
		}
		if absolute, err := filepath.Abs(directory); err == nil {
			directory = absolute
		}
		w.mcpStep.picker.CurrentDirectory = directory
		w.mcpStep.picker.AutoHeight = false
		w.mcpStep.picker.SetHeight(max(3, min(12, w.height-16)))
		return w, w.mcpStep.picker.Init()
	case mcpChoiceSkip:
		w.mcpStep.decided = true
		w.mcpStep.write = false
		w.mcpStep.launch = MCPLaunch{}
		w.mcpStep.path = ""
		w.mcpStep.origin = "explicit skip"
		return w.finishMCP()
	}
	return w, nil
}

func (w Wizard) openMCPPath(purpose mcpPathPurpose, value, placeholder string) (tea.Model, tea.Cmd) {
	w.mcpStep.typingPath = true
	w.mcpStep.pathPurpose = purpose
	w.mcpStep.input.SetValue(value)
	w.mcpStep.input.Placeholder = placeholder
	w.mcpStep.input.CursorEnd()
	return w, w.mcpStep.input.Focus()
}
func (w Wizard) mcpPathKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case tea.KeyEsc:
		w.mcpStep.typingPath = false
		w.mcpStep.input.Blur()
		w.mcpStep.err = nil
		return w, nil
	case tea.KeyEnter:
		switch w.mcpStep.pathPurpose {
		case mcpPathCheckout:
			return w.commitMCPCheckout()
		case mcpPathConfig:
			return w.commitExistingMCP(w.mcpStep.input.Value(), "manual path")
		case mcpPathDestination:
			return w.commitMCPDestination(w.mcpStep.input.Value())
		}
	}
	var cmd tea.Cmd
	w.mcpStep.input, cmd = w.mcpStep.input.Update(msg)
	return w, cmd
}
func (w Wizard) commitMCPCheckout() (tea.Model, tea.Cmd) {
	dir, err := absoluteMCPPath(w.mcpStep.input.Value())
	if err != nil {
		w.mcpStep.err = errors.New("type the path to the mcp-server directory")
		return w, nil
	}
	if validate := w.deps.ValidateMCPServerDir; validate != nil {
		if err := validate(dir); err != nil {
			w.mcpStep.err = err
			return w, nil
		}
	}
	w.mcpStep.pendingLaunch = MCPLaunchCheckout(dir)
	return w.commitMCPDestination(w.mcpStep.status.WriteTo)
}
func (w Wizard) commitMCPDestination(value string) (tea.Model, tea.Cmd) {
	path, err := absoluteMCPPath(value)
	if err == nil && w.deps.ValidateMCPWritePath != nil {
		err = w.deps.ValidateMCPWritePath(path)
	}
	if err != nil {
		w.mcpStep.err = err
		if errors.Is(err, ErrMCPConfigExists) {
			w.mcpStep.err = errors.New("a configuration already exists at this destination; enter a new destination or go back and explicitly select the existing config")
		}
		model, cmd := w.openMCPPath(mcpPathDestination, value, "/absolute/path/to/new-mcp-config.json")
		return model, cmd
	}
	w.mcpStep.decided = true
	w.mcpStep.write = true
	w.mcpStep.launch = w.mcpStep.pendingLaunch
	w.mcpStep.pendingLaunch = MCPLaunch{}
	w.mcpStep.status.IsTemplate = false
	w.mcpStep.status.Issue = ""
	w.mcpStep.path = path
	w.mcpStep.origin = "generated configuration"
	return w.finishMCP()
}
func (w Wizard) commitExistingMCP(value, origin string) (tea.Model, tea.Cmd) {
	path, err := absoluteMCPPath(value)
	if err == nil && w.deps.ValidateMCPConfig != nil {
		err = w.deps.ValidateMCPConfig(path)
	}
	if err != nil {
		w.mcpStep.err = err
		return w, nil
	}
	if origin == "" {
		origin = "selected configuration"
	}
	w.mcpStep.decided = true
	w.mcpStep.write = false
	w.mcpStep.launch = MCPLaunch{}
	w.mcpStep.path = path
	w.mcpStep.origin = origin
	w.mcpStep.status.Issue = ""
	w.mcpStep.status.IsTemplate = false
	return w.finishMCP()
}
func (w Wizard) finishMCP() (tea.Model, tea.Cmd) {
	w.mcpStep.err = nil
	w.mcpStep.typingPath = false
	w.mcpStep.discovering = false
	w.mcpStep.browsing = false
	w.mcpStep.input.Blur()
	w.jumpedFromReview = false
	w.step = StepReview
	return w, nil
}
func (w Wizard) mcpBrowseUpdate(msg tea.Msg) (tea.Model, tea.Cmd) {
	if key, ok := msg.(tea.KeyMsg); ok && key.Type == tea.KeyEsc {
		w.mcpStep.browsing = false
		return w, nil
	}
	var cmd tea.Cmd
	w.mcpStep.picker, cmd = w.mcpStep.picker.Update(msg)
	if selected, path := w.mcpStep.picker.DidSelectFile(msg); selected {
		return w.commitExistingMCP(path, "file browser")
	}
	return w, cmd
}

const mcpConsequences = "The coding agent reaches your board through the Backplane MCP server: claiming cards, posting notes, moving them to done. Loop mode does nothing without it."

func (w Wizard) mcpView(th Theme, width int) string {
	s := w.mcpStep
	wrap := func(value string) string { return ansi.Hardwrap(value, max(1, width), false) }
	lineCount := func(value string) int {
		if value == "" {
			return 0
		}
		return strings.Count(value, "\n") + 1
	}
	budget := 30
	if w.height > 0 {
		budget = max(5, w.height-lineCount(w.chromeView(th, width))-lineCount(w.footerView(th, width))-4)
	}
	lines := []string{th.Title.Render("MCP configuration")}
	if path := s.mcpConfigPath(); path != "" {
		lines = append(lines, th.Subtitle.Render(wrap("Selected: "+path)), th.Subtle.Render(wrap("Origin: "+s.mcpConfigOrigin())))
	} else {
		lines = append(lines, th.Subtle.Render("No MCP configuration selected."))
	}
	diagnostics := []string{}
	if s.err != nil {
		diagnostics = append(diagnostics, th.Error.Render(wrap("✗ "+s.err.Error())))
	} else if s.status.Issue != "" {
		diagnostics = append(diagnostics, th.Warn.Render(wrap(s.status.Issue)))
	} else if s.status.IsTemplate {
		diagnostics = append(diagnostics, th.Warn.Render("Example template — create or select a configured file."))
	}
	available := max(1, budget-lineCount(strings.Join(lines, "\n"))-lineCount(strings.Join(diagnostics, "\n")))
	switch {
	case s.typingPath:
		label := "Path to the mcp-server directory:"
		if s.pathPurpose == mcpPathConfig {
			label = "Path to an existing MCP configuration:"
		} else if s.pathPurpose == mcpPathDestination {
			label = "New destination (existing files are never replaced):"
		}
		lines = append(lines, th.Subtitle.Render(wrap(label)), s.input.View())
	case s.browsing:
		location := th.Subtitle.Render(wrap("Directory: " + s.picker.CurrentDirectory))
		s.picker.AutoHeight = false
		s.picker.SetHeight(max(1, available-lineCount(location)))
		lines = append(lines, location, s.picker.View())
	case s.discovering:
		lines = append(lines, th.Title.Render("Auto-find MCP configs"))
		if len(s.candidates) == 0 {
			lines = append(lines, th.Subtle.Render(wrap("No configurations found. Press esc to enter a path, browse, or create one.")))
			break
		}
		selected := s.candidates[s.candidateCursor]
		detail := th.Subtitle.Render(wrap(selected.Path)) + "\n" + th.Subtle.Render(wrap("Origin: "+selected.Origin))
		if selected.Issue != "" {
			detail += "\n" + th.Warn.Render(wrap(selected.Issue))
		} else if selected.IsTemplate {
			detail += "\n" + th.Warn.Render("Example template")
		}
		count := max(1, min(len(s.candidates), available-lineCount(detail)-1))
		first := max(0, min(s.candidateCursor-count/2, len(s.candidates)-count))
		for i := first; i < first+count; i++ {
			candidate := s.candidates[i]
			marker := "  "
			style := th.Subtitle
			if i == s.candidateCursor {
				marker = "▸ "
				style = th.Selected
			}
			lines = append(lines, style.Render(truncateCells(marker+filepath.Base(candidate.Path)+" — "+candidate.Origin, width)))
		}
		lines = append(lines, detail)
	default:
		count := min(len(mcpChoices), available)
		first := max(0, min(s.cursor-count/2, len(mcpChoices)-count))
		for i := first; i < first+count; i++ {
			opt := mcpChoices[i]
			marker := "  "
			style := th.Subtitle
			if i == s.cursor {
				marker = "▸ "
				style = th.Selected
			}
			label := opt.Label
			if opt.choice == mcpChoiceWrite && !s.uvxOK {
				label += " (uvx unavailable)"
			}
			lines = append(lines, style.Render(truncateCells(marker+label, width)))
		}
		if available > count {
			note := mcpChoices[s.cursor].Description
			lines = append(lines, th.Subtle.Render(truncateCells(note, width)))
		}
	}
	lines = append(lines, diagnostics...)
	return strings.Join(lines, "\n")
}
func (w Wizard) mcpReviewRow() (reviewRow, bool) {
	s := w.mcpStep
	switch {
	case s.skipped():
		return reviewRow{label: "mcp config", value: "skipped — loop mode will fail without it", warn: true, owner: StepMCP}, true
	case s.write:
		return reviewRow{label: "mcp config", value: "will write " + s.path + " (" + s.mcpConfigOrigin() + ")", owner: StepMCP}, true
	case s.mcpConfigPath() != "":
		return reviewRow{label: "mcp config", value: s.mcpConfigPath() + " (" + s.mcpConfigOrigin() + ")", warn: s.status.Issue != "", owner: StepMCP}, true
	case w.needsMCPStep():
		return reviewRow{label: "mcp config", value: "not selected", warn: true, owner: StepMCP}, true
	}
	return reviewRow{}, false
}
