// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// sidecarFixture is a session directory with one metadata sidecar in it,
// readable as written: each refusal is measured against that control.
func sidecarFixture(t *testing.T) (dir, path string) {
	t.Helper()
	dir, _ = filepath.EvalSymlinks(t.TempDir())
	path = filepath.Join(dir, "subagents", "agent-a1.meta.json")
	os.MkdirAll(filepath.Dir(path), 0o700)
	if err := os.WriteFile(path, []byte(`{"toolUseId":"toolu_1"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := ReadSessionSidecar(path, dir); !ok {
		t.Fatal("control: the fixture sidecar is unreadable")
	}
	return dir, path
}

func TestASessionSidecarIsReadWithinItsDirectory(t *testing.T) {
	dir, path := sidecarFixture(t)
	if data, ok := ReadSessionSidecar(path, dir); !ok || string(data) != `{"toolUseId":"toolu_1"}` {
		t.Fatalf("read %q %v", data, ok)
	}
}

func TestASessionSidecarOutsideItsDirectoryIsRefused(t *testing.T) {
	_, path := sidecarFixture(t)
	other, _ := filepath.EvalSymlinks(t.TempDir())
	if data, ok := ReadSessionSidecar(path, other); ok || data != nil {
		t.Fatalf("read %q outside its directory", data)
	}
}

func TestAnOversizedSessionSidecarIsRefused(t *testing.T) {
	dir, path := sidecarFixture(t)
	os.WriteFile(path, []byte(`{"pad":"`+strings.Repeat("x", 5<<10)+`"}`), 0o600)
	if data, ok := ReadSessionSidecar(path, dir); ok || data != nil {
		t.Fatalf("read %d bytes over the bound", len(data))
	}
}

func TestASymlinkedSessionSidecarIsRefused(t *testing.T) {
	dir, path := sidecarFixture(t)
	secret := filepath.Join(t.TempDir(), "secret.json")
	os.WriteFile(secret, []byte(`{"not":"the harness's"}`), 0o600)
	link := filepath.Join(filepath.Dir(path), "agent-a2.meta.json")
	if err := os.Symlink(secret, link); err != nil {
		t.Skipf("no symlink: %v", err)
	}
	if data, ok := ReadSessionSidecar(link, dir); ok || data != nil {
		t.Fatalf("read %q through a symlink", data)
	}
}
