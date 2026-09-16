// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"strings"
	"testing"

	"github.com/muesli/termenv"
)

func TestForcePlain_StripsAllEscapeSequences(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	th := New()
	styled := map[string]string{
		"title":    th.Title.Render("Backplane"),
		"subtle":   th.Subtle.Render("idle"),
		"error":    th.Error.Render("boom"),
		"success":  th.Success.Render("ok"),
		"warn":     th.Warn.Render("careful"),
		"selected": th.Selected.Render("row"),
		"keyhint":  th.KeyHint.Render("q"),
		"badge":    th.Badge.Render("RUNNING"),
		"accent":   th.Accent.Render("accent"),
		"panel":    th.Panel.Render("body"),
	}
	for name, out := range styled {
		if strings.ContainsRune(out, escape) {
			t.Errorf("%s style leaked an ANSI escape under ForcePlain: %q", name, out)
		}
	}
}

func TestForcePlain_RestoreIsReversible(t *testing.T) {
	// Pin a colored profile first so the assertion holds even where the suite
	// runs without a TTY (ambient profile would already be Ascii).
	outer := forceProfileTrueColor()
	defer outer()

	before := currentProfile()
	restore := ForcePlain()
	if got := currentProfile(); got != termenv.Ascii {
		t.Fatalf("ForcePlain left profile %v, want Ascii", got)
	}
	restore()
	if got := currentProfile(); got != before {
		t.Errorf("restore left profile %v, want %v", got, before)
	}
}

func TestNew_HonorsNoColorEnv(t *testing.T) {
	t.Setenv("NO_COLOR", "1")
	restoreProfile := ForcePlain()
	defer restoreProfile()

	th := New()
	if !th.Plain {
		t.Error("NO_COLOR set: theme should report Plain")
	}
	if out := th.Title.Render("x"); strings.ContainsRune(out, escape) {
		t.Errorf("NO_COLOR set: style still emitted escapes: %q", out)
	}
}

func TestNew_ColorEnabledWhenNoColorUnset(t *testing.T) {
	t.Setenv("NO_COLOR", "")
	restore := forceProfileTrueColor()
	defer restore()

	th := New()
	if th.Plain {
		t.Error("NO_COLOR empty on a color-capable profile: theme should not be Plain")
	}
	if out := th.Title.Render("x"); !strings.ContainsRune(out, escape) {
		t.Errorf("color enabled: Title should emit escapes, got %q", out)
	}
}

// Every semantic style must render its content verbatim — styling decorates,
// it never rewrites or truncates the caller's text.
func TestStyles_PreserveContent(t *testing.T) {
	restore := ForcePlain()
	defer restore()

	th := New()
	const content = "deploy-worker"
	styles := map[string]interface{ Render(...string) string }{
		"Title":    th.Title,
		"Subtle":   th.Subtle,
		"Error":    th.Error,
		"Success":  th.Success,
		"Warn":     th.Warn,
		"Selected": th.Selected,
		"KeyHint":  th.KeyHint,
		"Badge":    th.Badge,
		"Accent":   th.Accent,
	}
	for name, s := range styles {
		if out := s.Render(content); !strings.Contains(out, content) {
			t.Errorf("%s dropped its content: %q", name, out)
		}
	}
}

func TestAdaptiveColors_DefineBothPolarities(t *testing.T) {
	tests := []struct {
		name  string
		light string
		dark  string
	}{
		{"accent", Accent.Light, Accent.Dark},
		{"accentAlt", AccentAlt.Light, AccentAlt.Dark},
		{"fg", Foreground.Light, Foreground.Dark},
		{"muted", Muted.Light, Muted.Dark},
		{"border", Border.Light, Border.Dark},
		{"danger", Danger.Light, Danger.Dark},
		{"ok", OK.Light, OK.Dark},
		{"warning", Warning.Light, Warning.Dark},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if tc.light == "" || tc.dark == "" {
				t.Fatalf("adaptive color %q must define both polarities, got light=%q dark=%q",
					tc.name, tc.light, tc.dark)
			}
			for _, hex := range []string{tc.light, tc.dark} {
				if !strings.HasPrefix(hex, "#") || len(hex) != 7 {
					t.Errorf("%q is not a 6-digit hex color", hex)
				}
			}
			if tc.light == tc.dark {
				t.Errorf("adaptive color %q uses the same value on both polarities — "+
					"it will not adapt", tc.name)
			}
		})
	}
}
