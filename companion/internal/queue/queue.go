// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package queue is the durable, bounded upload queue: one ledger per
// installation. A record is written atomically before it is sent, and it is
// only deleted after a validated server ack has itself been persisted, so a
// crash at any point can replay or reclaim a record but never lose it.
package queue

import (
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

const (
	MaxRecords     = 1024
	MaxBytes       = 128 << 20
	MaxRecordBytes = 4 << 20

	// maxRecentSettled bounds the memory of uploaded ids that lets a replayed
	// inbox item be recognized after its record was acked and deleted.
	maxRecentSettled  = 4096
	maxBackoff        = 384 * time.Second
	maxFailures       = 16
	maxRejectReasons  = 32
	maxReasonLength   = 64
	maxLedgerBytes    = 1 << 20
	ledgerVersion     = 1
	unprocessableCode = "unprocessable"
)

const (
	settledAcknowledged = "acknowledged"
	settledRejected     = "rejected"
)

var (
	ErrCapacity      = errors.New("queue_capacity_reached")
	ErrMalformedAck  = errors.New("malformed_acknowledgement")
	ErrInvalidRecord = errors.New("invalid_queue_record")
	ErrNoProgress    = errors.New("ack_settled_nothing")
)

var (
	captureIDPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
	fileNamePattern  = regexp.MustCompile(`^[0-9]{20}-([0-9a-f]{32})\.json$`)
)

type ledger struct {
	Version int `json:"version"`
	// Settled holds acks persisted before their records are unlinked.
	Settled       map[string]string `json:"settled,omitempty"`
	RecentSettled []string          `json:"recent_settled,omitempty"`
	Failures      uint32            `json:"failures"`
	NextAttempt   time.Time         `json:"next_attempt"`
	LastError     string            `json:"last_error,omitempty"`
	IsolateNext   int               `json:"isolate_next,omitempty"`
	Acknowledged  uint64            `json:"acknowledged"`
	Rejected      uint64            `json:"rejected"`
	RejectReasons map[string]uint64 `json:"reject_reasons,omitempty"`
	// Dropped counts acknowledged records the server did not store.
	Dropped     uint64            `json:"dropped"`
	DropReasons map[string]uint64 `json:"drop_reasons,omitempty"`
}

type Queue struct {
	dir        string
	ledgerPath string
	now        func() time.Time
	maxRecords int
	maxBytes   int64
	maxRecent  int
}

func Open(layout store.Layout) *Queue {
	return &Queue{dir: layout.QueueDir(), ledgerPath: layout.Ledger(), now: time.Now, maxRecords: MaxRecords, maxBytes: MaxBytes, maxRecent: maxRecentSettled}
}

// WithClock makes backoff decisions use now instead of the wall clock.
func (q *Queue) WithClock(now func() time.Time) *Queue {
	q.now = now
	return q
}

// WithMaxRecords lowers the record bound, so a full queue can be staged.
func (q *Queue) WithMaxRecords(records int) *Queue {
	q.maxRecords = records
	return q
}

type entry struct {
	name, captureID string
	size            int64
}

// queuedAt reads the enqueue time from the name's nanosecond prefix.
func (e entry) queuedAt() *time.Time {
	nanos, err := strconv.ParseInt(e.name[:20], 10, 64)
	if err != nil {
		return nil
	}
	queued := time.Unix(0, nanos).UTC()
	return &queued
}

func (q *Queue) entries() ([]entry, int64, error) {
	listing, err := os.ReadDir(q.dir)
	if err != nil {
		return nil, 0, err
	}
	var entries []entry
	var total int64
	for _, item := range listing {
		match := fileNamePattern.FindStringSubmatch(item.Name())
		if match == nil || !item.Type().IsRegular() {
			continue
		}
		info, err := item.Info()
		if err != nil {
			continue
		}
		entries = append(entries, entry{name: item.Name(), captureID: match[1], size: info.Size()})
		total += info.Size()
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].name < entries[j].name })
	return entries, total, nil
}

// Enqueue durably stores record. When the queue is full it returns
// ErrCapacity and keeps every existing record: unacked data is never evicted.
func (q *Queue) Enqueue(captureID string, record []byte) error {
	if !captureIDPattern.MatchString(captureID) || len(record) > MaxRecordBytes {
		return ErrInvalidRecord
	}
	entries, total, err := q.entries()
	if err != nil {
		return err
	}
	if len(entries)+1 > q.maxRecords || total+int64(len(record)) > q.maxBytes {
		return ErrCapacity
	}
	name := fmt.Sprintf("%020d-%s.json", q.now().UnixNano(), captureID)
	return store.WriteFileAtomic(filepath.Join(q.dir, name), record)
}

// Has reports whether captureID is queued or was recently settled.
func (q *Queue) Has(captureID string) (bool, error) {
	state, err := q.load()
	if err != nil {
		return false, err
	}
	if state.Settled[captureID] != "" {
		return true, nil
	}
	for _, settled := range state.RecentSettled {
		if settled == captureID {
			return true, nil
		}
	}
	entries, _, err := q.entries()
	if err != nil {
		return false, err
	}
	for _, item := range entries {
		if item.captureID == captureID {
			return true, nil
		}
	}
	return false, nil
}

// Rewrite replaces or deletes queued records in place: rewrite answers the
// record to keep and its id (the same id keeps it unchanged), or keep false
// to delete it. A replacement keeps the original's place in the order.
// The replacement is written before the original is removed, so a crash
// leaves both and repeating the rewrite converges on the replacement.
func (q *Queue) Rewrite(rewrite func(captureID string, record []byte) (newID string, newRecord []byte, keep bool)) error {
	entries, _, err := q.entries()
	if err != nil {
		return err
	}
	queued := map[string]bool{}
	for _, item := range entries {
		queued[item.captureID] = true
	}
	for _, item := range entries {
		path := filepath.Join(q.dir, item.name)
		record, err := store.ReadPrivateFile(path, MaxRecordBytes)
		if err != nil {
			// Left as it is: once readable, a rich record rejected as invalid is retried events-only.
			continue
		}
		newID, newRecord, keep := rewrite(item.captureID, record)
		if keep && newID == item.captureID && string(newRecord) == string(record) {
			continue
		}
		if keep {
			if !captureIDPattern.MatchString(newID) || len(newRecord) > MaxRecordBytes {
				return ErrInvalidRecord
			}
			replacement := item.name[:20] + "-" + newID + ".json"
			if replacement == item.name || !queued[newID] {
				if err := store.WriteFileAtomic(filepath.Join(q.dir, replacement), newRecord); err != nil {
					return err
				}
				queued[newID] = true
			}
			if replacement == item.name {
				continue
			}
		}
		if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return store.SyncDir(q.dir)
}

// Records visits every queued record, in order, whatever Next is
// isolating. A record it cannot read is an error, never skipped: callers
// decide what is still declared from what it visits.
func (q *Queue) Records(visit func(captureID string, record []byte)) error {
	entries, _, err := q.entries()
	if err != nil {
		return err
	}
	for _, item := range entries {
		record, err := store.ReadPrivateFile(filepath.Join(q.dir, item.name), MaxRecordBytes)
		if errors.Is(err, os.ErrNotExist) {
			// Settled and reclaimed since the listing.
			continue
		}
		if err != nil {
			return err
		}
		visit(item.captureID, record)
	}
	return nil
}

// Queued names the records waiting in the queue.
func (q *Queue) Queued() (map[string]bool, error) {
	entries, _, err := q.entries()
	if err != nil {
		return nil, err
	}
	queued := make(map[string]bool, len(entries))
	for _, item := range entries {
		queued[item.captureID] = true
	}
	return queued, nil
}

type Batch struct {
	IDs     []string
	Records []json.RawMessage
	Bytes   int
	files   map[string]string
}

// Next reclaims any persisted acks, then returns the oldest records within
// the count and byte bounds (a single record while isolating a 422).
func (q *Queue) Next(maxRecords, maxBytes int) (Batch, error) {
	state, err := q.load()
	if err != nil {
		return Batch{}, err
	}
	if err := q.reclaim(&state); err != nil {
		return Batch{}, err
	}
	if state.IsolateNext > 0 {
		maxRecords = 1
	}
	entries, _, err := q.entries()
	if err != nil {
		return Batch{}, err
	}
	batch := Batch{files: map[string]string{}}
	for _, item := range entries {
		if len(batch.IDs) >= maxRecords {
			break
		}
		data, err := store.ReadPrivateFile(filepath.Join(q.dir, item.name), MaxRecordBytes)
		if err != nil {
			continue
		}
		if batch.Bytes+len(data) > maxBytes && len(batch.IDs) > 0 {
			break
		}
		batch.IDs = append(batch.IDs, item.captureID)
		batch.Records = append(batch.Records, data)
		batch.Bytes += len(data)
		batch.files[item.captureID] = item.name
	}
	return batch, nil
}

type SettleResult struct{ Acknowledged, Rejected int }

// Settle applies a server ack to batch. Records named in neither list stay
// pending; an ack naming unknown or duplicate ids changes nothing.
func (q *Queue) Settle(batch Batch, ack uplink.Ack) (SettleResult, error) {
	outcome, err := validateAck(batch, ack)
	if err != nil {
		return SettleResult{}, err
	}
	if len(outcome) == 0 {
		return SettleResult{}, ErrNoProgress
	}
	state, err := q.load()
	if err != nil {
		return SettleResult{}, err
	}
	result := SettleResult{}
	for captureID, status := range outcome {
		state.Settled[captureID] = status
		state.RecentSettled = append(state.RecentSettled, captureID)
		if status == settledAcknowledged {
			state.Acknowledged++
			result.Acknowledged++
		} else {
			state.Rejected++
			result.Rejected++
		}
	}
	for _, rejection := range ack.Rejected {
		countReason(state.RejectReasons, rejection.Reason)
	}
	// A dropped record was acknowledged, so it is deleted like any other;
	// a drop naming a record this batch did not acknowledge is ignored.
	for _, drop := range ack.Dropped {
		if outcome[drop.CaptureID] == settledAcknowledged {
			state.Dropped++
			countReason(state.DropReasons, drop.Reason)
		}
	}
	if overflow := len(state.RecentSettled) - q.maxRecent; overflow > 0 {
		state.RecentSettled = state.RecentSettled[overflow:]
	}
	if len(batch.IDs) == 1 && state.IsolateNext > 0 {
		state.IsolateNext--
	}
	state.Failures, state.NextAttempt, state.LastError = 0, time.Time{}, ""
	// The ack must be durable before any record is unlinked.
	if err := q.save(state); err != nil {
		return SettleResult{}, err
	}
	return result, q.reclaim(&state)
}

func validateAck(batch Batch, ack uplink.Ack) (map[string]string, error) {
	sent := map[string]bool{}
	for _, captureID := range batch.IDs {
		sent[captureID] = true
	}
	outcome := map[string]string{}
	mark := func(captureID, status string) error {
		if !sent[captureID] || outcome[captureID] != "" {
			return ErrMalformedAck
		}
		outcome[captureID] = status
		return nil
	}
	for _, captureID := range ack.Acknowledged {
		if err := mark(captureID, settledAcknowledged); err != nil {
			return nil, err
		}
	}
	for _, rejection := range ack.Rejected {
		if err := mark(rejection.CaptureID, settledRejected); err != nil {
			return nil, err
		}
	}
	return outcome, nil
}

// RecordUnprocessable handles a 422 for a whole batch. The server named no
// record, so a multi-record batch is retried one record at a time and only a
// singleton 422 rejects (and deletes) that record.
func (q *Queue) RecordUnprocessable(batch Batch) error {
	if len(batch.IDs) == 1 {
		_, err := q.Settle(batch, uplink.Ack{Rejected: []uplink.Rejection{{CaptureID: batch.IDs[0], Reason: unprocessableCode}}})
		return err
	}
	state, err := q.load()
	if err != nil {
		return err
	}
	state.IsolateNext = len(batch.IDs)
	return q.save(state)
}

func (q *Queue) reclaim(state *ledger) error {
	if len(state.Settled) == 0 {
		return nil
	}
	entries, _, err := q.entries()
	if err != nil {
		return err
	}
	for _, item := range entries {
		if state.Settled[item.captureID] == "" {
			continue
		}
		if err := os.Remove(filepath.Join(q.dir, item.name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	if err := store.SyncDir(q.dir); err != nil {
		return err
	}
	state.Settled = map[string]string{}
	return q.save(*state)
}

func countReason(counts map[string]uint64, reason string) {
	reason = strings.TrimSpace(reason)
	if len(reason) > maxReasonLength {
		reason = reason[:maxReasonLength]
	}
	if reason == "" {
		reason = "unspecified"
	}
	if _, known := counts[reason]; !known && len(counts) >= maxRejectReasons {
		reason = "other"
	}
	counts[reason]++
}

func (q *Queue) RecordFailure(code string) error {
	state, err := q.load()
	if err != nil {
		return err
	}
	if state.Failures < maxFailures {
		state.Failures++
	}
	delay := time.Second << min(state.Failures, 8)
	var jitter [1]byte
	rand.Read(jitter[:])
	delay += time.Duration(jitter[0]) * delay / 512
	state.NextAttempt = q.now().Add(min(delay, maxBackoff))
	state.LastError = code
	return q.save(state)
}

func (q *Queue) RecordSuccess() error {
	state, err := q.load()
	if err != nil {
		return err
	}
	state.Failures, state.NextAttempt, state.LastError = 0, time.Time{}, ""
	return q.save(state)
}

// Ready reports whether the backoff has elapsed. A wall-clock rollback can
// never stretch it past maxBackoff.
func (q *Queue) Ready() (bool, error) {
	state, err := q.load()
	if err != nil {
		return false, err
	}
	now := q.now()
	return !now.Before(state.NextAttempt) || state.NextAttempt.Sub(now) > maxBackoff, nil
}

type Stats struct {
	Records       int               `json:"records"`
	Bytes         int64             `json:"bytes"`
	Failures      uint32            `json:"failures"`
	NextAttempt   time.Time         `json:"next_attempt"`
	LastError     string            `json:"last_error,omitempty"`
	Acknowledged  uint64            `json:"acknowledged"`
	Rejected      uint64            `json:"rejected"`
	RejectReasons map[string]uint64 `json:"reject_reasons,omitempty"`
	Dropped       uint64            `json:"dropped"`
	DropReasons   map[string]uint64 `json:"drop_reasons,omitempty"`
	// OldestPendingAt is when the oldest unacknowledged record was queued.
	OldestPendingAt *time.Time `json:"oldest_pending_at"`
}

func (q *Queue) Stats() (Stats, error) {
	state, err := q.load()
	if err != nil {
		return Stats{}, err
	}
	entries, total, err := q.entries()
	if err != nil {
		return Stats{}, err
	}
	stats := Stats{Records: len(entries), Bytes: total, Failures: state.Failures, NextAttempt: state.NextAttempt, LastError: state.LastError, Acknowledged: state.Acknowledged, Rejected: state.Rejected, RejectReasons: state.RejectReasons, Dropped: state.Dropped, DropReasons: state.DropReasons}
	if len(entries) > 0 {
		stats.OldestPendingAt = entries[0].queuedAt()
	}
	return stats, nil
}

func (q *Queue) load() (ledger, error) {
	state := ledger{Version: ledgerVersion}
	err := store.ReadJSON(q.ledgerPath, maxLedgerBytes, &state)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return ledger{}, err
	}
	if state.Settled == nil {
		state.Settled = map[string]string{}
	}
	if state.RejectReasons == nil {
		state.RejectReasons = map[string]uint64{}
	}
	if state.DropReasons == nil {
		state.DropReasons = map[string]uint64{}
	}
	return state, nil
}

func (q *Queue) save(state ledger) error {
	state.Version = ledgerVersion
	return store.WriteJSON(q.ledgerPath, state)
}
