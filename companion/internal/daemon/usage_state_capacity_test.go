// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/claudecode"
	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
)

// A usage state the daemon could not load back would read the session from
// its start again, silently. Its read is not taken: the session keeps the
// state it had, nothing of the read is queued, and the capacity shows.
func TestAUsageStateTooLargeToLoadBackKeepsThePreviousState(t *testing.T) {
	for _, polled := range []bool{false, true} {
		t.Run(fmt.Sprintf("polled=%t", polled), func(t *testing.T) {
			adapter := &capacityUsageAgent{polled: polled}
			f := newFixture(t, adapter)
			path := filepath.Join(f.home, "SECRET_TRANSCRIPT.jsonl")
			if err := os.WriteFile(path, []byte(claudeRequest(t, f.stamp(), "msg_one", "req_one", 5, "SECRET_BODY")), 0o600); err != nil {
				t.Fatal(err)
			}
			*f.clock = f.clock.Add(time.Minute)
			read, err := claudecode.New().ReadUsage(agent.UsageRead{Transcript: path, SessionID: "sess-1", Event: "SessionEnd", Now: *f.clock}, nil)
			if err != nil || len(read.Events) != 1 {
				t.Fatalf("usage setup: %v, %v", read, err)
			}
			oversized, err := json.Marshal(map[string]string{"padding": strings.Repeat("x", maxUsageCursorBytes)})
			if err != nil {
				t.Fatal(err)
			}
			adapter.result = agent.UsageResult{Events: read.Events, Cursor: oversized}
			statePath := f.daemon.usageCursorPath(adapter.ID(), "sess-1")
			previous := usageState{FirstSeen: now, Source: usageFromTranscript, Cursor: json.RawMessage(`{"files":{"SECRET_TRANSCRIPT":{"offset":1}}}`)}
			if err := saveUsageState(f.layout, statePath, previous); err != nil {
				t.Fatal(err)
			}
			if polled {
				err = f.daemon.pollTranscript(context.Background(), "sess-1", state.Thread{Agent: adapter.ID(), Cwd: f.repo, Transcript: path, FirstSeen: now, SeenAt: *f.clock})
			} else {
				err = f.daemon.drainUsage(context.Background(), adapter, inbox.Item{Observation: agent.Observation{NativeSessionID: "sess-1", Cwd: f.repo, Event: "Stop"}, UsageTranscript: path, ReceivedAt: *f.clock})
			}
			if err != nil {
				t.Fatal(err)
			}
			if stored := loadUsageState(statePath); !bytes.Equal(stored.Cursor, previous.Cursor) {
				t.Fatalf("a usage state that cannot load back replaced the session's state: %d bytes", len(stored.Cursor))
			}
			if polled {
				if _, complete := f.daemon.rolloutMarks["sess-1\x00"+path]; complete {
					t.Error("a transcript whose read was not taken was marked as completely read")
				}
			}
			f.tick(t)
			if outputs := outputsOf(f.server.Records()); len(outputs) != 0 {
				t.Fatalf("usage of a read whose state was not saved was queued: %v", outputs)
			}
			data, err := os.ReadFile(f.layout.Health())
			if err != nil {
				t.Fatal(err)
			}
			var health struct {
				Capacity uint64 `json:"usage_capacity_limited_files"`
				Dropped  uint64 `json:"dropped_items"`
			}
			if err := json.Unmarshal(data, &health); err != nil {
				t.Fatal(err)
			}
			if health.Capacity != 1 || health.Dropped != 0 {
				t.Errorf("the refused state must show as capacity, not dropped: %+v", health)
			}
			for _, private := range []string{path, "SECRET_TRANSCRIPT", "SECRET_BODY"} {
				if strings.Contains(string(data), private) {
					t.Errorf("usage health copied private source detail %q", private)
				}
			}
		})
	}
}
