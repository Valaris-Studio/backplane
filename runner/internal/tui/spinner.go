// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package tui

import (
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/lipgloss"
)

// SpinnerKind selects one of the package's curated frame sets.
type SpinnerKind int

const (
	// SpinnerDots is the default in-flight indicator: quiet, one cell wide.
	SpinnerDots SpinnerKind = iota
	// SpinnerPulse breathes a block through four densities — for a single
	// long-running step where dots read as too busy.
	SpinnerPulse
	// SpinnerOrbit sweeps a braille dot around its cell, suggesting polling.
	SpinnerOrbit
	// SpinnerBar is an ASCII-only fallback for terminals without braille or
	// block glyph coverage.
	SpinnerBar
)

// Frame sets. FPS values are tuned so each cycle reads as motion rather than
// flicker: denser sets run slower to stay legible.
var (
	dotsFrames = spinner.Spinner{
		Frames: []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"},
		FPS:    time.Second / 12,
	}
	pulseFrames = spinner.Spinner{
		Frames: []string{"░", "▒", "▓", "█", "▓", "▒"},
		FPS:    time.Second / 8,
	}
	orbitFrames = spinner.Spinner{
		Frames: []string{"⠈", "⠐", "⠠", "⢀", "⡀", "⠄", "⠂", "⠁"},
		FPS:    time.Second / 10,
	}
	barFrames = spinner.Spinner{
		Frames: []string{"|", "/", "-", "\\"},
		FPS:    time.Second / 8,
	}
)

// Frames returns the raw frame set for a kind, for callers driving their own
// animation loop instead of a bubbles model.
func (k SpinnerKind) Frames() spinner.Spinner {
	switch k {
	case SpinnerPulse:
		return pulseFrames
	case SpinnerOrbit:
		return orbitFrames
	case SpinnerBar:
		return barFrames
	default:
		return dotsFrames
	}
}

// NewSpinner builds a bubbles spinner model wired to the theme accent. The
// caller still owns its lifecycle: return spinner.Tick from Init and forward
// spinner.TickMsg to the model's Update.
func NewSpinner(kind SpinnerKind) spinner.Model {
	th := New()
	style := lipgloss.NewStyle()
	if !th.Plain {
		style = style.Foreground(AccentAlt)
	}
	return spinner.New(
		spinner.WithSpinner(kind.Frames()),
		spinner.WithStyle(style),
	)
}
