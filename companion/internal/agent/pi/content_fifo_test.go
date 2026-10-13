// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package pi

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

// A FIFO where Pi's settings belong would block every content pass on an
// open that never returns; it is no settings file.
func TestContentRootsDoNotBlockOnASettingsFIFO(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "agent")
	os.MkdirAll(dir, 0o700)
	if err := syscall.Mkfifo(filepath.Join(dir, "settings.json"), 0o600); err != nil {
		t.Skip("no FIFO here:", err)
	}
	env := agent.Env{Home: t.TempDir(), Getenv: func(key string) string {
		if key == "PI_CODING_AGENT_DIR" {
			return dir
		}
		return ""
	}}
	done := make(chan []string, 1)
	go func() { done <- New().ContentRoots(env) }()
	select {
	case roots := <-done:
		if strings.Join(roots, ",") != filepath.Join(dir, "sessions") {
			t.Errorf("roots %v", roots)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("ContentRoots blocked opening a FIFO")
	}
}
