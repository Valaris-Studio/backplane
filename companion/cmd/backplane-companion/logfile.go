// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"os"
	"path/filepath"
	"sync"

	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// maxLogBytes caps each log file; with one rotated file the daemon's log
// never exceeds twice this.
const maxLogBytes = 5 << 20

type rotatingLog struct {
	mu       sync.Mutex
	path     string
	maxBytes int64
	file     *os.File
	size     int64
}

func openRotatingLog(path string, maxBytes int64) (*rotatingLog, error) {
	if err := store.EnsurePrivateDir(filepath.Dir(path)); err != nil {
		return nil, err
	}
	log := &rotatingLog{path: path, maxBytes: maxBytes}
	return log, log.open()
}

func (l *rotatingLog) open() error {
	if err := store.RejectSymlink(l.path); err != nil {
		return err
	}
	file, err := os.OpenFile(l.path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return err
	}
	l.file, l.size = file, info.Size()
	return nil
}

// Write rotates to path.1 (replacing it) before a write would pass the cap.
func (l *rotatingLog) Write(data []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.size > 0 && l.size+int64(len(data)) > l.maxBytes {
		l.file.Close()
		if err := os.Rename(l.path, l.path+".1"); err != nil {
			return 0, err
		}
		if err := l.open(); err != nil {
			return 0, err
		}
	}
	written, err := l.file.Write(data)
	l.size += int64(written)
	return written, err
}

func (l *rotatingLog) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.file.Close()
}
