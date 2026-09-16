// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"strings"

	"github.com/charmbracelet/lipgloss"
)

// Tagline sits under the wordmark. Kept short enough to never widen the art.
const Tagline = "software factory control plane"

// Column budgets for the two branding variants. Banner switches on these, and
// the art tests pin them so a glyph edit can never silently overflow.
const (
	// WordmarkWidth is the exact width of the block lettering.
	WordmarkWidth = 62
	// LogoWidth is the budget for the narrow-terminal variant.
	LogoWidth = 24
	// MinWordmarkCols is the terminal width at which Banner earns the full
	// wordmark. Equal to WordmarkWidth plus breathing room on both sides.
	MinWordmarkCols = 68
)

// wordmarkRows spell BACKPLANE in a 6-column-per-glyph block face, one space
// between glyphs. Every row is exactly WordmarkWidth so the vertical gradient
// lands on a flush block rather than a ragged edge — keep them padded when
// editing.
var wordmarkRows = []string{
	"█████   ████   █████ ██  ██ █████  ██      ████  ██  ██ ██████",
	"█   ██ ██  ██ ██     ██ ██  ██  ██ ██     ██  ██ ███ ██ ██    ",
	"█████  ██████ ██     ████   █████  ██     ██████ ██████ █████ ",
	"█   ██ ██  ██ ██     ██ ██  ██     ██     ██  ██ ██ ███ ██    ",
	"█████  ██  ██  █████ ██  ██ ██     ██████ ██  ██ ██  ██ ██████",
}

// logoRows are the narrow variant: a bracketed monogram that still names the
// product, for terminals below MinWordmarkCols. The P deliberately has no
// bottom stroke — closing it with a foot made the glyph read as an "e"; the
// bare stem descending below the bowl is what says "P".
var logoRows = []string{
	"┏━┓┏━┓",
	"┣━┫┣━┛  BACKPLANE",
	"┗━┛┃ " + shortTagline,
}

// shortTagline rides under the compact logo where the full Tagline would blow
// the LogoWidth budget.
const shortTagline = "control plane"

// Wordmark renders the full BACKPLANE banner with a vertical indigo→cyan
// gradient and the tagline beneath it. Never exceeds WordmarkWidth columns.
func Wordmark() string {
	th := New()
	lines := make([]string, 0, len(wordmarkRows)+2)

	for i, row := range wordmarkRows {
		if th.Plain {
			lines = append(lines, row)
			continue
		}
		stop := gradientStops[i*len(gradientStops)/len(wordmarkRows)]
		lines = append(lines, lipgloss.NewStyle().Foreground(stop).Render(row))
	}

	// Right-align the tagline under the lettering's trailing edge; it reads as
	// a signature rather than a second heading.
	tagline := th.Subtle.Render(Tagline)
	pad := WordmarkWidth - lipgloss.Width(Tagline)
	if pad > 0 {
		tagline = strings.Repeat(" ", pad) + tagline
	}
	return strings.Join(lines, "\n") + "\n\n" + tagline
}

// Logo renders the compact brand glyph for terminals too narrow for the
// wordmark. Never exceeds LogoWidth columns.
func Logo() string {
	th := New()
	if th.Plain {
		return strings.Join(logoRows, "\n")
	}

	lines := make([]string, 0, len(logoRows))
	for i, row := range logoRows {
		stop := gradientStops[i*len(gradientStops)/len(logoRows)]
		lines = append(lines, lipgloss.NewStyle().Foreground(stop).Render(row))
	}
	return strings.Join(lines, "\n")
}
