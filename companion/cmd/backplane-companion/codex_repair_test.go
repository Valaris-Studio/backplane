// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

func (h *harness) codexRepairResult(t *testing.T) string {
	t.Helper()
	health, err := state.Load[state.Health](store.Layout{Root: h.data}.Health())
	if err != nil {
		return ""
	}
	for _, repair := range health.AgentRepairs {
		if repair.Agent == "codex_cli" {
			return repair.Result
		}
	}
	return ""
}

// moveCompanion leaves every owned hook pointing at the old executable, as
// after an upgrade from another install location.
func (h *harness) moveCompanion(t *testing.T) {
	t.Helper()
	moved := filepath.Join(h.root, "moved", "backplane-companion")
	mustMkdir(t, filepath.Dir(moved))
	mustWrite(t, moved, "#!/bin/sh\n")
	os.Chmod(moved, 0o755)
	h.executable, h.app.executable = moved, moved
}

// The QA repro (DK-W1 B2): a Codex integration left by an older companion,
// on a data directory that has no gate yet. The daemon's repair must do what
// the manual Repair (agents install) does, not fail for want of a gate.
func TestDaemonRepairsAStaleCodexIntegrationBeforeAnyGateExists(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	codexHome := h.codexHome(t)
	if err := h.run(t, "agents", "install", "codex"); err != nil {
		t.Fatal(err)
	}
	layout := store.Layout{Root: h.data}
	if err := os.Remove(layout.OTelSettings()); err != nil {
		t.Fatal(err)
	}
	h.moveCompanion(t)
	h.env[envOtelcolArtifact] = filepath.Join(h.root, "missing", "otelcol.json")
	h.startDaemon(t)
	waitFor(t, "the daemon's codex repair", func() bool { return h.codexRepairResult(t) != "" })
	if result := h.codexRepairResult(t); result != "repaired" {
		t.Fatalf("daemon repair %s, want repaired (manual Repair succeeds on the same files)", result)
	}
	settings, err := state.Load[state.OTelSettings](layout.OTelSettings())
	if err != nil || settings.GatePort == 0 {
		t.Fatalf("gate not allocated for the repaired Codex: %+v %v", settings, err)
	}
	config, _ := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if !strings.Contains(string(config), "127.0.0.1:"+itoa(settings.GatePort)+"/v1/logs") {
		t.Fatalf("Codex not pointed at the gate:\n%s", config)
	}
	hooks, _ := os.ReadFile(filepath.Join(codexHome, "hooks.json"))
	if !strings.Contains(string(hooks), h.executable) {
		t.Fatalf("hooks not repointed:\n%s", hooks)
	}
}

func TestDaemonAllocatesNoGateWhenCodexIsNotSetUp(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	h.codexHome(t)
	logPath, stop := h.startDaemon(t)
	waitForLog(t, logPath, "started")
	stop()
	if _, err := os.Stat(store.Layout{Root: h.data}.OTelSettings()); err == nil {
		settings, _ := state.Load[state.OTelSettings](store.Layout{Root: h.data}.OTelSettings())
		if settings.GatePort != 0 {
			t.Fatalf("gate allocated with no Codex integration: %+v", settings)
		}
	}
	if result := h.codexRepairResult(t); result != "" {
		t.Fatalf("an agent that is not set up was repaired: %s", result)
	}
}

func TestDaemonLeavesCodexAloneWhenTheUserRemovedItsIntegration(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	codexHome := h.codexHome(t)
	if err := h.run(t, "agents", "install", "codex"); err != nil {
		t.Fatal(err)
	}
	if err := h.run(t, "agents", "uninstall", "codex"); err != nil {
		t.Fatal(err)
	}
	os.Remove(store.Layout{Root: h.data}.OTelSettings())
	h.moveCompanion(t)
	logPath, stop := h.startDaemon(t)
	waitForLog(t, logPath, "started")
	stop()
	config, _ := os.ReadFile(filepath.Join(codexHome, "config.toml"))
	if strings.Contains(string(config), "backplane-companion") {
		t.Fatalf("telemetry re-added after the user removed it:\n%s", config)
	}
}
