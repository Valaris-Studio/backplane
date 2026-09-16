// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !integration

package llm

import (
	"os"
	"path/filepath"
	"testing"
)

// TestMain is the backstop for scratchCodexHome: the whole hermetic package
// runs under a scratch CODEX_HOME, so even a test that forgets the helper can
// never resolve — and write into — the developer's ~/.codex. The live
// integration build (tag `integration`) deliberately has no TestMain: those
// probes need the host's real (or BACKPLANE_PROBE_CODEX_HOME) home.
func TestMain(m *testing.M) {
	home, err := os.MkdirTemp("", "codex-unit-home-*")
	if err != nil {
		panic("scratch CODEX_HOME: " + err.Error())
	}
	if err := os.WriteFile(filepath.Join(home, "auth.json"), []byte(`{"auth_mode":"chatgpt"}`), 0o600); err != nil {
		panic("scratch auth.json: " + err.Error())
	}
	os.Setenv("CODEX_HOME", home)
	code := m.Run()
	_ = os.RemoveAll(home)
	os.Exit(code)
}

// TestCodexLaunchHome_UnitTestsNeverTouchRealHome pins the hermeticity
// contract: under the unit build, CODEX_HOME resolves beneath the system temp
// dir (never ~/.codex), and a launch home built from it creates its session
// state THERE.
func TestCodexLaunchHome_UnitTestsNeverTouchRealHome(t *testing.T) {
	configured := os.Getenv("CODEX_HOME")
	if configured == "" {
		t.Fatal("CODEX_HOME must be set for the whole hermetic package (TestMain)")
	}
	realHome := resolveRealCodexHome(configured)

	userHome, err := os.UserHomeDir()
	if err == nil && realHome == filepath.Join(userHome, ".codex") {
		t.Fatalf("unit tests resolve the developer's real ~/.codex (%s)", realHome)
	}
	tempRoot, _ := filepath.EvalSymlinks(os.TempDir())
	resolvedHome, _ := filepath.EvalSymlinks(realHome)
	if rel, err := filepath.Rel(tempRoot, resolvedHome); err != nil || rel == ".." || filepath.HasPrefix(rel, ".."+string(filepath.Separator)) {
		t.Fatalf("scratch CODEX_HOME %s is not beneath os.TempDir() %s", realHome, tempRoot)
	}

	home, cleanup, err := codexLaunchHome(codexHomeSpec{RealCodexHome: configured, DenyRules: renderCodexDenyRules(SafeToolDenyFloor)})
	if err != nil {
		t.Fatalf("codexLaunchHome: %v", err)
	}
	defer cleanup()
	for _, name := range []string{"sessions", "session_index.jsonl", "history.jsonl"} {
		if _, err := os.Stat(filepath.Join(realHome, name)); err != nil {
			t.Errorf("session state %s must be created under the scratch home %s: %v", name, realHome, err)
		}
	}
	if target, _ := os.Readlink(filepath.Join(home, "sessions")); target != filepath.Join(realHome, "sessions") {
		t.Errorf("launch home sessions → %q, want the scratch home's %q", target, filepath.Join(realHome, "sessions"))
	}
}
