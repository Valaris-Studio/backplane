// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package state

import (
	"context"
	"sort"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// DeletedHistoryRetention is how long the device remembers a deletion after
// the server last reported it. Forgetting is safe: the server keeps
// dropping what was observed by the cutoff, the device just uploads it.
const DeletedHistoryRetention = 30 * 24 * time.Hour

const maxDeletedHistories = 1024

// Why a session's earlier history is gone: the owner deleted it, retention
// removed it, or the server did not say (it predates reasons).
const (
	ReasonOwner     = "owner"
	ReasonRetention = "retention"
	ReasonUnknown   = "unknown"
)

// DeletedHistories lists native sessions whose history was deleted on the
// server through a cutoff: captures observed by then are dropped locally
// instead of uploaded, later ones are captured as usual.
type DeletedHistories struct {
	Sessions []DeletedHistory `json:"sessions"`
}

type DeletedHistory struct {
	// The mapping, and so the workspace, the deletion applies to. Empty in
	// entries from the previous release, which hold for every mapping.
	MappingID       string `json:"mapping_id,omitempty"`
	Harness         string `json:"harness"`
	NativeSessionID string `json:"native_session_id"`
	Reason          string `json:"reason,omitempty"`
	// On this device's clock, as the server worked it out.
	DeletedThrough time.Time `json:"deleted_through"`
	Until          time.Time `json:"until"`
}

// cutoff reads an entry the previous release wrote, with no cutoff, as
// deleted through when it was written: on this device's clock and after the
// deletion, so nothing observed before the deletion passes it.
func (h DeletedHistory) cutoff() time.Time {
	if h.DeletedThrough.IsZero() {
		return h.Until.Add(-DeletedHistoryRetention)
	}
	return h.DeletedThrough
}

func RecordDeletedHistory(ctx context.Context, layout store.Layout, sessions []DeletedHistory, now time.Time) error {
	until := now.Add(DeletedHistoryRetention).UTC()
	return Update(ctx, layout, layout.Suppressions(), func(histories *DeletedHistories) bool {
		kept := histories.Sessions[:0]
		for _, history := range histories.Sessions {
			if history.Until.After(now) {
				kept = append(kept, history)
			}
		}
		for _, session := range sessions {
			session.DeletedThrough, session.Until = session.DeletedThrough.UTC(), until
			if index := deletedHistoryIndex(kept, session.MappingID, session.Harness, session.NativeSessionID); index >= 0 {
				// A cutoff only ever moves on, keeping the reason of the
				// deletion that set it: an older report never reopens what
				// a later deletion closed.
				if known := kept[index]; known.cutoff().After(session.DeletedThrough) {
					session.DeletedThrough, session.Reason = known.cutoff(), known.Reason
				}
				kept[index] = session
			} else {
				kept = append(kept, session)
			}
		}
		// Past the bound, the entries closest to expiring go first.
		sort.SliceStable(kept, func(i, j int) bool { return kept[i].Until.After(kept[j].Until) })
		if len(kept) > maxDeletedHistories {
			kept = kept[:maxDeletedHistories]
		}
		histories.Sessions = kept
		return true
	})
}

// DeletedThrough reports the deleted history of a session captured under
// mappingID, with the cutoff and reason filled in for entries that predate
// them. Where several entries apply, the latest cutoff wins.
func DeletedThrough(layout store.Layout, mappingID, harness, nativeSessionID string, now time.Time) (DeletedHistory, bool) {
	histories, err := Load[DeletedHistories](layout.Suppressions())
	if err != nil {
		return DeletedHistory{}, false
	}
	var found DeletedHistory
	deleted := false
	for _, history := range histories.Sessions {
		if history.Harness != harness || history.NativeSessionID != nativeSessionID || !history.Until.After(now) {
			continue
		}
		if history.MappingID != "" && history.MappingID != mappingID {
			continue
		}
		history.DeletedThrough = history.cutoff()
		if history.Reason == "" {
			history.Reason = ReasonUnknown
		}
		if !deleted || history.DeletedThrough.After(found.DeletedThrough) {
			found, deleted = history, true
		}
	}
	return found, deleted
}

func deletedHistoryIndex(sessions []DeletedHistory, mappingID, harness, nativeSessionID string) int {
	for index, session := range sessions {
		if session.MappingID == mappingID && session.Harness == harness && session.NativeSessionID == nativeSessionID {
			return index
		}
	}
	return -1
}
