// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package telemetry

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"time"
)

// ANSI escape sequences. Empty strings when color is disabled.
type palette struct {
	reset, dim, bold                              string
	red, yellow, green, cyan, magenta, blue, gray string
}

var colorPalette = palette{
	reset:   "\x1b[0m",
	dim:     "\x1b[2m",
	bold:    "\x1b[1m",
	red:     "\x1b[31m",
	yellow:  "\x1b[33m",
	green:   "\x1b[32m",
	cyan:    "\x1b[36m",
	magenta: "\x1b[35m",
	blue:    "\x1b[34m",
	gray:    "\x1b[90m",
}

var nullPalette = palette{}

// attrsHiddenByDefault are noisy in normal operator view; revealed under --verbose.
// Trimmed list — operator-relevant keys (error, role, card_id, message, branch, stage) stay visible.
var attrsHiddenByDefault = map[string]struct{}{
	"execution_id":  {},
	"dir":           {},
	"cmd":           {},
	"args":          {},
	"stdin_len":     {},
	"endpoint":      {},
	"url":           {},
	"agent_id":      {},
	"user_id":       {},
	"path":          {},
	"addr":          {},
	"poll_interval": {},
	"drain_timeout": {},
	"health_port":   {},
	"idle_backoff":  {},
	"commit":        {},
	"built":         {},
	"prev_version":  {},
}

// sharedWriter bundles the destination and its mutex so all derived handlers
// (WithAttrs / WithGroup) serialise writes to the same stream.
type sharedWriter struct {
	mu sync.Mutex
	w  io.Writer
}

// ConsoleHandler is a slog.Handler that renders human-friendly, optionally
// color-coded single-line output for operators. Under verbose=false it
// hides internal-detail attrs and shortens UUIDs; under verbose=true it
// emits every attr and forwards Debug-level records.
type ConsoleHandler struct {
	out     *sharedWriter
	level   slog.Level
	verbose bool
	color   palette
	attrs   []slog.Attr
	group   string
}

// ConsoleHandlerOptions configures a ConsoleHandler.
type ConsoleHandlerOptions struct {
	// Verbose: when true, Debug records pass and hidden attrs are shown.
	Verbose bool
	// Color: when true, ANSI color codes are emitted. Caller decides
	// (usually based on TTY detection).
	Color bool
}

// NewConsoleHandler builds a ConsoleHandler writing to w. Verbose controls
// the minimum level (Info vs Debug) and attr filtering; Color toggles ANSI.
func NewConsoleHandler(w io.Writer, opts ConsoleHandlerOptions) *ConsoleHandler {
	level := slog.LevelInfo
	if opts.Verbose {
		level = slog.LevelDebug
	}
	p := nullPalette
	if opts.Color {
		p = colorPalette
	}
	return &ConsoleHandler{
		out:     &sharedWriter{w: w},
		level:   level,
		verbose: opts.Verbose,
		color:   p,
	}
}

// IsTerminal reports whether f looks like an interactive TTY. Safe on nil.
// Used by callers to decide between ConsoleHandler (TTY) and slog.TextHandler (pipe).
func IsTerminal(f *os.File) bool {
	if f == nil {
		return false
	}
	info, err := f.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

func (h *ConsoleHandler) Enabled(_ context.Context, l slog.Level) bool {
	return l >= h.level
}

func (h *ConsoleHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	clone := *h
	clone.attrs = append(append([]slog.Attr(nil), h.attrs...), attrs...)
	return &clone
}

func (h *ConsoleHandler) WithGroup(name string) slog.Handler {
	clone := *h
	if h.group != "" {
		clone.group = h.group + "." + name
	} else {
		clone.group = name
	}
	return &clone
}

func (h *ConsoleHandler) Handle(_ context.Context, r slog.Record) error {
	var b strings.Builder

	b.WriteString(h.color.gray)
	// Render in UTC with an explicit Z so logs are unambiguous and directly
	// comparable to Cloud Run / board-activity / Cloud Build timestamps (all
	// UTC), regardless of the runner process's TZ env.
	b.WriteString(r.Time.UTC().Format(time.TimeOnly))
	b.WriteByte('Z')
	b.WriteString(h.color.reset)
	b.WriteByte(' ')

	b.WriteString(renderLevel(r.Level, h.color))
	b.WriteByte(' ')

	b.WriteString(h.color.bold)
	b.WriteString(r.Message)
	b.WriteString(h.color.reset)

	for _, a := range h.attrs {
		h.renderAttr(&b, a)
	}
	r.Attrs(func(a slog.Attr) bool {
		h.renderAttr(&b, a)
		return true
	})
	b.WriteByte('\n')

	h.out.mu.Lock()
	defer h.out.mu.Unlock()
	_, err := io.WriteString(h.out.w, b.String())
	return err
}

func (h *ConsoleHandler) renderAttr(b *strings.Builder, a slog.Attr) {
	key := a.Key
	if key == "" {
		return
	}
	if !h.verbose {
		if _, hidden := attrsHiddenByDefault[key]; hidden {
			return
		}
	}
	val := stringifyValue(a.Value)
	if !h.verbose && key == "card_id" {
		val = shortenID(val)
	}

	b.WriteByte(' ')
	b.WriteString(colorForKey(key, h.color))
	b.WriteString(key)
	b.WriteString(h.color.reset)
	b.WriteByte('=')
	valColor := colorForValue(key, val, h.color)
	if valColor != "" {
		b.WriteString(valColor)
		b.WriteString(val)
		b.WriteString(h.color.reset)
	} else {
		b.WriteString(val)
	}
}

func renderLevel(l slog.Level, p palette) string {
	switch {
	case l >= slog.LevelError:
		return p.red + p.bold + "ERROR" + p.reset
	case l >= slog.LevelWarn:
		return p.yellow + p.bold + "WARN " + p.reset
	case l >= slog.LevelInfo:
		return p.green + "INFO " + p.reset
	default:
		return p.gray + "DEBUG" + p.reset
	}
}

func colorForKey(key string, p palette) string {
	switch key {
	case "error":
		return p.red
	case "role":
		return p.cyan
	case "card_id":
		return p.yellow
	case "stage", "phase":
		return p.magenta
	default:
		return p.dim
	}
}

func colorForValue(key, _ string, p palette) string {
	if key == "error" {
		return p.red
	}
	return ""
}

// stringifyValue renders a slog.Value with minimal quoting — only quote when
// the value contains whitespace or '=' that would confuse the key=value scan.
func stringifyValue(v slog.Value) string {
	s := v.Resolve().String()
	if strings.ContainsAny(s, " \t=") {
		return fmt.Sprintf("%q", s)
	}
	return s
}

// shortenID truncates UUID-shaped values to their first 8 chars for scanability.
// Leaves shorter / non-UUID-looking ids alone.
func shortenID(s string) string {
	if len(s) >= 8 && strings.Count(s, "-") >= 1 {
		return s[:8]
	}
	return s
}
