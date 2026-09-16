// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package tui is the shared visual language for Backplane's interactive
// terminal screens: an adaptive palette, named semantic styles, ASCII
// branding, spinners, and the small render helpers every screen composes.
//
// Call sites never reach for a raw color — they render through a Theme's
// named styles so a palette change lands everywhere at once.
package tui

import (
	"os"
	"strings"

	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

// escape is the ANSI CSI introducer. Tests assert its absence to prove a
// plain-text render carries no styling.
const escape = '\x1b'

// Brand palette. Deep indigo carries the product identity; cyan is the
// live/active accent. Each color is stated for both terminal polarities:
// the Light value must survive a white background, the Dark value a black
// one — so the pair is never the same hex.
var (
	// Accent is the Backplane indigo — headings, borders, brand chrome.
	Accent = lipgloss.AdaptiveColor{Light: "#4338CA", Dark: "#818CF8"}
	// AccentAlt is the cyan used for live/in-flight signal against Accent.
	AccentAlt = lipgloss.AdaptiveColor{Light: "#0E7490", Dark: "#22D3EE"}
	// Foreground is default body text.
	Foreground = lipgloss.AdaptiveColor{Light: "#18181B", Dark: "#E4E4E7"}
	// Muted is secondary text: hints, units, timestamps.
	Muted = lipgloss.AdaptiveColor{Light: "#71717A", Dark: "#8B8B94"}
	// Border is panel chrome — deliberately dimmer than Muted text.
	Border = lipgloss.AdaptiveColor{Light: "#D4D4D8", Dark: "#3F3F46"}
	// Danger marks failure and destructive affordances.
	Danger = lipgloss.AdaptiveColor{Light: "#BE123C", Dark: "#FB7185"}
	// OK marks success and healthy state.
	OK = lipgloss.AdaptiveColor{Light: "#15803D", Dark: "#4ADE80"}
	// Warning marks degraded-but-running state.
	Warning = lipgloss.AdaptiveColor{Light: "#B45309", Dark: "#FBBF24"}
	// SelectedBg backs the focused row in a list.
	SelectedBg = lipgloss.AdaptiveColor{Light: "#E0E7FF", Dark: "#312E81"}
)

// gradientStops shade the wordmark from brand indigo into the cyan accent.
// Ordered top row to bottom row; Wordmark samples this by row index.
var gradientStops = []lipgloss.AdaptiveColor{
	{Light: "#3730A3", Dark: "#6366F1"},
	{Light: "#4338CA", Dark: "#818CF8"},
	{Light: "#3B5BDB", Dark: "#60A5FA"},
	{Light: "#1D6FA3", Dark: "#38BDF8"},
	{Light: "#0E7490", Dark: "#22D3EE"},
}

// Theme is a resolved set of semantic styles. Build one with New per screen
// (it is cheap) rather than sharing a package-level value — a package var
// would freeze the color profile at init, before NO_COLOR or a test hook
// could take effect.
type Theme struct {
	// Plain reports that color was suppressed, by NO_COLOR or a non-color
	// terminal. Screens can use it to swap in text markers for color cues.
	Plain bool

	Title      lipgloss.Style
	Subtitle   lipgloss.Style
	Subtle     lipgloss.Style
	Accent     lipgloss.Style
	Error      lipgloss.Style
	Success    lipgloss.Style
	Warn       lipgloss.Style
	Selected   lipgloss.Style
	Panel      lipgloss.Style
	PanelTitle lipgloss.Style
	KeyHint    lipgloss.Style
	KeyCap     lipgloss.Style
	Badge      lipgloss.Style
}

// New resolves the theme against the active terminal. When NO_COLOR is set
// (any non-empty value, per the no-color.org convention) every style renders
// as bare text.
func New() Theme {
	plain := noColorRequested() || currentProfile() == termenv.Ascii

	fg := func(c lipgloss.TerminalColor) lipgloss.Style {
		if plain {
			return lipgloss.NewStyle()
		}
		return lipgloss.NewStyle().Foreground(c)
	}

	th := Theme{
		Plain:    plain,
		Title:    fg(Accent).Bold(true),
		Subtitle: fg(Foreground),
		Subtle:   fg(Muted),
		Accent:   fg(AccentAlt),
		Error:    fg(Danger).Bold(true),
		Success:  fg(OK),
		Warn:     fg(Warning),
		KeyHint:  fg(Muted),
		KeyCap:   fg(AccentAlt).Bold(true),
	}

	th.Selected = fg(Foreground).Bold(true)
	th.Badge = fg(Accent).Bold(true).Padding(0, 1)
	th.PanelTitle = fg(Accent).Bold(true)
	th.Panel = lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		Padding(0, 1)

	if !plain {
		th.Selected = th.Selected.Background(SelectedBg)
		th.Badge = th.Badge.Background(SelectedBg)
		th.Panel = th.Panel.BorderForeground(Border)
	}
	return th
}

// noColorRequested honors the NO_COLOR convention: presence with any
// non-empty value disables color.
func noColorRequested() bool {
	return strings.TrimSpace(os.Getenv("NO_COLOR")) != ""
}

func currentProfile() termenv.Profile { return lipgloss.ColorProfile() }

// ForcePlain switches the global renderer to unstyled output and returns a
// function restoring the previous profile. Intended for tests and for
// callers piping TUI output into a file; defer the returned func.
func ForcePlain() func() {
	previous := currentProfile()
	lipgloss.SetColorProfile(termenv.Ascii)
	return func() { lipgloss.SetColorProfile(previous) }
}

// forceProfileTrueColor is the inverse hook used by tests that need to
// assert colored output regardless of where the suite runs (CI has no TTY,
// so the ambient profile would otherwise be Ascii).
func forceProfileTrueColor() func() {
	previous := currentProfile()
	lipgloss.SetColorProfile(termenv.TrueColor)
	return func() { lipgloss.SetColorProfile(previous) }
}
