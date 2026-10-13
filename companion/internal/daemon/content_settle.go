// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"encoding/json"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

// rejectionsRetriedEventsOnly are a record's rejections that may mean the
// server cannot read rich members; its events are resent without them.
var rejectionsRetriedEventsOnly = map[string]bool{"invalid": true, "unprocessable": true}

// richRecord is a queued record's rich members.
func richRecord(raw json.RawMessage) (uplink.Record, bool) {
	var record uplink.Record
	if json.Unmarshal(raw, &record) != nil || record.Contents == nil && record.CaptureGeneration == nil {
		return uplink.Record{}, false
	}
	return record, true
}

// settleContent applies an ingest answer to the spool before the queue
// settles it, so a crash in between replays the record and its acks.
func (d *Daemon) settleContent(ctx context.Context, batch queue.Batch, ack uplink.Ack) error {
	acknowledged := map[string]bool{}
	for _, id := range ack.Acknowledged {
		acknowledged[id] = true
	}
	rejected := map[string]string{}
	for _, rejection := range ack.Rejected {
		rejected[rejection.CaptureID] = rejection.Reason
	}
	acked := map[string][]uplink.ContentAck{}
	for _, content := range ack.Contents {
		acked[content.CaptureID] = append(acked[content.CaptureID], content)
	}
	records := map[string]uplink.Record{}
	for index, raw := range batch.Records {
		if record, rich := richRecord(raw); rich {
			records[batch.IDs[index]] = record
		}
	}
	// An acknowledged record's acks answer each of its declarations.
	for id, record := range records {
		if !acknowledged[id] {
			continue
		}
		answered := map[string]bool{}
		for _, content := range acked[id] {
			answered[content.ContentKey] = true
		}
		for _, declaration := range record.Contents {
			if !answered[declaration.ContentKey] {
				return queue.ErrMalformedAck
			}
		}
	}
	health := &contentHealth{}
	defer health.flush(d)
	for _, content := range ack.Contents {
		if _, declared := records[content.CaptureID]; !declared {
			continue
		}
		var err error
		switch content.Outcome {
		case uplink.OutcomeUploadRequired:
			var spooled bool
			if spooled, err = d.spool.AwaitUpload(content.ContentKey, content.ContentID, *content.Upload); err == nil && !spooled {
				health.touched = true
				health.MissingBodies++
			}
		case uplink.OutcomeRejected:
			health.reject(content.Rejection)
			err = d.spool.Settle(content.ContentKey)
		default:
			err = d.spool.Settle(content.ContentKey)
		}
		if err != nil {
			return err
		}
	}
	revert := false
	for id, reason := range rejected {
		record, rich := records[id]
		if !rich {
			continue
		}
		// A rejected record settles every declaration it carried.
		for _, declaration := range record.Contents {
			if err := d.spool.Settle(declaration.ContentKey); err != nil {
				return err
			}
		}
		if rejectionsRetriedEventsOnly[reason] {
			if err := d.retryEventsOnly(record, health); err != nil {
				return err
			}
			revert = revert || d.negotiation().AbsentResponses > 0
		}
	}
	if err := d.settleDeletedHistory(ack.HistoryDeleted); err != nil {
		return err
	}
	if revert {
		return d.revertToEventsOnly(ctx)
	}
	return nil
}

// retryEventsOnly queues a rejected rich record's events once more without
// its rich members; a record of contents alone has nothing to resend.
func (d *Daemon) retryEventsOnly(record uplink.Record, health *contentHealth) error {
	eventsOnly, ok := record.EventsOnly()
	if !ok {
		return nil
	}
	if known, err := d.queue.Has(eventsOnly.CaptureID); err != nil || known {
		return err
	}
	encoded, err := encodeRecord(eventsOnly)
	if err != nil {
		return err
	}
	health.touched = true
	health.EventsOnlyRetries++
	return d.queue.Enqueue(eventsOnly.CaptureID, encoded)
}

// settleDeletedHistory settles the spooled bodies a history cutoff reaches;
// the server drops them, so they are never uploaded. Read positions stay.
func (d *Daemon) settleDeletedHistory(deleted []uplink.HistoryDeleted) error {
	if len(deleted) == 0 {
		return nil
	}
	bodies, err := d.spool.Bodies()
	if err != nil {
		return err
	}
	for _, history := range deleted {
		for _, body := range bodies {
			if body.NativeSessionID == history.NativeSessionID && body.Harness == history.Harness && body.MappingID == history.MappingID && !body.OccurredAt.After(history.DeletedThrough) {
				if err := d.spool.Settle(body.ContentKey); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// spoolSweepInterval spaces the sweeps of bodies no record declares any
// more (a read that stopped before queueing them, then moved on).
const (
	spoolSweepInterval = time.Hour
	spoolOrphanAge     = time.Hour
)

// sweepSpool removes what a crash left mid-stage, and bodies the server was
// never asked for whose declaring record is no longer queued.
func (d *Daemon) sweepSpool() {
	now := d.config.Now()
	if now.Before(d.nextSpoolSweep) {
		return
	}
	d.nextSpoolSweep = now.Add(spoolSweepInterval)
	d.spool.Sweep()
	bodies, err := d.spool.Bodies()
	if err != nil || len(bodies) == 0 {
		return
	}
	declared := map[string]bool{}
	err = d.queue.Records(func(_ string, raw []byte) {
		if record, rich := richRecord(raw); rich {
			for _, content := range record.Contents {
				declared[content.ContentKey] = true
			}
		}
	})
	if err != nil {
		return
	}
	for _, body := range bodies {
		if body.ContentID == "" && now.Sub(body.StagedAt) > spoolOrphanAge && !declared[body.ContentKey] {
			d.spool.Settle(body.ContentKey)
		}
	}
}
