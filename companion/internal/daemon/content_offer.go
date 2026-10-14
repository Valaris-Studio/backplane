// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"path/filepath"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// negotiationState counts the offer-less policy responses of a server that
// may predate rich capture. It lives under RichDir, which a server switch
// purges, so responses of two servers never add up.
type negotiationState struct {
	AbsentResponses int       `json:"absent_responses"`
	LastAbsentAt    time.Time `json:"last_absent_at,omitzero"`
}

func (d *Daemon) negotiationPath() string {
	return filepath.Join(d.config.Layout.RichDir(), "negotiation.json")
}

func (d *Daemon) negotiation() negotiationState {
	loaded, _ := state.Load[negotiationState](d.negotiationPath())
	return loaded
}

func (d *Daemon) saveNegotiation(negotiation negotiationState) error {
	if err := store.EnsurePrivateDir(d.config.Layout.RichDir()); err != nil {
		return err
	}
	return store.WriteJSON(d.negotiationPath(), negotiation)
}

// absentResponsesForOldServer: this many consecutive offer-less responses,
// a policy interval apart, say the server predates rich capture. One alone
// may be a misrouted proxy or a revision mid-rollout.
const absentResponsesForOldServer = 2

// negotiateRichCapture reads what a fresh policy says of rich capture. An
// offer or null is the server speaking; an absent member changes nothing
// until it is evidence, and then the device stops sending rich members.
func (d *Daemon) negotiateRichCapture(fresh *policy.Policy, now time.Time) (revert bool) {
	negotiation := d.negotiation()
	if fresh.RichCapture.Present {
		if negotiation != (negotiationState{}) {
			d.saveNegotiation(negotiationState{})
		}
		return false
	}
	if negotiation.AbsentResponses == 0 || now.Sub(negotiation.LastAbsentAt) >= PolicyInterval {
		negotiation.AbsentResponses++
		negotiation.LastAbsentAt = now.UTC()
		d.saveNegotiation(negotiation)
	}
	if negotiation.AbsentResponses < absentResponsesForOldServer {
		if previous, err := policy.Load(d.config.Layout.Policy()); err == nil {
			fresh.RichCapture = previous.Policy.RichCapture
		}
		return false
	}
	previous, err := policy.Load(d.config.Layout.Policy())
	return err == nil && previous.Policy.RichCapture.Present
}

// revertToEventsOnly makes the queue fit a server without rich capture:
// rich records go events-only (or away), the spool is purged, and the
// cached policy stops carrying an offer.
func (d *Daemon) revertToEventsOnly(ctx context.Context) error {
	err := d.queue.Rewrite(func(captureID string, raw []byte) (string, []byte, bool) {
		record, rich := richRecord(raw)
		if !rich {
			return captureID, raw, true
		}
		eventsOnly, ok := record.EventsOnly()
		if !ok {
			return "", nil, false
		}
		encoded, err := encodeRecord(eventsOnly)
		if err != nil {
			return "", nil, false
		}
		return eventsOnly.CaptureID, encoded, true
	})
	if err != nil {
		return err
	}
	if err := d.spool.Purge(); err != nil {
		return err
	}
	if cached, err := policy.Load(d.config.Layout.Policy()); err == nil && cached.Policy.RichCapture.Present {
		cached.Policy.RichCapture = policy.RichCapture{}
		if err := policy.Save(d.config.Layout.Policy(), cached); err != nil {
			return err
		}
	}
	return d.saveNegotiation(negotiationState{AbsentResponses: absentResponsesForOldServer, LastAbsentAt: d.config.Now().UTC()})
}
