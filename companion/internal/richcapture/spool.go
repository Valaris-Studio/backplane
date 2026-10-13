// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package richcapture holds the provider-neutral parts of rich session
// capture: the durable body spool, read positions in the agents' session
// files, declarations with their redaction and placement, and the guarded
// reads of attachments and harness body stores. Agents only parse their own
// formats (agent.ContentParser); the daemon drives the rest.
package richcapture

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

// MaxSpoolBytes bounds the bodies waiting for the server, per connection.
const MaxSpoolBytes = 1 << 30

const (
	maxSidecarBytes = 64 << 10
	bodySuffix      = ".body"
	sidecarSuffix   = ".json"
	spoolLedger     = "ledger.json"
)

// ErrSpoolFull stops staging; nothing already spooled is ever evicted.
var ErrSpoolFull = errors.New("spool_full")

var contentKeyPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Spool keeps each body that must reach the server until the server settles
// it: a body file and its sidecar, both fsynced before the record declaring
// the body is queued. One process uses a spool at a time (the daemon, or a
// switch's flush while it holds the session).
type Spool struct {
	dir      string
	maxBytes int64
	now      func() time.Time
	// pendingBytes caches the spooled total; -1 until first counted.
	pendingBytes int64
}

func OpenSpool(dir string) *Spool {
	return &Spool{dir: dir, maxBytes: MaxSpoolBytes, now: time.Now, pendingBytes: -1}
}

func (s *Spool) WithMaxBytes(bytes int64) *Spool {
	s.maxBytes = bytes
	return s
}

func (s *Spool) WithClock(now func() time.Time) *Spool {
	s.now = now
	return s
}

// Body is a spooled body's sidecar.
type Body struct {
	ContentKey string `json:"content_key"`
	CaptureID  string `json:"capture_id"`
	// The session and time the body belongs to, so a history cutoff the
	// server reports settles the bodies it reaches.
	MappingID       string    `json:"mapping_id,omitempty"`
	Harness         string    `json:"harness,omitempty"`
	NativeSessionID string    `json:"native_session_id,omitempty"`
	OccurredAt      time.Time `json:"occurred_at,omitzero"`
	ByteCount       int64     `json:"byte_count"`
	SHA256          string    `json:"sha256"`
	StagedAt        time.Time `json:"staged_at"`
	// ContentID and Upload are set once the server asked for the body.
	ContentID   string             `json:"content_id,omitempty"`
	Upload      *uplink.UploadSlot `json:"upload,omitempty"`
	Failures    uint32             `json:"failures,omitempty"`
	NextAttempt time.Time          `json:"next_attempt,omitzero"`
	// Resent counts chunk_checksum_mismatch resends; one is allowed.
	Resent int `json:"resent,omitempty"`
}

func (s *Spool) bodyPath(key string) string    { return filepath.Join(s.dir, key+bodySuffix) }
func (s *Spool) sidecarPath(key string) string { return filepath.Join(s.dir, key+sidecarSuffix) }

// Stage durably spools data as the body described by body (its key, record
// and session); the size and digest are computed. Staging a key already
// spooled keeps the spooled one.
func (s *Spool) Stage(body Body, data []byte) (Body, error) {
	if !contentKeyPattern.MatchString(body.ContentKey) {
		return Body{}, store.ErrUnsafePath
	}
	if existing, found, err := s.Get(body.ContentKey); err != nil || found {
		return existing, err
	}
	pending, err := s.pending()
	if err != nil {
		return Body{}, err
	}
	if pending+int64(len(data)) > s.maxBytes {
		return Body{}, ErrSpoolFull
	}
	if err := store.EnsurePrivateDir(s.dir); err != nil {
		return Body{}, err
	}
	sum := sha256.Sum256(data)
	body.ByteCount, body.SHA256, body.StagedAt = int64(len(data)), hex.EncodeToString(sum[:]), s.now().UTC()
	// The body first: a sidecar names only a body that is already durable.
	if err := store.WriteFileAtomic(s.bodyPath(body.ContentKey), data); err != nil {
		return Body{}, err
	}
	if err := store.WriteJSON(s.sidecarPath(body.ContentKey), body); err != nil {
		return Body{}, err
	}
	s.pendingBytes = pending + body.ByteCount
	return body, nil
}

func (s *Spool) Get(contentKey string) (Body, bool, error) {
	var body Body
	err := store.ReadJSON(s.sidecarPath(contentKey), maxSidecarBytes, &body)
	if errors.Is(err, os.ErrNotExist) {
		return Body{}, false, nil
	}
	if err != nil {
		return Body{}, false, err
	}
	return body, true, nil
}

// Bodies are every spooled body, oldest first.
func (s *Spool) Bodies() ([]Body, error) {
	entries, err := os.ReadDir(s.dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var bodies []Body
	for _, entry := range entries {
		key, isSidecar := strings.CutSuffix(entry.Name(), sidecarSuffix)
		if !isSidecar || !contentKeyPattern.MatchString(key) {
			continue
		}
		body, found, err := s.Get(key)
		if err != nil || !found {
			continue
		}
		bodies = append(bodies, body)
	}
	sort.Slice(bodies, func(i, j int) bool {
		if !bodies[i].StagedAt.Equal(bodies[j].StagedAt) {
			return bodies[i].StagedAt.Before(bodies[j].StagedAt)
		}
		return bodies[i].ContentKey < bodies[j].ContentKey
	})
	return bodies, nil
}

// AwaitUpload records the server's upload slot for a body. A body no longer
// spooled will never reach the server: found is false and it is counted as
// failed.
func (s *Spool) AwaitUpload(contentKey, contentID string, slot uplink.UploadSlot) (found bool, err error) {
	body, found, err := s.Get(contentKey)
	if err != nil {
		return false, err
	}
	if !found {
		return false, s.countFailed()
	}
	body.ContentID, body.Upload = contentID, &slot
	return true, s.Save(body)
}

// Save rewrites a body's sidecar.
func (s *Spool) Save(body Body) error {
	if _, err := os.Stat(s.bodyPath(body.ContentKey)); err != nil {
		return err
	}
	return store.WriteJSON(s.sidecarPath(body.ContentKey), body)
}

// Chunk reads chunk index of a body awaiting upload.
func (s *Spool) Chunk(body Body, index int) ([]byte, error) {
	if body.Upload == nil || body.Upload.ChunkBytes < 1 {
		return nil, store.ErrUnsafePath
	}
	file, err := os.Open(s.bodyPath(body.ContentKey))
	if err != nil {
		return nil, err
	}
	defer file.Close()
	start := int64(index) * body.Upload.ChunkBytes
	size := min(body.Upload.ChunkBytes, body.ByteCount-start)
	if start < 0 || size < 0 {
		return nil, io.ErrUnexpectedEOF
	}
	chunk := make([]byte, size)
	if _, err := file.ReadAt(chunk, start); err != nil && !(errors.Is(err, io.EOF) && size == 0) {
		return nil, err
	}
	return chunk, nil
}

// Intact reports whether a spooled body still matches its sidecar's digest.
func (s *Spool) Intact(body Body) bool {
	file, err := os.Open(s.bodyPath(body.ContentKey))
	if err != nil {
		return false
	}
	defer file.Close()
	digest := sha256.New()
	size, err := io.Copy(digest, file)
	return err == nil && size == body.ByteCount && hex.EncodeToString(digest.Sum(nil)) == body.SHA256
}

// Settle deletes a body the server settled.
func (s *Spool) Settle(contentKey string) error {
	body, found, err := s.Get(contentKey)
	if err != nil || !found {
		return err
	}
	// The sidecar first: a body without one is swept, never declared again.
	if err := os.Remove(s.sidecarPath(contentKey)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if s.pendingBytes >= 0 {
		s.pendingBytes -= body.ByteCount
	}
	if err := os.Remove(s.bodyPath(contentKey)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

type spoolCounts struct {
	FailedTotal uint64 `json:"failed_total"`
}

// Fail deletes a body the server will never take, counting it.
func (s *Spool) Fail(contentKey string) error {
	if _, found, err := s.Get(contentKey); err != nil || !found {
		return err
	}
	if err := s.countFailed(); err != nil {
		return err
	}
	return s.Settle(contentKey)
}

func (s *Spool) countFailed() error {
	var counts spoolCounts
	if err := store.ReadJSON(filepath.Join(s.dir, spoolLedger), maxSidecarBytes, &counts); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	counts.FailedTotal++
	if err := store.EnsurePrivateDir(s.dir); err != nil {
		return err
	}
	return store.WriteJSON(filepath.Join(s.dir, spoolLedger), counts)
}

// Sweep removes what a crash left mid-stage: bodies without a sidecar.
func (s *Spool) Sweep() error {
	entries, err := os.ReadDir(s.dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		name := entry.Name()
		key, isBody := strings.CutSuffix(name, bodySuffix)
		orphan := isBody && contentKeyPattern.MatchString(key)
		if orphan {
			_, statErr := os.Stat(s.sidecarPath(key))
			orphan = errors.Is(statErr, os.ErrNotExist)
		}
		if orphan || strings.HasPrefix(name, ".pending-") {
			if err := os.Remove(filepath.Join(s.dir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	}
	return nil
}

// Purge deletes every body.
func (s *Spool) Purge() error {
	s.pendingBytes = -1
	return os.RemoveAll(s.dir)
}

type SpoolStats struct {
	PendingBodies   int
	PendingBytes    int64
	OldestPendingAt *time.Time
	// FailedTotal counts bodies that will never reach the server.
	FailedTotal uint64
}

func (s *Spool) Stats() (SpoolStats, error) {
	bodies, err := s.Bodies()
	if err != nil {
		return SpoolStats{}, err
	}
	stats := SpoolStats{PendingBodies: len(bodies)}
	for index, body := range bodies {
		stats.PendingBytes += body.ByteCount
		if index == 0 {
			oldest := body.StagedAt
			stats.OldestPendingAt = &oldest
		}
	}
	s.pendingBytes = stats.PendingBytes
	var counts spoolCounts
	if err := store.ReadJSON(filepath.Join(s.dir, spoolLedger), maxSidecarBytes, &counts); err != nil && !errors.Is(err, os.ErrNotExist) {
		return SpoolStats{}, err
	}
	stats.FailedTotal = counts.FailedTotal
	return stats, nil
}

func (s *Spool) pending() (int64, error) {
	if s.pendingBytes >= 0 {
		return s.pendingBytes, nil
	}
	stats, err := s.Stats()
	return stats.PendingBytes, err
}
