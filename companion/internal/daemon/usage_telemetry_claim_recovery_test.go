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
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/collector"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
)

func TestTelemetryCapacityLeavesItsCollectorPositionRetryable(t *testing.T) {
	f := codexFixture(t)
	f.thread(t, "thread-root", f.repo)
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
	if loaded := loadUsageState(usagePath); !bytes.Equal(loaded.Cursor, previous.Cursor) || !loaded.FirstSeen.Equal(previous.FirstSeen) {
		t.Fatal("prior usage state must load before the telemetry claim")
	}
	before, err := os.ReadFile(usagePath)
	if err != nil {
		t.Fatal(err)
	}
	line := traceUsage("thread-root", "codex_cli", "capacity-recovery", 5)
	f.appendRuntime(t, line)
	tailPath := filepath.Join(f.layout.OTelDir(), "tail.json")
	tailer := collector.NewTailer(collector.RuntimePath(f.layout.OTelDir()), tailPath)
	ctx := context.Background()
	// Use the real collector consumer seam to observe the sentinel that
	// drainOTel deliberately converts into a successful deferred pass.
	err = tailer.Next(func(line []byte, position collector.Position) error {
		return f.daemon.processOTelEvent(ctx, line, position)
	})
	if !errors.Is(err, errStopDrain) {
		t.Errorf("capacity refusal must return the existing retryable stop, got %v", err)
	}
	position, err := state.Load[collector.Position](tailPath)
	if err != nil {
		t.Fatal(err)
	}
	backlog, err := tailer.Backlog()
	if err != nil {
		t.Fatal(err)
	}
	queued := f.queueCount(t)
	t.Logf("refused position=%d backlog=%d eventBytes=%d queued=%d", position.Offset, backlog, len(line), queued)
	if position.Signature == "" || position.Offset != 0 || backlog != int64(len(line)) || queued != 0 {
		t.Error("refused ownership advanced past the event or queued it before a durable claim")
	}
	after, err := os.ReadFile(usagePath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Error("capacity refusal changed the previous usage state")
	}
	health, err := state.Load[state.Health](f.layout.Health())
	if err != nil {
		t.Fatal(err)
	}
	if health.UsageCapacityLimitedFiles != 1 || health.DroppedItems != 0 {
		t.Errorf("refused event needs capacity=1 and dropped=0: capacity=%d dropped=%d", health.UsageCapacityLimitedFiles, health.DroppedItems)
	}

	// Model only the capacity condition clearing; the collector event and
	// its position are never recreated or reset to make recovery succeed.
	previous.Cursor = json.RawMessage(`{"offset":1234}`)
	if err := saveUsageState(f.layout, usagePath, previous); err != nil {
		t.Fatal(err)
	}
	if err := f.daemon.drainOTel(ctx); err != nil {
		t.Fatal(err)
	}
	stored := loadUsageState(usagePath)
	if stored.Source != usageFromTelemetry || !stored.FirstSeen.Equal(previous.FirstSeen) || !bytes.Equal(stored.Cursor, previous.Cursor) {
		t.Errorf("retained event did not recover with loadable telemetry ownership: source=%q cursor=%s", stored.Source, stored.Cursor)
	}
	recovered, err := state.Load[collector.Position](tailPath)
	if err != nil {
		t.Fatal(err)
	}
	backlog, err = collector.NewTailer(collector.RuntimePath(f.layout.OTelDir()), tailPath).Backlog()
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Signature != position.Signature || recovered.Offset != int64(len(line)) || backlog != 0 || f.queueCount(t) != 1 {
		t.Errorf("same retained event must queue once and advance exactly its bytes: offset=%d backlog=%d queued=%d", recovered.Offset, backlog, f.queueCount(t))
	}
	for _, record := range readQueue(t, f) {
		if record.NativeSessionID != "thread-root" || record.Harness != "codex_cli" || len(record.Events) != 1 {
			t.Fatalf("recovery queued an unrelated record: session=%q harness=%q events=%d", record.NativeSessionID, record.Harness, len(record.Events))
		}
		var event struct {
			Event struct{ ID string } `json:"event"`
			GenAI struct {
				Usage struct {
					OutputTokens int `json:"output_tokens"`
				} `json:"usage"`
			} `json:"gen_ai"`
		}
		if err := json.Unmarshal(record.Events[0], &event); err != nil || event.Event.ID != "span-capacity-recovery" || event.GenAI.Usage.OutputTokens != 5 {
			t.Fatalf("recovery changed the retained event: id=%q output=%d err=%v", event.Event.ID, event.GenAI.Usage.OutputTokens, err)
		}
	}
	if err := f.daemon.drainOTel(ctx); err != nil {
		t.Fatal(err)
	}
	health, err = state.Load[state.Health](f.layout.Health())
	if err != nil {
		t.Fatal(err)
	}
	if f.queueCount(t) != 1 || health.UsageCapacityLimitedFiles != 1 || health.DroppedItems != 0 {
		t.Errorf("successful recovery must not duplicate usage or capacity: queued=%d capacity=%d dropped=%d", f.queueCount(t), health.UsageCapacityLimitedFiles, health.DroppedItems)
	}
}
