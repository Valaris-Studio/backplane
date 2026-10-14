// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sort"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
)

// An OTLP agent's traces may carry its usage (Codex CLI) or not (Codex
// Desktop exports no traces). Its transcript always does, so the daemon
// polls the transcripts its hooks named or its discovery found (Desktop
// may run without hooks) and counts, per session, whichever
// source delivers first; the other is then ignored for that session.
const (
	// rolloutSettle is how long transcript usage waits for a trace to count
	// it instead, when one can (sourceEmitsTraces). Codex exports a turn's
	// span within seconds of the turn and the gate holds a span for at most
	// otlpgate.HoldTTL.
	rolloutSettle = 2 * time.Minute
	// rolloutPollWindow: threads no hook named for this long are not polled.
	rolloutPollWindow = 24 * time.Hour
	// maxRolloutPolls bounds the transcripts read per pass, most recently
	// seen threads first.
	maxRolloutPolls = 64
	// maxTelemetryHarnesses bounds the remembered harness of each thread.
	maxTelemetryHarnesses = 4096
)

// rolloutMark is a transcript's size and time at its last complete read.
type rolloutMark struct {
	size    int64
	modTime time.Time
	readAt  time.Time
	// telemetry: the session's telemetry counts its usage, so its transcript
	// is never read again.
	telemetry bool
}

type polledThread struct {
	id     string
	thread state.Thread
}

func (d *Daemon) pollTranscripts(ctx context.Context) error {
	if d.config.AgentEnv.Home == "" {
		// Without the agents' home a transcript cannot be confined to it.
		return nil
	}
	threads, err := state.Load[state.Threads](d.config.Layout.Threads())
	if err != nil {
		return nil
	}
	now := d.config.Now()
	var due []polledThread
	for id, thread := range threads.Threads {
		if thread.Transcript != "" && now.Sub(thread.SeenAt) < rolloutPollWindow {
			due = append(due, polledThread{id: id, thread: thread})
		}
	}
	for _, found := range d.discoverSessions() {
		if _, reads := found.adapter.(agent.UsageSource); !reads {
			continue
		}
		if known := threads.Threads[found.ref.NativeSessionID]; known.Transcript != "" && now.Sub(known.SeenAt) < rolloutPollWindow {
			// A hook named it too: one session, one usage cursor.
			continue
		}
		// A hookless session's own lines start at its header's time; older
		// ones were copied in by a fork.
		firstSeen := found.ref.Began
		if firstSeen.IsZero() {
			firstSeen = now
		}
		due = append(due, polledThread{id: found.ref.NativeSessionID, thread: state.Thread{
			Agent: found.adapter.ID(), Cwd: found.ref.Cwd, SessionID: found.ref.EnvelopeParent(),
			SeenAt: now, FirstSeen: firstSeen, Transcript: found.ref.Path,
		}})
	}
	sort.Slice(due, func(i, j int) bool { return due[i].thread.SeenAt.After(due[j].thread.SeenAt) })
	for index, candidate := range due {
		if index >= maxRolloutPolls || ctx.Err() != nil {
			break
		}
		err := d.pollTranscript(ctx, candidate.id, candidate.thread)
		if errors.Is(err, errStopDrain) {
			// The queue is full: the rest waits, unread, for a later pass.
			return nil
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func (d *Daemon) pollTranscript(ctx context.Context, threadID string, thread state.Thread) error {
	adapter, err := d.config.Registry.Lookup(thread.Agent)
	if err != nil || adapter.Ingress() != agent.IngressOTLP {
		return nil
	}
	source, ok := adapter.(agent.UsageSource)
	if !ok {
		return nil
	}
	info, err := os.Stat(thread.Transcript)
	if err != nil {
		return nil
	}
	markKey := threadID + "\x00" + thread.Transcript
	mark, known := d.rolloutMarks[markKey]
	// Unchanged since a read that came after all of it had settled.
	if known && (mark.telemetry || mark.size == info.Size() && mark.modTime.Equal(info.ModTime()) && mark.readAt.Sub(mark.modTime) > rolloutSettle) {
		return nil
	}
	statePath := d.usageCursorPath(adapter.ID(), threadID)
	session := loadUsageState(statePath)
	if session.Source == usageFromTelemetry {
		d.markTranscript(markKey, rolloutMark{telemetry: true})
		return nil
	}
	decision, err := d.decide(ctx, adapter.ID(), thread.Cwd)
	if err != nil || !decision.InScope && decision.Reason.Transient() {
		// Kept for a later pass, like a hook item in a transient state.
		return nil
	}
	now := d.config.Now()
	if session.FirstSeen.IsZero() {
		session.FirstSeen = thread.FirstSeen
	}
	allowed := d.captureAllowedAt(adapter.ID(), decision.MappingID, decision.Cwd)
	read := agent.UsageRead{
		Transcript: thread.Transcript,
		SessionID:  threadID,
		Now:        now,
		Env:        d.config.AgentEnv,
		Harness:    d.telemetryHarness[threadID],
		// Lines older than the thread's first hook were copied in by a fork
		// or resume and counted by the thread they came from.
		Allowed: func(at time.Time) bool { return !at.Before(session.FirstSeen) && allowed(at) },
	}
	if session.Source != usageFromTranscript {
		read.Until = now.Add(-rolloutSettle)
	}
	result, err := source.ReadUsage(read, session.Cursor)
	// Which client wrote the transcript is only known once it is read.
	if err == nil && !read.Until.IsZero() && !d.sourceEmitsTraces(adapter, result.Cursor) {
		read.Until = time.Time{}
		result, err = source.ReadUsage(read, session.Cursor)
	}
	if err != nil {
		d.countDropped()
		return nil
	}
	if result.Harness != "" && result.Harness != adapter.ID() {
		// The harness the usage is uploaded under must itself be enabled.
		if decision, err = d.decide(ctx, result.Harness, thread.Cwd); err != nil || !decision.InScope && decision.Reason.Transient() {
			return nil
		}
	}
	claims := decision.InScope && len(result.Events) > 0
	if claims && session.Source == "" {
		session.Source = usageFromTranscript
	}
	// The state as it is saved, claim included, must load back: the claim
	// saved before queueing still holds the previous cursor.
	if !usageStateFits(session, result.Cursor) || claims && !usageStateFits(session, session.Cursor) {
		d.noteUsageRead(ctx, agent.UsageResult{CapacityLimitedFiles: 1})
		return nil
	}
	d.noteUsageRead(ctx, result)
	if claims {
		usage := observed{
			adapter:     adapter,
			harness:     result.Harness,
			observation: agent.Observation{NativeSessionID: threadID, Cwd: thread.Cwd},
			receivedAt:  now,
		}
		usage.parentSessionID = d.threadParent(adapter, threadID, thread)
		// Claimed before queueing: a crash in between must not leave the
		// session open to its traces with this usage already queued.
		if err := saveUsageState(d.config.Layout, statePath, session); err != nil {
			return err
		}
		if err := d.enqueueUsage(usage, decision, result.Events); err != nil {
			return err
		}
	}
	session.Cursor = result.Cursor
	if err := saveUsageState(d.config.Layout, statePath, session); err != nil {
		return err
	}
	if result.DeferredFiles == 0 && result.CapacityLimitedFiles == 0 {
		d.markTranscript(markKey, rolloutMark{size: info.Size(), modTime: info.ModTime(), readAt: now})
	}
	return nil
}

// threadParent is the session a thread's usage and telemetry name as its
// parent. A Codex hook names the tree's root (session_id), not the thread's
// immediate parent, and may name any file; the server keeps the first
// parent it is told. So for an agent whose files state their relation, only
// the thread's own current header names a parent; anything else leaves it
// unknown. Other agents' hooks name the parent itself.
func (d *Daemon) threadParent(adapter agent.Agent, threadID string, thread state.Thread) string {
	if _, reads := adapter.(agent.SessionRelations); reads {
		return d.ownParent(adapter, thread.Transcript, threadID)
	}
	if thread.SessionID == threadID {
		return ""
	}
	return thread.SessionID
}

// ownParent is the parent a session file's current header names for
// sessionID, "" when it names none, is not that session's or cannot be
// read. Each call reads the header again: a path can be replaced, rewritten
// or taken by another thread.
func (d *Daemon) ownParent(adapter agent.Agent, path, sessionID string) string {
	relations, reads := adapter.(agent.SessionRelations)
	if !reads || path == "" {
		return ""
	}
	if relation, readable := relations.SessionRelation(d.config.AgentEnv, path); readable && relation.SessionID == sessionID {
		return relation.ParentSessionID
	}
	return ""
}

// traceExporter is an adapter that knows, from a session's transcript
// cursor, whether the session's traces, which may carry usage, can reach the
// companion at all.
type traceExporter interface {
	ExportsTraces(env agent.Env, cursor json.RawMessage) bool
}

// sourceEmitsTraces reports whether a trace may still claim the session a
// transcript cursor describes; only then does the transcript wait out
// rolloutSettle.
func (d *Daemon) sourceEmitsTraces(adapter agent.Agent, cursor json.RawMessage) bool {
	if d.config.OTel == nil {
		return false
	}
	exporter, reports := adapter.(traceExporter)
	return !reports || exporter.ExportsTraces(d.config.AgentEnv, cursor)
}

func (d *Daemon) markTranscript(key string, mark rolloutMark) {
	if d.rolloutMarks == nil || len(d.rolloutMarks) >= maxTrackedSessions {
		d.rolloutMarks = map[string]rolloutMark{}
	}
	d.rolloutMarks[key] = mark
}

// noteTelemetryHarness remembers which harness a thread's telemetry named,
// so its transcript usage is attributed to the same session.
func (d *Daemon) noteTelemetryHarness(threadID, harness string) {
	if d.telemetryHarness[threadID] == harness {
		return
	}
	if d.telemetryHarness == nil || len(d.telemetryHarness) >= maxTelemetryHarnesses {
		d.telemetryHarness = map[string]string{}
	}
	d.telemetryHarness[threadID] = harness
}
