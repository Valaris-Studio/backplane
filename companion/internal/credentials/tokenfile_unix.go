// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package credentials

import (
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strings"

	"golang.org/x/sys/unix"
)

func unsafeBecause(check string) error { return UnsafeCredentialError{Check: check} }

// unreadable carries the bare errno, which names neither the path nor any
// of the file's bytes.
func unreadable(errno error) error { return fmt.Errorf("%w: %w", ErrCredentialUnreadable, errno) }

const (
	maxTokenPathBytes = 4096
	tokenPrefix       = "bpc_"
	tokenLength       = 47 // "bpc_" and a 43-character body
)

// The server's device-token format, with at most one trailing newline.
var tokenFilePattern = regexp.MustCompile(`^bpc_[A-Za-z0-9_-]{43}\n?$`)

// afterTokenPathCheck runs between the ancestor walk and the final open, so
// a test can swap the file in that window.
var afterTokenPathCheck = func() {}

// ReadTokenFile returns the device token from spec.Path, refusing any file
// another user could have planted, swapped or rewritten.
func ReadTokenFile(spec TokenFileSpec) (string, FileIdentity, error) {
	if err := checkTokenPath(spec.Path); err != nil {
		return "", FileIdentity{}, err
	}
	parent, err := openTrustedDirectory(filepath.Dir(spec.Path), spec.UID)
	if err != nil {
		return "", FileIdentity{}, err
	}
	defer unix.Close(parent)
	afterTokenPathCheck()

	base := filepath.Base(spec.Path)
	// O_NONBLOCK keeps a FIFO swapped in from blocking the open; fstat then
	// refuses it as not regular.
	file, err := openatRetrying(parent, base, unix.O_RDONLY|unix.O_NOFOLLOW|unix.O_NONBLOCK|unix.O_CLOEXEC)
	if err != nil {
		return "", FileIdentity{}, classifyOpenFailure(parent, base, err, unix.S_IFREG, "not_regular")
	}
	defer unix.Close(file)
	var opened unix.Stat_t
	if err := unix.Fstat(file, &opened); err != nil {
		return "", FileIdentity{}, unreadable(err)
	}
	if err := checkTokenFile(&opened, spec); err != nil {
		return "", FileIdentity{}, err
	}
	identity := identityOf(&opened)

	// One byte past the size shows a file that grew after the fstat.
	content, err := readAtMost(file, opened.Size+1)
	if err != nil {
		return "", FileIdentity{}, unreadable(err)
	}
	var afterRead unix.Stat_t
	if err := unix.Fstat(file, &afterRead); err != nil {
		return "", FileIdentity{}, unreadable(err)
	}
	if int64(len(content)) != opened.Size || identityOf(&afterRead) != identity {
		return "", FileIdentity{}, unsafeBecause("changed_during_read")
	}
	if !tokenFilePattern.Match(content) {
		return "", FileIdentity{}, ErrCredentialMalformed
	}
	return strings.TrimSuffix(string(content), "\n"), identity, nil
}

// StatTokenFile reports the identity of whatever is at path, never following
// a symlink, for a watcher to compare with the identity last read.
func StatTokenFile(path string) (FileIdentity, error) {
	var info unix.Stat_t
	if err := unix.Lstat(path, &info); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return FileIdentity{}, ErrCredentialMissing
		}
		return FileIdentity{}, unreadable(err)
	}
	return identityOf(&info), nil
}

func checkTokenPath(path string) error {
	switch {
	case len(path) > maxTokenPathBytes:
		return unsafeBecause("path_too_long")
	// A token pasted where its path belongs; the value is never repeated.
	case strings.HasPrefix(filepath.Base(path), tokenPrefix):
		return unsafeBecause("path_looks_like_token")
	case !filepath.IsAbs(path):
		return unsafeBecause("relative_path")
	case strings.IndexByte(path, 0) >= 0 || filepath.Clean(path) != path:
		return unsafeBecause("unclean_path")
	}
	return nil
}

// openTrustedDirectory opens dir one component at a time from "/" without
// following links, so a component renamed or replaced by a symlink after its
// check cannot redirect the walk: each step opens relative to the descriptor
// already checked. Every directory on the way must be owned by root or
// ownerUID and writable by no one else unless sticky (sshd StrictModes).
func openTrustedDirectory(dir string, ownerUID int) (int, error) {
	current, err := openatRetrying(unix.AT_FDCWD, "/", unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC)
	if err != nil {
		return -1, unreadable(err)
	}
	if err := checkAncestor(current, ownerUID); err != nil {
		unix.Close(current)
		return -1, err
	}
	for _, name := range strings.Split(strings.TrimPrefix(dir, "/"), "/") {
		if name == "" {
			continue
		}
		next, err := openatRetrying(current, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC)
		if err != nil {
			failure := classifyOpenFailure(current, name, err, unix.S_IFDIR, "ancestor_not_directory")
			unix.Close(current)
			return -1, failure
		}
		unix.Close(current)
		current = next
		if err := checkAncestor(current, ownerUID); err != nil {
			unix.Close(current)
			return -1, err
		}
	}
	return current, nil
}

func checkAncestor(directory, ownerUID int) error {
	var info unix.Stat_t
	if err := unix.Fstat(directory, &info); err != nil {
		return unreadable(err)
	}
	if info.Uid != 0 && int64(info.Uid) != int64(ownerUID) {
		return unsafeBecause("ancestor_owner")
	}
	if info.Mode&0o022 != 0 && info.Mode&unix.S_ISVTX == 0 {
		return unsafeBecause("ancestor_writable")
	}
	return nil
}

// classifyOpenFailure names why openat refused name. Platforms disagree on
// the errno for O_NOFOLLOW meeting a link (ELOOP, EMLINK, or ENOTDIR with
// O_DIRECTORY), so the entry itself is inspected. The inspection only picks
// the reason; the refusal already happened on the descriptor path.
func classifyOpenFailure(directory int, name string, openErr error, expectedType uint32, wrongTypeCheck string) error {
	if errors.Is(openErr, unix.ENOENT) {
		return ErrCredentialMissing
	}
	var entry unix.Stat_t
	if err := unix.Fstatat(directory, name, &entry, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		if errors.Is(err, unix.ENOENT) {
			return ErrCredentialMissing
		}
		return unreadable(openErr)
	}
	switch entryType := uint32(entry.Mode) & unix.S_IFMT; {
	case entryType == unix.S_IFLNK:
		return unsafeBecause("symlink")
	case entryType != expectedType:
		return unsafeBecause(wrongTypeCheck)
	}
	return unreadable(openErr)
}

func checkTokenFile(info *unix.Stat_t, spec TokenFileSpec) error {
	permissions := info.Mode & 0o7777
	switch {
	case info.Mode&unix.S_IFMT != unix.S_IFREG:
		return unsafeBecause("not_regular")
	// A second name could be a link the coding user made to a file it may
	// later swap or keep after the operator replaces the path.
	case info.Nlink != 1:
		return unsafeBecause("hardlink")
	case int64(info.Uid) != int64(spec.UID):
		return unsafeBecause("owner")
	case int64(info.Gid) != int64(spec.GID):
		return unsafeBecause("group")
	case permissions != 0o400 && permissions != 0o600:
		return unsafeBecause("mode")
	case info.Size != tokenLength && info.Size != tokenLength+1:
		return unsafeBecause("size")
	}
	return nil
}

func readAtMost(file int, limit int64) ([]byte, error) {
	content := make([]byte, limit)
	filled := 0
	for filled < len(content) {
		count, err := unix.Read(file, content[filled:])
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if count == 0 {
			break
		}
		filled += count
	}
	return content[:filled], nil
}

// openatRetrying retries EINTR as os.OpenFile does: the runtime's preemption
// signals can interrupt an open on a slow filesystem.
func openatRetrying(directory int, name string, flags int) (int, error) {
	for {
		fd, err := unix.Openat(directory, name, flags, 0)
		if !errors.Is(err, unix.EINTR) {
			return fd, err
		}
	}
}

func identityOf(info *unix.Stat_t) FileIdentity {
	return FileIdentity{
		Dev:     uint64(info.Dev),
		Ino:     uint64(info.Ino),
		Size:    info.Size,
		MtimeNs: info.Mtim.Nano(),
		CtimeNs: info.Ctim.Nano(),
		Mode:    uint32(info.Mode),
		UID:     info.Uid,
		GID:     info.Gid,
	}
}
