// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package hookfile

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

func TestConcurrentChangeAbortsOurWrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "hooks.json")
	os.WriteFile(path, []byte(`{"model":"before"}`), 0o600)
	concurrent := `{"model":"written by the agent meanwhile"}`
	beforeWrite = func(path string) { os.WriteFile(path, []byte(concurrent), 0o600) }
	defer func() { beforeWrite = nil }()
	err := Edit(path, true, func(hooks map[string]any) (bool, error) {
		hooks["Stop"] = []any{}
		return true, nil
	})
	if !errors.Is(err, agent.ErrConfigChanged) {
		t.Fatalf("concurrent change not detected: %v", err)
	}
	if data, _ := os.ReadFile(path); string(data) != concurrent {
		t.Fatal("our write clobbered a concurrent change")
	}
	if entries, _ := os.ReadDir(filepath.Dir(path)); len(entries) != 1 {
		t.Fatal("aborted write left a temporary file")
	}
}

func TestOwnedHooksReportPositions(t *testing.T) {
	owned := func(command string) bool { return command == "ours" }
	entries := []any{
		map[string]any{"hooks": []any{map[string]any{"command": "foreign"}}},
		map[string]any{"hooks": []any{map[string]any{"command": "x"}, map[string]any{"command": "ours"}}},
	}
	positions := OwnedHooks(entries, owned)
	if len(positions) != 1 || positions[0].Group != 1 || positions[0].Handler != 1 {
		t.Fatalf("positions: %+v", positions)
	}
	kept, removed := WithoutOwned(entries, owned)
	if !removed || len(kept) != 2 {
		t.Fatalf("without owned: %v", kept)
	}
}
