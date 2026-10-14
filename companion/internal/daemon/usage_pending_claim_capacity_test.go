// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/agent/claudecode"
	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
)

// A queue-full stop leaves the claim with the previous cursor on disk.
// That intermediate state must load back even when the final cursor shrinks.
func TestAQueueStopCannotLeaveAnUnloadableTranscriptClaim(t *testing.T) {
	for _, claimFits := range []bool{true, false} {
		t.Run(fmt.Sprintf("previous cursor fits claim=%t", claimFits), func(t *testing.T) {
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
			previous := usageState{FirstSeen: now, Cursor: json.RawMessage(`{"padding":""}`)}
			if claimFits {
				previous.Source = usageFromTranscript
			}
			minimum, err := json.Marshal(previous)
			if err != nil {
				t.Fatal(err)
			}
			previous.Cursor = json.RawMessage(`{"padding":"` + strings.Repeat("x", maxUsageCursorBytes-len(minimum)) + `"}`)
			previous.Source = ""
			statePath := f.daemon.usageCursorPath(adapter.ID(), "sess-1")
			if err := saveUsageState(f.layout, statePath, previous); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(statePath)
			if err != nil {
				t.Fatal(err)
			}
			adapter.result = agent.UsageResult{Cursor: json.RawMessage(`{"offset":9}`), Events: read.Events}
			f.daemon.queue = queue.Open(f.layout).WithClock(f.daemon.config.Now).WithMaxRecords(0)
			err = f.daemon.pollTranscript(context.Background(), "sess-1", state.Thread{Agent: adapter.ID(), Cwd: f.repo, Transcript: path, FirstSeen: now, SeenAt: *f.clock})
			stored := loadUsageState(statePath)
			if claimFits {
				if !errors.Is(err, errStopDrain) || stored.Source != usageFromTranscript || !bytes.Equal(stored.Cursor, previous.Cursor) || !stored.FirstSeen.Equal(previous.FirstSeen) {
					t.Errorf("queue-full control must retain a loadable claim and previous cursor: err=%v source=%q cursorBytes=%d", err, stored.Source, len(stored.Cursor))
				}
			} else {
				if err != nil {
					t.Errorf("capacity must stop before attempting to enqueue: %v", err)
				}
				after, err := os.ReadFile(statePath)
				if err != nil {
					t.Fatal(err)
				}
				if !bytes.Equal(before, after) {
					t.Errorf("queue stop replaced the previous state with an unloadable %d-byte claim", len(after))
				}
			}
			if _, complete := f.daemon.rolloutMarks["sess-1\x00"+path]; complete {
				t.Error("a read stopped before queueing was marked complete")
			}
			f.tick(t)
			if outputs := outputsOf(f.server.Records()); len(outputs) != 0 {
				t.Errorf("queue-full usage was uploaded: %v", outputs)
			}
			health, err := state.Load[struct {
				Capacity uint64 `json:"usage_capacity_limited_files"`
			}](f.layout.Health())
			if err != nil {
				t.Fatal(err)
			}
			wantCapacity := uint64(1)
			if claimFits {
				wantCapacity = 0
			}
			if health.Capacity != wantCapacity {
				t.Errorf("capacity must describe only the unpersistable claim: got %v, want %v", health.Capacity, wantCapacity)
			}
		})
	}
}
