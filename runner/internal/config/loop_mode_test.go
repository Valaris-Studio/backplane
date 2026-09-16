// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package config

import (
	"os"
	"path/filepath"
	"testing"
)

// loop_mode.keep_alive (card 5ffe97cf). Opting a runner into waiting for its
// board's loop to be re-enabled instead of exiting. Default OFF: every runner
// launched before this field existed must keep exiting exactly as it did.

func writeLoopModeConfig(t *testing.T, loopModeYAML string) string {
	t.Helper()
	content := `
valaris:
  api_url: "https://valaris.example.com"
  api_key: "vlr_test123"
  workspace_slug: "test-workspace"

llm:
  provider: "claude-cli"
  mcp_config_path: "/opt/backplane/mcp.json"

git:
  base_dir: "/tmp/repos"
` + loopModeYAML

	dir := t.TempDir()
	path := filepath.Join(dir, "config.yaml")
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestLoopMode_KeepAliveDefaultsOff(t *testing.T) {
	cfg, err := Load(writeLoopModeConfig(t, ""))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.LoopMode.KeepAlive {
		t.Error("loop_mode.keep_alive defaulted ON — every pre-existing runner would silently stop exiting on loop-off")
	}
}

func TestLoopMode_KeepAliveParsesFromYAML(t *testing.T) {
	cfg, err := Load(writeLoopModeConfig(t, "\nloop_mode:\n  keep_alive: true\n"))
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if !cfg.LoopMode.KeepAlive {
		t.Error("loop_mode.keep_alive: true did not parse — the YAML key is the profile-persisted half of this setting")
	}
}

// An old config file predates the whole loop_mode block; it must still load
// rather than erroring on the missing section.
func TestLoopMode_AbsentBlockStillLoads(t *testing.T) {
	if _, err := Load(writeLoopModeConfig(t, "\nlog_level: debug\n")); err != nil {
		t.Fatalf("Load with no loop_mode block: %v", err)
	}
}
