// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/scope"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

const (
	// maxUsageEventsPerRecord matches the backend's events-per-record limit.
	maxUsageEventsPerRecord = 256
	maxUsageCursorBytes     = 4 << 20
	// usageCursorRetention forgets the read position of sessions idle this
	// long; re-reading one yields the same event ids, recognized upstream.
	usageCursorRetention = 30 * 24 * time.Hour
	usagePruneInterval   = time.Hour
	// maxSessionsSeen bounds the in-memory note of sessions whose first
	// sighting is already on disk.
	maxSessionsSeen = 4096
)

// drainUsage reads the token usage an agent's transcript recorded since the
// session's previous boundary and queues it beside the hook's own record.
// The read position advances even when the session is no longer in scope,
// so usage from that stretch is never uploaded later.
func (d *Daemon) drainUsage(ctx context.Context, adapter agent.Agent, item inbox.Item) error {
	source, ok := adapter.(agent.UsageSource)
	if !ok || item.UsageTranscript == "" {
		return nil
	}
	decision, err := d.decide(ctx, adapter.ID(), item.Observation.Cwd)
	if err != nil {
		return err
	}
	if !decision.InScope && decision.Reason.Transient() {
		return errStopDrain
	}
	d.pruneUsageCursors()
	statePath := d.usageCursorPath(adapter.ID(), item.Observation.NativeSessionID)
	session := loadUsageState(statePath)
	if session.FirstSeen.IsZero() {
		session.FirstSeen = item.ReceivedAt
	}
	allowed := d.captureAllowedAt(adapter.ID(), decision.MappingID, decision.Cwd)
	result, err := source.ReadUsage(agent.UsageRead{
		Transcript: item.UsageTranscript,
		SessionID:  item.Observation.NativeSessionID,
		Event:      item.Observation.Event,
		Now:        d.config.Now(),
		Until:      item.ReceivedAt,
		// Lines older than the session's first hook were copied in by a fork
		// or resume and counted by the session they came from.
		Allowed: func(at time.Time) bool { return !at.Before(session.FirstSeen) && allowed(at) },
	}, session.Cursor)
	if err != nil {
		d.countDropped()
		return nil
	}
	if !usageStateFits(session, result.Cursor) {
		d.noteUsageRead(ctx, agent.UsageResult{CapacityLimitedFiles: 1})
		return nil
	}
	d.noteUsageRead(ctx, result)
	if decision.InScope {
		usage := observed{
			adapter:     adapter,
			observation: agent.Observation{NativeSessionID: item.Observation.NativeSessionID, Cwd: item.Observation.Cwd, Event: item.Observation.Event},
			receivedAt:  item.ReceivedAt,
		}
		if err := d.enqueueUsage(usage, decision, result.Events); err != nil {
			return err
		}
	}
	session.Cursor = result.Cursor
	return saveUsageState(d.config.Layout, statePath, session)
}

// usageState is the daemon's record of one session: when its first hook
// was observed and the agent's opaque read cursor. A missing or unreadable
// state reads from the start; the stable event ids keep that from counting
// a request twice.
type usageState struct {
	FirstSeen time.Time       `json:"first_seen"`
	Cursor    json.RawMessage `json:"cursor,omitempty"`
	// Source is what counts the session's usage when two could: its
	// telemetry or its transcript. The first to deliver keeps it, so the
	// same responses are never counted twice.
	Source usageSource `json:"source,omitempty"`
}

type usageSource string

const (
	usageFromTelemetry  usageSource = "telemetry"
	usageFromTranscript usageSource = "transcript"
)

// noteUsageRead counts what a usage read left for later, never naming it.
func (d *Daemon) noteUsageRead(ctx context.Context, result agent.UsageResult) {
	if result.DeferredFiles == 0 && result.CapacityLimitedFiles == 0 {
		return
	}
	state.Update(ctx, d.config.Layout, d.config.Layout.Health(), func(health *state.Health) bool {
		health.UsageDeferredFiles += uint64(result.DeferredFiles)
		health.UsageCapacityLimitedFiles += uint64(result.CapacityLimitedFiles)
		return true
	})
}

// usageStateFits reports whether the session saved with cursor loads back:
// a state past maxUsageCursorBytes would load as none and read from the
// start, so it is not saved and the session keeps its previous state.
func usageStateFits(session usageState, cursor json.RawMessage) bool {
	session.Cursor = cursor
	encoded, err := json.Marshal(session)
	return err == nil && len(encoded) <= maxUsageCursorBytes
}

func loadUsageState(path string) usageState {
	var loaded usageState
	if data, err := store.ReadPrivateFile(path, maxUsageCursorBytes); err == nil {
		json.Unmarshal(data, &loaded)
	}
	return loaded
}

func saveUsageState(layout store.Layout, path string, session usageState) error {
	if err := store.EnsurePrivateDir(layout.UsageDir()); err != nil {
		return err
	}
	encoded, err := json.Marshal(session)
	if err != nil {
		return err
	}
	return store.WriteFileAtomic(path, encoded)
}

// noteSessionSeen records when the daemon first observed a session of an
// agent whose usage it reads, which bounds that usage from below.
func (d *Daemon) noteSessionSeen(adapter agent.Agent, item inbox.Item) {
	if _, reads := adapter.(agent.UsageSource); !reads {
		return
	}
	path := d.usageCursorPath(adapter.ID(), item.Observation.NativeSessionID)
	if d.sessionsSeen[path] {
		return
	}
	session := loadUsageState(path)
	if session.FirstSeen.IsZero() {
		session.FirstSeen = item.ReceivedAt
		if saveUsageState(d.config.Layout, path, session) != nil {
			return
		}
	}
	if d.sessionsSeen == nil || len(d.sessionsSeen) >= maxSessionsSeen {
		d.sessionsSeen = map[string]bool{}
	}
	d.sessionsSeen[path] = true
}

// enqueueUsage queues usage events read from a transcript as records of the
// session usage describes, at most maxUsageEventsPerRecord events each.
func (d *Daemon) enqueueUsage(usage observed, decision scope.Decision, events []json.RawMessage) error {
	for start := 0; start < len(events); start += maxUsageEventsPerRecord {
		if err := d.enqueueUsageRecord(usage, decision, events[start:min(start+maxUsageEventsPerRecord, len(events))]); err != nil {
			return err
		}
	}
	return nil
}

func (d *Daemon) enqueueUsageRecord(usage observed, decision scope.Decision, events []json.RawMessage) error {
	leveled := make([]json.RawMessage, 0, len(events))
	content := sha256.New()
	for _, line := range events {
		// Usage events carry only metadata; the level is applied anyway so
		// they take the same path as every other event.
		applied, err := applyEventLevel(line, decision.ContentLevel)
		if err != nil {
			d.countDropped()
			return nil
		}
		leveled = append(leveled, applied)
		content.Write(applied)
		content.Write([]byte{'\n'})
	}
	// Derived from the events themselves: a re-read of the same usage is
	// recognized in the queue, while a later, larger copy of a request is a
	// new capture the backend can upgrade its row with.
	usage.captureID = captureID(usage.adapter.ID(), "usage\x00"+hex.EncodeToString(content.Sum(nil)))
	usage.ingress = agent.IngressPoll
	if known, err := d.queue.Has(usage.captureID); err != nil || known {
		return err
	}
	return d.enqueue(usage, decision.MappingID, decision.Place, decision.ContentLevel, beacon.Result{Events: leveled, SchemaVersion: "1.0"})
}

// claimUsage gives the session's usage to source unless the other source
// already delivers it, and reports whether source may count it. A claim the
// usage state could not load back with is not made: it stops the drain, so
// the event waits, and counts as capacity.
func (d *Daemon) claimUsage(ctx context.Context, adapter agent.Agent, sessionID string, source usageSource) (bool, error) {
	statePath := d.usageCursorPath(adapter.ID(), sessionID)
	session := loadUsageState(statePath)
	switch session.Source {
	case source:
		return true, nil
	case "":
		session.Source = source
		if !usageStateFits(session, session.Cursor) {
			d.noteUsageRead(ctx, agent.UsageResult{CapacityLimitedFiles: 1})
			return false, errStopDrain
		}
		return true, saveUsageState(d.config.Layout, statePath, session)
	}
	return false, nil
}

func (d *Daemon) usageCursorPath(agentID, sessionID string) string {
	sum := sha256.Sum256([]byte(agentID + "\x00" + sessionID))
	return filepath.Join(d.config.Layout.UsageDir(), hex.EncodeToString(sum[:16])+".json")
}

func (d *Daemon) pruneUsageCursors() {
	// File ages are wall-clock, whatever clock the daemon runs on.
	now := time.Now()
	if now.Before(d.nextUsagePrune) {
		return
	}
	d.nextUsagePrune = now.Add(usagePruneInterval)
	entries, err := os.ReadDir(d.config.Layout.UsageDir())
	if err != nil {
		return
	}
	for _, entry := range entries {
		info, err := entry.Info()
		if err == nil && info.Mode().IsRegular() && now.Sub(info.ModTime()) > usageCursorRetention {
			os.Remove(filepath.Join(d.config.Layout.UsageDir(), entry.Name()))
		}
	}
}
