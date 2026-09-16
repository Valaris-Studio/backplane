// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// TestRefreshPromptConfigs_LogsInfoOnFirstSeen_DebugOnRepeat asserts the
// per-poll noise fix: "prompt cache refreshed" emits at Info once per
// (role, prompt-set) tuple change, then drops to Debug on identical refreshes.
// Operators still see config changes; idle polls don't spam the log.
func TestRefreshPromptConfigs_LogsInfoOnFirstSeen_DebugOnRepeat(t *testing.T) {
	configs := []valaris.PromptConfig{
		{ID: "1", Slug: "discover", Stage: "discover", Content: "v1", Version: 1},
		{ID: "2", Slug: "claim", Stage: "claim", Content: "v1", Version: 1},
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(configs)
	}))
	defer srv.Close()

	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	loop := newTestLoop(srv.URL)

	// First refresh: tuple is new → Info.
	loop.RefreshPromptCache(context.Background())
	firstOutput := buf.String()
	buf.Reset()

	// Second refresh: identical tuple → Debug.
	loop.RefreshPromptCache(context.Background())
	secondOutput := buf.String()

	const msg = "prompt cache refreshed"

	firstInfo := strings.Contains(firstOutput, "level=INFO") && strings.Contains(firstOutput, msg)
	if !firstInfo {
		t.Errorf("first refresh: expected INFO %q in log, got:\n%s", msg, firstOutput)
	}

	if strings.Contains(secondOutput, "level=INFO") && strings.Contains(secondOutput, msg) {
		t.Errorf("second refresh: expected no INFO %q on identical configs, got:\n%s", msg, secondOutput)
	}
	if !(strings.Contains(secondOutput, "level=DEBUG") && strings.Contains(secondOutput, msg)) {
		t.Errorf("second refresh: expected DEBUG %q on identical configs, got:\n%s", msg, secondOutput)
	}
}

// TestRefreshPromptConfigs_LogsInfoOnVersionChange asserts that a version bump
// of the same stage re-emits Info — operators must see the prompt update land.
func TestRefreshPromptConfigs_LogsInfoOnVersionChange(t *testing.T) {
	call := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		call++
		version := 1
		if call > 1 {
			version = 2
		}
		_ = json.NewEncoder(w).Encode([]valaris.PromptConfig{
			{ID: "1", Slug: "discover", Stage: "discover", Content: "x", Version: version},
		})
	}))
	defer srv.Close()

	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	loop := newTestLoop(srv.URL)

	loop.RefreshPromptCache(context.Background())
	buf.Reset()
	loop.RefreshPromptCache(context.Background())

	out := buf.String()
	if !(strings.Contains(out, "level=INFO") && strings.Contains(out, "prompt cache refreshed")) {
		t.Errorf("expected INFO on version change, got:\n%s", out)
	}
}
