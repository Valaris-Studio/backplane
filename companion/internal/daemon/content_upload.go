// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"crypto/rand"
	"errors"
	"net/http"
	"slices"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/richcapture"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

// ContentAPI is what uploading spooled bodies needs of the server.
type ContentAPI interface {
	PutContentChunk(ctx context.Context, contentID string, index int, chunk []byte) (uplink.ChunkReceipt, error)
	FinalizeContent(ctx context.Context, contentID string, byteCount int64, sha256 string) (uplink.ContentUploadState, error)
	ContentUpload(ctx context.Context, contentID string) (uplink.ContentUploadState, error)
}

const (
	maxUploadBackoff = 384 * time.Second
	maxUploadRounds  = 64
)

// uploadContent sends the chunks of bodies the server asked for, at most
// maxChunkUploads per pass; drain ignores the per-body backoff.
func (d *Daemon) uploadContent(ctx context.Context, drain bool) (sent int, err error) {
	client, uploads := d.config.Client.(ContentAPI)
	if !uploads {
		return 0, nil
	}
	bodies, err := d.spool.Bodies()
	if err != nil {
		return 0, err
	}
	now := d.config.Now()
	for _, body := range bodies {
		if sent >= maxChunkUploads || ctx.Err() != nil || d.revoked.Load() {
			break
		}
		if body.ContentID == "" || body.Upload == nil || !drain && now.Before(body.NextAttempt) {
			continue
		}
		upload := bodyUpload{daemon: d, client: client, body: body, sent: &sent}
		upload.run(ctx)
	}
	return sent, nil
}

// drainUploads uploads every pending body, ignoring backoffs, until done,
// a pass sends nothing, or ctx ends.
func (d *Daemon) drainUploads(ctx context.Context) {
	for range maxUploadRounds {
		sent, err := d.uploadContent(ctx, true)
		if err != nil || sent == 0 || ctx.Err() != nil {
			return
		}
	}
}

type bodyUpload struct {
	daemon *Daemon
	client ContentAPI
	body   richcapture.Body
	sent   *int
}

func (u *bodyUpload) run(ctx context.Context) {
	received := map[int]bool{}
	for _, index := range u.body.Upload.ReceivedChunks {
		received[index] = true
	}
	for index := range u.body.Upload.ChunkCount {
		if received[index] {
			continue
		}
		if *u.sent >= maxChunkUploads {
			return
		}
		chunk, err := u.daemon.spool.Chunk(u.body, index)
		if err != nil {
			u.fail()
			return
		}
		receipt, err := u.client.PutContentChunk(ctx, u.body.ContentID, index, chunk)
		*u.sent++
		if err != nil {
			if !u.answer(ctx, err, index) {
				return
			}
			// Resent once after a damaged chunk; read the receipt again.
			if receipt, err = u.client.PutContentChunk(ctx, u.body.ContentID, index, chunk); err != nil {
				u.answer(ctx, err, -1)
				return
			}
			*u.sent++
		}
		u.body.Upload.ReceivedChunks = receipt.ReceivedChunks
		u.body.Failures, u.body.NextAttempt = 0, time.Time{}
		if receipt.Complete {
			break
		}
		if u.daemon.spool.Save(u.body) != nil || commitFault("chunk") != nil {
			return
		}
	}
	state, err := u.client.FinalizeContent(ctx, u.body.ContentID, u.body.ByteCount, u.body.SHA256)
	if err != nil {
		u.answer(ctx, err, -1)
		return
	}
	u.settleBy(state)
}

// answer reacts to an upload error, per its status and code; true only when
// the chunk index (≥ 0) is to be resent at once.
func (u *bodyUpload) answer(ctx context.Context, err error, index int) bool {
	var status *uplink.StatusError
	if !errors.As(err, &status) {
		u.backoff()
		return false
	}
	switch {
	case errors.Is(err, uplink.ErrDeviceRevoked):
		u.daemon.markRevoked(ctx)
	case status.Status == http.StatusNotFound, status.Status == http.StatusGone:
		u.fail()
	case status.Code == uplink.CodeRichCaptureUnavailable:
		u.fail()
	case status.Code == uplink.CodeUploadIncomplete, status.Code == uplink.CodeChunkConflict:
		u.resync(ctx)
	case status.Code == uplink.CodeBodyChecksumMismatch && !u.daemon.spool.Intact(u.body):
		// The spooled copy is what is damaged; no retry mends it.
		u.fail()
	case status.Code == uplink.CodeBodyChecksumMismatch:
		// The server discarded the chunks; all are sent again, and its
		// third failure records the upload failed.
		u.body.Upload.ReceivedChunks = []int{}
		u.backoff()
	case status.Code == uplink.CodeChunkChecksumMismatch && index >= 0 && u.body.Resent == 0 && u.daemon.spool.Intact(u.body):
		u.body.Resent++
		u.daemon.spool.Save(u.body)
		return true
	case status.Status == http.StatusNotImplemented:
		// storage_unavailable: no storage is configured; it will not come.
		u.fail()
	case status.Status == http.StatusUnauthorized, status.Status == http.StatusTooManyRequests, status.Status >= 500:
		u.backoff()
	default:
		// chunk_size_mismatch, a damaged spool body or any other refusal:
		// the device's own fault, which no retry mends.
		u.fail()
	}
	return false
}

func (u *bodyUpload) resync(ctx context.Context) {
	state, err := u.client.ContentUpload(ctx, u.body.ContentID)
	if err != nil {
		var status *uplink.StatusError
		if errors.As(err, &status) && (status.Status == http.StatusNotFound || status.Status == http.StatusGone) {
			u.fail()
			return
		}
		u.backoff()
		return
	}
	u.settleBy(state)
}

func (u *bodyUpload) settleBy(state uplink.ContentUploadState) {
	switch {
	case state.State == uplink.UploadAvailable:
		u.daemon.spool.Settle(u.body.ContentKey)
	case state.State == uplink.UploadRecorded && state.Coverage == "collection_failed":
		u.fail()
	case state.State == uplink.UploadRecorded:
		u.daemon.spool.Settle(u.body.ContentKey)
	case state.Upload != nil:
		u.body.Upload.ReceivedChunks = slices.Clone(state.Upload.ReceivedChunks)
		u.daemon.spool.Save(u.body)
	}
}

func (u *bodyUpload) fail() { u.daemon.spool.Fail(u.body.ContentKey) }

// backoff waits 1s<<min(n,8) plus jitter, at most maxUploadBackoff, as the
// queue does.
func (u *bodyUpload) backoff() {
	if u.body.Failures < 16 {
		u.body.Failures++
	}
	delay := time.Second << min(u.body.Failures, 8)
	var jitter [1]byte
	rand.Read(jitter[:])
	delay += time.Duration(jitter[0]) * delay / 512
	u.body.NextAttempt = u.daemon.config.Now().Add(min(delay, maxUploadBackoff))
	u.daemon.spool.Save(u.body)
}

// richCaptureStatus is the heartbeat's rich_capture member, for a server
// that offered rich capture.
func (d *Daemon) richCaptureStatus() *uplink.RichCaptureStatus {
	cached, err := policy.Load(d.config.Layout.Policy())
	if err != nil || cached.Policy.RichCapture.Offer == nil {
		return nil
	}
	stats, _ := d.spool.Stats()
	health, _ := state.Load[state.Health](d.config.Layout.Health())
	report := &uplink.RichCaptureStatus{Sources: []uplink.RichSourceStatus{}, Spool: uplink.SpoolStatus{
		PendingBodies: stats.PendingBodies, PendingBytes: stats.PendingBytes, OldestPendingAt: stats.OldestPendingAt, FailedTotal: stats.FailedTotal,
	}}
	for _, adapter := range d.config.Registry.All() {
		if _, reads := adapter.(agent.ContentSource); !reads {
			continue
		}
		source := uplink.RichSourceStatus{Harness: adapter.ID(), State: "capturing"}
		if health.RichCapture != nil && health.RichCapture.StalledSources > 0 {
			source.State, source.Detail = "stalled", "spool full; reading resumes when uploads drain"
		}
		report.Sources = append(report.Sources, source)
	}
	return report
}
