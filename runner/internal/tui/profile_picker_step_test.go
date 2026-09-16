// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"path/filepath"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"github.com/Valaris-Studio/backplane/runner/internal/profile"
)

// The acme profile is the fixture most tests select. Every value differs from
// testDeps' seed AND from config.Defaults(), so a prefilled field is always
// distinguishable from a defaulted or seeded one. The workspace is "acme-ws"
// on purpose: not a substring of the profile name, so a view assertion on it
// proves the workspace itself reached the screen.
var acmeCreds = profile.Credentials{
	APIKey:    "vlr_acme_key",
	APIURL:    "https://prod.acme.example.com",
	Workspace: "acme-ws",
}

const (
	acmeName    = "acme@prod"
	acmeBaseDir = "/srv/acme-runner/repos"
	acmeModel   = "acme-opus"
	acmeBudget  = 33.5
)

func acmeYAML() []byte {
	return []byte(`valaris:
  api_url: https://prod.acme.example.com
  api_key: ${VALARIS_API_KEY}
  workspace_slug: acme-ws
git:
  base_dir: /srv/acme-runner/repos
llm:
  provider: claude-cli
  model: acme-opus
  max_budget_usd: 33.5
`)
}

var betaCreds = profile.Credentials{
	APIKey:    "vlr_beta_key",
	APIURL:    "https://staging.beta.example.com",
	Workspace: "beta-ws",
}

const betaName = "beta@staging"

func betaYAML() []byte {
	return []byte(`valaris:
  api_url: https://staging.beta.example.com
  api_key: ${VALARIS_API_KEY}
  workspace_slug: beta-ws
`)
}

// mustSaveProfile seeds one stored profile; the store root is a t.TempDir(),
// never the real config home.
func mustSaveProfile(t *testing.T, store *profile.Store, name string, c profile.Credentials, runnerYAML []byte) {
	t.Helper()
	if err := store.Save(name, c, runnerYAML, []byte("{}\n")); err != nil {
		t.Fatalf("seeding profile %q: %v", name, err)
	}
}

// profileDeps is testDeps plus a store holding the acme profile.
func profileDeps(t *testing.T) WizardDeps {
	t.Helper()
	deps := testDeps()
	store := profile.NewStore(t.TempDir())
	mustSaveProfile(t, store, acmeName, acmeCreds, acmeYAML())
	deps.Profiles = store
	return deps
}

// atProfilePicker leaves the splash and expects to land on the profile picker
// — the step that exists exactly when the store holds at least one profile.
func atProfilePicker(t *testing.T, deps WizardDeps) Wizard {
	t.Helper()
	w := NewWizard(deps)
	w = drive(w, tea.WindowSizeMsg{Width: 100, Height: 40}, splashDoneMsg{})
	if w.Step() != StepProfilePicker {
		t.Fatalf("with stored profiles, leaving the splash should land on the profile picker, got %v", w.Step())
	}
	return w
}

// walkAssertsProfileValues drives a just-started connect attempt through to
// the review screen, asserting every subsequent step surfaces the acme
// profile's values rather than the wizard defaults — the pin that the
// profile's runner.yaml, not Defaults(), is the base config.
func walkAssertsProfileValues(t *testing.T, w Wizard) Wizard {
	t.Helper()
	if w.Step() != StepConnect {
		t.Fatalf("expected a connect attempt with the profile's credentials, got %v", w.Step())
	}
	res := w.Result()
	if res.APIURL != acmeCreds.APIURL {
		t.Fatalf("connect should use the profile's API URL, got %q want %q", res.APIURL, acmeCreds.APIURL)
	}
	if res.APIKey != acmeCreds.APIKey {
		t.Fatalf("connect should use the profile's key, got %q", res.APIKey)
	}

	w = drive(w, connectedMsg{identity: Identity{AgentName: "runner-alpha"}})
	if got := w.Result().Workspace; got != acmeCreds.Workspace {
		t.Fatalf("the profile's workspace should be the resolved one, got %q want %q", got, acmeCreds.Workspace)
	}
	if w.Step() != StepMode {
		t.Fatalf("with no workspace list the profile's workspace should settle straight to mode select, got %v", w.Step())
	}

	// Discovery skips the board picker; mode itself is never stored in a
	// profile, so the operator still chooses it.
	w = selectMode(t, w, ModeDiscovery)
	if w.Step() != StepWorkDir {
		t.Fatalf("expected the work-dir step, got %v", w.Step())
	}
	if got := w.workDirStep.Path(); got != acmeBaseDir {
		t.Errorf("the work-dir step should preselect the profile's git.base_dir, got %q want %q", got, acmeBaseDir)
	}

	w = drive(w, key("enter"))
	if w.Step() != StepProvider {
		t.Fatalf("expected the provider step, got %v", w.Step())
	}
	res = w.Result()
	if res.Model != acmeModel {
		t.Errorf("the provider step should show the profile's model, got %q want %q", res.Model, acmeModel)
	}
	if res.BudgetUSD != acmeBudget {
		t.Errorf("the provider step should show the profile's budget, got %v want %v", res.BudgetUSD, acmeBudget)
	}

	w = drive(w, key("enter"))
	if w.Step() == StepMCP {
		w.mcpStep.choose(mcpChoiceSkip)
		w = drive(w, key("enter"))
	}
	if w.Step() != StepReview {
		t.Fatalf("expected the review step, got %v", w.Step())
	}
	return w
}

// The picker joined the enum after doctor: appending is what keeps every
// persisted step number meaning what it always meant.
func TestStepProfilePicker_IsAppendedAfterDoctor(t *testing.T) {
	if StepProfilePicker <= StepDoctor {
		t.Fatalf("StepProfilePicker must be appended after StepDoctor, got %d <= %d", StepProfilePicker, StepDoctor)
	}
}

func TestProfilePicker_SplashLandsOnPickerWhenProfilesExist(t *testing.T) {
	defer ForcePlain()()

	w := atProfilePicker(t, profileDeps(t))
	if !strings.Contains(w.View(), acmeName) {
		t.Errorf("the picker should list the stored profile, got:\n%s", w.View())
	}
}

func TestProfilePicker_SkippedWithoutProfiles(t *testing.T) {
	defer ForcePlain()()

	// An empty picker must never render: no profiles means the splash hands
	// off to credentials exactly as it always did — with an empty store AND
	// with no store wired at all.
	t.Run("empty store", func(t *testing.T) {
		deps := testDeps()
		deps.Profiles = profile.NewStore(t.TempDir())
		w := drive(NewWizard(deps), splashDoneMsg{})
		if w.Step() != StepCredentials {
			t.Errorf("an empty store should skip the picker, got %v", w.Step())
		}
	})
	t.Run("nil store", func(t *testing.T) {
		w := drive(NewWizard(testDeps()), splashDoneMsg{})
		if w.Step() != StepCredentials {
			t.Errorf("no store wired should mean no picker, got %v", w.Step())
		}
	})
}

func TestProfilePicker_ListsNameHostAndWorkspace(t *testing.T) {
	defer ForcePlain()()

	deps := profileDeps(t)
	mustSaveProfile(t, deps.Profiles, betaName, betaCreds, betaYAML())

	view := atProfilePicker(t, deps).View()
	for _, want := range []string{
		acmeName, "prod.acme.example.com", "acme-ws",
		betaName, "staging.beta.example.com", "beta-ws",
	} {
		if !strings.Contains(view, want) {
			t.Errorf("the picker should show %q for each profile, got:\n%s", want, view)
		}
	}
}

// USE: enter runs with the selected profile — no retyping. Credentials are
// auto-committed into the normal connect attempt (a stale key must still fail
// visibly), and every later step shows the profile's values on the way to
// review.
func TestProfilePicker_EnterUsesTheProfile(t *testing.T) {
	defer ForcePlain()()

	w := drive(atProfilePicker(t, profileDeps(t)), key("enter"))
	w = walkAssertsProfileValues(t, w)

	view := w.View()
	if !strings.Contains(view, "save as profile") {
		t.Errorf("review should offer save-as-profile, got:\n%s", view)
	}
	if !strings.Contains(view, acmeName) {
		t.Errorf("the save name should default to the used profile's name, got:\n%s", view)
	}
	if got := w.Result().ProfileName; got != acmeName {
		t.Errorf("Result should carry the used profile's name, got %q want %q", got, acmeName)
	}
}

// EDIT: `e` walks the normal flow but with every field pre-filled from the
// profile, starting at credentials so a wrong host or rotated key is a single
// correction, not a restart.
func TestProfilePicker_EditPrefillsTheWholeFlow(t *testing.T) {
	defer ForcePlain()()

	w := drive(atProfilePicker(t, profileDeps(t)), key("e"))
	if w.Step() != StepCredentials {
		t.Fatalf("`e` should advance to the credentials step, got %v", w.Step())
	}
	if got := w.credentialsStep.host.Value(); got != acmeCreds.APIURL {
		t.Fatalf("the host field should be prefilled from the profile, got %q want %q", got, acmeCreds.APIURL)
	}
	if got := w.credentialsStep.key(); got != acmeCreds.APIKey {
		t.Fatalf("the key field should be prefilled from the profile, got %q", got)
	}

	w = drive(w, key("enter"))
	_ = walkAssertsProfileValues(t, w)
}

func TestProfilePicker_CredentialsStepNamesTheProfileAsSource(t *testing.T) {
	defer ForcePlain()()

	w := drive(atProfilePicker(t, profileDeps(t)), key("e"))
	if w.Step() != StepCredentials {
		t.Fatalf("`e` should land on credentials, got %v", w.Step())
	}
	// The provenance line: values prefilled from a selected profile name that
	// profile, the way env- and file-sourced values name their origin.
	if want := `profile "` + acmeName + `"`; !strings.Contains(w.View(), want) {
		t.Errorf("the credentials step should name %s as the source, got:\n%s", want, w.View())
	}
}

func TestProfilePicker_DeleteAsksThenRemovesOnY(t *testing.T) {
	defer ForcePlain()()

	deps := profileDeps(t)
	mustSaveProfile(t, deps.Profiles, betaName, betaCreds, betaYAML())

	w := drive(atProfilePicker(t, deps), key("d"))
	if !strings.Contains(strings.ToLower(w.View()), "delete") {
		t.Fatalf("`d` should ask for confirmation before deleting, got:\n%s", w.View())
	}
	if profiles, err := deps.Profiles.List(); err != nil || len(profiles) != 2 {
		t.Fatalf("asking must not delete anything yet, got %d profiles (%v)", len(profiles), err)
	}

	w = drive(w, key("y"))
	// Deletion is store-local: the row disappears, the store loses the
	// directory, and the wizard stays on the picker — no platform call, no
	// step change while other profiles remain.
	profiles, err := deps.Profiles.List()
	if err != nil {
		t.Fatalf("List after delete: %v", err)
	}
	if len(profiles) != 1 || profiles[0].Name != betaName {
		t.Errorf("confirming should delete exactly the selected profile, store holds %+v", profiles)
	}
	if w.Step() != StepProfilePicker {
		t.Errorf("deleting one of several profiles should stay on the picker, got %v", w.Step())
	}
	if strings.Contains(w.View(), acmeName) {
		t.Errorf("the deleted profile's row should be gone, got:\n%s", w.View())
	}
}

func TestProfilePicker_DeleteDeclinedKeepsTheProfile(t *testing.T) {
	defer ForcePlain()()

	deps := profileDeps(t)
	mustSaveProfile(t, deps.Profiles, betaName, betaCreds, betaYAML())

	w := drive(atProfilePicker(t, deps), key("d"), key("n"))
	if profiles, err := deps.Profiles.List(); err != nil || len(profiles) != 2 {
		t.Errorf("declining must delete nothing, got %d profiles (%v)", len(profiles), err)
	}
	if w.Step() != StepProfilePicker {
		t.Errorf("declining should stay on the picker, got %v", w.Step())
	}
}

func TestProfilePicker_DeletingLastProfileAdvancesToCredentials(t *testing.T) {
	defer ForcePlain()()

	deps := profileDeps(t) // exactly one profile
	w := drive(atProfilePicker(t, deps), key("d"), key("y"))

	if profiles, err := deps.Profiles.List(); err != nil || len(profiles) != 0 {
		t.Fatalf("the last profile should be gone, got %d profiles (%v)", len(profiles), err)
	}
	if w.Step() != StepCredentials {
		t.Errorf("an empty picker never renders — deleting the last profile should advance to credentials, got %v", w.Step())
	}
}

func TestProfilePicker_StartFreshLeavesDefaultsUntouched(t *testing.T) {
	defer ForcePlain()()

	deps := profileDeps(t)
	w := drive(atProfilePicker(t, deps), key("n"))

	if w.Step() != StepCredentials {
		t.Fatalf("start-fresh should land on credentials, got %v", w.Step())
	}
	// Fresh means today's flow exactly: the seed, not the profile, fills the
	// fields, and the defaults elsewhere stay defaults.
	if got := w.credentialsStep.host.Value(); got != deps.Credentials.Host {
		t.Errorf("fresh host should come from the seed, got %q want %q", got, deps.Credentials.Host)
	}
	if got := w.credentialsStep.key(); got != deps.Credentials.APIKey {
		t.Errorf("fresh key should come from the seed, got %q", got)
	}
	if got := w.workDirStep.Path(); got != deps.DefaultWorkDir {
		t.Errorf("fresh work dir should be the injected default, got %q want %q", got, deps.DefaultWorkDir)
	}
	if got := w.Result().ProfileName; got != "" {
		t.Errorf("a fresh run selects no profile, got ProfileName %q", got)
	}
}

func TestProfileMCPSelectionTildeAndCredentialMatch(t *testing.T) {
	for _, matched := range []bool{false, true} {
		t.Run(map[bool]string{false: "picker", true: "credential_match"}[matched], func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			deps := needsSetupDeps()
			deps.Profiles = profile.NewStore(t.TempDir())
			deps.Credentials.Workspace = acmeCreds.Workspace
			deps.MCPStatus = func() MCPConfigStatus { return MCPConfigStatus{Path: "/cwd/unrelated.json"} }
			if err := deps.Profiles.Save("selected", acmeCreds, []byte("llm:\n  mcp_config_path: ~/private-chosen.config\n"), []byte("{}\n")); err != nil {
				t.Fatal(err)
			}
			selected, err := deps.Profiles.Load("selected")
			if err != nil {
				t.Fatal(err)
			}
			w := NewWizard(deps)
			if matched {
				w.credentialsStep.committedHost = acmeCreds.APIURL
				w.credentialsStep.committedKey = acmeCreds.APIKey
				model, _ := w.maybeOfferProfile()
				w = model.(Wizard)
			} else {
				w = w.loadProfile(selected)
			}
			if want := filepath.Join(home, "private-chosen.config"); w.Result().MCPConfigPath != want {
				t.Fatalf("profile integration choice lost: got %q want %q", w.Result().MCPConfigPath, want)
			}
		})
	}
}
