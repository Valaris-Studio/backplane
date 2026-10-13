// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func snapshotRolloutIdentity(t *testing.T, path string) os.FileInfo {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	info, statErr := file.Stat()
	closeErr := file.Close()
	if statErr != nil || closeErr != nil {
		t.Fatalf("snapshot rollout identity: stat %v, close %v", statErr, closeErr)
	}
	return info
}

func replaceDiscoveryRollout(t *testing.T, path string, header []byte) {
	t.Helper()
	before := snapshotRolloutIdentity(t, path)
	if err := os.Rename(path, path+".previous"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(append([]byte{}, header...), '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	if os.SameFile(before, snapshotRolloutIdentity(t, path)) {
		t.Fatal("replacement fixture kept the original file identity")
	}
}

func TestDiscoveryReadsTheReplacementAtACachedPath(t *testing.T) {
	home := newDiscoveryHome(t)
	header := fixtureHeader(t, "codex-desktop", "rollout-main.jsonl.gz")
	path := home.rollout(t, "2026/10/13", "rollout-2026-10-13T09-00-00-"+desktopMain+".jsonl", header, time.Now())
	first := New().DiscoverContent(home.env, 64)
	if len(first) != 1 || first[0].Path != path || first[0].NativeSessionID != desktopMain {
		t.Fatalf("original rollout not discovered: %+v", first)
	}

	// Replace between the first and second discovery, before a cache hit can
	// cause Windows' lazy directory FileInfo to resolve its identity.
	replaceDiscoveryRollout(t, path, withSessionID(header, desktopMain, desktopChild))
	found := New().DiscoverContent(home.env, 64)
	if len(found) != 1 || found[0].Path != path || found[0].NativeSessionID != desktopChild {
		t.Fatalf("discovery retained the replaced file's header: %+v", found)
	}
}

func TestSessionRelationRefusesAFileReplacedAfterItsChecks(t *testing.T) {
	home := newDiscoveryHome(t)
	header := fixtureHeader(t, "codex-desktop", "rollout-main.jsonl.gz")
	path := home.rollout(t, "2026/10/13", "rollout-2026-10-13T09-00-00-"+desktopMain+".jsonl", header, time.Now())
	if relation, ok := New().SessionRelation(home.env, path); !ok || relation.SessionID != desktopMain {
		t.Fatalf("original rollout unreadable: %+v, readable %v", relation, ok)
	}
	previous := beforeOpenRollout
	t.Cleanup(func() { beforeOpenRollout = previous })
	replaced := false
	beforeOpenRollout = func(checked string) {
		if filepath.Clean(checked) != filepath.Clean(path) {
			t.Fatalf("unexpected rollout checked: %s", checked)
		}
		if !replaced {
			replaced = true
			replaceDiscoveryRollout(t, path, withSessionID(header, desktopMain, desktopChild))
		}
	}
	if relation, ok := New().SessionRelation(home.env, path); ok {
		t.Fatalf("read a different file than the one checked: %+v", relation)
	}
	if !replaced {
		t.Fatal("replacement hook was not reached")
	}
}
