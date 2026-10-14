// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"encoding/json"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
)

func (d *Daemon) pollInitialPrompt(ctx context.Context, threadID string, thread state.Thread) error {
	adapter, err := d.config.Registry.Lookup(thread.Agent)
	if err != nil {
		return nil
	}
	source, ok := adapter.(agent.InitialPromptSource)
	if !ok {
		return nil
	}
	path := d.usageCursorPath(adapter.ID(), threadID)
	session := loadUsageState(path)
	if session.InitialPromptDone {
		return nil
	}
	decision, err := d.decide(ctx, adapter.ID(), thread.Cwd)
	if err != nil || !decision.InScope {
		return err
	}
	result, err := source.ReadInitialPrompt(agent.InitialPromptRead{
		Transcript: thread.Transcript, SessionID: threadID, Cwd: decision.Cwd,
		FirstSeen: thread.FirstSeen, Now: d.config.Now(), Env: d.config.AgentEnv,
		Allowed: d.captureAllowedAt(adapter.ID(), decision.MappingID, decision.Cwd),
	})
	if err != nil {
		return err
	}
	if result.Done {
		session.InitialPromptDone = true
		// Checked before any effect: a mark the state could not load back
		// with would forget its cursor, first sighting and usage source.
		if !usageStateFits(session, session.Cursor) {
			d.noteUsageRead(ctx, agent.UsageResult{CapacityLimitedFiles: 1})
			return nil
		}
	}
	if len(result.Event) > 0 {
		decision, err = d.decide(ctx, result.Harness, thread.Cwd)
		if err != nil || !decision.InScope {
			return err
		}
		var event map[string]any
		if err := json.Unmarshal(result.Event, &event); err != nil {
			return err
		}
		sanitized, _ := privacy.SanitizeFor(event, nil, decision.ContentLevel)
		encoded, err := encodeEvent(privacy.ApplyEventContentLevel(privacy.WorkingDirectoryName(sanitized, decision.ContentLevel), decision.ContentLevel))
		if err != nil {
			return err
		}
		item := observed{
			captureID: captureID(adapter.ID(), "initial_prompt\x00"+threadID), adapter: adapter, harness: result.Harness, ingress: agent.IngressPoll,
			observation: agent.Observation{NativeSessionID: threadID, Cwd: thread.Cwd}, receivedAt: result.ObservedAt,
			parentSessionID: d.threadParent(adapter, threadID, thread),
		}
		known, err := d.queue.Has(item.captureID)
		if err != nil {
			return err
		}
		if !known {
			if err := d.enqueue(item, decision.MappingID, decision.Place, decision.ContentLevel, beacon.Result{Events: []json.RawMessage{encoded}, SchemaVersion: "1.0"}); err != nil {
				return err
			}
		}
	}
	if result.Done {
		return saveUsageState(d.config.Layout, path, session)
	}
	return nil
}
