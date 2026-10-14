// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package store

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestDefaultRootHonorsOverrideAndPlatformDefaults(t *testing.T) {
	fixtureRoot := t.TempDir()
	home := filepath.Join(fixtureRoot, "home", "u")
	override := filepath.Join(fixtureRoot, "custom", "root")
	env := map[string]string{"HOME": home, EnvHome: override}
	getenv := func(key string) string { return env[key] }
	root, err := DefaultRoot(getenv, "linux", home)
	if err != nil || root != override {
		t.Fatalf("override ignored: %q %v", root, err)
	}
	delete(env, EnvHome)
	cases := []struct{ goos, want string }{
		{"darwin", filepath.Join(home, "Library", "Application Support", "Backplane Companion")},
		{"linux", filepath.Join(home, ".local", "state", "backplane-companion")},
	}
	for _, c := range cases {
		root, err := DefaultRoot(getenv, c.goos, home)
		if err != nil || root != c.want {
			t.Fatalf("%s: %q %v", c.goos, root, err)
		}
	}
	env["XDG_STATE_HOME"] = filepath.Join(fixtureRoot, "xdg")
	if root, _ := DefaultRoot(getenv, "linux", home); root != filepath.Join(env["XDG_STATE_HOME"], "backplane-companion") {
		t.Fatalf("XDG_STATE_HOME ignored: %s", root)
	}
	env["LOCALAPPDATA"] = filepath.Join(home, "AppData", "Local")
	if root, _ := DefaultRoot(getenv, "windows", home); root != filepath.Join(env["LOCALAPPDATA"], "Backplane", "Companion") {
		t.Fatalf("windows default: %s", root)
	}
	env[EnvHome] = "relative"
	if _, err := DefaultRoot(getenv, "linux", home); err == nil {
		t.Fatal("relative override accepted")
	}
}

func TestOpenCreatesPrivateLayoutAndRejectsSymlinks(t *testing.T) {
	root := filepath.Join(t.TempDir(), "data")
	layout, err := Open(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{layout.Root, layout.InboxDir(), layout.QueueDir(), layout.WorkDir()} {
		info, err := os.Lstat(dir)
		if err != nil || !info.IsDir() {
			t.Fatalf("missing %s", dir)
		}
		if runtime.GOOS != "windows" && info.Mode().Perm() != 0o700 {
			t.Fatalf("not private: %s %v", dir, info.Mode())
		}
	}
	outside := t.TempDir()
	if err := os.RemoveAll(layout.InboxDir()); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, layout.InboxDir()); err != nil {
		t.Skip(err)
	}
	if _, err := Open(root); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("symlinked inbox accepted: %v", err)
	}
}

func TestWriteFileAtomicIsPrivateAndLeavesNoTemporaries(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "value.json")
	if err := WriteJSON(path, map[string]string{"a": "<b>"}); err != nil {
		t.Fatal(err)
	}
	data, err := ReadPrivateFile(path, 1024)
	if err != nil || string(data) != "{\"a\":\"<b>\"}\n" {
		t.Fatalf("unexpected content %q %v", data, err)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Fatal("temporary file left behind")
	}
	if _, err := ReadPrivateFile(path, 4); !errors.Is(err, ErrUnsafePath) {
		t.Fatalf("oversized file accepted: %v", err)
	}
	link := filepath.Join(dir, "link.json")
	if err := os.Symlink(path, link); err == nil {
		if _, err := ReadPrivateFile(link, 1024); !errors.Is(err, ErrUnsafePath) {
			t.Fatal("symlinked private file accepted")
		}
		if err := WriteFileAtomic(link, []byte("x")); !errors.Is(err, ErrUnsafePath) {
			t.Fatal("write through symlink accepted")
		}
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := ReadPrivateFile(path, 1024); !errors.Is(err, ErrUnsafePath) {
			t.Fatal("group-readable private file accepted")
		}
	}
}

func TestLockIsExclusiveAndCancellable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x.lock")
	held, ok, err := TryLock(path)
	if err != nil || !ok {
		t.Fatalf("first lock failed: %v", err)
	}
	if _, ok, err := TryLock(path); err != nil || ok {
		t.Fatal("second lock acquired while held")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Millisecond)
	defer cancel()
	started := time.Now()
	if _, err := Lock(ctx, path); err == nil || time.Since(started) > time.Second {
		t.Fatal("lock wait did not honor cancellation")
	}
	held.Unlock()
	again, err := Lock(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	again.Unlock()
}
