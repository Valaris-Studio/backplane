// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package richcapture

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

// On Windows a file's identity is its volume serial and file index.
func TestAFileReplacedAtItsPathHasAnotherIdentity(t *testing.T) {
	path := filepath.Join(t.TempDir(), "session.jsonl")
	os.WriteFile(path, []byte("{\"n\":1}\n"), 0o600)
	source, _, err := OpenSource(path, Cursor{}, false)
	if err != nil {
		t.Fatal(err)
	}
	cursor := source.Mark(8)
	source.Close()
	if cursor.Identity == "" {
		t.Fatal("no file identity")
	}
	os.Rename(path, path+".old")
	os.WriteFile(path, []byte("{\"n\":1}\n"), 0o600)
	again, change, err := OpenSource(path, cursor, true)
	if err != nil {
		t.Fatal(err)
	}
	again.Close()
	if change != Replaced {
		t.Fatalf("change = %v", change)
	}
}

// A reparse point (a symlink or junction) is never followed into.
func TestAStoreThatIsAReparsePointIsRefused(t *testing.T) {
	within := t.TempDir()
	target := filepath.Join(t.TempDir(), "secret.txt")
	os.WriteFile(target, []byte("not the harness's"), 0o600)
	link := filepath.Join(within, "b1.txt")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("no symlink privilege: %v", err)
	}
	if _, err := ReadHarnessStore(agent.BodyStore{Path: link, Within: within}, 1<<20); !errors.Is(err, ErrStoreRefused) {
		t.Fatalf("read through a reparse point: %v", err)
	}
	plain := filepath.Join(within, "b2.txt")
	os.WriteFile(plain, []byte("body"), 0o600)
	if body, err := ReadHarnessStore(agent.BodyStore{Path: plain, Within: within}, 1<<20); err != nil || string(body) != "body" {
		t.Fatalf("plain store: %q %v", body, err)
	}
}
