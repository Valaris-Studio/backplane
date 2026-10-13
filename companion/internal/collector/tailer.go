// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package collector

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"

	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

const (
	maxLineBytes    = 1 << 20
	maxLinesPerNext = 512
)

// Position identifies one line: which file (by a signature of its first
// line, which survives the renames into .1 and .2) and where it starts.
type Position struct {
	Signature string `json:"signature"`
	Offset    int64  `json:"offset"`
}

func (p Position) Key() string { return fmt.Sprintf("%s:%d", p.Signature, p.Offset) }

// Tailer reads complete lines from a file the collector appends to and
// rotates (path → path.1 → path.2), remembering its position across restarts.
type Tailer struct {
	path      string
	statePath string
}

func NewTailer(path, statePath string) *Tailer { return &Tailer{path: path, statePath: statePath} }

type tailFile struct {
	path      string
	signature string
	size      int64
}

// files lists the collector's files that have content, oldest first.
func (t *Tailer) files() ([]tailFile, error) {
	var files []tailFile
	for archive := rotateArchives; archive >= 0; archive-- {
		path := t.path
		if archive > 0 {
			path += "." + strconv.Itoa(archive)
		}
		signature, err := signature(path)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		files = append(files, tailFile{path: path, signature: signature, size: info.Size()})
	}
	return files, nil
}

// start finds the file holding position; when that file was rotated away
// entirely, reading resumes at the oldest file still present.
func start(files []tailFile, position Position) (int, int64) {
	for index, file := range files {
		if file.signature == position.Signature {
			return index, position.Offset
		}
	}
	return 0, 0
}

// Next hands each new complete line to consume, oldest first. It moves to a
// newer file only after reading an older one to its end, saves its position
// once per pass and only past lines consume accepted, so a line whose
// consumer failed, or any line after a crash, is delivered again; consumers
// dedupe by Position.
func (t *Tailer) Next(consume func(line []byte, position Position) error) error {
	position, err := t.load()
	if err != nil {
		return err
	}
	files, err := t.files()
	if err != nil || len(files) == 0 {
		return err
	}
	index, offset := start(files, position)
	budget := maxLinesPerNext
	for ; index < len(files); index++ {
		current := Position{Signature: files[index].signature, Offset: offset}
		current, finished, err := readFrom(files[index], current, consume, &budget)
		if saveErr := t.save(current); err != nil || saveErr != nil {
			return errors.Join(err, saveErr)
		}
		if !finished || index == len(files)-1 {
			return nil
		}
		offset = 0
	}
	return nil
}

// Backlog is the number of unread bytes, used to push back on producers
// before unread data could be rotated away.
func (t *Tailer) Backlog() (int64, error) {
	position, err := t.load()
	if err != nil {
		return 0, err
	}
	files, err := t.files()
	if err != nil || len(files) == 0 {
		return 0, err
	}
	index, offset := start(files, position)
	backlog := files[index].size - offset
	for _, file := range files[index+1:] {
		backlog += file.size
	}
	return backlog, nil
}

// readFrom delivers lines from file until its end (finished) or until the
// line budget runs out.
func readFrom(file tailFile, position Position, consume func([]byte, Position) error, budget *int) (Position, bool, error) {
	handle, err := os.Open(file.path)
	if err != nil {
		return position, false, nil
	}
	defer handle.Close()
	// A rotation between listing and opening would hand us another file.
	if opened, err := signatureOf(handle); err != nil || opened != file.signature {
		return position, false, nil
	}
	if _, err := handle.Seek(position.Offset, io.SeekStart); err != nil {
		return position, false, err
	}
	reader := bufio.NewReaderSize(handle, 64<<10)
	for *budget > 0 {
		line, err := reader.ReadSlice('\n')
		if errors.Is(err, bufio.ErrBufferFull) {
			line, err = readLongLine(reader, line)
		}
		if err != nil {
			// End of file, possibly after a partial line the writer will finish.
			return position, true, nil
		}
		if len(line) <= maxLineBytes {
			if err := consume(line[:len(line)-1], position); err != nil {
				return position, false, err
			}
		}
		position.Offset += int64(len(line))
		*budget--
	}
	return position, false, nil
}

func readLongLine(reader *bufio.Reader, prefix []byte) ([]byte, error) {
	line := append([]byte(nil), prefix...)
	for {
		chunk, err := reader.ReadSlice('\n')
		line = append(line, chunk...)
		if !errors.Is(err, bufio.ErrBufferFull) {
			return line, err
		}
	}
}

// signature identifies a file by its first complete line, which never
// changes once written (Beacon events carry unique ids and timestamps).
func signature(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	return signatureOf(file)
}

func signatureOf(file *os.File) (string, error) {
	reader := bufio.NewReaderSize(io.NewSectionReader(file, 0, 1<<62), 64<<10)
	first, err := reader.ReadSlice('\n')
	if err != nil {
		// No complete line yet: the file has no identity to track.
		return "", os.ErrNotExist
	}
	sum := sha256.Sum256(first)
	return hex.EncodeToString(sum[:16]), nil
}

func (t *Tailer) load() (Position, error) {
	var position Position
	err := store.ReadJSON(t.statePath, 4096, &position)
	if errors.Is(err, os.ErrNotExist) {
		return Position{}, nil
	}
	return position, err
}

func (t *Tailer) save(position Position) error { return store.WriteJSON(t.statePath, position) }
