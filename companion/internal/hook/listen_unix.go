// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build unix

package hook

import (
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"

	"golang.org/x/sys/unix"

	"github.com/Valaris-Studio/backplane/companion/internal/control"
)

// maxSocketPathBytes leaves room for sun_path's NUL.
var maxSocketPathBytes = len(unix.RawSockaddrUnix{}.Path) - 1

// staleProbeTimeout bounds the dial that tells a crashed daemon's leftover
// socket from a live one.
const staleProbeTimeout = time.Second

// socketMode lets the coding uid connect; the directory, which only this
// uid and root can write, and the peer check are what keep others away.
const socketMode = 0o666

// CheckDirectory refuses a socket path whose directory another uid could
// write, or whose leaf is anything but an absent or stale socket. It is
// what the daemon checks at start, before any session.
func CheckDirectory(path string) error {
	if err := checkPath(path); err != nil {
		return err
	}
	dir, err := openPrivateDirectory(filepath.Dir(path))
	if err != nil {
		return err
	}
	defer unix.Close(dir)
	info, exists, err := leafStat(dir, filepath.Base(path))
	if err != nil {
		return err
	}
	if exists && info.Mode&unix.S_IFMT != unix.S_IFSOCK {
		return fmt.Errorf("%w: %s is not a socket", ErrUnsafeDirectory, path)
	}
	return nil
}

// Listen binds the hook socket at path, serving only options.PeerUID. The
// directory is opened once, without following symlinks, and the leaf is
// checked through it before the stale removal, after the bind and after
// the chmod, so nothing another uid placed there is ever bound or opened.
func Listen(path string, options Options) (net.Listener, error) {
	if err := checkPath(path); err != nil {
		return nil, err
	}
	if options.PeerUID <= 0 || options.PeerUID == os.Geteuid() {
		return nil, fmt.Errorf("%w: %d", ErrPeerUID, options.PeerUID)
	}
	dir, err := openPrivateDirectory(filepath.Dir(path))
	if err != nil {
		return nil, err
	}
	defer unix.Close(dir)
	base := filepath.Base(path)
	if err := removeStaleSocket(dir, path, base); err != nil {
		return nil, err
	}
	listener, err := net.Listen("unix", path)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnsafeDirectory, err)
	}
	// Go would unlink the path by name on Close, which could remove whatever
	// sits there by then; Close unlinks only the inode this bind created.
	listener.(*net.UnixListener).SetUnlinkOnClose(false)
	if options.afterBind != nil {
		options.afterBind(path)
	}
	bound, err := verifyOwnSocket(dir, base, nil)
	if err != nil {
		listener.Close()
		return nil, err
	}
	// The directory admits no other writer, so the leaf verified above is
	// the one this chmod reaches; it is verified again after.
	if err := os.Chmod(path, socketMode); err != nil {
		listener.Close()
		unlinkOwnSocket(path, &bound)
		return nil, fmt.Errorf("%w: %v", ErrUnsafeDirectory, err)
	}
	if _, err := verifyOwnSocket(dir, base, &bound); err != nil {
		listener.Close()
		return nil, err
	}
	if options.ReadPeerUID == nil {
		options.ReadPeerUID = control.PeerUID
	}
	return &peerCheckedListener{Listener: listener, options: options, path: path, bound: bound}, nil
}

// socketIdentity is the inode a bind created; only it is ever unlinked.
type socketIdentity struct {
	dev uint64
	ino uint64
}

func identityOf(info unix.Stat_t) socketIdentity {
	return socketIdentity{dev: uint64(info.Dev), ino: uint64(info.Ino)}
}

// unlinkOwnSocket removes the leaf only while it is still the bound inode,
// through a freshly checked directory descriptor.
func unlinkOwnSocket(path string, bound *socketIdentity) {
	dir, err := openPrivateDirectory(filepath.Dir(path))
	if err != nil {
		return
	}
	defer unix.Close(dir)
	base := filepath.Base(path)
	if _, err := verifyOwnSocket(dir, base, bound); err != nil {
		return
	}
	unix.Unlinkat(dir, base, 0)
}

func checkPath(path string) error {
	if path == "" || !filepath.IsAbs(path) || filepath.Clean(path) != path || filepath.Base(path) == string(filepath.Separator) {
		return fmt.Errorf("%w: %q is not an absolute, clean socket path", ErrUnsafeDirectory, path)
	}
	if len(path) > maxSocketPathBytes {
		return fmt.Errorf("%w: %s is %d bytes, the limit is %d", ErrSocketPathTooLong, path, len(path), maxSocketPathBytes)
	}
	return nil
}

// openPrivateDirectory opens dir without following a symlink as its last
// component (its parents are the operator's) and checks it is owned by this
// uid and writable by no one else.
func openPrivateDirectory(dir string) (int, error) {
	descriptor, err := openNoFollow(dir)
	if err != nil {
		return -1, fmt.Errorf("%w: %s: %v", ErrUnsafeDirectory, dir, err)
	}
	var info unix.Stat_t
	if err := unix.Fstat(descriptor, &info); err != nil {
		unix.Close(descriptor)
		return -1, fmt.Errorf("%w: %s: %v", ErrUnsafeDirectory, dir, err)
	}
	switch {
	case info.Mode&unix.S_IFMT != unix.S_IFDIR:
		err = fmt.Errorf("%w: %s is not a directory", ErrUnsafeDirectory, dir)
	case int64(info.Uid) != int64(os.Geteuid()):
		err = fmt.Errorf("%w: %s is owned by uid %d", ErrUnsafeDirectory, dir, info.Uid)
	case info.Mode&0o022 != 0:
		err = fmt.Errorf("%w: %s is writable by group or others (%o)", ErrUnsafeDirectory, dir, info.Mode&0o777)
	}
	if err != nil {
		unix.Close(descriptor)
		return -1, err
	}
	return descriptor, nil
}

func openNoFollow(dir string) (int, error) {
	for {
		descriptor, err := unix.Openat(unix.AT_FDCWD, dir, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if !errors.Is(err, unix.EINTR) {
			return descriptor, err
		}
	}
}

// leafStat reads the leaf through the opened directory, never following a
// symlink at the leaf.
func leafStat(dir int, base string) (info unix.Stat_t, exists bool, err error) {
	for {
		err = unix.Fstatat(dir, base, &info, unix.AT_SYMLINK_NOFOLLOW)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if errors.Is(err, unix.ENOENT) {
			return info, false, nil
		}
		if err != nil {
			return info, false, fmt.Errorf("%w: %s: %v", ErrUnsafeDirectory, base, err)
		}
		return info, true, nil
	}
}

// removeStaleSocket clears a socket a crashed daemon left; one that still
// answers is live and refused, anything else at the leaf is refused.
func removeStaleSocket(dir int, path, base string) error {
	info, exists, err := leafStat(dir, base)
	if err != nil || !exists {
		return err
	}
	if info.Mode&unix.S_IFMT != unix.S_IFSOCK {
		return fmt.Errorf("%w: %s is not a socket", ErrUnsafeDirectory, path)
	}
	if conn, err := net.DialTimeout("unix", path, staleProbeTimeout); err == nil {
		conn.Close()
		return fmt.Errorf("%w: %s", ErrSocketInUse, path)
	}
	if err := unix.Unlinkat(dir, base, 0); err != nil && !errors.Is(err, unix.ENOENT) {
		return fmt.Errorf("%w: %s: %v", ErrUnsafeDirectory, path, err)
	}
	return nil
}

// verifyOwnSocket checks the leaf is this uid's socket and, when bound is
// known, the very inode that was bound.
func verifyOwnSocket(dir int, base string, bound *socketIdentity) (socketIdentity, error) {
	info, exists, err := leafStat(dir, base)
	if err != nil {
		return socketIdentity{}, err
	}
	if !exists || info.Mode&unix.S_IFMT != unix.S_IFSOCK || int64(info.Uid) != int64(os.Geteuid()) {
		return socketIdentity{}, fmt.Errorf("%w: %s", ErrSocketSubstituted, base)
	}
	identity := identityOf(info)
	if bound != nil && identity != *bound {
		return socketIdentity{}, fmt.Errorf("%w: %s", ErrSocketSubstituted, base)
	}
	return identity, nil
}

// peerCheckedListener closes, without a response, every connection whose
// peer is not the served uid or cannot be identified.
type peerCheckedListener struct {
	net.Listener
	options Options
	path    string
	bound   socketIdentity
}

// Close stops listening and unlinks the socket this listener bound, never
// another file that has since taken its place.
func (l *peerCheckedListener) Close() error {
	err := l.Listener.Close()
	unlinkOwnSocket(l.path, &l.bound)
	return err
}

func (l *peerCheckedListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if uid, err := l.options.ReadPeerUID(conn); err == nil && uid == l.options.PeerUID {
			return conn, nil
		}
		conn.Close()
	}
}
