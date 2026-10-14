// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"testing"
	"time"
)

// A hookless fork's usage and contents name the thread it forked from, as
// its own session_meta states it; a subagent forks no history.
func TestDiscoveryNamesAForksParentAndItsStart(t *testing.T) {
	home := newDiscoveryHome(t)
	forkID := "01a11e78-0000-7000-8000-000000000010"
	fork := home.rollout(t, "2026/10/08", "rollout-2026-10-08T22-23-21-"+forkID+".jsonl", fixtureHeader(t, "codex-desktop", "rollout-fork.jsonl"), time.Now())
	subagent := home.rollout(t, "2026/10/08", "rollout-2026-10-08T22-23-17-"+desktopChild+".jsonl", fixtureHeader(t, "codex-desktop", "rollout-subagent.jsonl"), time.Now().Add(-time.Minute))
	found := discoverWithinRoots(t, home.env, 64)
	if len(found) != 2 || found[0].Path != fork || found[1].Path != subagent {
		t.Fatalf("found %+v", found)
	}
	if found[0].ParentSessionID != desktopMain || !found[0].Began.Equal(time.Date(2026, 10, 9, 2, 23, 21, 621e6, time.UTC)) {
		t.Fatalf("fork ref %+v, want parent %s", found[0], desktopMain)
	}
	if found[1].ParentSessionID != "" {
		t.Fatalf("subagent ref %+v names a fork parent", found[1])
	}
}

// forked_from_id goes upstream as parent_native_session_id: one that is no
// thread id, or the thread's own, names no parent.
func TestAForkedFromIDThatNamesNoOtherThreadIsNoParent(t *testing.T) {
	parser := New().ContentParser()
	for _, forkedFrom := range []string{"../../escape", desktopMain, "has space"} {
		line := `{"timestamp":"2026-10-09T02:22:46.348Z","type":"session_meta","payload":{"id":"` + desktopMain + `","cwd":"/tmp","originator":"Codex Desktop","timestamp":"2026-10-09T02:22:46.326Z","forked_from_id":"` + forkedFrom + `"}}`
		header, ok := parser.Header([]byte(line))
		if !ok || header.ParentSessionID != "" {
			t.Errorf("forked_from_id %q: header %+v %v, want no parent", forkedFrom, header, ok)
		}
		home := newDiscoveryHome(t)
		home.rollout(t, "2026/10/09", "rollout-2026-10-09T02-22-46-"+desktopMain+".jsonl", []byte(line), time.Now())
		if found := discoverWithinRoots(t, home.env, 64); len(found) != 1 || found[0].ParentSessionID != "" {
			t.Errorf("forked_from_id %q: discovered %+v, want no parent", forkedFrom, found)
		}
	}
}
