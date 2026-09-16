// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package llm

import (
	"os"
	"path/filepath"
	"testing"
)

// scratchCodexHome points CODEX_HOME at a throwaway "real" home for one test.
// The Codex driver resolves the real home from $CODEX_HOME (else ~/.codex)
// and now WRITES into it on every launch — sessions/, session_index.jsonl,
// history.jsonl are created there when absent — so a unit test that leaves
// CODEX_HOME unset would mutate the developer's own ~/.codex. Every test that
// reaches Execute, codexMCPHome or codexLaunchHome goes through this helper
// (or passes its own fake real home explicitly).
func scratchCodexHome(t *testing.T) string {
	t.Helper()
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "auth.json"), []byte(`{"auth_mode":"chatgpt"}`), 0o600); err != nil {
		t.Fatalf("write scratch auth.json: %v", err)
	}
	t.Setenv("CODEX_HOME", home)
	return home
}
