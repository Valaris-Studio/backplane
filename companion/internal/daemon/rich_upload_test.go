// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/richcapture"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

const firstContent = "00000000-0000-4000-8000-000000000001"

// uploadFixture declares one 3-chunk body; tune changes the fake first.
func uploadFixture(t *testing.T, tune func(server *uplinktest.Server)) (*fixture, string) {
	t.Helper()
	f := newRichFixture(t)
	f.server.Lock()
	tune(f.server)
	f.server.Unlock()
	f.richHook(t, session, f.repo)
	body := strings.Repeat("0123456789abcdef", 1500)
	f.appendLines(t, session, replyLine("e1", f.stamp(), body))
	return f, body
}

func (f *fixture) passes(t *testing.T, count int) {
	t.Helper()
	for range count {
		*f.clock = f.clock.Add(10 * time.Minute)
		f.tick(t)
	}
}

// declaredContent is the server's row for key, which must exist.
func (f *fixture) declaredContent(t *testing.T, key string) *uplinktest.StoredContent {
	t.Helper()
	f.server.Lock()
	defer f.server.Unlock()
	content := f.server.Contents[key]
	if content == nil {
		t.Fatalf("%s was never declared", key)
	}
	return content
}

func spoolStats(f *fixture) (pending int, failed uint64) {
	stats, _ := f.daemon.spool.Stats()
	return stats.PendingBodies, stats.FailedTotal
}

// body_checksum_mismatch: every chunk is uploaded again from the spool.
func TestABodyChecksumMismatchReuploadsEveryChunk(t *testing.T) {
	f, body := uploadFixture(t, func(server *uplinktest.Server) { server.FinalizeFailures[firstContent] = 1 })
	f.passes(t, 6)
	if string(f.server.Body(itemKey("e1"))) != body || f.server.ChunkPuts != 6 {
		t.Fatalf("body %d bytes after %d chunk puts", len(f.server.Body(itemKey("e1"))), f.server.ChunkPuts)
	}
	if pending, failed := spoolStats(f); pending != 0 || failed != 0 {
		t.Fatalf("spool %d pending, %d failed", pending, failed)
	}
}

// After the server's third mismatch it records the upload failed; the
// device's next call meets 409 and settles the body.
func TestAThirdBodyChecksumMismatchEndsInTheServersRecordedFailure(t *testing.T) {
	f, _ := uploadFixture(t, func(server *uplinktest.Server) { server.FinalizeFailures[firstContent] = 99 })
	f.passes(t, 12)
	content := f.declaredContent(t, itemKey("e1"))
	f.server.Lock()
	finalizes := content.Finalizes
	f.server.Unlock()
	if pending, failed := spoolStats(f); pending != 0 || failed != 1 || finalizes != 3 {
		t.Fatalf("spool %d pending, %d failed after %d finalizes", pending, failed, finalizes)
	}
}

// chunk_checksum_mismatch: the chunk is read again and resent once.
func TestAChunkChecksumMismatchResendsTheChunkOnce(t *testing.T) {
	f, body := uploadFixture(t, func(server *uplinktest.Server) { server.ChunkChecksumFailures[firstContent] = 1 })
	f.passes(t, 4)
	if string(f.server.Body(itemKey("e1"))) != body || f.server.ChunkPuts != 4 {
		t.Fatalf("body %d bytes after %d chunk puts", len(f.server.Body(itemKey("e1"))), f.server.ChunkPuts)
	}
}

// A spooled body that no longer matches its digest is settled locally as
// failed; it never loops.
func TestADamagedSpoolBodyIsSettledLocallyWithoutLooping(t *testing.T) {
	f, _ := uploadFixture(t, func(server *uplinktest.Server) {
		server.UploadErrors[firstContent] = uplinktest.UploadError{Status: 503, Code: "storage_backend_unavailable"}
	})
	f.passes(t, 1)
	files, _ := filepath.Glob(filepath.Join(f.layout.RichDir(), "spool", "*.body"))
	if len(files) != 1 {
		t.Fatalf("spooled bodies: %v", files)
	}
	if err := os.WriteFile(files[0], []byte(strings.Repeat("X", 24000)), 0o600); err != nil {
		t.Fatal(err)
	}
	f.server.Lock()
	delete(f.server.UploadErrors, firstContent)
	f.server.ChunkChecksumFailures[firstContent] = 99
	f.server.Unlock()
	f.passes(t, 6)
	if pending, failed := spoolStats(f); pending != 0 || failed != 1 || f.server.ChunkPuts > 3 {
		t.Fatalf("spool %d pending, %d failed after %d puts", pending, failed, f.server.ChunkPuts)
	}
}

// chunk_size_mismatch is the device's own bug: terminal, counted.
func TestAChunkSizeMismatchIsTerminal(t *testing.T) {
	f, _ := uploadFixture(t, func(server *uplinktest.Server) {
		server.UploadErrors[firstContent] = uplinktest.UploadError{Status: 422, Code: "chunk_size_mismatch"}
	})
	f.passes(t, 3)
	if pending, failed := spoolStats(f); pending != 0 || failed != 1 {
		t.Fatalf("spool %d pending, %d failed", pending, failed)
	}
}

// chunk_conflict: the device reads the row's state and settles by it.
func TestAChunkConflictResyncsAndSettlesByTheServersState(t *testing.T) {
	f, _ := uploadFixture(t, func(server *uplinktest.Server) {
		server.UploadErrors[firstContent] = uplinktest.UploadError{Status: 503, Code: "storage_backend_unavailable"}
	})
	f.passes(t, 1)
	content := f.declaredContent(t, itemKey("e1"))
	f.server.Lock()
	delete(f.server.UploadErrors, firstContent)
	content.State = "recorded"
	f.server.Unlock()
	f.passes(t, 3)
	if pending, _ := spoolStats(f); pending != 0 {
		t.Fatalf("spool kept %d bodies of a settled row", pending)
	}
}

// A settled row takes the same bytes as complete (amendment 3): an upload
// already published elsewhere settles without failing.
func TestARowAlreadyAvailableTakesTheSameChunksAsComplete(t *testing.T) {
	f, body := uploadFixture(t, func(server *uplinktest.Server) {
		server.UploadErrors[firstContent] = uplinktest.UploadError{Status: 503, Code: "storage_backend_unavailable"}
	})
	f.passes(t, 1)
	content := f.declaredContent(t, itemKey("e1"))
	f.server.Lock()
	delete(f.server.UploadErrors, firstContent)
	content.State, content.Body = "available", []byte(body)
	f.server.Unlock()
	f.passes(t, 3)
	if pending, failed := spoolStats(f); pending != 0 || failed != 0 {
		t.Fatalf("spool %d pending, %d failed", pending, failed)
	}
}

// A bare 401 from a proxy is not the server revoking the device: the body
// waits, uncounted.
func TestABare401OnAChunkKeepsTheBody(t *testing.T) {
	f, body := uploadFixture(t, func(server *uplinktest.Server) {
		server.Status["/api/companion/contents/"+firstContent+"/chunks/0"] = 401
	})
	f.passes(t, 2)
	if pending, failed := spoolStats(f); pending != 1 || failed != 0 {
		t.Fatalf("spool %d pending, %d failed", pending, failed)
	}
	f.server.Lock()
	delete(f.server.Status, "/api/companion/contents/"+firstContent+"/chunks/0")
	f.server.Unlock()
	f.passes(t, 3)
	if string(f.server.Body(itemKey("e1"))) != body {
		t.Fatal("the body never arrived after the 401 cleared")
	}
}

// A body no queued record declares, never asked for by the server, is
// swept after an hour; a declared one waits for its record however long.
func TestASpooledBodyNoRecordDeclaresIsSweptAfterAnHour(t *testing.T) {
	f := newRichFixture(t)
	f.holdUploads(t, true)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, replyLine("e1", f.stamp(), strings.Repeat("r", 20<<10)))
	f.tick(t)
	orphan := strings.Repeat("0", 64)
	if _, err := f.daemon.spool.Stage(richcapture.Body{ContentKey: orphan}, []byte("orphan")); err != nil {
		t.Fatal(err)
	}
	*f.clock = f.clock.Add(2 * time.Hour)
	f.tick(t)
	if _, found, _ := f.daemon.spool.Get(orphan); found {
		t.Fatal("an orphaned body was kept")
	}
	if _, found, _ := f.daemon.spool.Get(itemKey("e1")); !found {
		t.Fatal("a body its queued record declares was swept")
	}
}

// The sweep sees every queued record while the queue isolates a 422: bodies
// other records declare are never taken for orphans.
func TestTheSweepKeepsBodiesOfRecordsTheQueueIsNotSendingYet(t *testing.T) {
	f := newRichFixture(t)
	f.holdUploads(t, true)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, replyLine("e1", f.stamp(), strings.Repeat("1", 20<<10)))
	f.tick(t)
	f.appendLines(t, session, replyLine("e2", f.stamp(), strings.Repeat("2", 20<<10)))
	*f.clock = f.clock.Add(time.Second)
	f.tick(t)
	q := queue.Open(f.layout)
	batch, _ := q.Next(32, 8<<20)
	if len(batch.IDs) < 2 {
		t.Fatalf("setup: %d records queued", len(batch.IDs))
	}
	q.RecordUnprocessable(batch)
	*f.clock = f.clock.Add(2 * time.Hour)
	f.tick(t)
	for _, id := range []string{"e1", "e2"} {
		if _, found, _ := f.daemon.spool.Get(itemKey(id)); !found {
			t.Fatalf("%s's body was swept while its record waited", id)
		}
	}
}

// A body the server asks for that is no longer spooled will never arrive:
// it is counted, never silently forgotten.
func TestAnUploadAskedForABodyNoLongerSpooledIsCounted(t *testing.T) {
	f := newRichFixture(t)
	f.holdUploads(t, true)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, replyLine("e1", f.stamp(), strings.Repeat("r", 20<<10)))
	f.tick(t)
	files, _ := filepath.Glob(filepath.Join(f.layout.RichDir(), "spool", "*"))
	for _, file := range files {
		if !strings.HasSuffix(file, "ledger.json") {
			os.Remove(file)
		}
	}
	f.holdUploads(t, false)
	f.passes(t, 2)
	if _, failed := spoolStats(f); failed != 1 || richHealth(t, f).MissingBodies != 1 {
		t.Fatalf("failed %d, health %+v", failed, richHealth(t, f))
	}
}

// 501 storage_unavailable is permanent (amendment 1): no storage is
// configured, so the body is given up at once rather than retried.
func TestAServerWithoutStorageEndsTheUploadAtOnce(t *testing.T) {
	f, _ := uploadFixture(t, func(server *uplinktest.Server) {
		server.UploadErrors[firstContent] = uplinktest.UploadError{Status: 501, Code: "storage_unavailable"}
	})
	f.passes(t, 1)
	if pending, failed := spoolStats(f); pending != 0 || failed != 1 {
		t.Fatalf("spool %d pending, %d failed", pending, failed)
	}
}

// When finalize finds the body's digest wrong and the spooled body no
// longer matches its own, the device's copy is at fault: it fails locally,
// not after three server finalizes.
func TestADamagedSpoolBodyFailsLocallyAtTheFirstBodyMismatch(t *testing.T) {
	f, _ := uploadFixture(t, func(server *uplinktest.Server) {
		server.UploadErrors[firstContent] = uplinktest.UploadError{Status: 503, Code: "storage_backend_unavailable"}
	})
	f.passes(t, 1)
	files, _ := filepath.Glob(filepath.Join(f.layout.RichDir(), "spool", "*.body"))
	if len(files) != 1 {
		t.Fatalf("spooled bodies: %v", files)
	}
	os.WriteFile(files[0], []byte(strings.Repeat("X", 24000)), 0o600)
	f.server.Lock()
	delete(f.server.UploadErrors, firstContent)
	f.server.Unlock()
	f.passes(t, 4)
	content := f.declaredContent(t, itemKey("e1"))
	f.server.Lock()
	finalizes := content.Finalizes
	f.server.Unlock()
	if pending, failed := spoolStats(f); pending != 0 || failed != 1 || finalizes != 1 {
		t.Fatalf("spool %d pending, %d failed after %d finalizes", pending, failed, finalizes)
	}
}

// The sweep stops at a queued record it cannot read: its bodies may be
// declared there, so none are taken for orphans.
func TestTheSweepKeepsBodiesWhenAQueuedRecordCannotBeRead(t *testing.T) {
	f := newRichFixture(t)
	f.holdUploads(t, true)
	f.richHook(t, session, f.repo)
	f.appendLines(t, session, replyLine("e1", f.stamp(), strings.Repeat("1", 20<<10)))
	f.tick(t)
	entries, _ := os.ReadDir(f.layout.QueueDir())
	for _, entry := range entries {
		os.Chmod(filepath.Join(f.layout.QueueDir(), entry.Name()), 0o644)
	}
	*f.clock = f.clock.Add(2 * time.Hour)
	f.tick(t)
	if _, found, _ := f.daemon.spool.Get(itemKey("e1")); !found {
		t.Fatal("a body was swept while the record declaring it could not be read")
	}
}
