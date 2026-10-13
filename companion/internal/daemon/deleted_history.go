// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"encoding/json"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

// noteDeletedHistory remembers the cutoff of each session whose history was
// deleted, per mapping, so captures observed by then are no longer
// uploaded, and tells the session's row. A server that predates cutoffs
// only drops; the moment the device learns of that drop stands in for the
// cutoff, and nobody is named as having deleted it.
func (d *Daemon) noteDeletedHistory(ctx context.Context, batch queue.Batch, ack uplink.Ack) {
	now := d.config.Now()
	histories := map[string]state.DeletedHistory{}
	for _, reported := range ack.HistoryDeleted {
		histories[deletedHistoryKey(reported.MappingID, reported.Harness, reported.NativeSessionID)] = state.DeletedHistory{
			MappingID: reported.MappingID, Harness: reported.Harness, NativeSessionID: reported.NativeSessionID,
			DeletedThrough: reported.DeletedThrough, Reason: reported.Reason,
		}
	}
	deleted := map[string]bool{}
	for _, drop := range ack.Dropped {
		if drop.Reason == "session_deleted" {
			deleted[drop.CaptureID] = true
		}
	}
	for index, raw := range batch.Records {
		var record struct {
			MappingID       string `json:"mapping_id"`
			Harness         string `json:"harness"`
			NativeSessionID string `json:"native_session_id"`
		}
		if !deleted[batch.IDs[index]] || json.Unmarshal(raw, &record) != nil || record.NativeSessionID == "" {
			continue
		}
		key := deletedHistoryKey(record.MappingID, record.Harness, record.NativeSessionID)
		if _, reported := histories[key]; !reported {
			histories[key] = state.DeletedHistory{
				MappingID: record.MappingID, Harness: record.Harness, NativeSessionID: record.NativeSessionID,
				DeletedThrough: now, Reason: state.ReasonUnknown,
			}
		}
	}
	if len(histories) == 0 {
		return
	}
	sessions := make([]state.DeletedHistory, 0, len(histories))
	for _, history := range histories {
		sessions = append(sessions, history)
	}
	state.RecordDeletedHistory(ctx, d.config.Layout, sessions, now)
	for _, history := range sessions {
		if recorded, deleted := state.DeletedThrough(d.config.Layout, history.MappingID, history.Harness, history.NativeSessionID, now); deleted {
			d.sessions.noteHistoryDeleted(history.Harness, history.NativeSessionID, recorded.DeletedThrough, recorded.Reason)
		}
	}
}

func deletedHistoryKey(mappingID, harness, nativeSessionID string) string {
	return mappingID + "\x00" + sessionKey(harness, nativeSessionID)
}

// eventsObservedAfter keeps the events observed after a deleted history's
// cutoff. An event without a readable timestamp is as old as the capture
// that carries it.
func eventsObservedAfter(lines []json.RawMessage, through, capturedAt time.Time) []json.RawMessage {
	kept := make([]json.RawMessage, 0, len(lines))
	for _, line := range lines {
		if eventTime(line, capturedAt).After(through) {
			kept = append(kept, line)
		}
	}
	return kept
}

func eventTime(line json.RawMessage, fallback time.Time) time.Time {
	var event struct {
		Timestamp time.Time `json:"timestamp"`
	}
	if json.Unmarshal(line, &event) != nil || event.Timestamp.IsZero() {
		return fallback
	}
	return event.Timestamp
}
