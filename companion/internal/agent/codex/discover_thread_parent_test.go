// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"testing"
	"time"
)

// A Desktop subagent shares no history with the thread that spawned it, so
// it names no fork parent; its envelopes still name that thread, from its
// session_meta's parent_thread_id; session_id alone is only the tree's root.
func TestDiscoveryNamesTheThreadThatSpawnedASubagent(t *testing.T) {
	home := newDiscoveryHome(t)
	home.rollout(t, "2026/10/08", "rollout-2026-10-08T22-23-17-"+desktopChild+".jsonl", fixtureHeader(t, "codex-desktop", "rollout-subagent.jsonl"), time.Now())
	home.rollout(t, "2026/10/08", "rollout-2026-10-08T22-22-46-"+desktopMain+".jsonl", fixtureHeader(t, "codex-desktop", "rollout-main.jsonl.gz"), time.Now().Add(-time.Minute))
	forkID := "01a11e78-0000-7000-8000-000000000010"
	home.rollout(t, "2026/10/08", "rollout-2026-10-08T22-23-21-"+forkID+".jsonl", fixtureHeader(t, "codex-desktop", "rollout-fork.jsonl"), time.Now().Add(-2*time.Minute))
	found := discoverWithinRoots(t, home.env, 64)
	if len(found) != 3 {
		t.Fatalf("found %+v", found)
	}
	subagent, root, fork := found[0], found[1], found[2]
	if subagent.ParentThreadID != desktopMain || subagent.ParentSessionID != "" || subagent.EnvelopeParent() != desktopMain {
		t.Errorf("subagent ref %+v, want spawned by %s and no fork parent", subagent, desktopMain)
	}
	if root.ParentThreadID != "" || root.EnvelopeParent() != "" {
		t.Errorf("root ref %+v names a parent", root)
	}
	if fork.ParentThreadID != "" || fork.EnvelopeParent() != desktopMain {
		t.Errorf("fork ref %+v, want envelope parent %s from forked_from_id", fork, desktopMain)
	}
}

// The relation goes upstream as parent_native_session_id: an id that is no
// thread id, or the thread's own, is passed over for the next.
func TestASubagentRelationThatNamesNoOtherThreadIsPassedOver(t *testing.T) {
	cases := []struct{ sessionID, parentThreadID, want string }{
		{desktopChild, "", ""},
		{desktopChild, desktopChild, ""},
		{"../../escape", "has space", ""},
		{desktopChild, desktopMain, desktopMain},
		{"../../escape", desktopMain, desktopMain},
		{desktopMain, cliThread, cliThread},
		{desktopMain, "has space", ""},
		{desktopMain, "", ""},
	}
	for _, c := range cases {
		home := newDiscoveryHome(t)
		line := `{"timestamp":"2026-10-09T02:23:17.406Z","type":"session_meta","payload":{"id":"` + desktopChild + `","session_id":"` + c.sessionID + `","parent_thread_id":"` + c.parentThreadID + `","cwd":"/tmp","originator":"Codex Desktop","timestamp":"2026-10-09T02:23:17.358Z"}}`
		home.rollout(t, "2026/10/09", "rollout-2026-10-09T02-23-17-"+desktopChild+".jsonl", []byte(line), time.Now())
		found := discoverWithinRoots(t, home.env, 64)
		if len(found) != 1 || found[0].ParentThreadID != c.want {
			t.Errorf("session_id %q parent_thread_id %q: discovered %+v, want %q", c.sessionID, c.parentThreadID, found, c.want)
		}
	}
}

// A Desktop guardian_review subagent (0.159, 0.162) is spawned by another
// subagent: its session_id is the tree's root, its parent_thread_id the
// thread that spawned it, which its envelopes must name.
func TestDiscoveryNamesANestedSubagentsImmediateSpawner(t *testing.T) {
	home := newDiscoveryHome(t)
	spawner := "01a12dbf-98b2-77a1-af8e-f2b77c1d69ac"
	line := `{"timestamp":"2026-10-09T02:23:17.406Z","type":"session_meta","payload":{"id":"` + desktopChild + `","session_id":"` + desktopMain + `","parent_thread_id":"` + spawner + `","cwd":"/tmp","originator":"Codex Desktop","thread_source":"guardian_review","timestamp":"2026-10-09T02:23:17.358Z"}}`
	home.rollout(t, "2026/10/09", "rollout-2026-10-09T02-23-17-"+desktopChild+".jsonl", []byte(line), time.Now())
	found := discoverWithinRoots(t, home.env, 64)
	if len(found) != 1 || found[0].EnvelopeParent() != spawner {
		t.Fatalf("discovered %+v, want envelope parent %s, the immediate spawner", found, spawner)
	}
}
