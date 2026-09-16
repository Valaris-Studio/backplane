// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package telemetry

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"
)

func newRecord(level slog.Level, msg string, kv ...any) slog.Record {
	r := slog.NewRecord(time.Date(2026, 5, 15, 12, 34, 56, 0, time.UTC), level, msg, 0)
	r.Add(kv...)
	return r
}

func TestConsoleHandler_TimestampIsUTCWithZSuffix(t *testing.T) {
	var buf bytes.Buffer
	h := NewConsoleHandler(&buf, ConsoleHandlerOptions{Color: false})

	// Record stamped in a NON-UTC zone (EDT, -04:00) at 08:34:56 local, which
	// is 12:34:56 UTC. The console line must render the UTC instant with an
	// explicit Z so logs are unambiguous and comparable to Cloud Run / board-
	// activity timestamps (all UTC), regardless of the runner's TZ env.
	edt := time.FixedZone("EDT", -4*60*60)
	r := slog.NewRecord(
		time.Date(2026, 5, 15, 8, 34, 56, 0, edt), slog.LevelInfo, "boot", 0,
	)
	if err := h.Handle(context.Background(), r); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "12:34:56Z") {
		t.Errorf("want UTC timestamp 12:34:56Z, got: %s", out)
	}
	if strings.Contains(out, "08:34:56") {
		t.Errorf("rendered local time instead of UTC: %s", out)
	}
}

func TestConsoleHandler_DefaultHidesNoisyAttrs(t *testing.T) {
	var buf bytes.Buffer
	h := NewConsoleHandler(&buf, ConsoleHandlerOptions{Verbose: false, Color: false})

	r := newRecord(slog.LevelInfo, "claim_card",
		"role", "orchestrator",
		"card_id", "9d4ae732-75a6-428e-8daf-a919a0747fd5",
		"execution_id", "exec-abc-123",
		"dir", "/tmp/repo",
		"cmd", "git",
	)
	if err := h.Handle(context.Background(), r); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	out := buf.String()
	wantContain := []string{"INFO", "claim_card", "role=orchestrator", "card_id=9d4ae732"}
	for _, s := range wantContain {
		if !strings.Contains(out, s) {
			t.Errorf("output missing %q: %s", s, out)
		}
	}
	wantMissing := []string{"execution_id", "dir=", "cmd=", "75a6-428e"}
	for _, s := range wantMissing {
		if strings.Contains(out, s) {
			t.Errorf("output should hide %q under default verbose=false: %s", s, out)
		}
	}
}

func TestConsoleHandler_VerboseShowsAllAttrs(t *testing.T) {
	var buf bytes.Buffer
	h := NewConsoleHandler(&buf, ConsoleHandlerOptions{Verbose: true, Color: false})

	r := newRecord(slog.LevelDebug, "polling",
		"role", "orchestrator",
		"card_id", "9d4ae732-75a6-428e-8daf-a919a0747fd5",
		"execution_id", "exec-abc-123",
		"dir", "/tmp/repo",
	)
	if !h.Enabled(context.Background(), slog.LevelDebug) {
		t.Fatal("verbose handler must enable Debug")
	}
	if err := h.Handle(context.Background(), r); err != nil {
		t.Fatalf("Handle: %v", err)
	}

	out := buf.String()
	wantAll := []string{
		"DEBUG", "polling", "role=orchestrator",
		"card_id=9d4ae732-75a6-428e-8daf-a919a0747fd5",
		"execution_id=exec-abc-123", "dir=/tmp/repo",
	}
	for _, s := range wantAll {
		if !strings.Contains(out, s) {
			t.Errorf("verbose output missing %q: %s", s, out)
		}
	}
}

func TestConsoleHandler_DefaultDropsDebug(t *testing.T) {
	var buf bytes.Buffer
	h := NewConsoleHandler(&buf, ConsoleHandlerOptions{Verbose: false, Color: false})
	if h.Enabled(context.Background(), slog.LevelDebug) {
		t.Error("default handler must drop Debug")
	}
	if !h.Enabled(context.Background(), slog.LevelInfo) {
		t.Error("default handler must accept Info")
	}
}

func TestConsoleHandler_ColorEmitsANSI(t *testing.T) {
	var buf bytes.Buffer
	h := NewConsoleHandler(&buf, ConsoleHandlerOptions{Verbose: false, Color: true})

	r := newRecord(slog.LevelError, "boom", "error", "kaboom")
	if err := h.Handle(context.Background(), r); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "\x1b[31m") {
		t.Errorf("expected red ANSI for ERROR level: %q", out)
	}
	if !strings.Contains(out, "\x1b[0m") {
		t.Errorf("expected ANSI reset: %q", out)
	}
}

func TestConsoleHandler_NoColorOmitsANSI(t *testing.T) {
	var buf bytes.Buffer
	h := NewConsoleHandler(&buf, ConsoleHandlerOptions{Verbose: false, Color: false})

	r := newRecord(slog.LevelError, "boom", "error", "kaboom")
	if err := h.Handle(context.Background(), r); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if strings.Contains(buf.String(), "\x1b[") {
		t.Errorf("expected no ANSI codes when Color=false: %q", buf.String())
	}
}

func TestConsoleHandler_WithAttrsPropagates(t *testing.T) {
	var buf bytes.Buffer
	h := NewConsoleHandler(&buf, ConsoleHandlerOptions{Verbose: false, Color: false})
	enriched := h.WithAttrs([]slog.Attr{slog.String("role", "reviewer")})

	r := newRecord(slog.LevelInfo, "tick")
	if err := enriched.Handle(context.Background(), r); err != nil {
		t.Fatalf("Handle: %v", err)
	}
	if !strings.Contains(buf.String(), "role=reviewer") {
		t.Errorf("WithAttrs role not rendered: %s", buf.String())
	}
}

func TestIsTerminal_PipeIsFalse(t *testing.T) {
	rp, wp, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	defer rp.Close()
	defer wp.Close()
	if IsTerminal(rp) {
		t.Error("pipe should not be detected as terminal")
	}
}

func TestIsTerminal_NilIsFalse(t *testing.T) {
	if IsTerminal(nil) {
		t.Error("nil file should not be terminal")
	}
}

func TestShortenID(t *testing.T) {
	cases := map[string]string{
		"9d4ae732-75a6-428e-8daf-a919a0747fd5": "9d4ae732",
		"short":                                "short",
		"":                                     "",
		"no-uuid":                              "no-uuid", // 7 chars
	}
	for in, want := range cases {
		if got := shortenID(in); got != want {
			t.Errorf("shortenID(%q) = %q, want %q", in, got, want)
		}
	}
}
