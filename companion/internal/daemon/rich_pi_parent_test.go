// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/pi"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
)

func TestNativePiForkContentKeepsItsHeaderParent(t *testing.T) {
	f := newFixture(t, pi.New())
	f.daemon.config.AgentEnv = agent.Env{Home: f.home}
	f.server.Lock()
	f.server.Policy.Installation.EnabledAgents = nil
	f.server.Policy.Mappings = []policy.Mapping{richMappingOf(f)}
	f.server.Policy.RichCapture = offerFor(map[string]time.Time{richMapping: richGrantedAt})
	f.server.Unlock()
	f.forcePolicyRefresh(t)

	const parent = "01a11e77-495e-7096-9830-f863d293518b"
	const fork = "01a11e79-8293-78ea-895f-cf661f71cc8b"
	const name = "2026-10-09T02-24-02-195Z_" + fork + ".jsonl"
	path := filepath.Join(f.home, ".pi", "agent", "sessions", "--code-app--", name)
	began := f.clock.Add(time.Second)
	writeLines(t, path, f.fixtureRolloutLines(t, "pi", "sessions/"+name, began))
	*f.clock = began
	payload, _ := json.Marshal(map[string]any{
		"type": "session_start", "sessionId": fork, "sessionFile": path, "cwd": f.repo,
	})
	if err := f.shim.Handle(pi.ID, bytes.NewReader(payload)); err != nil {
		t.Fatal(err)
	}
	f.tickUntilSettled(t)

	declared := declarationsByKey(f)
	if len(declared[agent.ContentKey(pi.ID, fork, "1789ecbd", "text:0")]) != 1 || len(declared[agent.ContentKey(pi.ID, fork, "5b8ab3b5", "text:0")]) != 1 {
		t.Fatal("the native fork's new prompt and reply were not captured")
	}
	if len(declared[agent.ContentKey(pi.ID, fork, "a0864fb0", "text:0")]) != 0 {
		t.Fatal("the fork exported a prompt inherited from its parent")
	}
	records := contentRecords(f)
	if len(records) == 0 {
		t.Fatal("no native Pi content envelopes were uploaded")
	}
	for _, record := range records {
		if record["native_session_id"] != fork || record["parent_native_session_id"] != parent {
			t.Errorf("Pi fork content lost its own header parent: session %v parent %v, want %s under %s", record["native_session_id"], record["parent_native_session_id"], fork, parent)
		}
	}
}
