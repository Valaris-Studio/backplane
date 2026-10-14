// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package richcapture

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

const (
	// MaxLineBytes bounds one session-file line held in memory; a longer one
	// is collection_failed/record_too_large.
	MaxLineBytes = 32 << 20
	// maxSeenKeys bounds the keys a cursor remembers as declared.
	maxSeenKeys = 20000
	// prefixBytes are digested to recognize a file replaced in place.
	prefixBytes     = 4 << 10
	readBufferBytes = 64 << 10
	// A cursor holds up to maxSeenKeys 64-character keys.
	maxCursorBytes = 4 << 20
)

// Cursor is the read position in one session file, kept per connection
// across restarts and generations.
type Cursor struct {
	Path string `json:"path"`
	// Identity is the file's device and inode (volume serial and file index
	// on Windows); a new identity at the same path is another file.
	Identity     string    `json:"identity"`
	Size         int64     `json:"size"`
	ModTime      time.Time `json:"mod_time"`
	PrefixSHA256 string    `json:"prefix_sha256"`
	Offset       int64     `json:"offset"`
	SeenKeys     []string  `json:"seen_keys,omitempty"`
	// SourceIncarnation distinguishes deliveries after a rewrite that keeps
	// the physical identity. Zero preserves capture IDs from legacy cursors.
	SourceIncarnation uint64 `json:"source_incarnation,omitempty"`
	// Parser is the agent parser's own state for the file.
	Parser json.RawMessage `json:"parser,omitempty"`
	// Began is when the native session began; ParentSessionID the session it
	// forked from, when its header names one.
	Began           time.Time `json:"began,omitzero"`
	ParentSessionID string    `json:"parent_session_id,omitempty"`
	// HeaderBegan: Began is the file's own header, not a first sighting.
	HeaderBegan bool `json:"header_began,omitempty"`
	// Harness is what the file is captured for, fixed when first read so a
	// later sighting naming another cannot re-key it.
	Harness string `json:"harness,omitempty"`
	// StalledSince is when a full spool first held the read back.
	StalledSince time.Time `json:"stalled_since,omitzero"`
	// Drain is how far the oversized line starting at Offset, already
	// reported, was read past. Offset stays at the line's start, where a
	// binary that knows no drain resumes and skips the line whole.
	Drain *agent.Skipped `json:"drain,omitempty"`
	// Committing is a record being queued: once it is in the queue, the read
	// resumes after it.
	Committing *Commit `json:"committing,omitempty"`
	seen       map[string]bool
}

type Commit struct {
	CaptureID string          `json:"capture_id"`
	End       int64           `json:"end"`
	Drain     *agent.Skipped  `json:"drain,omitempty"`
	Keys      []string        `json:"keys,omitempty"`
	Parser    json.RawMessage `json:"parser,omitempty"`
}

// Position is where reading resumes: past the drained part of an
// oversized line, else Offset.
func (c Cursor) Position() int64 {
	if c.Drain != nil {
		return c.Drain.To
	}
	return c.Offset
}

func (c *Cursor) Seen(key string) bool {
	if c.seen == nil {
		c.seen = make(map[string]bool, len(c.SeenKeys))
		for _, seen := range c.SeenKeys {
			c.seen[seen] = true
		}
	}
	return c.seen[key]
}

// Remember notes keys as declared, keeping the newest maxSeenKeys.
func (c *Cursor) Remember(keys ...string) {
	for _, key := range keys {
		if c.Seen(key) {
			continue
		}
		c.SeenKeys = append(c.SeenKeys, key)
		c.seen[key] = true
	}
	if overflow := len(c.SeenKeys) - maxSeenKeys; overflow > 0 {
		for _, forgotten := range c.SeenKeys[:overflow] {
			delete(c.seen, forgotten)
		}
		c.SeenKeys = append([]string(nil), c.SeenKeys[overflow:]...)
	}
}

// Cursors persist read positions under one directory.
type Cursors struct{ dir string }

func OpenCursors(dir string) Cursors { return Cursors{dir: dir} }

func (c Cursors) path(source string) string {
	sum := sha256.Sum256([]byte(source))
	return filepath.Join(c.dir, hex.EncodeToString(sum[:16])+".json")
}

func (c Cursors) Load(path string) (Cursor, bool, error) {
	var cursor Cursor
	err := store.ReadJSON(c.path(path), maxCursorBytes, &cursor)
	if errors.Is(err, os.ErrNotExist) {
		return Cursor{}, false, nil
	}
	if err != nil {
		return Cursor{}, false, err
	}
	return cursor, cursor.Path == path, nil
}

func (c Cursors) Save(cursor Cursor) error {
	if err := store.EnsurePrivateDir(c.dir); err != nil {
		return err
	}
	return store.WriteJSON(c.path(cursor.Path), cursor)
}

// Change is what happened to a session file since its cursor was saved.
type Change int

const (
	// FirstSeen: no cursor yet.
	FirstSeen Change = iota
	// Unchanged: read to its end, and nothing written since.
	Unchanged
	// Grown: there is more past the read position.
	Grown
	// Replaced: another file now has the path, or this one was truncated or
	// rewritten; its old position means nothing.
	Replaced
)

var ErrSourceMissing = errors.New("source_missing")

// SourceFile is an open session file read from a cursor.
type SourceFile struct {
	file     *os.File
	info     os.FileInfo
	cursor   Cursor
	reader   *bufio.Reader
	position int64
	// draining: position is inside the oversized line starting at
	// drainStart, being read past.
	draining   bool
	drainStart int64
	// digested is what checking and marking drains read, not yet charged.
	digested int64
}

// OpenSource opens path and compares it with its cursor.
func OpenSource(path string, cursor Cursor, known bool) (*SourceFile, Change, error) {
	file, err := openSource(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, FirstSeen, ErrSourceMissing
	}
	if err != nil {
		return nil, FirstSeen, err
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		file.Close()
		return nil, FirstSeen, ErrSourceMissing
	}
	source := &SourceFile{file: file, info: info, cursor: cursor}
	source.cursor.Path = path
	source.reader = bufio.NewReaderSize(file, readBufferBytes)
	if !known {
		source.cursor.Drain = nil
		return source, FirstSeen, nil
	}
	switch {
	case !source.Describes(cursor):
		// The drain was through a line of another file.
		source.cursor.Drain = nil
		return source, Replaced, nil
	case info.Size() == cursor.Size && info.ModTime().Equal(cursor.ModTime) && cursor.Position() == info.Size():
		return source, Unchanged, nil
	}
	return source, Grown, nil
}

// Describes reports whether cursor was marked on this file, as it is or as
// what it has grown from: the same identity, no shorter, and the same
// content as far as the cursor saw. Identity alone is not enough: ext4
// hands a file recreated at a path its predecessor's inode.
func (f *SourceFile) Describes(cursor Cursor) bool {
	return fileIdentity(f.file, f.info) == cursor.Identity && f.info.Size() >= cursor.Position() && f.info.Size() >= cursor.Size &&
		f.prefixDigest(cursor.Size) == cursor.PrefixSHA256
}

func (f *SourceFile) prefixDigest(size int64) string {
	prefix := make([]byte, min(size, prefixBytes))
	if _, err := f.file.ReadAt(prefix, 0); err != nil && !errors.Is(err, io.EOF) {
		return ""
	}
	sum := sha256.Sum256(prefix)
	return hex.EncodeToString(sum[:])
}

// LineState is the outcome of reading one line.
type LineState int

const (
	LineComplete LineState = iota
	// LineOversized: a line longer than the limit, reported once it passes
	// the limit; what is left of it is read past in LineDraining steps.
	LineOversized
	// LineIncomplete: the file ends before the line's newline; it waits.
	LineIncomplete
	// LineDraining: more of an oversized line was read past; nothing of it
	// is a line.
	LineDraining
)

type Line struct {
	Bytes  []byte
	Offset int64
	End    int64
}

// FirstLine is the file's first complete line, for a parser's Header.
func (f *SourceFile) FirstLine(limit int) ([]byte, bool) {
	// A header ends within limit bytes, its newline included: reading no
	// further bounds a malformed one.
	header := io.NewSectionReader(f.file, 0, min(f.info.Size(), int64(limit)))
	content, _, complete := agent.NextLine(bufio.NewReaderSize(header, readBufferBytes), limit)
	return content, complete && content != nil
}

// SeekTo positions the read at offset; at the cursor's own offset, a drain
// the cursor was marked in goes on, unless the line was rewritten since.
func (f *SourceFile) SeekTo(offset int64) error {
	drain := f.cursor.Drain
	if drain != nil && offset == f.cursor.Offset {
		f.digested += agent.DigestCost(offset, drain.To)
	}
	if drain != nil && offset == f.cursor.Offset && drain.Holds(f.file, offset, f.info.Size()) {
		if err := f.seek(drain.To); err != nil {
			return err
		}
		f.draining, f.drainStart = true, offset
		return nil
	}
	f.draining = false
	return f.seek(offset)
}

func (f *SourceFile) seek(offset int64) error {
	if _, err := f.file.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	f.reader.Reset(f.file)
	f.position = offset
	return nil
}

// Next reads the line at the current position, consuming at most limit
// bytes and one read buffer. Only an LF-terminated line is complete; a
// longer one than limit is reported oversized once, then read past.
func (f *SourceFile) Next(limit int) (Line, LineState) {
	start := f.position
	if f.draining {
		size, ended := agent.SkipLine(f.reader, limit)
		if size == 0 {
			return Line{Offset: start, End: start}, LineIncomplete
		}
		f.position += size
		f.draining = !ended
		return Line{Offset: start, End: f.position}, LineDraining
	}
	content, size, ended, oversized := agent.BoundedLine(f.reader, limit)
	if oversized {
		f.position += size
		f.draining, f.drainStart = !ended, start
		return Line{Offset: start, End: f.position}, LineOversized
	}
	if !ended {
		// Read again from its start once the writer finishes it.
		f.seek(start)
		return Line{Offset: start, End: start}, LineIncomplete
	}
	f.position += size
	return Line{Bytes: content, Offset: start, End: f.position}, LineComplete
}

// Digested returns, and forgets, what checking and marking drains read of
// the file since it was last asked, for a reader's budget.
func (f *SourceFile) Digested() int64 {
	digested := f.digested
	f.digested = 0
	return digested
}

// Position is where the next line is read, past any drain resumed.
func (f *SourceFile) Position() int64 { return f.position }

// Mark is the cursor describing the file as it was opened, positioned at
// offset; where the read stands there inside an oversized line, at the
// line's start with the drain so far. Size can trail offset when the file
// grew while it was read; the next open then sees it Grown.
func (f *SourceFile) Mark(offset int64) Cursor {
	cursor := f.cursor
	cursor.Identity = fileIdentity(f.file, f.info)
	cursor.Size, cursor.ModTime = f.info.Size(), f.info.ModTime()
	cursor.PrefixSHA256 = f.prefixDigest(f.info.Size())
	cursor.Offset, cursor.Drain = offset, nil
	if f.draining && offset == f.position {
		f.digested += agent.DigestCost(f.drainStart, offset)
		drain := agent.Skip(f.file, f.drainStart, offset)
		cursor.Offset, cursor.Drain = f.drainStart, &drain
	}
	return cursor
}

// TrailingRun is where the file's trailing run of complete lines that keep
// accepts begins, and whether limit cut it. The limit bounds the older
// content looked at, not the newest line, which is found up to MaxLineBytes.
func (f *SourceFile) TrailingRun(limit int64, keep func(line []byte) bool) (int64, bool) {
	size := f.info.Size()
	start := max(0, size-limit)
	tail := f.tailFrom(start)
	end := bytes.LastIndexByte(tail, '\n') + 1
	if start > 0 && (end == 0 || bytes.IndexByte(tail, '\n')+1 == end) {
		// The newest line, complete or still being written, began before
		// the bound: find its start.
		reach := max(0, start-MaxLineBytes)
		head := f.tailFrom(reach)
		before := len(head)
		if end > 0 {
			before = int(start-reach) + end - 1
		}
		newest := bytes.LastIndexByte(head[:before], '\n') + 1
		if newest == 0 && reach > 0 {
			return start + int64(end), true
		}
		start = max(0, reach+int64(newest)-limit)
		tail = f.tailFrom(start)
		end = bytes.LastIndexByte(tail, '\n') + 1
	}
	if end == 0 {
		// One line, still being written: it is read whole once complete.
		return start, false
	}
	first := 0
	if start > 0 {
		first = bytes.IndexByte(tail, '\n') + 1
	}
	boundary := end
	for boundary > first {
		line := bytes.LastIndexByte(tail[:boundary-1], '\n') + 1
		if !keep(tail[line : boundary-1]) {
			return start + int64(boundary), false
		}
		boundary = line
	}
	return start + int64(boundary), start > 0
}

func (f *SourceFile) tailFrom(start int64) []byte {
	tail := make([]byte, f.info.Size()-start)
	read, _ := f.file.ReadAt(tail, start)
	return tail[:read]
}

func (f *SourceFile) Size() int64 { return f.info.Size() }

// Info is the file as it was when opened.
func (f *SourceFile) Info() os.FileInfo { return f.info }

func (f *SourceFile) Close() error { return f.file.Close() }
