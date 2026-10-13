// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

// Codex Desktop runs without the CLI's hooks, so its sessions are found in
// $CODEX_HOME/sessions by their own session_meta.
type discoveryHome struct {
	env      agent.Env
	sessions string
}

func newDiscoveryHome(t *testing.T) discoveryHome {
	t.Helper()
	home, _ := filepath.EvalSymlinks(t.TempDir())
	sessions := filepath.Join(home, ".codex", "sessions")
	if err := os.MkdirAll(sessions, 0o700); err != nil {
		t.Fatal(err)
	}
	return discoveryHome{env: agent.Env{Home: home, Getenv: func(string) string { return "" }}, sessions: sessions}
}

// rollout writes a rollout under day (YYYY/MM/DD) whose first line is
// header, modified at modified.
func (h discoveryHome) rollout(t *testing.T, day, name string, header []byte, modified time.Time) string {
	t.Helper()
	path := filepath.Join(h.sessions, filepath.FromSlash(day), name)
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	body := append(append(bytes.Clone(header), '\n'), []byte(`{"timestamp":"2026-10-09T02:22:46.400Z","type":"event_msg","payload":{"type":"task_started"}}`+"\n")...)
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, modified, modified); err != nil {
		t.Fatal(err)
	}
	return path
}

func fixtureHeader(t *testing.T, surface, file string) []byte {
	t.Helper()
	return fixtureRolloutLines(t, surface, file)[0]
}

func withSessionID(header []byte, from, to string) []byte {
	return bytes.ReplaceAll(header, []byte(from), []byte(to))
}

func TestDiscoveryFindsDesktopSessionsNewestFirstAndNoCLIOnes(t *testing.T) {
	home := newDiscoveryHome(t)
	recent := time.Now().Add(-time.Minute)
	main := home.rollout(t, "2026/10/08", "rollout-2026-10-08T22-22-46-"+desktopMain+".jsonl", fixtureHeader(t, "codex-desktop", "rollout-main.jsonl.gz"), recent.Add(-time.Minute))
	child := home.rollout(t, "2026/10/08", "rollout-2026-10-08T22-23-17-"+desktopChild+".jsonl", fixtureHeader(t, "codex-desktop", "rollout-subagent.jsonl"), recent)
	home.rollout(t, "2026/10/08", "rollout-2026-10-08T22-18-46-"+cliThread+".jsonl", fixtureHeader(t, "codex-cli", "rollout-main.jsonl"), time.Now())
	home.rollout(t, "2026/10/08", "notes.jsonl", withSessionID(fixtureHeader(t, "codex-desktop", "rollout-main.jsonl.gz"), desktopMain, "01a11e78-0000-7000-8000-000000000001"), time.Now())
	if err := os.Symlink(main, filepath.Join(home.sessions, "2026", "10", "08", "rollout-2026-10-08T22-30-00-01a11e78-0000-7000-8000-000000000002.jsonl")); err != nil {
		t.Fatal(err)
	}
	found := discoverWithinRoots(t, home.env, 64)
	want := []agent.ContentFileRef{
		{Path: child, NativeSessionID: desktopChild, Cwd: "/tmp/fixture-desktop-repo", Harness: DesktopID, Began: time.Date(2026, 10, 9, 2, 23, 17, 358e6, time.UTC), ParentThreadID: desktopMain},
		{Path: main, NativeSessionID: desktopMain, Cwd: "/tmp/fixture-desktop-repo", Harness: DesktopID, Began: time.Date(2026, 10, 9, 2, 22, 46, 326e6, time.UTC)},
	}
	if len(found) != len(want) {
		t.Fatalf("found %+v, want %+v", found, want)
	}
	for index := range want {
		if found[index] != want[index] {
			t.Fatalf("found[%d] = %+v, want %+v", index, found[index], want[index])
		}
	}
	if limited := discoverWithinRoots(t, home.env, 1); len(limited) != 1 || limited[0].Path != child {
		t.Fatalf("limit 1 found %+v", limited)
	}
}

// A Desktop thread resumed today appends to the rollout of the day it
// began; one untouched for longer than the poll window is not offered.
func TestDiscoveryFindsAResumedOldThreadAndSkipsStaleOnes(t *testing.T) {
	home := newDiscoveryHome(t)
	header := fixtureHeader(t, "codex-desktop", "rollout-main.jsonl.gz")
	resumed := home.rollout(t, "2025/01/02", "rollout-2025-01-02T09-00-00-"+desktopMain+".jsonl", header, time.Now())
	stale := "01a11e78-0000-7000-8000-00000000000a"
	home.rollout(t, "2026/10/01", "rollout-2026-10-01T09-00-00-"+stale+".jsonl", withSessionID(header, desktopMain, stale), time.Now().Add(-48*time.Hour))
	found := discoverWithinRoots(t, home.env, 64)
	if len(found) != 1 || found[0].Path != resumed {
		t.Fatalf("found %+v, want only %s", found, resumed)
	}
}

func TestDiscoveryFollowsCodexHome(t *testing.T) {
	home := newDiscoveryHome(t)
	home.rollout(t, "2026/10/08", "rollout-2026-10-08T22-22-46-"+desktopMain+".jsonl", fixtureHeader(t, "codex-desktop", "rollout-main.jsonl.gz"), time.Now())
	elsewhere, _ := filepath.EvalSymlinks(t.TempDir())
	other := discoveryHome{env: agent.Env{Home: home.env.Home, Getenv: func(key string) string {
		if key == "CODEX_HOME" {
			return elsewhere
		}
		return ""
	}}, sessions: filepath.Join(elsewhere, "sessions")}
	otherID := "01a11e78-0000-7000-8000-00000000000b"
	path := other.rollout(t, "2026/10/09", "rollout-2026-10-09T08-00-00-"+otherID+".jsonl", withSessionID(fixtureHeader(t, "codex-desktop", "rollout-main.jsonl.gz"), desktopMain, otherID), time.Now())
	found := discoverWithinRoots(t, other.env, 64)
	if len(found) != 1 || found[0].Path != path || found[0].NativeSessionID != otherID {
		t.Fatalf("with CODEX_HOME set, found %+v", found)
	}
}

func TestDiscoverySkipsFilesWithoutADesktopSessionMeta(t *testing.T) {
	home := newDiscoveryHome(t)
	headers := map[string][]byte{
		"01a11e78-0000-7000-8000-00000000000c": []byte(`{"timestamp":"2026-10-09T02:22:46.348Z","type":"event_msg","payload":{"type":"task_started"}}`),
		"01a11e78-0000-7000-8000-00000000000d": []byte(`{"timestamp":"2026-10-09T02:22:46.348Z","type":"session_meta","payload":{"id":"../../escape","cwd":"/tmp","originator":"Codex Desktop","timestamp":"2026-10-09T02:22:46.326Z"}}`),
		"01a11e78-0000-7000-8000-00000000000e": []byte(`{"timestamp":"2026-10-09T02:22:46.348Z","type":"session_meta","payload":{"id":"01a11e78-0000-7000-8000-00000000000e","cwd":"/tmp","originator":"Codex Desktop","timestamp":"2026-10-09T02:22:46.326Z","base_instructions":{"text":"` + strings.Repeat("x", maxRolloutLineBytes) + `"}}}`),
		"01a11e78-0000-7000-8000-00000000000f": []byte(`not json`),
	}
	for id, header := range headers {
		home.rollout(t, "2026/10/09", "rollout-2026-10-09T08-00-00-"+id+".jsonl", header, time.Now())
	}
	if found := discoverWithinRoots(t, home.env, 64); len(found) != 0 {
		t.Fatalf("found %+v", found)
	}
}

// Discovery runs on every content pass: a header once read is not read
// again while its file stays the same file.
func TestDiscoveryReadsEachHeaderOnce(t *testing.T) {
	home := newDiscoveryHome(t)
	path := home.rollout(t, "2026/10/08", "rollout-2026-10-08T22-22-46-"+desktopMain+".jsonl", fixtureHeader(t, "codex-desktop", "rollout-main.jsonl.gz"), time.Now())
	opens := 0
	beforeOpenRollout = func(string) { opens++ }
	t.Cleanup(func() { beforeOpenRollout = func(string) {} })
	discoverWithinRoots(t, home.env, 64)
	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	file.WriteString(`{"timestamp":"2026-10-09T02:22:47.000Z","type":"event_msg","payload":{"type":"task_complete"}}` + "\n")
	file.Close()
	found := discoverWithinRoots(t, home.env, 64)
	if opens != 1 || len(found) != 1 {
		t.Fatalf("two passes opened rollouts %d times and found %+v", opens, found)
	}
}

// Amendment 34: the core reads a content file only under these roots.
func TestContentRootsAreTheSessionsDirectory(t *testing.T) {
	home := newDiscoveryHome(t)
	if roots := New().ContentRoots(home.env); len(roots) != 1 || roots[0] != home.sessions {
		t.Fatalf("roots under the default home %v, want [%s]", roots, home.sessions)
	}
	elsewhere, _ := filepath.EvalSymlinks(t.TempDir())
	overridden := agent.Env{Home: home.env.Home, Getenv: func(key string) string {
		if key == "CODEX_HOME" {
			return elsewhere
		}
		return ""
	}}
	if roots := New().ContentRoots(overridden); len(roots) != 1 || roots[0] != filepath.Join(elsewhere, "sessions") {
		t.Fatalf("roots with CODEX_HOME set %v", roots)
	}
	codexHomeIs := func(value string) agent.Env {
		return agent.Env{Home: home.env.Home, Getenv: func(key string) string {
			if key == "CODEX_HOME" {
				return value
			}
			return ""
		}}
	}
	// Roots are absolute and clean: a relative CODEX_HOME is not Codex's
	// documented override and falls back to the default.
	if roots := New().ContentRoots(codexHomeIs("codex")); len(roots) != 1 || roots[0] != home.sessions {
		t.Fatalf("roots with a relative CODEX_HOME %v", roots)
	}
	if roots := New().ContentRoots(codexHomeIs(elsewhere + "/")); len(roots) != 1 || roots[0] != filepath.Join(elsewhere, "sessions") {
		t.Fatalf("roots with a trailing slash %v", roots)
	}
	// One root serves the CLI's rollouts and Desktop's alike.
	cli := home.rollout(t, "2026/10/08", "rollout-2026-10-08T22-18-46-"+cliThread+".jsonl", fixtureHeader(t, "codex-cli", "rollout-main.jsonl"), time.Now())
	desktop := home.rollout(t, "2026/10/08", "rollout-2026-10-08T22-22-46-"+desktopMain+".jsonl", fixtureHeader(t, "codex-desktop", "rollout-main.jsonl.gz"), time.Now())
	for _, path := range []string{cli, desktop} {
		assertWithinRoots(t, home.env, path)
	}
}

// assertWithinRoots fails unless path lies under one of ContentRoots(env).
func assertWithinRoots(t *testing.T, env agent.Env, path string) {
	t.Helper()
	for _, root := range New().ContentRoots(env) {
		if !filepath.IsAbs(root) || filepath.Clean(root) != root {
			t.Fatalf("root %q is not absolute and clean", root)
		}
		if relative, err := filepath.Rel(root, path); err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
			return
		}
	}
	t.Fatalf("%s lies outside the content roots %v", path, New().ContentRoots(env))
}

// discoverWithinRoots is DiscoverContent, every ref checked against the
// roots the core confines reading to.
func discoverWithinRoots(t *testing.T, env agent.Env, limit int) []agent.ContentFileRef {
	t.Helper()
	found := New().DiscoverContent(env, limit)
	for _, ref := range found {
		assertWithinRoots(t, env, ref.Path)
	}
	return found
}
