// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/Valaris-Studio/backplane/runner/internal/config"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

var errNoConnector = errors.New("no platform connection configured — set BACKPLANE_API_KEY or run with --config")

// ---------------------------------------------------------------- connect --

type connectStep struct {
	connecting bool
	identity   Identity
	err        error
}

func (w Wizard) connectKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if w.profileOffer.active {
		return w.profileOfferKey(msg)
	}
	if w.connectStep.err == nil {
		return w, nil
	}
	switch msg.String() {
	case "r":
		return w.enterConnect()
	case "e":
		// The failure this exists for: a valid key against the wrong host. Both
		// fields keep their values, so correcting one is a single edit rather
		// than a restart of the whole wizard.
		return w.enterCredentials()
	}
	return w, nil
}

func (w Wizard) connectView(th Theme, width int) string {
	if w.profileOffer.active {
		return w.profileOfferView(th, width)
	}
	if err := w.connectStep.err; err != nil {
		pw := PanelWidth(width)
		body := Prose(th.Error, "Could not reach the platform", pw) + "\n" +
			Prose(th.Subtitle, err.Error(), pw) + "\n\n" +
			Prose(th.Subtle, "Press r to retry, or e to edit credentials — a 404 here usually means "+
				"the key is fine but the backend url is not.", pw)
		return Panel("connection failed", body, pw)
	}

	items := []ChecklistItem{{Label: "resolving identity", State: StateRunning}}
	if id := w.connectStep.identity; id.AgentName != "" {
		items = []ChecklistItem{{Label: "resolving identity", State: StateOK, Detail: id.AgentName}}
	}
	return w.spin.View() + " " + th.Subtitle.Render("connecting to Backplane") + "\n\n" + Checklist(items)
}

// ------------------------------------------------------------------- mode --

// modeOption is one row of the mode menu.
type modeOption struct {
	Mode        Mode
	Icon        string
	Label       string
	Description string
}

// allModes is the menu in presentation order — the two board-scoped run modes
// first, then the whole-workspace utilities.
var allModes = []modeOption{
	{ModeLoop, "↻", "Loop a board", "keep working one board until its ready cards are done"},
	{ModePipeline, "⇉", "Run the pipeline", "take assignments from the platform scheduler as they appear"},
	{ModeDiscovery, "⌕", "Discovery scan", "one-shot survey of a repo — no commits, no pushes"},
	{ModeDoctor, "✚", "Doctor", "check this machine: agents on PATH, git, credentials"},
}

// needsBoard reports whether a mode operates on one specific board, which is
// what gates the picker step.
func (m Mode) needsBoard() bool {
	return m == ModeLoop || m == ModePipeline
}

type modeStep struct {
	cursor int
}

func newModeStep() modeStep { return modeStep{} }

// Selected is the mode under the cursor.
func (s modeStep) Selected() Mode {
	if s.cursor < 0 || s.cursor >= len(allModes) {
		return ""
	}
	return allModes[s.cursor].Mode
}

func (w Wizard) modeKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "up", "k":
		w.modeStep.cursor = wrapIndex(w.modeStep.cursor-1, len(allModes))
		w.providerStep.setRunModel(false)
	case "down", "j":
		w.modeStep.cursor = wrapIndex(w.modeStep.cursor+1, len(allModes))
		w.providerStep.setRunModel(false)
	case "enter":
		if w.consumeReviewJump() {
			w.step = StepReview
			return w, nil
		}
		return w.advanceFromMode()
	}
	return w, nil
}

func (w Wizard) modeView(th Theme, width int) string {
	rows := make([]string, 0, len(allModes)*2)
	for i, opt := range allModes {
		marker := "  "
		label := th.Subtitle.Render(opt.Label)
		if i == w.modeStep.cursor {
			marker = th.Accent.Render("▸") + " "
			label = th.Selected.Render(opt.Label)
		}
		rows = append(rows,
			marker+th.Accent.Render(opt.Icon)+" "+label,
			"    "+th.Subtle.Render(truncateCells(opt.Description, width-4)))
	}
	return th.Title.Render("What should this runner do?") + "\n\n" + joinStrings(rows, "\n")
}

// ------------------------------------------------------------------ board --

type boardStep struct {
	boards  []BoardChoice
	filter  string
	cursor  int
	loading bool
	err     error
	chosen  BoardChoice
	// touched records that the user has interacted with the filter, so an
	// empty filter after a backspace still counts as "filtering" for the
	// key-capture check.
	touched bool
}

func (s *boardStep) setBoards(boards []BoardChoice) {
	s.boards = boards
	s.loading = false
	s.err = nil
	s.cursor = 0
}

// filtering reports whether raw runes should go to the filter rather than to
// the global key bindings. The picker is filter-first: once boards are on
// screen, typing always narrows.
func (s boardStep) filtering() bool { return !s.loading && s.err == nil && len(s.boards) > 0 }

// visible is the board list narrowed by the current filter. Matching is
// case-insensitive across name and slug so "demo" and "Demo Workspace" both land.
func (s boardStep) visible() []BoardChoice {
	if s.filter == "" {
		return s.boards
	}
	needle := strings.ToLower(s.filter)
	matches := make([]BoardChoice, 0, len(s.boards))
	for _, b := range s.boards {
		if strings.Contains(strings.ToLower(b.Name), needle) ||
			strings.Contains(strings.ToLower(b.Slug), needle) {
			matches = append(matches, b)
		}
	}
	return matches
}

func (w Wizard) boardKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if w.boardStep.err != nil && msg.String() == "r" {
		w.boardStep.loading = true
		w.boardStep.err = nil
		return w, loadBoardsCmd(w.deps.LoadBoards, w.workspaceStep.chosen.Slug)
	}

	visible := w.boardStep.visible()

	switch msg.Type {
	case tea.KeyUp:
		w.boardStep.cursor = wrapIndex(w.boardStep.cursor-1, len(visible))
		return w, nil
	case tea.KeyDown:
		w.boardStep.cursor = wrapIndex(w.boardStep.cursor+1, len(visible))
		return w, nil
	case tea.KeyBackspace:
		if n := len(w.boardStep.filter); n > 0 {
			w.boardStep.filter = w.boardStep.filter[:n-1]
			w.boardStep.cursor = 0
		}
		return w, nil
	case tea.KeyEnter:
		// Index into the *filtered* slice — the visible row is the one the
		// user is pointing at, regardless of its position in the full list.
		if w.boardStep.cursor < 0 || w.boardStep.cursor >= len(visible) {
			return w, nil
		}
		if w.boardStep.chosen.ID != visible[w.boardStep.cursor].ID {
			w.providerStep.setRunModel(false)
		}
		w.boardStep.chosen = visible[w.boardStep.cursor]
		if w.consumeReviewJump() {
			w.step = StepReview
			return w.refreshCompletionSetup()
		}
		w.step = StepWorkDir
		return w.refreshCompletionSetup()
	case tea.KeyRunes, tea.KeySpace:
		runes := msg.Runes
		if msg.Type == tea.KeySpace {
			runes = []rune{' '}
		}
		w.boardStep.filter += string(runes)
		w.boardStep.touched = true
		w.boardStep.cursor = 0
		return w, nil
	}
	return w, nil
}

func (w Wizard) boardView(th Theme, width int) string {
	s := w.boardStep
	title := th.Title.Render("Which board?")
	if teamLine := w.pipelineTeamLine(th, width); teamLine != "" {
		title += "\n" + teamLine
	}

	switch {
	case s.err != nil:
		pw := PanelWidth(width)
		body := Prose(th.Error, "Could not load your boards", pw) + "\n" +
			Prose(th.Subtitle, s.err.Error(), pw) + "\n\n" +
			Prose(th.Subtle, "Press r to retry, or esc to pick a different mode.", pw)
		return title + "\n\n" + Panel("board list failed", body, pw)

	case s.loading:
		return title + "\n\n" + w.spin.View() + " " + th.Subtle.Render("loading boards")

	case len(s.boards) == 0:
		pw := PanelWidth(width)
		body := Prose(th.Subtitle, "No boards in this workspace yet.", pw) + "\n\n" +
			Prose(th.Subtle, "Create one in the Backplane web app, then rerun this wizard. "+
				"A board needs at least one ready card and a bound git repo before a runner can work it.", pw)
		return title + "\n\n" + Panel("nothing to run", body, pw)
	}

	visible := s.visible()
	rows := make([]string, 0, len(visible)+2)
	rows = append(rows, th.Subtle.Render("filter: ")+renderFilter(th, s.filter))

	if len(visible) == 0 {
		rows = append(rows, "", th.Warn.Render("No board matches "+strconv.Quote(s.filter))+
			"\n"+th.Subtle.Render("Backspace to widen the search."))
		return title + "\n\n" + joinStrings(rows, "\n")
	}

	rows = append(rows, "")
	nameCol := boardNameColumn(visible, width)
	for i, b := range visible {
		marker := "  "
		// Pad and truncate the PLAIN name, before styling: a styled string
		// measures its escape bytes as columns, so the notes would not line up.
		name := truncateCells(b.Name, nameCol)
		pad := strings.Repeat(" ", nameCol-lipgloss.Width(name))
		styled := th.Subtitle.Render(name)
		if i == s.cursor {
			marker = th.Accent.Render("▸") + " "
			styled = th.Selected.Render(name)
		}
		row := marker + styled
		if note := w.boardStateNote(b); note != "" {
			row += pad + boardNoteGap + th.Subtle.Render(note)
		}
		rows = append(rows, truncateCells(row, width))
	}
	return title + "\n\n" + joinStrings(rows, "\n")
}

// boardStateNote picks the phrase the picker shows beside a board: pipeline
// facts when the operator is setting up a pipeline run, loop facts otherwise.
// Loop chatter on a pipeline picker was actively misleading — the two features
// share nothing but the board.
func (w Wizard) boardStateNote(b BoardChoice) string {
	note := b.StateNote
	if w.modeStep.Selected() == ModePipeline && b.PipelineNote != "" {
		note = b.PipelineNote
	}
	if b.ExplicitlyBlockedCount > 0 {
		note += fmt.Sprintf(" · %d cards in Blocked", b.ExplicitlyBlockedCount)
	}
	return note
}

// pipelineTeamLine names the team and role the scheduler will assign work by,
// or warns that there is none — a runner without a team role sits idle no
// matter which board it watches, which the operator should hear before picking
// one, not after the run starts.
func (w Wizard) pipelineTeamLine(th Theme, width int) string {
	if w.modeStep.Selected() != ModePipeline {
		return ""
	}
	id := w.connectStep.identity
	if id.TeamName == "" {
		return th.Warn.Render(truncateCells(
			glyphWarn+" this agent is on no team — the scheduler assigns work by team role", width))
	}
	line := StatusLine("◆", "team", id.TeamName)
	if id.TeamRole != "" {
		line += th.Subtle.Render(hintSeparator) + StatusLine("", "role", id.TeamRole)
	}
	return line
}

// Board picker column geometry. The name column is sized to the longest board
// name so every state note starts at the same cell, with the clamp keeping one
// pathological name from pushing the whole notes column off the screen.
const (
	boardMarkerCols  = 2
	boardNoteGap     = "  "
	boardNameMinCols = 8
	boardNameMaxCols = 28
)

// boardNameColumn is the display width every board name is padded or truncated
// to. It follows the longest visible name up to the clamp, and gives up the
// clamp on a terminal too narrow to seat both columns — a squeezed-but-aligned
// name beats a note pushed past the right edge.
func boardNameColumn(boards []BoardChoice, width int) int {
	longest := 0
	for _, b := range boards {
		if w := lipgloss.Width(b.Name); w > longest {
			longest = w
		}
	}

	col := min(longest, boardNameMaxCols)
	// Leave room for the marker, the gap, and something of the note itself.
	if budget := width - boardMarkerCols - len(boardNoteGap) - boardNameMinCols; col > budget {
		col = budget
	}
	return max(col, boardNameMinCols)
}

func renderFilter(th Theme, filter string) string {
	if filter == "" {
		return th.Subtle.Render("(type to narrow)")
	}
	return th.Accent.Render(filter)
}

// ---------------------------------------------------------------- workdir --

// workDirPresets are offered before the free-text option. The first entry is
// replaced by the injected default when one is supplied.
var workDirPresets = []string{
	"~/backplane-runner/repos",
	"/tmp/backplane-runner",
}

// workDirCustomRowLabel is the list's last row: not a preset but the visible
// affordance for the free-text editor that `e` also opens.
const workDirCustomRowLabel = "enter a custom path…"

type workDirStep struct {
	presets   []string
	cursor    int
	editing   bool
	input     textinput.Model
	committed string
	err       error
}

func newWorkDirStep(defaultDir string) workDirStep {
	presets := make([]string, 0, len(workDirPresets)+1)
	if defaultDir != "" {
		presets = append(presets, defaultDir)
	}
	for _, p := range workDirPresets {
		if p != defaultDir {
			presets = append(presets, p)
		}
	}

	input := textinput.New()
	input.Prompt = "› "
	input.Placeholder = "/absolute/path/for/clones"
	input.CharLimit = 512

	return workDirStep{presets: presets, input: input}
}

// rowCount is the presets plus the custom-path row the cursor can also reach.
func (s workDirStep) rowCount() int { return len(s.presets) + 1 }

// onCustomRow reports whether the cursor sits on the custom-path affordance.
func (s workDirStep) onCustomRow() bool { return s.cursor == len(s.presets) }

// Path is the directory the step would commit right now — the free-text value
// while editing, otherwise the highlighted preset. The custom row names no
// path, so it yields "".
func (s workDirStep) Path() string {
	if s.editing {
		return strings.TrimSpace(s.input.Value())
	}
	if s.cursor < 0 || s.cursor >= len(s.presets) {
		return ""
	}
	return s.presets[s.cursor]
}

func (w Wizard) workDirKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if w.workDirStep.editing {
		return w.workDirEditKey(msg)
	}

	switch msg.String() {
	case "up", "k":
		w.workDirStep.cursor = wrapIndex(w.workDirStep.cursor-1, w.workDirStep.rowCount())
	case "down", "j":
		w.workDirStep.cursor = wrapIndex(w.workDirStep.cursor+1, w.workDirStep.rowCount())
	case "e":
		return w.openWorkDirEditor()
	case "enter":
		if w.workDirStep.onCustomRow() {
			return w.openWorkDirEditor()
		}
		return w.commitWorkDir()
	}
	return w, nil
}

func (w Wizard) openWorkDirEditor() (tea.Model, tea.Cmd) {
	w.workDirStep.editing = true
	w.workDirStep.input.SetValue(w.workDirStep.Path())
	w.workDirStep.input.CursorEnd()
	return w, w.workDirStep.input.Focus()
}

func (w Wizard) workDirEditKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case tea.KeyEsc:
		w.workDirStep.editing = false
		w.workDirStep.input.Blur()
		return w, nil
	case tea.KeyEnter:
		// Committing the text closes the editor first so Path() reads from the
		// preset list on the next render — the typed value becomes a preset.
		typed := strings.TrimSpace(w.workDirStep.input.Value())
		if typed == "" {
			return w, nil
		}
		w.workDirStep.presets = append([]string{typed}, w.workDirStep.presets...)
		w.workDirStep.cursor = 0
		w.workDirStep.editing = false
		w.workDirStep.input.Blur()
		w.workDirStep.err = nil
		return w, nil
	}

	var cmd tea.Cmd
	w.workDirStep.input, cmd = w.workDirStep.input.Update(msg)
	return w, cmd
}

func (w Wizard) commitWorkDir() (tea.Model, tea.Cmd) {
	path := w.workDirStep.Path()
	if path == "" {
		w.workDirStep.err = errors.New("choose a directory before continuing")
		return w, nil
	}
	if validate := w.deps.ValidateWorkDir; validate != nil {
		if err := validate(path); err != nil {
			w.workDirStep.err = err
			return w, nil
		}
	}
	w.workDirStep.err = nil
	w.workDirStep.committed = path
	if w.consumeReviewJump() {
		w.step = StepReview
		return w, nil
	}
	w.step = StepProvider
	if w.modeStep.Selected() == ModeLoop {
		w.providerStep.field = fieldRunModel
	}
	return w.syncProviderFocus()
}

// workDirConsequences is the honest disclosure the step owes the user: this
// directory is not a workspace they share with the runner, it is scratch space
// the runner owns and will destroy.
const workDirConsequences = "The runner clones every repo it works on here and hard-resets those clones " +
	"between cards — anything you leave in them is lost. Expect one full checkout per repo of disk. " +
	"Pick a fresh directory that is NOT inside an existing git worktree; a runner rooted in a live " +
	"checkout will reset your own work."

func (w Wizard) workDirView(th Theme, width int) string {
	s := w.workDirStep
	panelWidth := PanelWidth(width)
	parts := []string{
		th.Title.Render("Where should the runner work?"),
		Panel("what this directory is for", Prose(th.Subtitle, workDirConsequences, panelWidth), panelWidth),
	}

	if s.editing {
		parts = append(parts, th.Subtitle.Render("Type a path:")+"\n"+s.input.View())
	} else {
		rows := make([]string, 0, s.rowCount())
		for i, p := range append(append([]string{}, s.presets...), workDirCustomRowLabel) {
			marker := "  "
			label := th.Subtitle.Render(p)
			if i == s.cursor {
				marker = th.Accent.Render("▸") + " "
				label = th.Selected.Render(p)
			}
			rows = append(rows, truncateCells(marker+label, width))
		}
		parts = append(parts, joinStrings(rows, "\n"))
	}

	if s.err != nil {
		parts = append(parts, th.Error.Render("✗ "+s.err.Error()))
	}
	return joinNonEmpty(parts, "\n\n")
}

// --------------------------------------------------------------- provider --

// boardPin is how far the chosen board's loop config constrains the provider
// step. In loop mode the runner rebuilds dispatch from the board's provider
// and model every iteration, so the step must display them rather than re-ask
// questions whose answers would be ignored.
type boardPin struct {
	board BoardChoice
	// pinned: the board names a concrete provider+model, used verbatim at
	// runtime — the local chips and model input would be a lie.
	pinned bool
	// tier: the board names a tier alias — routing intent, never a runnable
	// model id, so the local provider/model stay live as the fallback the
	// runner substitutes.
	tier bool
}

// loopPin derives the constraint from wizard state rather than storing it, so
// back-navigation and re-entry can never leave it stale. Pipeline mode never
// reads the board's loop config — the scheduler resolves tiers server-side.
func (w Wizard) loopPin() boardPin {
	b := w.boardStep.chosen
	if w.modeStep.Selected() != ModeLoop || b.LoopModel == "" {
		return boardPin{}
	}
	if isTierAlias(b.LoopModel) {
		return boardPin{board: b, tier: true}
	}
	if b.LoopProvider == "" {
		return boardPin{}
	}
	return boardPin{board: b, pinned: true}
}

// isTierAlias mirrors workloop's closed set: the tier→model mapping is
// backend-owned, so these are never runnable model ids.
func isTierAlias(model string) bool {
	switch model {
	case "premium", "mid", "low":
		return true
	}
	return false
}

// providerField is which of the three inputs has focus.
type providerField int

const (
	fieldProvider providerField = iota
	fieldModel
	fieldBudget
	// fieldKeepAlive exists only in loop mode — pipeline mode reads no board
	// loop config, so the field is skipped by providerFieldCount there rather
	// than rendered inert.
	fieldKeepAlive
	fieldRunModel
)

type providerStep struct {
	providers []string
	cursor    int
	field     providerField
	model     textinput.Model
	budget    textinput.Model
	err       error

	committedModel      string
	committedBudget     float64
	chooseRunModel      bool
	runOverride         *config.ModelSelection
	savedCursor         int
	savedModel          string
	savedCommittedModel string

	// keepAlive is loop mode's "what happens when the loop is switched off":
	// false exits (the historical behaviour), true waits for a re-enable.
	keepAlive bool
}

// providerFieldCount is how many fields the tab cycle walks. Loop mode adds
// keep-alive and model-source selection; pipeline keeps the original three.
func (w Wizard) providerFieldCount() int {
	if w.modeStep.Selected() == ModeLoop {
		return 5
	}
	return 3
}

func newProviderStep(providers []string, defaultModel string, defaultBudget float64) providerStep {
	modelInput := textinput.New()
	modelInput.Prompt = "› "
	modelInput.Placeholder = "model name"
	modelInput.CharLimit = 128
	modelInput.SetValue(defaultModel)

	budgetInput := textinput.New()
	budgetInput.Prompt = "› "
	budgetInput.Placeholder = "5.00"
	budgetInput.CharLimit = 16
	budgetInput.SetValue(formatUSD(defaultBudget))

	return providerStep{
		providers:       providers,
		model:           modelInput,
		budget:          budgetInput,
		committedModel:  defaultModel,
		committedBudget: defaultBudget,
	}
}

// Provider is the coding agent under the cursor, empty when none are available.
func (s providerStep) Provider() string {
	if s.cursor < 0 || s.cursor >= len(s.providers) {
		return ""
	}
	return s.providers[s.cursor]
}

// CommittedModel and CommittedBudget report the last values that passed
// validation, so a half-typed field never leaks into a Result.
func (s providerStep) CommittedModel() string   { return s.committedModel }
func (s providerStep) CommittedBudget() float64 { return s.committedBudget }

func (s providerStep) editingText() bool { return s.field == fieldModel || s.field == fieldBudget }

// ceiling is the budget the effective preview reflects RIGHT NOW: the live
// input when it parses, else the last committed value — so the preview tracks
// typing without flickering on a half-typed number.
func (s providerStep) ceiling() float64 {
	if v, err := parseBudget(s.budget.Value()); err == nil {
		return v
	}
	return s.committedBudget
}

func (w Wizard) providerKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if w.modeStep.Selected() == ModeLoop && w.providerStep.field == fieldRunModel {
		switch msg.Type {
		case tea.KeyTab:
			w.providerStep.field = fieldProvider
			if w.loopPin().pinned && !w.providerStep.chooseRunModel {
				w.providerStep.field = fieldBudget
			}
			return w.syncProviderFocus()
		case tea.KeyShiftTab:
			w.providerStep.field = fieldKeepAlive
			return w.syncProviderFocus()
		case tea.KeyEnter:
			return w.commitProvider()
		}
		switch msg.String() {
		case "left", "right", "h", "l", " ":
			w.providerStep.setRunModel(!w.providerStep.chooseRunModel)
		}
		return w, nil
	}
	if w.loopPin().pinned && !w.providerStep.chooseRunModel {
		return w.pinnedProviderKey(msg)
	}
	// Enter and tab are step-level even while a text field has focus; every
	// other rune belongs to the field.
	switch msg.Type {
	case tea.KeyTab:
		w.providerStep.field = providerField(wrapIndex(int(w.providerStep.field)+1, w.providerFieldCount()))
		return w.syncProviderFocus()
	case tea.KeyShiftTab:
		w.providerStep.field = providerField(wrapIndex(int(w.providerStep.field)-1, w.providerFieldCount()))
		return w.syncProviderFocus()
	case tea.KeyEnter:
		return w.commitProvider()
	}

	if w.providerStep.field == fieldKeepAlive {
		// Space is the conventional flip for a boolean field; enter is already
		// step-level (commit), so it cannot double as the toggle.
		if msg.Type == tea.KeySpace || msg.String() == " " {
			w.providerStep.keepAlive = !w.providerStep.keepAlive
		}
		return w, nil
	}

	if w.providerStep.field == fieldProvider {
		switch msg.String() {
		case "left", "h", "up", "k":
			w.providerStep.cursor = wrapIndex(w.providerStep.cursor-1, len(w.providerStep.providers))
		case "right", "l", "down", "j":
			w.providerStep.cursor = wrapIndex(w.providerStep.cursor+1, len(w.providerStep.providers))
		}
		return w, nil
	}

	var cmd tea.Cmd
	if w.providerStep.field == fieldModel {
		w.providerStep.model, cmd = w.providerStep.model.Update(msg)
	} else {
		w.providerStep.budget, cmd = w.providerStep.budget.Update(msg)
	}
	return w, cmd
}

// pinnedProviderKey handles the step when the board pins concrete values: the
// budget, keep-alive and model-source selection stay reachable. Provider/model
// fields become editable only after an explicit per-run selection.
func (w Wizard) pinnedProviderKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case tea.KeyEnter:
		return w.commitProvider()
	case tea.KeyTab, tea.KeyShiftTab:
		fields := []providerField{fieldBudget, fieldKeepAlive, fieldRunModel}
		current := 0
		for i, field := range fields {
			if field == w.providerStep.field {
				current = i
			}
		}
		delta := 1
		if msg.Type == tea.KeyShiftTab {
			delta = -1
		}
		w.providerStep.field = fields[wrapIndex(current+delta, len(fields))]
		return w.syncProviderFocus()
	}

	if w.providerStep.field == fieldKeepAlive {
		if msg.Type == tea.KeySpace || msg.String() == " " {
			w.providerStep.keepAlive = !w.providerStep.keepAlive
		}
		return w, nil
	}
	// Back-navigation can land here with stale focus; repair it lazily.
	if w.providerStep.field != fieldBudget {
		w.providerStep.field = fieldBudget
		w.providerStep.budget.Focus()
	}
	var cmd tea.Cmd
	w.providerStep.budget, cmd = w.providerStep.budget.Update(msg)
	return w, cmd
}

// syncProviderFocus gives the textinput cursor to whichever field is active —
// bubbles renders no cursor on a blurred input, so focus must follow.
func (w Wizard) syncProviderFocus() (tea.Model, tea.Cmd) {
	w.providerStep.model.Blur()
	w.providerStep.budget.Blur()
	switch w.providerStep.field {
	case fieldModel:
		return w, w.providerStep.model.Focus()
	case fieldBudget:
		return w, w.providerStep.budget.Focus()
	}
	return w, nil
}

func (w Wizard) commitProvider() (tea.Model, tea.Cmd) {
	// With the board pinning provider and model, the local fields are inert —
	// validating them would block the commit on answers nobody can edit.
	pinned := w.loopPin().pinned && !w.providerStep.chooseRunModel

	if !pinned && w.providerStep.Provider() == "" {
		w.providerStep.err = errors.New("no coding agent available to run with")
		return w, nil
	}

	model := strings.TrimSpace(w.providerStep.model.Value())
	if !pinned && model == "" {
		w.providerStep.err = errors.New("give the agent a model name")
		return w, nil
	}

	budget, err := parseBudget(w.providerStep.budget.Value())
	if err != nil {
		w.providerStep.err = err
		return w, nil
	}

	if w.providerStep.chooseRunModel && w.modeStep.Selected() == ModeLoop {
		selection := &config.ModelSelection{Provider: NormalizeProvider(w.providerStep.Provider()), Model: w.providerStep.model.Value()}
		if err := selection.Validate(); err != nil {
			w.providerStep.err = err
			return w, nil
		}
		w.providerStep.runOverride = selection
	}
	w.providerStep.err = nil
	w.providerStep.committedModel = model
	w.providerStep.committedBudget = budget
	if w.consumeReviewJump() {
		w.step = StepReview
		return w, nil
	}
	return w.enterMCP()
}

// parseBudget accepts a bare number with an optional leading $, which is what
// users type after reading a dollar-denominated prompt.
func parseBudget(raw string) (float64, error) {
	trimmed := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(raw), "$"))
	if trimmed == "" {
		return 0, errors.New("budget: enter a dollar amount, e.g. 5.00")
	}
	value, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, fmt.Errorf("budget %q is not a number — enter a dollar amount, e.g. 5.00", raw)
	}
	if value < 0 {
		return 0, errors.New("budget cannot be negative")
	}
	return value, nil
}

func formatUSD(v float64) string { return strconv.FormatFloat(v, 'f', 2, 64) }

func (w Wizard) providerView(th Theme, width int) string {
	if w.modeStep.Selected() == ModeLoop && w.height > 0 && w.height <= 30 {
		return w.compactLoopProviderView(th, width)
	}
	s := w.providerStep
	pin := w.loopPin()
	if pin.pinned && !s.chooseRunModel {
		return w.pinnedProviderView(th, width, pin.board)
	}

	parts := []string{th.Title.Render("How should it run?"), w.runModelLine(th)}
	if s.chooseRunModel {
		parts = append(parts, StatusLine("▸", "board request", w.boardRequest()), Prose(th.Subtle, "This pair applies only to this run. Saved defaults and board settings stay unchanged.", PanelWidth(width)))
	}

	if len(s.providers) == 0 {
		pw := PanelWidth(width)
		body := Prose(th.Error, "No coding agent found on this machine.", pw) + "\n\n" +
			Prose(th.Subtle, "Install one (claude or codex) and make sure it is on your PATH, "+
				"then rerun the wizard.", pw)
		return joinStrings([]string{parts[0], Panel("nothing to run with", body, pw)}, "\n\n")
	}

	agentLabel, modelLabel := "agent", "model"
	if pin.tier && !s.chooseRunModel {
		pw := PanelWidth(width)
		parts = append(parts,
			Panel("set by the board", Prose(th.Subtitle,
				"The board's loop pins the "+strconv.Quote(pin.board.LoopModel)+" tier — routing intent, "+
					"not a runnable model id. The local agent and model below are the fallback that "+
					"actually runs.", pw), pw),
			StatusLine("▸", "board model", pin.board.LoopModel+" (tier)"))
		agentLabel, modelLabel = "fallback agent", "fallback model"
	}

	chips := make([]string, 0, len(s.providers))
	for i, p := range s.providers {
		if i == s.cursor {
			chips = append(chips, th.Selected.Render("["+p+"]"))
			continue
		}
		chips = append(chips, th.Subtle.Render(" "+p+" "))
	}
	parts = append(parts,
		fieldLabel(th, agentLabel, s.field == fieldProvider)+"\n  "+joinStrings(chips, " "),
		fieldLabel(th, modelLabel, s.field == fieldModel)+"\n  "+s.model.View(),
		fieldLabel(th, "budget (USD)", s.field == fieldBudget)+"\n  "+s.budget.View())
	if w.modeStep.Selected() == ModeLoop {
		parts = append(parts, boardBudgetSummary(w.boardStep.chosen, s.ceiling()))
	}
	parts = append(parts, w.keepAliveLine(th))

	if s.err != nil {
		parts = append(parts, th.Error.Render("✗ "+s.err.Error()))
	}
	return joinNonEmpty(parts, "\n\n")
}

// pinnedProviderView is the step when the board's loop config names a concrete
// provider and model: the runner will use them verbatim, so they render as
// facts and the one question left is the per-session ceiling. The effective
// preview mirrors the runner's min(board remaining, ceiling) session cap.
func (w Wizard) pinnedProviderView(th Theme, width int, board BoardChoice) string {
	s := w.providerStep
	pw := PanelWidth(width)

	parts := []string{
		th.Title.Render("How should it run?"),
		w.runModelLine(th),
		Panel("set by the board", Prose(th.Subtitle,
			"This board's loop config decides the agent and model. Session dollar amounts are settings; "+
				"the provider and billing mode determine whether they can stop a session.", pw), pw),
		joinStrings([]string{
			StatusLine("▸", "agent", board.LoopProvider+" (board)"),
			StatusLine("▸", "model", board.LoopModel+" (board)"),
		}, "\n"),
		fieldLabel(th, "session budget ceiling (USD)", s.field == fieldBudget) + "\n  " + s.budget.View(),
		boardBudgetSummary(board, s.ceiling()),
		w.keepAliveLine(th),
	}
	if s.err != nil {
		parts = append(parts, th.Error.Render("✗ "+s.err.Error()))
	}
	return joinNonEmpty(parts, "\n\n")
}

// keepAliveLine renders loop mode's on-loop-off toggle. Shown only in loop
// mode: pipeline mode reads no board loop config, so the field would be a
// promise the runner does not keep.
func (w Wizard) keepAliveLine(th Theme) string {
	if w.modeStep.Selected() != ModeLoop {
		return ""
	}
	value := "exit"
	if w.providerStep.keepAlive {
		value = "wait for re-enable"
	}
	return fieldLabel(th, "on loop off", w.providerStep.field == fieldKeepAlive) +
		"\n  " + th.Selected.Render("["+value+"]") + "  " + th.Subtle.Render("space to toggle")
}

func fieldLabel(th Theme, label string, focused bool) string {
	if focused {
		return th.Accent.Render("▸ " + label)
	}
	return th.Subtle.Render("  " + label)
}

// ----------------------------------------------------------------- review --

type reviewStep struct {
	saveConfig bool
	configPath string
	// editingName is the save-as-profile name editor; confirmOverwrite gates a
	// launch whose profile name would clobber a DIFFERENT existing profile.
	editingName      bool
	nameInput        textinput.Model
	confirmOverwrite bool
	// launchErr is what ValidateLaunch rejected the current answers with. It
	// keeps the operator IN the wizard — the same failure used to surface on
	// stderr after the TUI was torn down, when nothing could be corrected.
	launchErr error
}

// newReviewStep pre-arms the save toggle only when there is somewhere to save
// to — offering "save" with no destination would be a lie.
func newReviewStep(configPath string) reviewStep {
	nameInput := textinput.New()
	nameInput.Prompt = "› "
	nameInput.CharLimit = 128
	return reviewStep{saveConfig: configPath != "", configPath: configPath, nameInput: nameInput}
}

func (w Wizard) reviewKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if msg.String() == "r" && !w.reviewStep.editingName && !w.reviewStep.confirmOverwrite {
		return w.refreshCompletionSetup()
	}
	if w.reviewStep.confirmOverwrite {
		switch msg.String() {
		case "y":
			w.reviewStep.confirmOverwrite = false
			w.profileOverwrite = true
			return w.launchFromReview()
		case "n":
			w.reviewStep.confirmOverwrite = false
		}
		return w, nil
	}

	if w.reviewStep.editingName {
		switch msg.Type {
		case tea.KeyEsc:
			w.reviewStep.editingName = false
			w.reviewStep.nameInput.Blur()
			return w, nil
		case tea.KeyEnter:
			name := strings.TrimSpace(w.reviewStep.nameInput.Value())
			if name == "" {
				return w, nil
			}
			// Naming the profile IS the intent to save it.
			w.profileName = name
			w.profileSave = true
			w.reviewStep.editingName = false
			w.reviewStep.nameInput.Blur()
			return w, nil
		}
		var cmd tea.Cmd
		w.reviewStep.nameInput, cmd = w.reviewStep.nameInput.Update(msg)
		return w, cmd
	}

	switch msg.String() {
	case "s":
		if w.deps.Profiles != nil {
			w.profileSave = !w.profileSave
		} else {
			w.reviewStep.saveConfig = !w.reviewStep.saveConfig
		}
		return w, nil
	case "e":
		if w.deps.Profiles == nil {
			return w, nil
		}
		w.reviewStep.editingName = true
		w.reviewStep.nameInput.SetValue(w.profileName)
		w.reviewStep.nameInput.CursorEnd()
		return w, w.reviewStep.nameInput.Focus()
	case "enter":
		if w.profileNeedsOverwriteConfirm() {
			w.reviewStep.confirmOverwrite = true
			return w, nil
		}
		return w.launchFromReview()
	case "1", "2", "3", "4", "5", "6", "7", "8", "9":
		return w.jumpToReviewRow(int(msg.String()[0] - '0'))
	}
	return w, nil
}

// jumpToReviewRow re-opens the step owning the nth summary row. The jump flag
// makes that step's commit and esc return here instead of following the flow.
func (w Wizard) jumpToReviewRow(n int) (tea.Model, tea.Cmd) {
	rows := w.reviewRows()
	if n < 1 || n > len(rows) {
		return w, nil
	}
	target := rows[n-1].owner
	w.jumpedFromReview = true
	if target == StepCredentials {
		return w.enterCredentials()
	}
	w.step = target
	return w, nil
}

func (w Wizard) launchFromReview() (tea.Model, tea.Cmd) {
	if err := w.confirmCompletionProviders(); err != nil {
		w.reviewStep.launchErr = err
		return w, nil
	}
	w.completionSetup.confirmed = true
	if validate := w.deps.ValidateLaunch; validate != nil {
		if err := validate(w.Result()); err != nil {
			w.completionSetup.confirmed = false
			w.reviewStep.launchErr = err
			return w, nil
		}
	}
	w.reviewStep.launchErr = nil
	w.launched = true
	return w, tea.Quit
}

// profileNeedsOverwriteConfirm gates the launch on an explicit confirmation
// when the save name belongs to a DIFFERENT existing profile. Relaunching the
// profile this run was loaded from must not nag — that overwrite is implied.
func (w Wizard) profileNeedsOverwriteConfirm() bool {
	if w.deps.Profiles == nil || !w.profileSave || w.profileName == "" {
		return false
	}
	if w.profileName == w.loadedProfileName {
		return false
	}
	_, err := w.deps.Profiles.Load(w.profileName)
	return err == nil
}

// reviewRow is one numbered line of the run summary: its content and the step
// a digit jump re-opens to change it.
type reviewRow struct {
	label string
	value string
	warn  bool
	owner Step
}

// reviewRows is the summary in render order — the view numbers rows from 1 and
// the digit keys index the same slice, so a row's number always jumps to the
// step that owns it. Rows the flow skipped are simply absent.
func (w Wizard) reviewRows() []reviewRow {
	res := w.Result()
	rows := []reviewRow{{label: "mode", value: string(res.Mode), owner: StepMode}}
	if res.BoardName != "" {
		rows = append(rows, reviewRow{label: "board", value: res.BoardName, owner: StepBoard})
	}
	agent, model, budget := res.Provider, res.Model, "$"+formatUSD(res.BudgetUSD)
	if res.Mode == ModeLoop {
		budget = boardBudgetSummary(w.boardStep.chosen, res.BudgetUSD)
	}
	if pin := w.loopPin(); pin.pinned {
		// Review mirrors what will run: the board's picks marked as such, and
		// the budget as the ceiling plus the effective min the runner applies.
		agent += " (board)"
		model += " (board)"
		budget = boardBudgetSummary(pin.board, res.BudgetUSD)
	}
	if res.RunOverride != nil {
		// Keep review numbering stable: credential editing must remain reachable
		// with the existing single-digit shortcuts.
		if len(rows) > 1 && rows[1].owner == StepBoard {
			rows[1].value += "\n  board request: " + w.boardRequest() + " (board)"
		}
		agent = res.RunOverride.Provider + " (per-run)"
		model = res.RunOverride.Model + " (per-run)"
	}
	rows = append(rows,
		reviewRow{label: "work dir", value: res.WorkDir, owner: StepWorkDir},
		reviewRow{label: "agent", value: agent, owner: StepProvider},
		reviewRow{label: "model", value: model, owner: StepProvider},
		reviewRow{label: "budget", value: budget, owner: StepProvider})
	if res.Mode == ModeLoop {
		// The one loop-mode setting the board has no opinion about, so it needs
		// its own row rather than a "(board)" annotation.
		onLoopOff := "exit"
		if res.KeepAlive {
			onLoopOff = "wait for re-enable"
		}
		rows = append(rows, reviewRow{label: "on loop off", value: onLoopOff, owner: StepProvider})
	}
	if mcp, ok := w.mcpReviewRow(); ok {
		rows = append(rows, mcp)
	}
	return append(rows, reviewRow{label: "backend", value: res.APIURL, owner: StepCredentials})
}

func (w Wizard) reviewView(th Theme, width int) string {
	rows := make([]string, 0, 8)
	for i, r := range w.reviewRows() {
		num := strconv.Itoa(i + 1)
		if r.warn {
			rows = append(rows, th.Accent.Render(num)+" "+th.Warn.Render(glyphWarn+" "+r.label+"    "+r.value))
			continue
		}
		rows = append(rows, StatusLine(num, r.label, r.value))
	}

	body := joinStrings(rows, "\n")
	parts := []string{
		th.Title.Render("Ready to launch"),
		Panel("your run", body, shrinkToFit(body, "your run", PanelWidth(width))),
		w.saveToggleView(th, width),
		w.completionSetupView(th, width),
	}
	if w.reviewStep.confirmOverwrite {
		pw := PanelWidth(width)
		body := Prose(th.Warn, `profile "`+w.profileName+`" already exists — overwrite it with this run's setup?`, pw) + "\n\n" +
			Prose(th.Subtle, "y overwrites · n keeps the stored profile", pw)
		parts = append(parts, Panel("overwrite profile?", body, pw))
	}
	if err := w.reviewStep.launchErr; err != nil {
		pw := PanelWidth(width)
		blocked := Prose(th.Error, err.Error(), pw) + "\n\n" +
			Prose(th.Subtle, "Step back with esc and change the answer it names — nothing you entered is lost.", pw)
		parts = append(parts, Panel("launch blocked", blocked, pw))
	}
	return joinNonEmpty(parts, "\n\n")
}

func (w Wizard) saveToggleView(th Theme, width int) string {
	if w.deps.Profiles != nil {
		return w.profileSaveView(th, width)
	}
	s := w.reviewStep
	if s.configPath == "" {
		return th.Subtle.Render("These choices apply to this run only.")
	}
	box := "[ ]"
	if s.saveConfig {
		box = th.Success.Render("[✓]")
	}
	return box + " " + th.Subtitle.Render("save as ") + th.Accent.Render(truncateCells(s.configPath, width-16))
}

// profileSaveView is the save toggle when a profile store is wired: the run
// is saved as a named profile — credentials, runner.yaml and mcp config
// together — rather than as a bare config file.
func (w Wizard) profileSaveView(th Theme, width int) string {
	if w.reviewStep.editingName {
		return th.Subtitle.Render("profile name:") + "\n" + w.reviewStep.nameInput.View()
	}
	box := "[ ]"
	if w.profileSave {
		box = th.Success.Render("[✓]")
	}
	return box + " " + th.Subtitle.Render("save as profile ") +
		th.Accent.Render(truncateCells(w.profileName, width-20))
}

// wrapIndex keeps a cursor inside [0,length) with wraparound at both ends.
// A zero length collapses to 0 so an empty list cannot produce a modulo panic.
func wrapIndex(i, length int) int {
	if length <= 0 {
		return 0
	}
	return ((i % length) + length) % length
}

// setRunModel keeps editable per-run choices separate from saved local answers.
func (s *providerStep) setRunModel(choose bool) {
	if choose == s.chooseRunModel {
		return
	}
	if choose {
		s.savedCursor, s.savedModel, s.savedCommittedModel = s.cursor, s.model.Value(), s.committedModel
	} else {
		s.cursor = s.savedCursor
		s.model.SetValue(s.savedModel)
		s.committedModel = s.savedCommittedModel
	}
	s.chooseRunModel = choose
	s.runOverride = nil
	s.err = nil
}

func (w Wizard) runModelLine(th Theme) string {
	if w.modeStep.Selected() != ModeLoop {
		return ""
	}
	follow, choose := "Follow board settings", "Choose a model for this run"
	if w.providerStep.chooseRunModel {
		choose = th.Selected.Render("[" + choose + "]")
	} else {
		follow = th.Selected.Render("[" + follow + "]")
	}
	return fieldLabel(th, "model selection", w.providerStep.field == fieldRunModel) + "\n  " + follow + "\n  " + choose + "\n  " + th.Subtle.Render("tab to focus · ←/→ or space to change")
}

func (w Wizard) boardRequest() string {
	b := w.boardStep.chosen
	provider, model := b.LoopProvider, b.LoopModel
	if provider == "" {
		provider = "local provider"
	}
	if model == "" {
		model = "local model"
	}
	return provider + " / " + model
}

// compactLoopProviderView keeps the new source selector visible in a standard
// 24-row alternate-screen terminal; only this step changes density.
func (w Wizard) compactLoopProviderView(th Theme, width int) string {
	s := w.providerStep
	pin := w.loopPin()
	parts := []string{th.Title.Render("How should it run?"), w.runModelLine(th), StatusLine("▸", "board request", w.boardRequest())}
	if pin.pinned && !s.chooseRunModel {
		parts = append(parts, StatusLine("▸", "agent", pin.board.LoopProvider+" (board)"), StatusLine("▸", "model", pin.board.LoopModel+" (board)"))
	} else {
		chips := make([]string, 0, len(s.providers))
		for i, p := range s.providers {
			if i == s.cursor {
				chips = append(chips, th.Selected.Render("["+p+"]"))
			} else {
				chips = append(chips, p)
			}
		}
		if len(chips) == 0 {
			chips = append(chips, "No coding agent found on PATH")
		}
		parts = append(parts, fieldLabel(th, "agent", s.field == fieldProvider)+" "+strings.Join(chips, " "), fieldLabel(th, "model", s.field == fieldModel)+" "+s.model.View())
	}
	parts = append(parts, fieldLabel(th, "ceiling USD", s.field == fieldBudget)+" "+s.budget.View())
	parts = append(parts, boardBudgetSummary(w.boardStep.chosen, s.ceiling()))
	onOff := "exit"
	if s.keepAlive {
		onOff = "wait for re-enable"
	}
	parts = append(parts, fieldLabel(th, "on loop off", s.field == fieldKeepAlive)+" ["+onOff+"] · space")
	if s.chooseRunModel {
		parts = append(parts, th.Subtle.Render("Per-run only; saved defaults stay unchanged."))
	}
	if s.err != nil {
		parts = append(parts, Prose(th.Error, s.err.Error(), width))
	}
	return strings.Join(parts, "\n")
}
