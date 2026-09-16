// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"errors"
	"fmt"
	neturl "net/url"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
)

// hostPresets seeds the field with the local dev stack. Backplane is
// self-hosted: every install's backend lives at an address only its operator
// knows, so there is no hosted default to offer and shipping one deployment's
// domain in the binary would leak it to every other install.
var hostPresets = []string{
	"http://localhost:8000",
}

// maskRune stands in for every rune of the agent key on screen. A key is a
// bearer credential: it must survive a screenshot, a screen share and a pasted
// bug report without being usable.
const maskRune = "•"

// credentialsField is which of the two inputs has focus.
type credentialsField int

const (
	fieldHost credentialsField = iota
	fieldAgentKey
)

type credentialsStep struct {
	host   textinput.Model
	apiKey textinput.Model
	field  credentialsField

	hostSource string
	keySource  string

	// presetCursor tracks which host preset the arrow keys last landed on, so
	// cycling is stable even after the operator types over the field.
	presetCursor int

	// committedHost and committedKey are what the last successful commit
	// settled: normalized, and what the connect attempt actually used. Result
	// reports THESE, never the live field contents — an edit the operator
	// started and abandoned must not be persisted as if it were confirmed.
	committedHost string
	committedKey  string

	err error
}

func newCredentialsStep(seed CredentialSeed) credentialsStep {
	host := textinput.New()
	host.Prompt = "› "
	host.Placeholder = hostPresets[0]
	host.CharLimit = 256
	host.SetValue(seed.Host)
	host.CursorEnd()

	// EchoPassword renders the mask; the model keeps the real value, which is
	// what key() reads and what the Result carries.
	apiKey := textinput.New()
	apiKey.Prompt = "› "
	apiKey.Placeholder = "vlr_…"
	apiKey.CharLimit = 512
	apiKey.EchoMode = textinput.EchoPassword
	apiKey.EchoCharacter = []rune(maskRune)[0]
	apiKey.SetValue(seed.APIKey)
	apiKey.CursorEnd()

	return credentialsStep{
		host:         host,
		apiKey:       apiKey,
		hostSource:   seed.HostSource,
		keySource:    seed.APIKeySource,
		presetCursor: presetIndex(seed.Host),
	}
}

// key is the real agent key behind the mask, trimmed: operators paste with a
// trailing newline and a stray "\n" in a bearer header is a 401 nobody can see.
func (s credentialsStep) key() string { return strings.TrimSpace(s.apiKey.Value()) }

// presetIndex locates a host among the presets so arrow navigation resumes
// where the prefilled value already sits. An off-preset host starts before the
// first entry, so one "down" lands on hostPresets[0].
func presetIndex(host string) int {
	for i, p := range hostPresets {
		if p == host {
			return i
		}
	}
	return -1
}

func (w Wizard) credentialsKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.Type {
	case tea.KeyTab:
		w.credentialsStep.field = credentialsField(wrapIndex(int(w.credentialsStep.field)+1, 2))
		return w.syncCredentialsFocus()
	case tea.KeyShiftTab:
		w.credentialsStep.field = credentialsField(wrapIndex(int(w.credentialsStep.field)-1, 2))
		return w.syncCredentialsFocus()
	case tea.KeyEnter:
		return w.commitCredentials()
	}

	// Arrows cycle the host presets, but only while the host field has focus —
	// inside the key field they belong to the (masked) cursor.
	if w.credentialsStep.field == fieldHost {
		switch msg.String() {
		case "up", "down":
			// An operator who typed their own URL is on the primary path; the
			// arrows offer the presets to an untouched field and must never
			// overwrite that work. With a single preset there is nowhere to
			// cycle, so the only move the arrows can make is seeding it.
			if w.credentialsStep.presetCursor >= 0 && len(hostPresets) == 1 {
				return w, nil
			}
			if w.credentialsStep.presetCursor < 0 && strings.TrimSpace(w.credentialsStep.host.Value()) != "" {
				return w, nil
			}
			step := 1
			if msg.String() == "up" {
				step = -1
			}
			w.credentialsStep.presetCursor = wrapIndex(w.credentialsStep.presetCursor+step, len(hostPresets))
			w.credentialsStep.host.SetValue(hostPresets[w.credentialsStep.presetCursor])
			w.credentialsStep.host.CursorEnd()
			w.credentialsStep.err = nil
			return w, nil
		}
	}

	var cmd tea.Cmd
	if w.credentialsStep.field == fieldHost {
		w.credentialsStep.host, cmd = w.credentialsStep.host.Update(msg)
		// Typing over the field detaches it from the preset list; the next arrow
		// press should start the cycle rather than jump to a stale index.
		w.credentialsStep.presetCursor = presetIndex(w.credentialsStep.host.Value())
	} else {
		w.credentialsStep.apiKey, cmd = w.credentialsStep.apiKey.Update(msg)
	}
	return w, cmd
}

func (w Wizard) syncCredentialsFocus() (tea.Model, tea.Cmd) {
	w.credentialsStep.host.Blur()
	w.credentialsStep.apiKey.Blur()
	if w.credentialsStep.field == fieldAgentKey {
		return w, w.credentialsStep.apiKey.Focus()
	}
	return w, w.credentialsStep.host.Focus()
}

// commitCredentials validates both fields and, when they hold, hands off to the
// connect attempt. A rejection is reported inline rather than deferred to a
// connect failure, which would blame the network for a typo.
func (w Wizard) commitCredentials() (tea.Model, tea.Cmd) {
	host, err := normalizeHost(w.credentialsStep.host.Value())
	if err != nil {
		w.credentialsStep.err = err
		return w, nil
	}
	if w.credentialsStep.key() == "" {
		w.credentialsStep.err = errors.New("paste an agent key — mint one on the platform under Agents")
		return w, nil
	}

	w.credentialsStep.err = nil
	w.credentialsStep.host.SetValue(host)
	w.credentialsStep.committedHost = host
	w.credentialsStep.committedKey = w.credentialsStep.key()
	// A jumped commit deliberately keeps the jump pending: the edited
	// credential must pass connect before review may claim it, so the jump is
	// spent on connect success (or by esc from a failed connect).
	return w.enterConnect()
}

// normalizeHost turns what an operator types into a base URL the client can
// use. It is deliberately forgiving about the scheme (nobody types "https://"
// when reading a domain off a browser bar) and deliberately strict about
// anything that could not be a backend at all.
func normalizeHost(raw string) (string, error) {
	host := strings.TrimSpace(raw)
	if host == "" {
		return "", errors.New("enter the backend URL, e.g. http://localhost:8000 or https://backplane.example.com")
	}
	if strings.ContainsAny(host, " \t") {
		return "", fmt.Errorf("%q is not a URL — it contains a space", host)
	}

	if !strings.Contains(host, "://") {
		// A bare localhost (or 127.0.0.1) is a dev stack served over plain HTTP;
		// everything else is assumed to be a real deployment behind TLS.
		if isLoopbackHost(host) {
			host = "http://" + host
		} else {
			host = "https://" + host
		}
	}

	parsed, err := neturl.Parse(host)
	if err != nil {
		return "", fmt.Errorf("%q is not a URL: %w", raw, err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", fmt.Errorf("%q must be an http:// or https:// URL", raw)
	}
	if parsed.Host == "" {
		return "", fmt.Errorf("%q names no host", raw)
	}
	// A path is never part of the API base — the client appends /api/... itself,
	// so a trailing slash (or worse) would produce a double-slashed 404.
	return strings.TrimRight(parsed.Scheme+"://"+parsed.Host+parsed.Path, "/"), nil
}

func isLoopbackHost(host string) bool {
	name, _, _ := strings.Cut(host, ":")
	return name == "localhost" || name == "127.0.0.1" || name == "[::1]"
}

func (w Wizard) credentialsView(th Theme, width int) string {
	s := w.credentialsStep
	parts := []string{th.Title.Render("Which backend, and with which key?")}

	parts = append(parts,
		fieldLabel(th, "backend url"+sourceSuffix(s.hostSource), s.field == fieldHost)+
			"\n  "+s.host.View()+
			"\n  "+th.Subtle.Render(hostHint(s.host.Value())),
		fieldLabel(th, "agent key"+sourceSuffix(s.keySource), s.field == fieldAgentKey)+
			"\n  "+s.apiKey.View())

	if s.err != nil {
		parts = append(parts, th.Error.Render("✗ "+s.err.Error()))
	}
	return joinNonEmpty(parts, "\n\n")
}

// presetHintKey names only the keys that do something. A single preset has
// nowhere to cycle, so offering "↑/↓" promises navigation that is a no-op.
func presetHintKey() string {
	if len(hostPresets) > 1 {
		return "↑/↓"
	}
	return "↑"
}

// hostHint keeps the affordance honest about what the arrows can actually do.
// Backplane is self-hosted: every deployment lives at an address only its
// operator knows, so typing a URL is the primary path and the presets are just
// a shortcut to the local dev stack. Once the field already holds that preset,
// naming it again would advertise a keypress that changes nothing.
func hostHint(current string) string {
	if len(hostPresets) > 1 {
		return "type your backend url, or " + presetHintKey() + " for " + strings.Join(hostPresets, "  ")
	}
	if strings.TrimSpace(current) == hostPresets[0] {
		return "type your own backend url to change it"
	}
	return "type your backend url, or ↑ for " + hostPresets[0]
}

// sourceSuffix names where a prefilled value came from, so an operator staring
// at a wrong host knows whether to edit their shell or their config file.
func sourceSuffix(source string) string {
	if source == "" {
		return ""
	}
	return " (" + source + ")"
}
