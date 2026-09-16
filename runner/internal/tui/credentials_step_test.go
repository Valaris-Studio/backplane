// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

// atCredentials lands on the first interactive step: the splash has passed and
// the credentials form is on screen, before any connection is attempted.
func atCredentials(t *testing.T, deps WizardDeps) Wizard {
	t.Helper()
	w := NewWizard(deps)
	w = drive(w, tea.WindowSizeMsg{Width: 100, Height: 40})
	w = drive(w, splashDoneMsg{})
	if w.Step() != StepCredentials {
		t.Fatalf("splash should hand off to the credentials step, got %v", w.Step())
	}
	return w
}

func TestCredentialsStep_MasksTheKeyInEveryRender(t *testing.T) {
	defer ForcePlain()()

	const secret = "vlr_supersecret123"
	deps := testDeps()
	deps.Credentials = CredentialSeed{Host: "http://localhost:8000"}

	w := atCredentials(t, deps)
	w = drive(w, key("tab")) // focus the key field
	w = typeRunes(w, secret)

	view := w.View()
	if strings.Contains(view, secret) {
		t.Fatalf("the raw key reached the screen:\n%s", view)
	}
	if strings.Contains(view, "supersecret") {
		t.Fatalf("part of the key body reached the screen:\n%s", view)
	}
	if !strings.Contains(view, strings.Repeat(maskRune, len(secret))) {
		t.Errorf("the key field should render one %q per typed rune:\n%s", maskRune, view)
	}
	if got := w.credentialsStep.key(); got != secret {
		t.Errorf("the masked field must still hold the real key, got %q", got)
	}
}

// Bubble Tea delivers a paste as ONE KeyRunes message carrying every rune. A
// field that reads only Runes[0] silently truncates a pasted key to a single
// character — the exact failure a paste-friendly prompt exists to avoid.
func TestCredentialsStep_PasteBurstLandsWhole(t *testing.T) {
	defer ForcePlain()()

	const pasted = "vlr_pasted_key_with_many_runes"
	deps := testDeps()
	deps.Credentials = CredentialSeed{Host: "http://localhost:8000"}

	w := drive(atCredentials(t, deps), key("tab"))
	w = drive(w, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(pasted)})

	if got := w.credentialsStep.key(); got != pasted {
		t.Errorf("a paste burst must be appended wholesale, got %q want %q", got, pasted)
	}
}

func TestCredentialsStep_TrimsSurroundingWhitespaceOnCommit(t *testing.T) {
	defer ForcePlain()()

	w := atCredentials(t, testDeps())
	w.credentialsStep.host.SetValue("https://backplane.example.com")
	w.credentialsStep.apiKey.SetValue("  vlr_pasted_with_newline\n ")

	w = drive(w, key("enter"))

	if got := w.Result().APIKey; got != "vlr_pasted_with_newline" {
		t.Errorf("a pasted key's surrounding whitespace must be trimmed, got %q", got)
	}
}

func TestCredentialsStep_NormalizesTheHost(t *testing.T) {
	defer ForcePlain()()

	tests := []struct {
		name  string
		typed string
		want  string
	}{
		{"bare domain gains https", "backplane.example.com", "https://backplane.example.com"},
		{"trailing slash stripped", "https://backplane.example.com/", "https://backplane.example.com"},
		{"several trailing slashes stripped", "https://backplane.example.com///", "https://backplane.example.com"},
		{"explicit http is respected", "http://localhost:8000", "http://localhost:8000"},
		{"surrounding whitespace trimmed", "  https://backplane.example.com  ", "https://backplane.example.com"},
		{"bare host:port gains http for localhost", "localhost:8000", "http://localhost:8000"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := normalizeHost(tc.typed)
			if err != nil {
				t.Fatalf("normalizeHost(%q) errored: %v", tc.typed, err)
			}
			if got != tc.want {
				t.Errorf("normalizeHost(%q) = %q, want %q", tc.typed, got, tc.want)
			}
		})
	}
}

func TestCredentialsStep_RejectsNonsenseHostInline(t *testing.T) {
	defer ForcePlain()()

	for _, bad := range []string{"", "   ", "not a url", "https://", "ftp://example.com"} {
		if _, err := normalizeHost(bad); err == nil {
			t.Errorf("normalizeHost(%q) should have been rejected", bad)
		}
	}

	w := atCredentials(t, testDeps())
	w.credentialsStep.host.SetValue("not a url")
	w.credentialsStep.apiKey.SetValue("vlr_key")

	w = drive(w, key("enter"))

	if w.Step() != StepCredentials {
		t.Fatalf("an invalid host must not advance to connect, got %v", w.Step())
	}
	if !strings.Contains(strings.ToLower(w.View()), "url") {
		t.Errorf("the rejection should be explained inline, got:\n%s", w.View())
	}
}

func TestCredentialsStep_PrefillsFromResolvedCredentialsAndNamesTheSource(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.Credentials = CredentialSeed{
		APIKey:       "vlr_env_key",
		APIKeySource: "environment",
		Host:         "https://backplane.example.com",
		HostSource:   "config file",
	}

	w := atCredentials(t, deps)
	view := w.View()

	if got := w.credentialsStep.key(); got != "vlr_env_key" {
		t.Errorf("the key field should be prefilled, got %q", got)
	}
	if !strings.Contains(view, "https://backplane.example.com") {
		t.Errorf("the prefilled host should be visible:\n%s", view)
	}
	if strings.Contains(view, "vlr_env_key") {
		t.Fatalf("a prefilled key must be masked too:\n%s", view)
	}
	for _, want := range []string{"environment", "config file"} {
		if !strings.Contains(view, want) {
			t.Errorf("the step should name where %q came from:\n%s", want, view)
		}
	}
}

// An operator whose env already works must not be made to retype anything: one
// Enter carries them straight into the connect attempt.
func TestCredentialsStep_FullyResolvedAdvancesOnOneEnter(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.Credentials = CredentialSeed{
		APIKey:       "vlr_env_key",
		APIKeySource: "environment",
		Host:         "https://backplane.example.com",
		HostSource:   "environment",
	}

	w := drive(atCredentials(t, deps), key("enter"))

	if w.Step() != StepConnect {
		t.Fatalf("resolved credentials should advance on one enter, got %v", w.Step())
	}
	res := w.Result()
	if res.APIKey != "vlr_env_key" || res.APIURL != "https://backplane.example.com" {
		t.Errorf("the committed credentials should carry through: %+v", res)
	}
}

func TestCredentialsStep_MissingKeyBlocksAdvancing(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.Credentials = CredentialSeed{Host: "https://backplane.example.com"}

	w := drive(atCredentials(t, deps), key("enter"))

	if w.Step() != StepCredentials {
		t.Fatalf("no key means no connect attempt, got %v", w.Step())
	}
	if !strings.Contains(strings.ToLower(w.View()), "key") {
		t.Errorf("the missing key should be named inline, got:\n%s", w.View())
	}
}

// Backplane is self-hosted, so localhost is the only address the binary can
// honestly suggest — every real deployment lives somewhere only its operator
// knows. With a single preset, the arrows must be a stable no-op rather than
// something that clears or mangles the field.
func TestCredentialsStep_HostPresetIsLocalhostAndArrowsAreStable(t *testing.T) {
	defer ForcePlain()()

	if len(hostPresets) != 1 || hostPresets[0] != "http://localhost:8000" {
		t.Fatalf("localhost should be the only shipped preset, got %v", hostPresets)
	}

	w := atCredentials(t, testDeps())
	if !strings.Contains(w.View(), hostPresets[0]) {
		t.Errorf("the localhost preset should be offered:\n%s", w.View())
	}

	// The host field starts focused; down seeds the preset into an empty field.
	w = drive(w, key("down"))
	if got := w.credentialsStep.host.Value(); got != hostPresets[0] {
		t.Fatalf("down should set the only preset, got %q", got)
	}

	// Further arrow presses in either direction hold that value: a one-entry
	// list has nowhere to cycle to, and must never wrap into an empty field.
	for _, k := range []string{"down", "down", "up", "up"} {
		w = drive(w, key(k))
		if got := w.credentialsStep.host.Value(); got != hostPresets[0] {
			t.Fatalf("%q left the single preset, got %q", k, got)
		}
	}
	if presetIndex(w.credentialsStep.host.Value()) < 0 {
		t.Errorf("the field should still hold a preset, got %q", w.credentialsStep.host.Value())
	}
}

// The presets are a convenience, never a constraint: a self-hosted operator's
// own URL is the primary path and typing it must survive the arrow keys.
func TestCredentialsStep_TypedHostSurvivesArrowKeys(t *testing.T) {
	defer ForcePlain()()

	w := atCredentials(t, testDeps())
	w.credentialsStep.host.SetValue("https://backplane.example.com")
	w.credentialsStep.presetCursor = presetIndex("https://backplane.example.com")

	w = drive(w, key("up"))

	if got := w.credentialsStep.host.Value(); got != "https://backplane.example.com" {
		t.Errorf("an arrow press must not discard a typed host, got %q", got)
	}
}

func TestCredentialsStep_TabCyclesHostAndKeyFields(t *testing.T) {
	defer ForcePlain()()

	w := atCredentials(t, testDeps())
	if w.credentialsStep.field != fieldHost {
		t.Fatalf("the host field should start focused, got %v", w.credentialsStep.field)
	}
	w = drive(w, key("tab"))
	if w.credentialsStep.field != fieldAgentKey {
		t.Errorf("tab should move to the key field, got %v", w.credentialsStep.field)
	}
	w = drive(w, key("tab"))
	if w.credentialsStep.field != fieldHost {
		t.Errorf("tab should wrap back to the host field, got %v", w.credentialsStep.field)
	}
}

// The 404 that motivated this step: a valid production key against a localhost
// default. Fixing it must not require restarting the whole wizard.
func TestConnectFailure_EReturnsToCredentialsWithValuesIntact(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.Credentials = CredentialSeed{APIKey: "vlr_env_key", Host: "http://localhost:8000"}

	w := drive(atCredentials(t, deps), key("enter"))
	if w.Step() != StepConnect {
		t.Fatalf("expected a connect attempt, got %v", w.Step())
	}
	w = drive(w, connectFailedMsg{err: &stubError{"valaris API error (HTTP 404)"}})

	if !strings.Contains(w.View(), "edit credentials") {
		t.Errorf("the failure state should offer the way back:\n%s", w.View())
	}

	w = drive(w, key("e"))
	if w.Step() != StepCredentials {
		t.Fatalf("`e` should return to the credentials step, got %v", w.Step())
	}
	if got := w.credentialsStep.key(); got != "vlr_env_key" {
		t.Errorf("the previous key must survive the round trip, got %q", got)
	}
	if got := w.credentialsStep.host.Value(); got != "http://localhost:8000" {
		t.Errorf("the previous host must survive the round trip, got %q", got)
	}
}

func TestCredentialsStep_EditedHostReachesTheConnectAttempt(t *testing.T) {
	defer ForcePlain()()

	deps := testDeps()
	deps.Credentials = CredentialSeed{APIKey: "vlr_env_key", Host: "http://localhost:8000"}

	w := atCredentials(t, deps)
	w.credentialsStep.host.SetValue("backplane.example.com")
	w = drive(w, key("enter"))

	if got := w.Result().APIURL; got != "https://backplane.example.com" {
		t.Errorf("the normalized, edited host must be what connect uses, got %q", got)
	}
}

// stubError keeps the connect-failure tests free of an errors import in every
// case that only needs a message.
type stubError struct{ msg string }

func (e *stubError) Error() string { return e.msg }
