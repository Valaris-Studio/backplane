// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/pi"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
)

// Amendment 38, seen natively with Pi 0.84.4: resuming a session that
// began before admission, Pi writes the new prompt before the managed
// extension's first event reaches the shim (fire-and-forget spawn, ~20 ms
// later), and the daemon's first read comes later still. The resumed run's
// new activity is captured; nothing from before the resume is.
func TestAResumedPiSessionKeepsThePromptWrittenBeforeItsFirstSighting(t *testing.T) {
	f := newFixture(t, pi.New())
	f.daemon.config.AgentEnv = agent.Env{Home: f.home}
	f.server.Lock()
	f.server.Policy.Installation.EnabledAgents = nil
	f.server.Policy.Mappings = []policy.Mapping{richMappingOf(f)}
	f.server.Policy.RichCapture = offerFor(map[string]time.Time{richMapping: richGrantedAt})
	f.server.Unlock()
	f.forcePolicyRefresh(t)

	const id = "01a11e77-495e-7096-9830-f863d293518b"
	began := richGrantedAt.Add(-time.Hour)
	file := filepath.Join(f.home, ".pi", "agent", "sessions", "--code-app--", began.Format("2006-01-02T15-04-05-000Z")+"_"+id+".jsonl")
	entry := func(entryID, role, text string, at time.Time) string {
		line, _ := json.Marshal(map[string]any{"type": "message", "id": entryID, "parentId": nil, "timestamp": at.Format(time.RFC3339Nano),
			"message": map[string]any{"role": role, "content": []any{map[string]any{"type": "text", "text": text}}}})
		return string(line) + "\n"
	}
	header, _ := json.Marshal(map[string]any{"type": "session", "version": 3, "id": id, "timestamp": began.Format(time.RFC3339Nano), "cwd": f.repo})
	appendSession(t, file, string(header)+"\n"+entry("0ld00001", "user", "said before capture", began.Add(time.Second))+entry("0ld00002", "assistant", "answered before capture", began.Add(2*time.Second)))

	// The resume: Pi appends the prompt, then the extension's event arrives.
	resumedAt := f.clock.Add(time.Second)
	appendSession(t, file, entry("n3w00001", "user", "after the resume", resumedAt))
	*f.clock = resumedAt.Add(19 * time.Millisecond)
	payload, _ := json.Marshal(map[string]any{"type": "input", "text": "after the resume", "source": "interactive", "sessionId": id, "cwd": f.repo, "sessionFile": file})
	if err := f.shim.Handle(pi.ID, bytes.NewReader(payload)); err != nil {
		t.Fatal(err)
	}
	// The daemon's first read lands between the prompt and the reply, as it
	// did natively; the reply was captured there, the prompt was not.
	f.tick(t)
	appendSession(t, file, entry("n3w00002", "assistant", "resumed reply", resumedAt.Add(2*time.Second)))
	f.tickUntilSettled(t)

	key := func(entryID string) string { return agent.ContentKey(pi.ID, id, entryID, "text:0") }
	declared := map[string]bool{}
	for _, declaration := range f.server.Declarations() {
		declared[declaration["content_key"].(string)] = true
	}
	var missing, leaked []string
	for _, entryID := range []string{"n3w00001", "n3w00002"} {
		if !declared[key(entryID)] {
			missing = append(missing, entryID)
		}
	}
	for _, entryID := range []string{"0ld00001", "0ld00002"} {
		if declared[key(entryID)] {
			leaked = append(leaked, entryID)
		}
	}
	sort.Strings(missing)
	if len(missing) > 0 || len(leaked) > 0 {
		t.Fatalf("resumed activity missing %v; pre-admission activity declared %v (%s)", missing, leaked, strings.Join(keysOf(declared), ","))
	}
}

func keysOf(set map[string]bool) []string {
	var keys []string
	for key := range set {
		keys = append(keys, fmt.Sprint(key[:8]))
	}
	sort.Strings(keys)
	return keys
}
