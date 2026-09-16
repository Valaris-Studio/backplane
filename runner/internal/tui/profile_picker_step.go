// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	neturl "net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"gopkg.in/yaml.v3"

	"github.com/Valaris-Studio/backplane/runner/internal/config"
	"github.com/Valaris-Studio/backplane/runner/internal/profile"
)

// ---------------------------------------------------------- profile picker --

type profilePickerStep struct {
	profiles []profile.Profile
	cursor   int
	// confirmingDelete gates `d`: deletion removes a stored key, so it never
	// happens on a single keypress.
	confirmingDelete bool
}

func (s profilePickerStep) selected() (profile.Profile, bool) {
	if s.cursor < 0 || s.cursor >= len(s.profiles) {
		return profile.Profile{}, false
	}
	return s.profiles[s.cursor], true
}

// leaveSplash routes the first advance: stored profiles land on the picker,
// otherwise the credentials step exactly as before profiles existed. A store
// that cannot be listed is treated as empty — a corrupt profiles dir must not
// kill the wizard.
func (w Wizard) leaveSplash() (tea.Model, tea.Cmd) {
	if w.deps.Profiles != nil {
		if profiles, err := w.deps.Profiles.List(); err == nil && len(profiles) > 0 {
			w.profilePicker.profiles = profiles
			w.step = StepProfilePicker
			return w, nil
		}
	}
	return w.enterCredentials()
}

func (w Wizard) profilePickerKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if w.profilePicker.confirmingDelete {
		switch msg.String() {
		case "y":
			w.profilePicker.confirmingDelete = false
			return w.deleteSelectedProfile()
		case "n":
			w.profilePicker.confirmingDelete = false
		}
		return w, nil
	}

	switch msg.String() {
	case "up", "k":
		w.profilePicker.cursor = wrapIndex(w.profilePicker.cursor-1, len(w.profilePicker.profiles))
	case "down", "j":
		w.profilePicker.cursor = wrapIndex(w.profilePicker.cursor+1, len(w.profilePicker.profiles))
	case "enter":
		return w.useSelectedProfile()
	case "e":
		return w.editSelectedProfile()
	case "d":
		w.profilePicker.confirmingDelete = true
	case "n":
		// Start fresh: today's flow exactly — the seed fills the fields and no
		// profile is selected.
		return w.enterCredentials()
	}
	return w, nil
}

// useSelectedProfile is EDIT minus the credentials stop: the stored
// credentials are committed as-is straight into the connect attempt, so a
// stale key fails visibly on the connect screen instead of silently.
func (w Wizard) useSelectedProfile() (tea.Model, tea.Cmd) {
	p, ok := w.profilePicker.selected()
	if !ok {
		return w, nil
	}
	w = w.loadProfile(p)
	w.credentialsStep.committedHost = p.Credentials.APIURL
	w.credentialsStep.committedKey = p.Credentials.APIKey
	return w.enterConnect()
}

// editSelectedProfile walks the normal flow with every field pre-filled from
// the profile, starting at credentials so a rotated key or wrong host is a
// single correction rather than a restart.
func (w Wizard) editSelectedProfile() (tea.Model, tea.Cmd) {
	p, ok := w.profilePicker.selected()
	if !ok {
		return w, nil
	}
	w = w.loadProfile(p)
	return w.enterCredentials()
}

func (w Wizard) deleteSelectedProfile() (tea.Model, tea.Cmd) {
	p, ok := w.profilePicker.selected()
	if !ok {
		return w, nil
	}
	_ = w.deps.Profiles.Delete(p.Name)
	if remaining, err := w.deps.Profiles.List(); err == nil {
		w.profilePicker.profiles = remaining
	}
	if len(w.profilePicker.profiles) == 0 {
		// An empty picker never renders — fall through to credentials, the
		// same handoff an empty store gets at the splash.
		return w.enterCredentials()
	}
	if w.profilePicker.cursor >= len(w.profilePicker.profiles) {
		w.profilePicker.cursor = len(w.profilePicker.profiles) - 1
	}
	return w, nil
}

// loadProfile makes p the base of this run: its name pinned as the save
// target, its credentials prefilled, and workdir/provider/model/budget seeded
// from its runner.yaml instead of the shipped defaults.
func (w Wizard) loadProfile(p profile.Profile) Wizard {
	w.loadedProfileName = p.Name
	w.loadedWorkspace = p.Credentials.Workspace
	w.profileName = p.Name
	w.profileSave = true

	source := `profile "` + p.Name + `"`
	w.credentialsStep = newCredentialsStep(CredentialSeed{
		Host:            p.Credentials.APIURL,
		HostSource:      source,
		APIKey:          p.Credentials.APIKey,
		APIKeySource:    source,
		Workspace:       p.Credentials.Workspace,
		WorkspaceSource: source,
	})

	cfg := w.profileBaseConfig(p)
	w = w.seedProfileMCP(p, cfg)
	workDir := cfg.Git.BaseDir
	if workDir == "" {
		workDir = w.deps.DefaultWorkDir
	}
	w.workDirStep = newWorkDirStep(workDir)
	w.providerStep = newProviderStep(w.deps.Providers, cfg.LLM.Model, cfg.LLM.MaxBudgetUSD)
	if i := providerIndex(w.deps.Providers, cfg.LLM.Provider); i >= 0 {
		w.providerStep.cursor = i
	}
	return w
}

func (w Wizard) seedProfileMCP(p profile.Profile, cfg *config.Config) Wizard {
	// A profile's explicit integration choice must never inherit another
	// project's cwd discovery, even when its selected file has disappeared.
	path := cfg.LLM.MCPConfigPath
	if path != "" && !filepath.IsAbs(path) && path != "~" && !strings.HasPrefix(path, "~/") {
		path = filepath.Join(filepath.Dir(w.deps.Profiles.ConfigPath(p.Name)), path)
	}
	if path != "" {
		if absolute, err := absoluteMCPPath(path); err == nil {
			path = absolute
		}
	}
	writeTo := w.mcpStep.status.WriteTo
	w.mcpStep = newMCPStep()
	w.mcpStep.status = MCPConfigStatus{Path: path, Origin: `profile "` + p.Name + `"`, WriteTo: writeTo}
	if w.deps.UvxAvailable != nil {
		w.mcpStep.uvxOK = w.deps.UvxAvailable()
	}
	if path != "" {
		w.mcpStep.choose(mcpChoiceUse)
		if validate := w.deps.ValidateMCPConfig; validate != nil {
			if err := validate(path); err != nil {
				w.mcpStep.status.Issue = err.Error()
			}
		}
	}
	return w
}

// profileBaseConfig parses the profile's runner.yaml over the shipped
// defaults, deliberately without config.Load's env overrides or validation: a
// prefill must reflect the file, and an incomplete file is exactly what the
// wizard exists to complete.
func (w Wizard) profileBaseConfig(p profile.Profile) *config.Config {
	cfg := config.Defaults()
	if w.deps.Profiles == nil {
		return cfg
	}
	data, err := os.ReadFile(w.deps.Profiles.ConfigPath(p.Name))
	if err != nil {
		return cfg
	}
	// A malformed yaml degrades to the defaults it was unmarshaled over.
	_ = yaml.Unmarshal(data, cfg)
	return cfg
}

// providerIndex locates the picker label whose normalized id matches the
// profile's llm.provider, so the cursor starts on the profile's agent.
func providerIndex(labels []string, providerID string) int {
	for i, label := range labels {
		if NormalizeProvider(label) == providerID {
			return i
		}
	}
	return -1
}

func (w Wizard) profilePickerView(th Theme, width int) string {
	s := w.profilePicker
	title := th.Title.Render("Which profile?")

	rows := make([]string, 0, len(s.profiles)+2)
	nameCol := profileNameColumn(s.profiles, width)
	for i, p := range s.profiles {
		marker := "  "
		name := truncateCells(p.Name, nameCol)
		pad := strings.Repeat(" ", nameCol-lipgloss.Width(name))
		styled := th.Subtitle.Render(name)
		if i == s.cursor {
			marker = th.Accent.Render("▸") + " "
			styled = th.Selected.Render(name)
		}
		rows = append(rows, truncateCells(marker+styled+pad+boardNoteGap+th.Subtle.Render(profileNote(p)), width))
	}

	if p, ok := s.selected(); ok && s.confirmingDelete {
		rows = append(rows, "", th.Warn.Render(truncateCells(
			`delete profile "`+p.Name+`" and its stored key? (y/n)`, width)))
	}
	return title + "\n\n" + joinStrings(rows, "\n")
}

// profileNote is the row's identity beyond the name: which backend and which
// workspace this profile points at.
func profileNote(p profile.Profile) string {
	parts := make([]string, 0, 2)
	if host := profileHost(p.Credentials.APIURL); host != "" {
		parts = append(parts, host)
	}
	if p.Credentials.Workspace != "" {
		parts = append(parts, p.Credentials.Workspace)
	}
	return strings.Join(parts, hintSeparator)
}

// profileHost strips the scheme for display — the row answers "which
// backend", not "over which protocol".
func profileHost(apiURL string) string {
	if u, err := neturl.Parse(apiURL); err == nil && u.Host != "" {
		return u.Host
	}
	return apiURL
}

// profileNameColumn mirrors the board picker's column geometry so the three
// pickers read as the same control.
func profileNameColumn(profiles []profile.Profile, width int) int {
	longest := 0
	for _, p := range profiles {
		if w := lipgloss.Width(p.Name); w > longest {
			longest = w
		}
	}

	col := min(longest, boardNameMaxCols)
	if budget := width - boardMarkerCols - len(boardNoteGap) - boardNameMinCols; col > budget {
		col = budget
	}
	return max(col, boardNameMinCols)
}

// ------------------------------------------------------- registration offer --

// profileOfferStep is the post-connect registration offer: credentials the
// store has never seen are proposed for saving before the flow moves on. It
// renders on the connect step — the flow has not advanced yet.
type profileOfferStep struct {
	active    bool
	editing   bool
	suggested string
	input     textinput.Model
}

// maybeOfferProfile decides what stands between a successful connect and the
// workspace step: credentials the store already knows adopt that profile's
// name silently, unknown ones are offered for registration, and with no store
// the flow proceeds exactly as it always did.
func (w Wizard) maybeOfferProfile() (tea.Model, tea.Cmd) {
	if w.deps.Profiles == nil {
		return w.enterWorkspace()
	}
	creds := w.committedProfileCredentials()
	if match, ok, err := w.deps.Profiles.Match(creds); err == nil && ok {
		if !w.mcpStep.decided {
			w = w.seedProfileMCP(match, w.profileBaseConfig(match))
		}
		w.loadedProfileName = match.Name
		w.profileName = match.Name
		w.profileSave = true
		return w.enterWorkspace()
	}
	w.profileOffer.active = true
	w.profileOffer.editing = false
	w.profileOffer.suggested = w.deps.Profiles.SuggestName(creds)
	return w, nil
}

// committedProfileCredentials is the triple this run would store: what the
// credentials step committed, plus the workspace the run will resolve — the
// loaded profile's when one was picked, else the injected seed's.
func (w Wizard) committedProfileCredentials() profile.Credentials {
	workspace := w.deps.Credentials.Workspace
	if w.loadedWorkspace != "" {
		workspace = w.loadedWorkspace
	}
	return profile.Credentials{
		APIKey:    w.credentialsStep.committedKey,
		APIURL:    w.credentialsStep.committedHost,
		Workspace: workspace,
	}
}

func (w Wizard) profileOfferKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if w.profileOffer.editing {
		switch msg.Type {
		case tea.KeyEsc:
			w.profileOffer.editing = false
			w.profileOffer.input.Blur()
			return w, nil
		case tea.KeyEnter:
			name := strings.TrimSpace(w.profileOffer.input.Value())
			if name == "" {
				return w, nil
			}
			return w.acceptProfileOffer(name)
		}
		var cmd tea.Cmd
		w.profileOffer.input, cmd = w.profileOffer.input.Update(msg)
		return w, cmd
	}

	switch msg.String() {
	case "y":
		return w.acceptProfileOffer(w.profileOffer.suggested)
	case "e":
		input := textinput.New()
		input.Prompt = "› "
		input.CharLimit = 128
		input.SetValue(w.profileOffer.suggested)
		input.CursorEnd()
		w.profileOffer.input = input
		w.profileOffer.editing = true
		return w, w.profileOffer.input.Focus()
	case "n":
		// The suggestion survives a decline: the review screen proposes the
		// save once more under this default.
		w.profileName = w.profileOffer.suggested
		w.profileSave = false
		w.profileOffer.active = false
		return w.enterWorkspace()
	}
	return w, nil
}

func (w Wizard) acceptProfileOffer(name string) (tea.Model, tea.Cmd) {
	// Accepting records intent only — the caller writes at launch, with the
	// rest of the Result.
	w.profileName = name
	w.profileSave = true
	w.profileOffer.active = false
	w.profileOffer.editing = false
	return w.enterWorkspace()
}

func (w Wizard) profileOfferView(th Theme, width int) string {
	pw := PanelWidth(width)
	if w.profileOffer.editing {
		body := Prose(th.Subtitle, "Profile name:", pw) + "\n" + w.profileOffer.input.View()
		return Panel("save as profile", body, pw)
	}
	body := Prose(th.Subtitle, "These credentials are new to this machine. Save them as a profile "+
		"so the next launch is a single pick?", pw) + "\n\n" +
		StatusLine("▸", "name", w.profileOffer.suggested) + "\n\n" +
		Prose(th.Subtle, "y saves under that name · e edits the name · n continues without saving", pw)
	return Panel("save as profile", body, pw)
}
