// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/collector"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// Telemetry adds Source to an existing opaque cursor before queueing usage.
// Its durable ownership must fit the same loader as a transcript's claim.
func TestTelemetryCannotClaimUsageWithAnUnloadableState(t *testing.T) {
	for _, check := range []struct {
		name         string
		claimedBytes int
		accepted     bool
	}{
		{"ordinary state", 1024, true},
		{"exact loader limit", maxUsageCursorBytes, true},
		{"claim exceeds loader limit", maxUsageCursorBytes + 1, false},
	} {
		t.Run(check.name, func(t *testing.T) {
			f := codexFixture(t)
			f.thread(t, "thread-root", f.repo)
			previous := usageState{
				FirstSeen: now,
				Cursor:    json.RawMessage(`{"PRIVATE_CURSOR_BODY":""}`),
				Source:    usageFromTelemetry,
			}
			minimum, err := json.Marshal(previous)
			if err != nil {
				t.Fatal(err)
			}
			previous.Cursor = json.RawMessage(`{"PRIVATE_CURSOR_BODY":"` + strings.Repeat("x", check.claimedBytes-len(minimum)) + `"}`)
			proposed, err := json.Marshal(previous)
			if err != nil || len(proposed) != check.claimedBytes {
				t.Fatalf("claim boundary setup: bytes=%d err=%v", len(proposed), err)
			}
			previous.Source = ""
			path := f.daemon.usageCursorPath("codex_cli", "thread-root")
			if err := saveUsageState(f.layout, path, previous); err != nil {
				t.Fatal(err)
			}
			before, err := store.ReadPrivateFile(path, maxUsageCursorBytes)
			if err != nil {
				t.Fatalf("prior state must be safely readable: %v", err)
			}
			loaded := loadUsageState(path)
			if loaded.Source != "" || !loaded.FirstSeen.Equal(previous.FirstSeen) || !bytes.Equal(loaded.Cursor, previous.Cursor) {
				t.Fatal("prior state did not load through the production usage loader")
			}

			line := []byte(traceUsage("thread-root", "codex_cli", "capacity-probe", 5))
			err = f.daemon.processOTelEvent(context.Background(), line, collector.Position{Signature: "capacity-probe", Offset: 0})
			if err != nil && (check.accepted || !errors.Is(err, errStopDrain)) {
				t.Fatalf("telemetry claim returned an unexpected error: %v", err)
			}
			after, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			stored := loadUsageState(path)
			_, loadErr := store.ReadPrivateFile(path, maxUsageCursorBytes)
			queued := f.queueCount(t)
			health, err := state.Load[state.Health](f.layout.Health())
			if err != nil {
				t.Fatalf("health must load through its bounded production decoder: %v", err)
			}
			t.Logf("prior=%d proposed=%d stored=%d loadable=%t source=%q cursorBytes=%d queued=%d capacity=%d",
				len(before), len(proposed), len(after), loadErr == nil, stored.Source, len(stored.Cursor), queued, health.UsageCapacityLimitedFiles)
			if loadErr != nil || !stored.FirstSeen.Equal(previous.FirstSeen) || !bytes.Equal(stored.Cursor, previous.Cursor) {
				t.Errorf("telemetry replaced a loadable cursor with state the production loader cannot restore: loadErr=%v", loadErr)
			}
			if check.accepted {
				if stored.Source != usageFromTelemetry || queued != 1 || health.UsageCapacityLimitedFiles != 0 {
					t.Errorf("loadable telemetry claim must own and enqueue once without capacity signal: source=%q queued=%d capacity=%d", stored.Source, queued, health.UsageCapacityLimitedFiles)
				}
			} else {
				if !bytes.Equal(before, after) || stored.Source != "" {
					t.Error("refused telemetry ownership must leave the previous durable state byte-for-byte unchanged")
				}
				if queued != 0 {
					t.Errorf("usage without a persistable ownership claim was enqueued: %d", queued)
				}
				if health.UsageCapacityLimitedFiles != 1 || health.DroppedItems != 0 {
					t.Errorf("refused telemetry ownership needs the existing bounded capacity signal, not dropped usage: capacity=%d dropped=%d", health.UsageCapacityLimitedFiles, health.DroppedItems)
				}
			}
			healthBytes, err := os.ReadFile(f.layout.Health())
			if err != nil {
				t.Fatal(err)
			}
			for _, private := range []string{path, "PRIVATE_CURSOR_BODY"} {
				if bytes.Contains(healthBytes, []byte(private)) {
					t.Errorf("capacity health copied private source detail %q", private)
				}
			}
		})
	}
}
