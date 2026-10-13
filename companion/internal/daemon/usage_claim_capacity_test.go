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
	"github.com/Valaris-Studio/backplane/companion/internal/state"
)

// The first transcript delivery claims the session before it queues usage.
// That added source field must fit the loader limit together with its cursor.
func TestAFirstTranscriptClaimFitsTogetherWithItsUsageCursor(t *testing.T) {
	base := usageState{FirstSeen: now, Cursor: json.RawMessage(`{"padding":""}`)}
	unclaimed, _ := json.Marshal(base)
	base.Source = usageFromTranscript
	claimed, _ := json.Marshal(base)
	claimOverhead := len(claimed) - len(unclaimed)
	for _, extra := range []int{0, claimOverhead} {
		t.Run(fmt.Sprintf("final state bytes above limit=%d", extra), func(t *testing.T) {
			adapter := &capacityUsageAgent{polled: true}
			f := newFixture(t, adapter)
			path := filepath.Join(f.home, "transcript.jsonl")
			if err := os.WriteFile(path, []byte(claudeRequest(t, f.stamp(), "msg_one", "req_one", 5, "body")), 0o600); err != nil {
				t.Fatal(err)
			}
			*f.clock = f.clock.Add(time.Minute)
			read, err := claudecode.New().ReadUsage(agent.UsageRead{Transcript: path, SessionID: "sess-1", Event: "SessionEnd", Now: *f.clock}, nil)
			if err != nil || len(read.Events) != 1 {
				t.Fatalf("usage setup: %v, %v", read, err)
			}
			statePath := f.daemon.usageCursorPath(adapter.ID(), "sess-1")
			previous := usageState{FirstSeen: now, Cursor: json.RawMessage(`{"offset":1}`)}
			if err := saveUsageState(f.layout, statePath, previous); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(statePath)
			if err != nil {
				t.Fatal(err)
			}
			proposed := usageState{FirstSeen: now, Source: usageFromTranscript, Cursor: json.RawMessage(`{"padding":""}`)}
			minimum, err := json.Marshal(proposed)
			if err != nil {
				t.Fatal(err)
			}
			proposed.Cursor = json.RawMessage(`{"padding":"` + strings.Repeat("x", maxUsageCursorBytes+extra-len(minimum)) + `"}`)
			encoded, err := json.Marshal(proposed)
			if err != nil || len(encoded) != maxUsageCursorBytes+extra {
				t.Fatalf("boundary setup: %d bytes, %v", len(encoded), err)
			}
			adapter.result = agent.UsageResult{Cursor: proposed.Cursor, Events: read.Events}
			if err := f.daemon.pollTranscript(context.Background(), "sess-1", state.Thread{Agent: adapter.ID(), Cwd: f.repo, Transcript: path, FirstSeen: now, SeenAt: *f.clock}); err != nil {
				t.Fatal(err)
			}
			stored := loadUsageState(statePath)
			if extra == 0 {
				if stored.Source != usageFromTranscript || !bytes.Equal(stored.Cursor, proposed.Cursor) {
					t.Error("an exactly loadable claimed state did not survive persistence")
				}
			} else {
				after, err := os.ReadFile(statePath)
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(before, after) {
					t.Errorf("claim overhead replaced the previous state with %d bytes that cannot load back", len(after))
				}
				if _, complete := f.daemon.rolloutMarks["sess-1\x00"+path]; complete {
					t.Error("an unpersistable claimed cursor was marked completely read")
				}
			}
			f.tick(t)
			outputs := outputsOf(f.server.Records())
			if extra == 0 && fmt.Sprint(outputs) != "[5]" || extra > 0 && len(outputs) != 0 {
				t.Errorf("usage must match the persistable claimed state: extra=%d outputs=%v", extra, outputs)
			}
			health, err := state.Load[struct {
				Capacity uint64 `json:"usage_capacity_limited_files"`
			}](f.layout.Health())
			if err != nil {
				t.Fatal(err)
			}
			wantCapacity := uint64(0)
			if extra > 0 {
				wantCapacity = 1
			}
			if health.Capacity != wantCapacity {
				t.Errorf("capacity should count only the unpersistable final state: got %v, want %v", health.Capacity, wantCapacity)
			}
		})
	}
}
