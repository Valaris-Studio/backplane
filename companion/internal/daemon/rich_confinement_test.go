// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

// Amendment 34: a session file is read only within its agent's content
// roots, however it was named. Directory links are judged where they land,
// as ReadOwnedFile judges them; a link in the file's own place is refused.

// richHookNaming is the agent's hook naming path as the session's file.
func (f *fixture) richHookNaming(t *testing.T, id, path string) {
	t.Helper()
	payload, _ := json.Marshal(map[string]string{"session_id": id, "cwd": f.repo, "hook_event_name": "message_end", "session_file": path})
	if err := f.shim.Handle(richAgent, bytes.NewReader(payload)); err != nil {
		t.Fatal(err)
	}
}

func (f *fixture) writeSessionAt(t *testing.T, path, id string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o700)
	appendSession(t, path, textLine(id, f.stamp(), "said "+id).Encode())
}

func assertRefused(t *testing.T, f *fixture) {
	t.Helper()
	if keys := declaredKeys(f); len(keys) != 0 {
		t.Fatalf("a refused file declared %v", keys)
	}
	if parsed := f.parsed.Load(); parsed != 0 {
		t.Fatalf("a refused file was parsed: %d lines", parsed)
	}
	if refused := richHealth(t, f).SourcesRefused; refused != 1 {
		t.Fatalf("refused counted %d times, want once", refused)
	}
}

func TestAHookNamedFileOutsideItsAgentsRootsIsNeverOpened(t *testing.T) {
	f := newRichFixture(t)
	outside := filepath.Join(f.home, "elsewhere", "s.jsonl")
	f.writeSessionAt(t, outside, "e1")
	f.richHookNaming(t, session, outside)
	f.tickUntilSettled(t)
	assertRefused(t, f)
}

func TestADiscoveredFileOutsideItsAgentsRootsIsNeverOpened(t *testing.T) {
	var found []agent.ContentFileRef
	f := newRichFixture(t, func() []agent.ContentFileRef { return found })
	outside := filepath.Join(f.home, "elsewhere", "d.jsonl")
	f.writeSessionAt(t, outside, "e1")
	found = []agent.ContentFileRef{{Path: outside, NativeSessionID: "d", Cwd: f.repo}}
	f.tickUntilSettled(t)
	assertRefused(t, f)
}

func TestAFileUnderADirectoryLinkLeavingTheRootsIsNeverOpened(t *testing.T) {
	f := newRichFixture(t)
	outside := filepath.Join(f.home, "elsewhere")
	os.MkdirAll(outside, 0o700)
	os.MkdirAll(sessionsDir(f.home), 0o700)
	if err := os.Symlink(outside, filepath.Join(sessionsDir(f.home), "linked")); err != nil {
		t.Fatal(err)
	}
	named := filepath.Join(sessionsDir(f.home), "linked", "s.jsonl")
	f.writeSessionAt(t, named, "e1")
	f.richHookNaming(t, session, named)
	f.tickUntilSettled(t)
	assertRefused(t, f)
}

func TestALinkInTheSessionFilesOwnPlaceIsNeverOpened(t *testing.T) {
	f := newRichFixture(t)
	target := filepath.Join(sessionsDir(f.home), "target.jsonl")
	f.writeSessionAt(t, target, "e1")
	link := filepath.Join(sessionsDir(f.home), "link.jsonl")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	f.richHookNaming(t, session, link)
	f.tickUntilSettled(t)
	assertRefused(t, f)
}

func TestAFileUnderADirectoryLinkWithinTheRootsIsRead(t *testing.T) {
	f := newRichFixture(t)
	within := filepath.Join(sessionsDir(f.home), "2026")
	os.MkdirAll(within, 0o700)
	if err := os.Symlink(within, filepath.Join(sessionsDir(f.home), "latest")); err != nil {
		t.Fatal(err)
	}
	named := filepath.Join(sessionsDir(f.home), "latest", "s.jsonl")
	f.writeSessionAt(t, named, "e1")
	f.richHookNaming(t, session, named)
	f.tickUntilSettled(t)
	if keys := declaredKeys(f); len(keys) != 1 || keys[0] != itemKey("e1") {
		t.Fatalf("declared %v", keys)
	}
	if refused := richHealth(t, f).SourcesRefused; refused != 0 {
		t.Fatalf("refused %d", refused)
	}
}
