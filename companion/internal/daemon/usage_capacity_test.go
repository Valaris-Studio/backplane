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

type capacityUsageAgent struct {
	claudecode.ClaudeCode
	result agent.UsageResult
	polled bool
	reads  int
}

func (a *capacityUsageAgent) Ingress() agent.Ingress {
	if a.polled {
		return agent.IngressOTLP
	}
	return agent.IngressHook
}

func (a *capacityUsageAgent) ReadUsage(agent.UsageRead, json.RawMessage) (agent.UsageResult, error) {
	a.reads++
	return a.result, nil
}

// One transcript can hit the reader's retained-state capacity while another
// succeeds. Both daemon ingress paths must preserve that success and expose
// the distinct capacity outcome without copying private source details.
func TestUsageCapacityIsVisibleWithoutDiscardingHealthyResults(t *testing.T) {
	for _, polled := range []bool{false, true} {
		for _, counts := range []struct {
			name               string
			capacity, deferred int
		}{
			{"capacity", 2, 0},
			{"capacity and deferred", 2, 3},
			{"deferred control", 0, 3},
		} {
			t.Run(fmt.Sprintf("polled=%t/%s", polled, counts.name), func(t *testing.T) {
				adapter := &capacityUsageAgent{polled: polled}
				f := newFixture(t, adapter)
				path := filepath.Join(f.home, "SECRET_TRANSCRIPT.jsonl")
				if err := os.WriteFile(path, []byte(claudeRequest(t, f.stamp(), "msg_healthy", "req_healthy", 5, "SECRET_BODY")), 0o600); err != nil {
					t.Fatal(err)
				}
				*f.clock = f.clock.Add(time.Minute)
				healthy, err := claudecode.New().ReadUsage(agent.UsageRead{Transcript: path, SessionID: "sess-1", Event: "SessionEnd", Now: *f.clock}, nil)
				if err != nil || len(healthy.Events) != 1 {
					t.Fatalf("healthy usage setup: %v, %v", healthy, err)
				}
				// Inject through the wire shape so the pre-field implementation
				// compiles and fails on observable daemon behavior.
				next := json.RawMessage(`{"files":{"SECRET_TRANSCRIPT":{"offset":1},"healthy":{"offset":9}}}`)
				encoded, err := json.Marshal(map[string]any{
					"Events": healthy.Events, "Cursor": next,
					"CapacityLimitedFiles": counts.capacity, "DeferredFiles": counts.deferred,
				})
				if err != nil {
					t.Fatal(err)
				}
				if err := json.Unmarshal(encoded, &adapter.result); err != nil {
					t.Fatal(err)
				}
				statePath := f.daemon.usageCursorPath(adapter.ID(), "sess-1")
				previous := usageState{FirstSeen: now, Source: usageFromTranscript, Cursor: json.RawMessage(`{"files":{"SECRET_TRANSCRIPT":{"offset":1},"healthy":{"offset":0}}}`)}
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
				if adapter.reads != 1 {
					t.Fatalf("expected one usage read, got %d", adapter.reads)
				}
				if stored := loadUsageState(statePath); !bytes.Equal(stored.Cursor, next) || stored.Source != previous.Source || !stored.FirstSeen.Equal(previous.FirstSeen) {
					t.Fatalf("healthy progress or session ownership was discarded: %+v", stored)
				}
				if polled && counts.capacity > 0 {
					if _, complete := f.daemon.rolloutMarks["sess-1\x00"+path]; complete {
						t.Error("capacity-limited transcript was marked as completely read")
					}
				}
				f.tick(t)
				if outputs := outputsOf(f.server.Records()); fmt.Sprint(outputs) != "[5]" {
					t.Fatalf("healthy usage was lost or repeated: %v", outputs)
				}
				data, err := os.ReadFile(f.layout.Health())
				if err != nil {
					t.Fatal(err)
				}
				var health struct {
					Capacity uint64 `json:"usage_capacity_limited_files"`
					Deferred uint64 `json:"usage_deferred_files"`
					Dropped  uint64 `json:"dropped_items"`
				}
				if err := json.Unmarshal(data, &health); err != nil {
					t.Fatal(err)
				}
				if health.Capacity != uint64(counts.capacity) || health.Deferred != uint64(counts.deferred) || health.Dropped != 0 {
					t.Errorf("capacity must remain visible and distinct from deferred or dropped usage: got %+v, want capacity=%d deferred=%d dropped=0", health, counts.capacity, counts.deferred)
				}
				for _, private := range []string{path, "SECRET_TRANSCRIPT", "SECRET_BODY"} {
					if strings.Contains(string(data), private) {
						t.Errorf("usage health copied private source detail %q", private)
					}
				}
			})
		}
	}
}
