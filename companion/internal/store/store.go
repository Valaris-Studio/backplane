// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package store owns the companion's private data directory: its layout,
// atomic private file writes and cross-process locks.
package store

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"time"

	"github.com/gofrs/flock"
)

// EnvHome overrides the data directory. Every test uses it.
const EnvHome = "BACKPLANE_COMPANION_HOME"

var ErrUnsafePath = errors.New("unsafe_storage_path")

type Layout struct{ Root string }

func DefaultRoot(getenv func(string) string, goos, home string) (string, error) {
	if override := getenv(EnvHome); override != "" {
		if !filepath.IsAbs(override) {
			return "", fmt.Errorf("%w: %s must be absolute", ErrUnsafePath, EnvHome)
		}
		return filepath.Clean(override), nil
	}
	if home == "" {
		return "", fmt.Errorf("%w: home directory unknown", ErrUnsafePath)
	}
	switch goos {
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Backplane Companion"), nil
	case "windows":
		base := getenv("LOCALAPPDATA")
		if base == "" {
			base = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(base, "Backplane", "Companion"), nil
	default:
		base := getenv("XDG_STATE_HOME")
		if base == "" || !filepath.IsAbs(base) {
			base = filepath.Join(home, ".local", "state")
		}
		return filepath.Join(base, "backplane-companion"), nil
	}
}

func Open(root string) (Layout, error) {
	if !filepath.IsAbs(root) {
		return Layout{}, fmt.Errorf("%w: data directory must be absolute", ErrUnsafePath)
	}
	layout := Layout{Root: filepath.Clean(root)}
	for _, dir := range []string{layout.Root, layout.InboxDir(), layout.QueueDir(), layout.WorkDir()} {
		if err := EnsurePrivateDir(dir); err != nil {
			return Layout{}, err
		}
	}
	// Lock files belong to the layout, so a hook invocation creates no files
	// beyond the ones it means to write.
	for _, lock := range []string{layout.StateLock(), layout.DaemonLock(), layout.SessionLock()} {
		if err := touchPrivate(lock); err != nil {
			return Layout{}, err
		}
	}
	return layout, nil
}

func touchPrivate(path string) error {
	if err := RejectSymlink(path); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return err
	}
	return file.Close()
}

func (l Layout) Installation() string { return filepath.Join(l.Root, "installation.json") }
func (l Layout) Policy() string       { return filepath.Join(l.Root, "policy.json") }
func (l Layout) Preferences() string  { return filepath.Join(l.Root, "preferences.json") }
func (l Layout) Admission() string    { return filepath.Join(l.Root, "admission.json") }

// Retiring names a connection a switch replaced until its retirement (server
// revoke, keyring entries) finished, so a crash in between is completed later.
func (l Layout) Retiring() string     { return filepath.Join(l.Root, "retiring.json") }
func (l Layout) Health() string       { return filepath.Join(l.Root, "health.json") }
func (l Layout) Discovered() string   { return filepath.Join(l.Root, "discovered.json") }
func (l Layout) Threads() string      { return filepath.Join(l.Root, "threads.json") }
func (l Layout) MappedRoots() string  { return filepath.Join(l.Root, "mapped-roots.json") }
func (l Layout) Suppressions() string { return filepath.Join(l.Root, "suppressed-sessions.json") }
func (l Layout) OTelDir() string      { return filepath.Join(l.Root, "otel") }
func (l Layout) OTelSettings() string { return filepath.Join(l.Root, "otel.json") }
func (l Layout) Ledger() string       { return filepath.Join(l.Root, "ledger.json") }
func (l Layout) StateLock() string    { return filepath.Join(l.Root, "state.lock") }
func (l Layout) DaemonLock() string   { return filepath.Join(l.Root, "daemon.lock") }
func (l Layout) InboxDir() string     { return filepath.Join(l.Root, "inbox") }
func (l Layout) QueueDir() string     { return filepath.Join(l.Root, "queue") }
func (l Layout) WorkDir() string      { return filepath.Join(l.Root, "work") }

// UsageDir holds, per session, how far its transcripts were read for usage.
func (l Layout) UsageDir() string { return filepath.Join(l.Root, "usage") }

// CaptureWindows records when the daemon saw capture allowed, per agent and
// mapping, so usage read later is uploaded only from those spans.
func (l Layout) CaptureWindows() string { return filepath.Join(l.Root, "capture-windows.json") }

// RichDir holds rich capture's spooled bodies and its read positions in the
// agents' session files.
func (l Layout) RichDir() string { return filepath.Join(l.Root, "rich") }

// SessionLock is held by the daemon while it captures for a connection;
// disconnect takes it to wait that session out.
func (l Layout) SessionLock() string { return filepath.Join(l.Root, "session.lock") }

// LogsDir holds the daemon's own log and, under a service, its stderr.
func (l Layout) LogsDir() string { return filepath.Join(l.Root, "logs") }

// ServiceDir holds the Windows Scheduled Task definition while installed.
func (l Layout) ServiceDir() string { return filepath.Join(l.Root, "service") }

// DaemonPID names the process holding DaemonLock, so a lock held by anything
// else (an orphaned child, a dying process) is not taken for a daemon.
func (l Layout) DaemonPID() string { return filepath.Join(l.Root, "daemon.pid") }

// DisconnectRequest asks a running daemon to end its session.
func (l Layout) DisconnectRequest() string { return filepath.Join(l.Root, "disconnect.request") }

// EnsurePrivateDir creates dir as owner-only: mode 0700, or on Windows an
// access list that grants no other user.
func EnsurePrivateDir(dir string) error {
	if err := RejectSymlink(dir); err != nil {
		return err
	}
	info, err := os.Lstat(dir)
	if err == nil && !info.IsDir() {
		return fmt.Errorf("%w: %s is not a directory", ErrUnsafePath, dir)
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	return restrictToOwner(dir)
}

func RejectSymlink(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: refusing symlink %s", ErrUnsafePath, path)
	}
	return nil
}

func WriteJSON(path string, value any) error {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return err
	}
	return WriteFileAtomic(path, buffer.Bytes())
}

// WriteFileAtomic publishes data with owner-only permissions. The content is
// fsynced before the rename and the directory after it, so a crash leaves
// either the old file or the complete new one.
func WriteFileAtomic(path string, data []byte) error {
	return WriteFileAtomicMode(path, data, 0o600)
}

// WriteFileAtomicMode is WriteFileAtomic for files that are not the
// companion's own, such as agent settings whose existing mode is kept.
func WriteFileAtomicMode(path string, data []byte, mode os.FileMode) error {
	return WriteFileAtomicIf(path, data, mode, nil)
}

// WriteFileAtomicIf publishes data only if precondition, checked after the
// new content is durable and immediately before the rename, returns nil.
func WriteFileAtomicIf(path string, data []byte, mode os.FileMode, precondition func() error) error {
	if err := RejectSymlink(path); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(path), ".pending-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if err := file.Chmod(mode); err != nil {
		file.Close()
		return err
	}
	if _, err := file.Write(data); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if precondition != nil {
		if err := precondition(); err != nil {
			return err
		}
	}
	if err := os.Rename(file.Name(), path); err != nil {
		return err
	}
	return SyncDir(filepath.Dir(path))
}

func ReadPrivateFile(path string, limit int64) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, fmt.Errorf("%w: %s is not a bounded regular file", ErrUnsafePath, path)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0 {
		return nil, fmt.Errorf("%w: %s is readable by others", ErrUnsafePath, path)
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%w: %s grew past its limit", ErrUnsafePath, path)
	}
	return data, nil
}

// ReadJSON decodes a private file tolerantly: unknown fields are ignored.
func ReadJSON(path string, limit int64, value any) error {
	data, err := ReadPrivateFile(path, limit)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	return decoder.Decode(value)
}

type Unlocker interface{ Unlock() error }

const lockRetryDelay = 10 * time.Millisecond

// newLock opens the lock through os.OpenFile, whose handles Go creates
// non-inheritable (O_CLOEXEC on Unix, no bInheritHandle on Windows), so no
// child such as the OTel collector can keep a daemon's lock held.
func newLock(path string) (*flock.Flock, error) {
	if err := RejectSymlink(path); err != nil {
		return nil, err
	}
	return flock.New(path, flock.SetPermissions(0o600)), nil
}

func Lock(ctx context.Context, path string) (Unlocker, error) {
	lock, err := newLock(path)
	if err != nil {
		return nil, err
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	locked, err := lock.TryLockContext(ctx, lockRetryDelay)
	if err != nil {
		return nil, err
	}
	if !locked {
		return nil, context.Canceled
	}
	return lock, nil
}

func TryLock(path string) (Unlocker, bool, error) {
	lock, err := newLock(path)
	if err != nil {
		return nil, false, err
	}
	locked, err := lock.TryLock()
	if err != nil || !locked {
		return nil, false, err
	}
	return lock, true, nil
}
