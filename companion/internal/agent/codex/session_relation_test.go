// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

// A rollout's own session_meta says which thread it is and which one it
// descends from: the one it forked from, else the one that spawned it.
func TestSessionRelationIsTheRolloutsOwnHeader(t *testing.T) {
	var _ agent.SessionRelations = New()
	home := newDiscoveryHome(t)
	spawner := "01a12dbf-98b2-77a1-af8e-f2b77c1d69ac"
	nested := `{"timestamp":"2026-10-09T02:23:17.406Z","type":"session_meta","payload":{"id":"` + desktopChild + `","session_id":"` + desktopMain + `","parent_thread_id":"` + spawner + `","cwd":"/tmp","originator":"Codex Desktop","timestamp":"2026-10-09T02:23:17.358Z"}}`
	forkID := "01a11e78-0000-7000-8000-000000000010"
	cases := []struct {
		name   string
		header []byte
		want   agent.SessionRelation
	}{
		{"rollout-2026-10-08T22-22-46-" + desktopMain + ".jsonl", fixtureHeader(t, "codex-desktop", "rollout-main.jsonl.gz"), agent.SessionRelation{SessionID: desktopMain}},
		{"rollout-2026-10-08T22-23-17-" + desktopChild + ".jsonl", fixtureHeader(t, "codex-desktop", "rollout-subagent.jsonl"), agent.SessionRelation{SessionID: desktopChild, ParentSessionID: desktopMain}},
		{"rollout-2026-10-08T22-23-21-" + forkID + ".jsonl", fixtureHeader(t, "codex-desktop", "rollout-fork.jsonl"), agent.SessionRelation{SessionID: "01a11e78-e40c-7053-b316-e3e45bb698dd", ParentSessionID: desktopMain}},
		{"rollout-2026-10-09T02-23-17-nested.jsonl", []byte(nested), agent.SessionRelation{SessionID: desktopChild, ParentSessionID: spawner}},
	}
	for _, c := range cases {
		path := home.rollout(t, "2026/10/09", c.name, c.header, time.Now())
		if got, ok := New().SessionRelation(home.env, path); !ok || got != c.want {
			t.Errorf("%s: relation %+v %v, want %+v", c.name, got, ok, c.want)
		}
	}
}

// The header is read only from a regular rollout inside $CODEX_HOME/sessions
// and only when its first line is a complete session_meta.
func TestSessionRelationIsUnknownForAnyOtherFile(t *testing.T) {
	home := newDiscoveryHome(t)
	header := fixtureHeader(t, "codex-desktop", "rollout-main.jsonl.gz")
	outside := filepath.Join(home.env.Home, "rollout-2026-10-09T02-22-46-"+desktopMain+".jsonl")
	if err := os.WriteFile(outside, append(header, '\n'), 0o600); err != nil {
		t.Fatal(err)
	}
	unfinished := filepath.Join(home.sessions, "2026", "10", "09", "rollout-2026-10-09T02-22-47-"+desktopChild+".jsonl")
	os.MkdirAll(filepath.Dir(unfinished), 0o700)
	if err := os.WriteFile(unfinished, header[:len(header)/2], 0o600); err != nil {
		t.Fatal(err)
	}
	noMeta := home.rollout(t, "2026/10/09", "rollout-2026-10-09T02-22-48-"+cliThread+".jsonl", []byte(`{"timestamp":"2026-10-09T02:22:46.348Z","type":"event_msg","payload":{"type":"task_started"}}`), time.Now())
	for _, path := range []string{outside, unfinished, noMeta, filepath.Join(home.sessions, "missing", "rollout-x.jsonl")} {
		if got, ok := New().SessionRelation(home.env, path); ok {
			t.Errorf("%s: relation %+v from a file that is not a readable rollout header", path, got)
		}
	}
}
