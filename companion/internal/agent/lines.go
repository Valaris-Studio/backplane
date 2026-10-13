// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package agent

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
)

// NextLine reads one line of at most limit bytes without its newline. A
// longer line is consumed and returned empty; a line not yet ended by a
// newline is incomplete.
func NextLine(reader *bufio.Reader, limit int) (content []byte, size int64, complete bool) {
	oversized := false
	for {
		chunk, err := reader.ReadSlice('\n')
		size += int64(len(chunk))
		if !oversized && len(content)+len(chunk) > limit {
			oversized, content = true, nil
		}
		if !oversized {
			content = append(content, chunk...)
		}
		switch {
		case err == nil:
			return bytes.TrimRight(content, "\r\n"), size, true
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		default:
			return nil, size, false
		}
	}
}

// BoundedLine reads one line as NextLine does, but stops a longer line as
// soon as it passes limit, consuming at most limit bytes and one buffered
// read: oversized, its content is nil and, unless ended, SkipLine reads
// past its rest.
func BoundedLine(reader *bufio.Reader, limit int) (content []byte, size int64, ended, oversized bool) {
	for {
		chunk, err := reader.ReadSlice('\n')
		size += int64(len(chunk))
		if size > int64(limit) {
			return nil, size, err == nil, true
		}
		content = append(content, chunk...)
		switch {
		case err == nil:
			return bytes.TrimRight(content, "\r\n"), size, true, false
		case errors.Is(err, bufio.ErrBufferFull):
			continue
		default:
			return nil, size, false, false
		}
	}
}

// SkipLine reads past about limit more bytes of an oversized line, at most
// one buffered read more; ended once its newline is consumed. Nothing read
// is kept.
func SkipLine(reader *bufio.Reader, limit int) (size int64, ended bool) {
	for size < int64(limit) {
		chunk, err := reader.ReadSlice('\n')
		size += int64(len(chunk))
		if err == nil {
			return size, true
		}
		if !errors.Is(err, bufio.ErrBufferFull) {
			return size, false
		}
	}
	return size, false
}

// skippedDigestBytes is how much of each end of a skipped stretch is
// digested: enough to tell a rewritten file, without reading it all again.
const skippedDigestBytes = 4 << 10

// Skipped is a stretch of a file a reader went past without reading it as
// lines, up to To. Head and Tail digest its first and last bytes, so a file
// rewritten since is not taken for the one read; a rewrite that keeps both
// ends is not told apart.
type Skipped struct {
	To   int64  `json:"to"`
	Head string `json:"head"`
	Tail string `json:"tail"`
}

func Skip(file io.ReaderAt, from, to int64) Skipped {
	head, tail := RangeDigests(file, from, to)
	return Skipped{To: to, Head: head, Tail: tail}
}

// Holds reports whether a file of size still has, from from, the stretch
// that was skipped. A digest that could not be read, then or now, never
// vouches for it.
func (s Skipped) Holds(file io.ReaderAt, from, size int64) bool {
	if s.To < from || s.To > size || s.Head == "" || s.Tail == "" {
		return false
	}
	head, tail := RangeDigests(file, from, s.To)
	return head == s.Head && tail == s.Tail
}

// DigestCost is what Skip or Holds reads of [from, to): both windows.
func DigestCost(from, to int64) int64 { return 2 * min(max(to-from, 0), skippedDigestBytes) }

// RangeDigests digest the first and last skippedDigestBytes of [from, to);
// a window that cannot be read digests empty.
func RangeDigests(file io.ReaderAt, from, to int64) (head, tail string) {
	window := min(to-from, skippedDigestBytes)
	return digestAt(file, from, window), digestAt(file, to-window, window)
}

func digestAt(file io.ReaderAt, at, length int64) string {
	content := make([]byte, length)
	if _, err := file.ReadAt(content, at); err != nil && length > 0 {
		return ""
	}
	sum := sha256.Sum256(content)
	return hex.EncodeToString(sum[:16])
}
