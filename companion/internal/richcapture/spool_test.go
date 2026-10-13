// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package richcapture

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

func key(n byte) string { return strings.Repeat(string("0123456789abcdef"[n%16]), 64) }

const captureA = "0123456789abcdef0123456789abcdef"

func openSpool(t *testing.T) (*Spool, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "spool")
	clock := time.Date(2026, 10, 9, 12, 0, 0, 0, time.UTC)
	return OpenSpool(dir).WithClock(func() time.Time { clock = clock.Add(time.Second); return clock }), dir
}

func TestStagedBodyIsDurableAndReadByChunk(t *testing.T) {
	spool, _ := openSpool(t)
	data := bytes.Repeat([]byte("0123456789"), 1000)
	body, err := spool.Stage(Body{ContentKey: key(1), CaptureID: captureA}, data)
	sum := sha256.Sum256(data)
	if err != nil || body.ByteCount != int64(len(data)) || body.SHA256 != hex.EncodeToString(sum[:]) || body.CaptureID != captureA {
		t.Fatalf("staged %+v %v", body, err)
	}
	if found, err := spool.AwaitUpload(key(1), "content-1", uplink.UploadSlot{ChunkBytes: 4096, ChunkCount: 3}); err != nil || !found {
		t.Fatal(err)
	}
	reopened := OpenSpool(spool.dir)
	got, found, err := reopened.Get(key(1))
	if err != nil || !found || got.ContentID != "content-1" || got.Upload == nil || got.Upload.ChunkCount != 3 {
		t.Fatalf("after reopen: %+v %v %v", got, found, err)
	}
	var joined []byte
	for index := range 3 {
		chunk, err := reopened.Chunk(got, index)
		if err != nil {
			t.Fatal(err)
		}
		joined = append(joined, chunk...)
	}
	if !bytes.Equal(joined, data) {
		t.Fatalf("chunks rejoin to %d bytes, want %d", len(joined), len(data))
	}
}

func TestStagingAKeyAgainKeepsItsUploadState(t *testing.T) {
	spool, _ := openSpool(t)
	spool.Stage(Body{ContentKey: key(1), CaptureID: captureA}, []byte("body"))
	spool.AwaitUpload(key(1), "content-1", uplink.UploadSlot{ChunkBytes: 4096, ChunkCount: 1})
	again, err := spool.Stage(Body{ContentKey: key(1), CaptureID: "fedcba9876543210fedcba9876543210"}, []byte("body"))
	if err != nil || again.ContentID != "content-1" {
		t.Fatalf("restaging lost the upload state: %+v %v", again, err)
	}
}

// Backpressure: a full spool refuses the next body and keeps every body it
// holds; nothing unacknowledged is ever evicted.
func TestAFullSpoolRefusesNewBodiesAndEvictsNothing(t *testing.T) {
	spool, _ := openSpool(t)
	spool.WithMaxBytes(100)
	if _, err := spool.Stage(Body{ContentKey: key(1), CaptureID: captureA}, bytes.Repeat([]byte("a"), 60)); err != nil {
		t.Fatal(err)
	}
	if _, err := spool.Stage(Body{ContentKey: key(2), CaptureID: captureA}, bytes.Repeat([]byte("b"), 60)); !errors.Is(err, ErrSpoolFull) {
		t.Fatalf("over the bound: %v", err)
	}
	stats, err := spool.Stats()
	if err != nil || stats.PendingBodies != 1 || stats.PendingBytes != 60 || stats.OldestPendingAt == nil {
		t.Fatalf("stats %+v %v", stats, err)
	}
	if _, found, _ := spool.Get(key(1)); !found {
		t.Fatal("a spooled body was evicted")
	}
}

func TestSettledAndFailedBodiesAreDeletedAndFailuresCounted(t *testing.T) {
	spool, _ := openSpool(t)
	spool.Stage(Body{ContentKey: key(1), CaptureID: captureA}, []byte("one"))
	spool.Stage(Body{ContentKey: key(2), CaptureID: captureA}, []byte("two"))
	if err := spool.Settle(key(1)); err != nil {
		t.Fatal(err)
	}
	if err := spool.Fail(key(2)); err != nil {
		t.Fatal(err)
	}
	stats, _ := spool.Stats()
	if stats.PendingBodies != 0 || stats.PendingBytes != 0 || stats.FailedTotal != 1 {
		t.Fatalf("stats %+v", stats)
	}
	if err := spool.Settle(key(1)); err != nil {
		t.Fatalf("settling twice must be harmless: %v", err)
	}
	if again, _ := OpenSpool(spool.dir).Stats(); again.FailedTotal != 1 {
		t.Fatal("the failure count is not durable")
	}
}

// A crash mid-stage leaves a body without its sidecar: it was never
// declared, so it is not pending and the sweep removes it.
func TestABodyACrashLeftWithoutItsSidecarIsSwept(t *testing.T) {
	spool, dir := openSpool(t)
	spool.Stage(Body{ContentKey: key(1), CaptureID: captureA}, []byte("kept"))
	if err := os.WriteFile(filepath.Join(dir, key(2)+".body"), []byte("orphan"), 0o600); err != nil {
		t.Fatal(err)
	}
	if stats, _ := spool.Stats(); stats.PendingBodies != 1 || stats.PendingBytes != 4 {
		t.Fatalf("an orphan counts as pending: %+v", stats)
	}
	if err := spool.Sweep(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, key(2)+".body")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("orphan body left: %v", err)
	}
	if _, found, _ := spool.Get(key(1)); !found {
		t.Fatal("the sweep removed a declared body")
	}
}

func TestPurgeDeletesEveryBody(t *testing.T) {
	spool, _ := openSpool(t)
	spool.Stage(Body{ContentKey: key(1), CaptureID: captureA}, []byte("one"))
	spool.Stage(Body{ContentKey: key(2), CaptureID: captureA}, []byte("two"))
	if bodies, _ := spool.Bodies(); len(bodies) != 2 {
		t.Fatalf("setup: %d bodies", len(bodies))
	}
	if err := spool.Purge(); err != nil {
		t.Fatal(err)
	}
	if bodies, _ := spool.Bodies(); len(bodies) != 0 {
		t.Fatalf("bodies left: %+v", bodies)
	}
}

func TestBodiesAreListedOldestFirst(t *testing.T) {
	spool, _ := openSpool(t)
	spool.Stage(Body{ContentKey: key(2), CaptureID: captureA}, []byte("first"))
	spool.Stage(Body{ContentKey: key(1), CaptureID: captureA}, []byte("second"))
	bodies, err := spool.Bodies()
	if err != nil || len(bodies) != 2 || bodies[0].ContentKey != key(2) {
		t.Fatalf("bodies %+v %v", bodies, err)
	}
}
