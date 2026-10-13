// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/collector"
	"github.com/Valaris-Studio/backplane/companion/internal/otlpgate"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
)

func TestTelemetryCapacityRefusalHonorsCancellation(t *testing.T) {
	for _, cancelAtDelivery := range []bool{false, true} {
		name := "uncontended capacity refusal"
		if cancelAtDelivery {
			name = "canceled with state lock held"
		}
		t.Run(name, func(t *testing.T) {
			f := codexFixture(t)
			f.thread(t, "thread-root", f.repo)
			// Resolve through the real policy path before taking the shared
			// state lock, so the contested operation is the refusal's health write.
			if decision := f.daemon.Resolve(context.Background(), "thread-root", "codex_cli"); decision.Verdict != otlpgate.Forward {
				t.Fatal("synthetic telemetry must be authorized before the claim")
			}
			previous := usageState{FirstSeen: now, Source: usageFromTelemetry, Cursor: json.RawMessage(`{"padding":""}`)}
			minimum, err := json.Marshal(previous)
			if err != nil {
				t.Fatal(err)
			}
			previous.Cursor = json.RawMessage(`{"padding":"` + strings.Repeat("x", maxUsageCursorBytes+1-len(minimum)) + `"}`)
			previous.Source = ""
			usagePath := f.daemon.usageCursorPath("codex_cli", "thread-root")
			if err := saveUsageState(f.layout, usagePath, previous); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(usagePath)
			if err != nil {
				t.Fatal(err)
			}
			if loaded := loadUsageState(usagePath); !bytes.Equal(loaded.Cursor, previous.Cursor) || loaded.Source != "" {
				t.Fatal("existing unclaimed usage state must be loadable")
			}
			line := traceUsage("thread-root", "codex_cli", "capacity-cancellation", 5)
			f.appendRuntime(t, line)
			tailPath := filepath.Join(f.layout.OTelDir(), "tail.json")
			tailer := collector.NewTailer(collector.RuntimePath(f.layout.OTelDir()), tailPath)

			release := func() {}
			if cancelAtDelivery {
				held, unblock, holderDone := make(chan struct{}), make(chan struct{}), make(chan error, 1)
				go func() {
					holderDone <- state.Update(context.Background(), f.layout, f.layout.Health(), func(*state.Health) bool {
						close(held)
						<-unblock
						return false
					})
				}()
				var once sync.Once
				release = func() { once.Do(func() { close(unblock) }) }
				t.Cleanup(release)
				select {
				case <-held:
				case err := <-holderDone:
					t.Fatalf("state writer failed before obtaining the lock: %v", err)
				case <-time.After(2 * time.Second):
					t.Fatal("state writer did not obtain the uncontended lock")
				}
				t.Cleanup(func() {
					release()
					if err := <-holderDone; err != nil {
						t.Errorf("state lock holder: %v", err)
					}
				})
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() {
				done <- tailer.Next(func(line []byte, position collector.Position) error {
					if cancelAtDelivery {
						cancel()
					}
					return f.daemon.processOTelEvent(ctx, line, position)
				})
			}()
			returnedWhileHeld := true
			select {
			case err = <-done:
			case <-time.After(2 * time.Second):
				returnedWhileHeld = false
				t.Error("canceled telemetry remained blocked until the state lock was released")
				release()
				select {
				case err = <-done:
				case <-time.After(2 * time.Second):
					t.Fatal("telemetry did not finish after releasing the state lock")
				}
			}
			if !errors.Is(err, errStopDrain) && !(cancelAtDelivery && errors.Is(err, context.Canceled)) {
				t.Errorf("refused event must remain retryable, got %v", err)
			}
			after, err := os.ReadFile(usagePath)
			if err != nil || !bytes.Equal(before, after) {
				t.Fatalf("capacity refusal changed durable usage: %v", err)
			}
			position, err := state.Load[collector.Position](tailPath)
			if err != nil {
				t.Fatal(err)
			}
			backlog, err := tailer.Backlog()
			if err != nil {
				t.Fatal(err)
			}
			if position.Signature == "" || position.Offset != 0 || backlog != int64(len(line)) || f.queueCount(t) != 0 {
				t.Errorf("refused event was consumed: offset=%d backlog=%d queued=%d", position.Offset, backlog, f.queueCount(t))
			}
			health, err := state.Load[state.Health](f.layout.Health())
			if err != nil {
				t.Fatal(err)
			}
			wantCapacity := uint64(1)
			if cancelAtDelivery {
				wantCapacity = 0
			}
			if health.UsageCapacityLimitedFiles != wantCapacity || health.DroppedItems != 0 {
				t.Errorf("canceled health write must be skipped; ordinary refusal still counts: capacity=%d want=%d dropped=%d", health.UsageCapacityLimitedFiles, wantCapacity, health.DroppedItems)
			}
			t.Logf("canceled=%t returned_before_unlock=%t offset=%d backlog=%d queued=%d capacity=%d", cancelAtDelivery, returnedWhileHeld, position.Offset, backlog, f.queueCount(t), health.UsageCapacityLimitedFiles)
			release()
		})
	}
}
