// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"context"
	"strconv"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/config"

	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// Step is a screen in the wizard's fixed sequence.
type Step int

const (
	StepSplash Step = iota
	StepCredentials
	StepConnect
	StepWorkspace
	StepMode
	StepBoard
	StepWorkDir
	StepProvider
	StepMCP
	StepReview
	// StepDoctor is deliberately last: it joined after the others and appending
	// keeps every persisted step number meaning what it always meant.
	StepDoctor
	// StepProfilePicker joined after doctor and is appended for the same
	// reason. The advance functions, not enum order, place it in the flow:
	// it renders between the splash and the credentials step.
	StepProfilePicker
)

func (s Step) String() string {
	switch s {
	case StepSplash:
		return "splash"
	case StepCredentials:
		return "credentials"
	case StepConnect:
		return "connect"
	case StepWorkspace:
		return "workspace"
	case StepMode:
		return "mode"
	case StepBoard:
		return "board"
	case StepWorkDir:
		return "workdir"
	case StepProvider:
		return "provider"
	case StepMCP:
		return "mcp"
	case StepReview:
		return "review"
	case StepDoctor:
		return "doctor"
	case StepProfilePicker:
		return "profiles"
	}
	return "unknown"
}

// splashHold is how long the brand beat lingers before auto-advancing. Long
// enough to read the wordmark, short enough that a returning user does not
// feel taxed — any keypress cuts it short.
const splashHold = 900 * time.Millisecond

// fallbackWidth is the render width assumed before the first WindowSizeMsg.
// Bubble Tea delivers that message on startup, but Update can run first in
// tests and on terminals that never report a size.
const fallbackWidth = 80

// Identity, WizardDeps, Result, Mode and BoardChoice are declared in
// wizardcfg.go, which also owns their mapping onto the runner's config file.

// Async step outcomes. Each carries its result rather than mutating the model
// from a goroutine — the tea runtime owns all state transitions.
type (
	splashDoneMsg       struct{}
	connectedMsg        struct{ identity Identity }
	connectFailedMsg    struct{ err error }
	workspacesLoadedMsg struct{ workspaces []WorkspaceChoice }
	workspacesFailedMsg struct{ err error }
	boardsLoadedMsg     struct{ boards []BoardChoice }
	boardsFailedMsg     struct{ err error }
	doctorDoneMsg       struct{ report DoctorReport }
)

// Wizard sequences the interactive setup screens. It is a value type: Update
// returns a copy, so tests can fork a run at any step.
type Wizard struct {
	deps   WizardDeps
	step   Step
	width  int
	height int

	spin     spinner.Model
	showHelp bool

	credentialsStep credentialsStep
	connectStep     connectStep
	workspaceStep   workspaceStep
	modeStep        modeStep
	boardStep       boardStep
	workDirStep     workDirStep
	providerStep    providerStep
	mcpStep         mcpStep
	reviewStep      reviewStep
	completionSetup completionSetup
	doctorStep      doctorStep
	profilePicker   profilePickerStep
	profileOffer    profileOfferStep

	// profileName/profileSave are the save-as-profile intent: the name set by
	// the picker, the registration offer or the review editor, and whether the
	// launch should actually store it. loadedProfileName remembers which
	// profile this run was loaded from (USE/EDIT), so re-saving under one's own
	// name never demands an overwrite confirmation; loadedWorkspace is that
	// profile's workspace, which stands in for the seed's when resolving.
	profileName       string
	profileSave       bool
	profileOverwrite  bool
	loadedProfileName string
	loadedWorkspace   string

	// jumpedFromReview marks a step re-opened by a digit on the review screen:
	// its commit and esc return straight to review instead of following the
	// flow, and either spends the flag — the next esc walks back normally.
	jumpedFromReview bool

	cancelled bool
	launched  bool
}

// NewWizard builds the wizard at its first step. Missing deps are tolerated:
// unwired effects surface as a stalled step, never a nil-func panic.
func NewWizard(deps WizardDeps) Wizard {
	// The MCP facts are read once, here, rather than per render: the menu must
	// not change under the operator's cursor, and Result must be able to report
	// an already-configured machine from any step.
	mcp := newMCPStep()
	if deps.MCPStatus != nil {
		mcp.status = deps.MCPStatus()
		if mcp.status.Path != "" {
			if path, err := absoluteMCPPath(mcp.status.Path); err == nil {
				mcp.status.Path = path
			}
			if mcp.status.Origin == "" {
				mcp.status.Origin = "auto-discovered configuration"
			}
			mcp.choose(mcpChoiceUse)
		}
	}
	if deps.UvxAvailable != nil {
		mcp.uvxOK = deps.UvxAvailable()
	}

	return Wizard{
		deps:            deps,
		step:            StepSplash,
		width:           fallbackWidth,
		spin:            NewSpinner(SpinnerDots),
		credentialsStep: newCredentialsStep(deps.Credentials),
		workspaceStep:   newWorkspaceStep(deps.AllowedWorkspaces),
		modeStep:        newModeStep(),
		workDirStep:     newWorkDirStep(deps.DefaultWorkDir),
		providerStep:    newProviderStep(deps.Providers, deps.DefaultModel, deps.DefaultBudget),
		mcpStep:         mcp,
		reviewStep:      newReviewStep(deps.ConfigPath),
	}
}

// Step reports the screen currently rendered.
func (w Wizard) Step() Step { return w.step }

// Result is everything gathered so far. Safe to read at any point — a caller
// that aborts mid-flow gets Cancelled set and partial-but-consistent fields.
func (w Wizard) Result() Result {
	profileName := ""
	if w.profileSave {
		profileName = w.profileName
	}
	provider, model := w.providerStep.Provider(), w.providerStep.CommittedModel()
	// A board pinning concrete loop values is what actually runs — the local
	// answers never reach dispatch, so the Result must not carry them.
	if pin := w.loopPin(); pin.pinned {
		provider, model = pin.board.LoopProvider, pin.board.LoopModel
	}
	var runOverride *config.ModelSelection
	if w.modeStep.Selected() == ModeLoop && w.providerStep.chooseRunModel {
		provider, model = "", w.providerStep.savedCommittedModel
		if i := w.providerStep.savedCursor; i >= 0 && i < len(w.providerStep.providers) {
			provider = w.providerStep.providers[i]
		}
		if w.providerStep.runOverride != nil {
			copy := *w.providerStep.runOverride
			runOverride = &copy
		}
	}
	return Result{
		ExtraProviders:               w.completionProviders(),
		CompletionProvidersConfirmed: w.completionSetup.confirmed,
		RunOverride:                  runOverride,
		ProfileName:                  profileName,
		ProfileOverwrite: w.profileOverwrite ||
			(profileName != "" && profileName == w.loadedProfileName),
		LoadedProfileName: w.loadedProfileName,

		Mode:      w.modeStep.Selected(),
		BoardID:   w.boardStep.chosen.ID,
		BoardName: w.boardStep.chosen.Name,
		APIURL:    w.credentialsStep.committedHost,
		APIKey:    w.credentialsStep.committedKey,
		Workspace: w.workspaceStep.chosen.Slug,
		WorkDir:   w.workDirStep.committed,
		Provider:  provider,
		Model:     model,
		BudgetUSD: w.providerStep.CommittedBudget(),
		KeepAlive: w.providerStep.keepAlive,

		MCPConfigSelected: w.mcpStep.decided,
		MCPConfigSkipped:  w.mcpStep.skipped(),
		MCPConfigOrigin:   w.mcpStep.mcpConfigOrigin(),
		MCPConfigPath:     w.mcpStep.mcpConfigPath(),
		MCPWrite:          w.mcpStep.write,
		MCPLaunch:         w.mcpStep.launch,

		SaveConfig: w.reviewStep.saveConfig,
		ConfigPath: w.deps.ConfigPath,
		Cancelled:  w.cancelled,
	}
}

func (w Wizard) Init() tea.Cmd {
	return tea.Batch(w.spin.Tick, splashTimer())
}

func splashTimer() tea.Cmd {
	return tea.Tick(splashHold, func(time.Time) tea.Msg { return splashDoneMsg{} })
}

func (w Wizard) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch m := msg.(type) {
	case completionSetupMsg:
		if m.request != w.completionSetup.request {
			return w, nil
		}
		w.completionSetup.loading = false
		w.completionSetup.loaded = m.err == nil && m.requirements != nil
		w.completionSetup.err = m.err
		w.completionSetup.status = m.status
		if m.requirements != nil {
			w.completionSetup.requirements = m.requirements.Requirements
		}
		return w, nil
	case tea.WindowSizeMsg:
		w.width = m.Width
		w.height = m.Height
		w.providerStep.model.Width = max(8, m.Width-12)
		w.mcpStep.input.Width = max(8, m.Width-4)
		return w, nil

	case spinner.TickMsg:
		var cmd tea.Cmd
		w.spin, cmd = w.spin.Update(m)
		return w, cmd

	case splashDoneMsg:
		if w.step == StepSplash {
			return w.leaveSplash()
		}
		return w, nil

	case connectedMsg:
		if w.step != StepConnect {
			return w, nil
		}
		w.connectStep.identity = m.identity
		w.connectStep.connecting = false
		w.connectStep.err = nil
		// The key's own allow-list is only knowable after it authenticates, so
		// it lands here rather than at construction. An identity that reports
		// none leaves the injected seed alone.
		if len(m.identity.AllowedWorkspaces) > 0 {
			w.workspaceStep.allowed = m.identity.AllowedWorkspaces
		}
		if w.consumeReviewJump() {
			w.step = StepReview
			return w.refreshCompletionSetup()
		}
		return w.maybeOfferProfile()

	case connectFailedMsg:
		w.connectStep.connecting = false
		w.connectStep.err = m.err
		w.step = StepConnect
		return w, nil

	case workspacesLoadedMsg:
		if w.step != StepWorkspace {
			return w, nil
		}
		w.workspaceStep.workspaces = m.workspaces
		w.workspaceStep.loading = false
		w.workspaceStep.err = nil
		w.workspaceStep.cursor = 0
		return w.settleWorkspace()

	case workspacesFailedMsg:
		if w.step != StepWorkspace {
			return w, nil
		}
		w.workspaceStep.loading = false
		w.workspaceStep.err = m.err
		// A list the backend would not serve must not strand an operator whose
		// env already names a workspace — the picker is a convenience over the
		// resolved slug, never a new hard dependency.
		if resolved := w.resolvedWorkspace(); resolved != "" {
			w.workspaceStep.chosen = WorkspaceChoice{Name: resolved, Slug: resolved}
			w.step = StepMode
		}
		return w, nil

	case boardsLoadedMsg:
		w.boardStep.setBoards(m.boards)
		return w, nil

	case boardsFailedMsg:
		w.boardStep.loading = false
		w.boardStep.err = m.err
		return w, nil

	case doctorDoneMsg:
		if w.step != StepDoctor {
			return w, nil
		}
		w.doctorStep.running = false
		w.doctorStep.done = true
		w.doctorStep.report = m.report
		return w, nil

	case tea.KeyMsg:
		return w.handleKey(m)
	}
	if w.step == StepMCP && w.mcpStep.browsing {
		return w.mcpBrowseUpdate(msg)
	}
	return w, nil
}

func (w Wizard) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	// ctrl+c outranks everything, including a focused text field — it is the
	// only escape a stuck user reliably knows.
	if msg.Type == tea.KeyCtrlC {
		return w.cancel()
	}

	// esc is navigation everywhere EXCEPT inside an open text editor, where it
	// first closes the editor — otherwise a user who opened the path field
	// would be thrown a whole step back by the same key that cancels the edit.
	if msg.Type == tea.KeyEsc {
		if w.stepEditingText() {
			return w.routeKey(msg)
		}
		return w.back()
	}

	// Only literal runes are handed to a focused text field. Navigation keys
	// keep working while typing, so "q" and "?" inside a path stay literal
	// without stranding the user with no way out of the step.
	if w.stepCapturesText() && msg.Type == tea.KeyRunes {
		// Except "?" in a picker FILTER: that is a search box over names that
		// never contain "?", and the footer advertises "? help" there — feeding
		// it to the filter makes the advertised key silently search instead.
		// Real text editors (paths, credentials, model) keep it literal.
		if msg.String() == "?" && w.stepFiltersAList() {
			w.showHelp = !w.showHelp
			return w, nil
		}
		return w.routeKey(msg)
	}

	switch msg.String() {
	case "q":
		return w.cancel()
	case "?":
		w.showHelp = !w.showHelp
		return w, nil
	case "left":
		// A text editor uses ←/→ to move its cursor, and a horizontal list uses
		// them to move its selection — only a step doing neither treats ← as
		// "go back". Anything else makes the same key navigate the list one way
		// and eject the user the other.
		if !w.stepCapturesText() && !w.stepOwnsHorizontalArrows() {
			return w.back()
		}
	}

	if w.step == StepSplash {
		return w.leaveSplash()
	}
	return w.routeKey(msg)
}

// stepEditingText reports whether an explicit, dismissable free-text editor is
// open — the only case where esc means "close this" rather than "go back".
// The provider step's fields are always-on rather than modal, so esc there is
// navigation like everywhere else.
func (w Wizard) stepEditingText() bool {
	return (w.step == StepWorkDir && w.workDirStep.editing) ||
		(w.step == StepMCP && (w.mcpStep.typingPath || w.mcpStep.discovering || w.mcpStep.browsing)) ||
		(w.step == StepConnect && w.profileOffer.editing) ||
		(w.step == StepReview && w.reviewStep.editingName)
}

// stepOwnsHorizontalArrows reports whether the active step navigates a
// horizontal list with ←/→, which strips those keys of their global "go back"
// meaning. esc still goes back on such a step.
func (w Wizard) stepOwnsHorizontalArrows() bool {
	return (w.step == StepMCP && w.mcpStep.browsing) || (w.step == StepProvider && (w.providerStep.field == fieldProvider || w.providerStep.field == fieldRunModel))
}

// stepFiltersAList reports whether the active rune capture is a picker filter
// rather than a free-text editor — the distinction that decides whether "?"
// means help or is a character the user could plausibly want.
func (w Wizard) stepFiltersAList() bool {
	switch w.step {
	case StepWorkspace:
		return w.workspaceStep.filtering()
	case StepBoard:
		return w.boardStep.filtering()
	}
	return false
}

// stepCapturesText reports whether the active step owns raw rune input.
func (w Wizard) stepCapturesText() bool {
	switch w.step {
	case StepCredentials:
		return true
	case StepConnect:
		return w.profileOffer.editing
	case StepWorkspace:
		return w.workspaceStep.filtering()
	case StepBoard:
		return w.boardStep.filtering()
	case StepWorkDir:
		return w.workDirStep.editing
	case StepProvider:
		return w.providerStep.editingText()
	case StepMCP:
		return w.mcpStep.typingPath
	case StepReview:
		return w.reviewStep.editingName
	}
	return false
}

func (w Wizard) routeKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch w.step {
	case StepCredentials:
		return w.credentialsKey(msg)
	case StepConnect:
		return w.connectKey(msg)
	case StepWorkspace:
		return w.workspaceKey(msg)
	case StepMode:
		return w.modeKey(msg)
	case StepBoard:
		return w.boardKey(msg)
	case StepWorkDir:
		return w.workDirKey(msg)
	case StepProvider:
		return w.providerKey(msg)
	case StepMCP:
		return w.mcpKey(msg)
	case StepReview:
		return w.reviewKey(msg)
	case StepDoctor:
		return w.doctorKey(msg)
	case StepProfilePicker:
		return w.profilePickerKey(msg)
	}
	return w, nil
}

func (w Wizard) cancel() (tea.Model, tea.Cmd) {
	w.cancelled = true
	return w, tea.Quit
}

// back walks one step toward the start, skipping steps that do not apply to
// the chosen mode. StepWorkspace is the floor: going further would re-run the
// connect attempt behind the operator's back, so the credentials step is
// reached deliberately instead — via `e` on a connect failure.
func (w Wizard) back() (tea.Model, tea.Cmd) {
	// A jumped-to step escapes to review, even from steps back() otherwise
	// never leaves (credentials) — the jump flag overrides the floor.
	if w.consumeReviewJump() {
		w.step = StepReview
		return w, nil
	}
	switch w.step {
	case StepMode:
		w.step = StepWorkspace
	case StepBoard, StepDoctor:
		w.step = StepMode
	case StepWorkDir:
		if w.modeStep.Selected().needsBoard() {
			w.step = StepBoard
		} else {
			w.step = StepMode
		}
	case StepProvider:
		w.step = StepWorkDir
	case StepMCP:
		w.step = StepProvider
	case StepReview:
		// A launch rejection describes the answers as they were — leaving it up
		// while the operator edits them would report a state that no longer
		// exists. Re-validation happens on the next launch attempt.
		w.reviewStep.launchErr = nil
		// Back must skip whatever forward navigation skipped, or an operator
		// whose MCP is already configured would be dropped onto a step the
		// wizard deliberately never showed them.
		if w.needsMCPStep() {
			w.step = StepMCP
		} else {
			w.step = StepProvider
		}
	}
	return w, nil
}

// consumeReviewJump reports whether the active step was entered by a review
// jump, spending the flag — the caller returns to StepReview instead of
// following the flow.
func (w *Wizard) consumeReviewJump() bool {
	if !w.jumpedFromReview {
		return false
	}
	w.jumpedFromReview = false
	return true
}

func (w Wizard) enterCredentials() (tea.Model, tea.Cmd) {
	w.step = StepCredentials
	w.credentialsStep.err = nil
	return w.syncCredentialsFocus()
}

func (w Wizard) enterConnect() (tea.Model, tea.Cmd) {
	w.step = StepConnect
	w.connectStep.connecting = true
	w.connectStep.err = nil
	// Point the caller's client at whatever the credentials step last committed,
	// so a retry after an edit authenticates against the corrected backend.
	if retarget := w.deps.Retarget; retarget != nil {
		retarget(w.credentialsStep.committedHost, w.credentialsStep.committedKey)
	}
	return w, connectCmd(w.deps.Connect)
}

// enterWorkspace opens the picker and asks for the list. With no LoadWorkspaces
// dep there is nothing to pick from, so it settles immediately on whatever the
// caller resolved — the wizard never blocks on an unwired effect.
func (w Wizard) enterWorkspace() (tea.Model, tea.Cmd) {
	w.step = StepWorkspace
	w.workspaceStep.err = nil
	if w.deps.LoadWorkspaces == nil {
		return w.settleWorkspace()
	}
	w.workspaceStep.loading = true
	return w, loadWorkspacesCmd(w.deps.LoadWorkspaces)
}

// settleWorkspace decides whether the operator has a choice to make. A lone
// workspace, or a resolved slug that the caller can actually see, is not a
// question worth asking — but the step stays reachable by back-navigation, so
// skipping never hides it.
func (w Wizard) settleWorkspace() (tea.Model, tea.Cmd) {
	switch {
	case len(w.workspaceStep.workspaces) == 1:
		return w.commitWorkspace(w.workspaceStep.workspaces[0])

	case len(w.workspaceStep.workspaces) == 0:
		// No list at all (unwired dep) still honors a resolved slug; a list that
		// came back genuinely empty is a state the view explains.
		resolved := w.resolvedWorkspace()
		if resolved != "" && w.deps.LoadWorkspaces == nil {
			w.workspaceStep.chosen = WorkspaceChoice{Name: resolved, Slug: resolved}
			w.step = StepMode
		}
		return w, nil
	}

	// A resolved slug the caller cannot see is a typo or a stale config — the
	// picker exists to correct exactly that, so it must not be obeyed silently.
	if ws, ok := w.workspaceStep.find(w.resolvedWorkspace()); ok && w.workspaceStep.selectable(ws) {
		return w.commitWorkspace(ws)
	}
	return w, nil
}

// resolvedWorkspace is the slug the run would use before the picker settles:
// the loaded profile's workspace when this run started from one, else
// whatever the caller resolved from env and files.
func (w Wizard) resolvedWorkspace() string {
	if w.loadedWorkspace != "" {
		return w.loadedWorkspace
	}
	return w.deps.Credentials.Workspace
}

func connectCmd(connect func(context.Context) (Identity, error)) tea.Cmd {
	if connect == nil {
		return func() tea.Msg {
			return connectFailedMsg{err: errNoConnector}
		}
	}
	return func() tea.Msg {
		identity, err := connect(context.Background())
		if err != nil {
			return connectFailedMsg{err: err}
		}
		return connectedMsg{identity: identity}
	}
}

func loadWorkspacesCmd(load func(context.Context) ([]WorkspaceChoice, error)) tea.Cmd {
	return func() tea.Msg {
		workspaces, err := load(context.Background())
		if err != nil {
			return workspacesFailedMsg{err: err}
		}
		return workspacesLoadedMsg{workspaces: workspaces}
	}
}

func loadBoardsCmd(load func(context.Context, string) ([]BoardChoice, error), workspaceSlug string) tea.Cmd {
	if load == nil {
		return func() tea.Msg { return boardsLoadedMsg{} }
	}
	return func() tea.Msg {
		boards, err := load(context.Background(), workspaceSlug)
		if err != nil {
			return boardsFailedMsg{err: err}
		}
		return boardsLoadedMsg{boards: boards}
	}
}

// advanceFromMode moves past mode select, skipping the board picker for the
// modes that operate on the whole workspace rather than one board. Doctor
// never leaves the TUI: its report is a screen the operator can back out of,
// not a reason to tear the program down.
func (w Wizard) advanceFromMode() (tea.Model, tea.Cmd) {
	if w.modeStep.Selected() == ModeDoctor {
		return w.enterDoctor()
	}
	if !w.modeStep.Selected().needsBoard() {
		w.step = StepWorkDir
		return w, nil
	}
	w.step = StepBoard
	w.boardStep.loading = true
	w.boardStep.err = nil
	return w, loadBoardsCmd(w.deps.LoadBoards, w.workspaceStep.chosen.Slug)
}

func (w Wizard) View() string {
	th := New()
	width := w.renderWidth()

	var body string
	switch w.step {
	case StepSplash:
		body = w.splashView(th, width)
	case StepCredentials:
		body = w.credentialsView(th, width)
	case StepConnect:
		body = w.connectView(th, width)
	case StepWorkspace:
		body = w.workspaceView(th, width)
	case StepMode:
		body = w.modeView(th, width)
	case StepBoard:
		body = w.boardView(th, width)
	case StepWorkDir:
		body = w.workDirView(th, width)
	case StepProvider:
		body = w.providerView(th, width)
	case StepMCP:
		body = w.mcpView(th, width)
	case StepReview:
		body = w.reviewView(th, width)
	case StepDoctor:
		body = w.doctorView(th, width)
	case StepProfilePicker:
		body = w.profilePickerView(th, width)
	}

	sections := []string{w.chromeView(th, width), body, w.footerView(th, width)}
	out := joinNonEmpty(sections, "\n\n")
	// A late clamp is cheaper than threading width through every helper, and
	// guarantees the invariant tests assert: never wider than the terminal.
	return clampLines(out, width)
}

// renderWidth is the usable column budget. Bubble Tea sends WindowSizeMsg on
// startup, but Update can run before it in tests and on terminals that never
// report a size, so an unknown width falls back rather than rendering at zero.
func (w Wizard) renderWidth() int {
	if w.width <= 0 {
		return fallbackWidth
	}
	return w.width
}

// chromeView is the persistent header: the full banner on the splash, the
// compact brand mark plus an identity line on every step after it — the brand
// never leaves the screen, it just gets out of the way.
func (w Wizard) chromeView(th Theme, width int) string {
	if w.step == StepSplash {
		return ""
	}
	chrome := Logo()
	id := w.connectStep.identity
	// The workspace is the operator's choice, not the key's identity — it is
	// only known once the picker settles, which is after connect.
	workspace := w.workspaceStep.chosen.Slug
	if id.AgentName == "" && workspace == "" {
		return chrome
	}
	line := StatusLine("◆", "agent", id.AgentName)
	if workspace != "" {
		line += th.Subtle.Render(hintSeparator) + StatusLine("", "workspace", workspace)
	}
	if id.BudgetNote != "" && width >= MinWordmarkCols {
		line += th.Subtle.Render(hintSeparator) + th.Subtle.Render(id.BudgetNote)
	}
	return chrome + "\n" + line
}

func (w Wizard) footerView(th Theme, width int) string {
	hints := w.stepHints()
	if w.showHelp {
		// On a step whose list moves with ←/→ the arrow is not "back" — saying
		// so in the footer would teach the exact confusion it exists to prevent.
		backKey := "esc/←"
		if w.stepOwnsHorizontalArrows() {
			backKey = "esc"
		}
		hints = append(hints,
			[2]string{backKey, "back"},
			[2]string{"?", "help"},
			[2]string{"q", "quit"},
		)
	} else {
		hints = append(hints, [2]string{"?", "help"})
	}
	footer := KeyHints(hints...)
	if !w.showHelp {
		return footer
	}
	help := w.stepHelp()
	if help == "" {
		return footer
	}
	return footer + "\n" + renderWrapped(th.Subtle, help, width, "")
}

// stepHelp is the "?" explainer: what THIS screen decides and what happens
// with the answer. One screen, one story — a generic line repeated everywhere
// taught nothing (and was called out for exactly that).
func (w Wizard) stepHelp() string {
	switch w.step {
	case StepSplash:
		return "Interactive setup for the Backplane runner. Any key skips ahead."
	case StepCredentials:
		return "Where this runner connects: the backend url and an AGENT API key minted on the " +
			"platform. Values already found in your env, credentials file or config are prefilled — " +
			"enter accepts them as-is. Once they authenticate, they are remembered for next launch."
	case StepConnect:
		return "Checking that the key authenticates against that url and which agent it belongs to. " +
			"Read-only — nothing is written or started."
	case StepWorkspace:
		return "Boards live inside a workspace; pick the one this runner operates in. " +
			"Rows marked " + strconv.Quote(blockedNote) + " are visible to you but not to this agent key."
	case StepMode:
		return "What the runner should do. Loop and pipeline start real agents that spend money; " +
			"discovery only reads a repo; doctor only checks this machine."
	case StepBoard:
		if w.modeStep.Selected() == ModePipeline {
			return "The board to run the pipeline against. The platform scheduler hands out its cards " +
				"by your agent's team role, so the board needs typed columns, a linked repo, and your " +
				"agent needs a team."
		}
		return "The board the loop will keep working until its ready cards are done. The note beside " +
			"each board says whether a runner would find anything to do there."
	case StepWorkDir:
		return "Scratch space the runner OWNS: it clones every repo here and hard-resets those clones " +
			"between cards. Pick an empty directory outside any git checkout you care about."
	case StepProvider:
		if w.modeStep.Selected() == ModeLoop {
			return "Follow board settings, or choose a discovered coding agent and concrete model for this run only. Tab moves between fields; arrows or space change the model selection. Per-run choices never change saved defaults or board settings."
		}
		return "Which local coding agent does the work, the model it runs, and the most one run may " +
			"spend before the runner stops it."
	case StepMCP:
		return "How the coding agent reaches your board — claiming cards, posting notes, moving them " +
			"to done. The wizard can write this config for you; without it, loop mode cannot work."
	case StepReview:
		return "Last look before anything starts. Enter validates these answers and launches; " +
			"esc walks back through them — nothing you entered is lost."
	case StepDoctor:
		return "A read-only diagnosis of this machine: coding agents on PATH, git, credentials, " +
			"backend reachability, MCP config, work dir safety. It never clones, spends or writes."
	case StepProfilePicker:
		return "Saved runner setups on this machine, each with its own credentials and config. " +
			"Enter runs one as-is; e walks the setup with its values prefilled; a fresh setup " +
			"touches no stored profile."
	}
	return ""
}

func (w Wizard) stepHints() [][2]string {
	switch w.step {
	case StepCredentials:
		return [][2]string{{presetHintKey(), "preset url"}, {"tab", "next field"}, {"↵", "continue"}}
	case StepConnect:
		if w.profileOffer.active {
			if w.profileOffer.editing {
				return [][2]string{{"↵", "save under this name"}, {"esc", "back"}}
			}
			return [][2]string{{"y", "save"}, {"e", "edit name"}, {"n", "skip"}}
		}
		if w.connectStep.err != nil {
			return [][2]string{{"r", "retry"}, {"e", "edit credentials"}}
		}
		return nil
	case StepWorkspace:
		return [][2]string{{"↑/↓", "choose"}, {"type", "filter"}, {"↵", "select"}}
	case StepMode:
		return [][2]string{{"↑/↓", "choose"}, {"↵", "select"}}
	case StepBoard:
		return [][2]string{{"↑/↓", "choose"}, {"type", "filter"}, {"↵", "select"}}
	case StepWorkDir:
		if w.workDirStep.editing {
			return [][2]string{{"↵", "use this path"}, {"esc", "cancel edit"}}
		}
		return [][2]string{{"↑/↓", "preset"}, {"e", "type a path"}, {"↵", "continue"}}
	case StepProvider:
		if w.modeStep.Selected() == ModeLoop && w.providerStep.field == fieldRunModel {
			return [][2]string{{"←/→", "model selection"}, {"tab", "next field"}, {"↵", "continue"}}
		}
		if w.loopPin().pinned && !w.providerStep.chooseRunModel {
			return [][2]string{{"tab", "next field"}, {"↵", "continue"}}
		}
		return [][2]string{{"←/→", "provider"}, {"tab", "next field"}, {"↵", "continue"}}
	case StepMCP:
		if w.mcpStep.browsing {
			return [][2]string{{"↑/↓", "choose"}, {"←/→", "directory"}, {"↵", "select"}, {"esc", "back to choices"}}
		}
		if w.mcpStep.discovering {
			return [][2]string{{"↑/↓", "choose"}, {"↵", "select"}, {"esc", "back to choices"}}
		}
		if w.mcpStep.typingPath {
			return [][2]string{{"↵", "use this path"}, {"esc", "back to choices"}}
		}
		return [][2]string{{"↑/↓", "choose"}, {"↵", "select"}}
	case StepReview:
		if w.deps.Profiles != nil {
			return [][2]string{{"s", "toggle save"}, {"e", "rename profile"}, {"↵", "launch"}}
		}
		return [][2]string{{"s", "toggle save"}, {"↵", "launch"}}
	case StepDoctor:
		if w.doctorStep.running {
			return nil
		}
		return [][2]string{{"r", "run again"}, {"esc", "pick another mode"}}
	case StepProfilePicker:
		if w.profilePicker.confirmingDelete {
			return [][2]string{{"y", "delete"}, {"n", "keep"}}
		}
		return [][2]string{{"↵", "use"}, {"e", "edit"}, {"d", "delete"}, {"n", "start fresh"}}
	}
	return nil
}

func (w Wizard) splashView(th Theme, width int) string {
	parts := []string{Banner(width)}
	if v := w.deps.Version; v != "" {
		parts = append(parts, th.Subtle.Render(v))
	}
	parts = append(parts, th.Subtle.Render(w.spin.View()+" starting"))
	return joinNonEmpty(parts, "\n\n")
}

// Run drives the wizard on the real terminal and returns what the user chose.
// A cancelled run is not an error — check Result.Cancelled.
func Run(ctx context.Context, deps WizardDeps) (Result, error) {
	program := tea.NewProgram(NewWizard(deps), tea.WithContext(ctx))
	final, err := program.Run()
	if err != nil {
		return Result{Cancelled: true}, err
	}
	wizard, ok := final.(Wizard)
	if !ok {
		return Result{Cancelled: true}, nil
	}
	result := wizard.Result()
	// A program torn down by ctx cancellation or a signal never reaches the
	// review step; treat anything unlaunched as a bail-out.
	if !wizard.launched {
		result.Cancelled = true
	}
	return result, nil
}

func joinNonEmpty(parts []string, sep string) string {
	kept := parts[:0:0]
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	return joinStrings(kept, sep)
}

func joinStrings(parts []string, sep string) string {
	switch len(parts) {
	case 0:
		return ""
	case 1:
		return parts[0]
	}
	out := parts[0]
	for _, p := range parts[1:] {
		out += sep + p
	}
	return out
}

// clampLines truncates every line to width cells. lipgloss wraps most content
// already; this catches the residue — unwrappable art, long single tokens —
// so the view never bleeds past the terminal edge.
func clampLines(s string, width int) string {
	if width <= 0 || lipgloss.Width(s) <= width {
		return s
	}
	lines := splitLines(s)
	for i, line := range lines {
		if lipgloss.Width(line) > width {
			lines[i] = truncateCells(line, width)
		}
	}
	return joinStrings(lines, "\n")
}

func splitLines(s string) []string {
	var out []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			out = append(out, s[start:i])
			start = i + 1
		}
	}
	return append(out, s[start:])
}
