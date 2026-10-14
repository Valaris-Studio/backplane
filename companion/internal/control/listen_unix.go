// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package control

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

var (
	// ErrUnsafeDirectory refuses a socket directory others could reach, and
	// anything but a socket at the socket path.
	ErrUnsafeDirectory = errors.New("unsafe_control_directory")
	// ErrSocketInUse is a live listener at the socket path.
	ErrSocketInUse = errors.New("control_socket_in_use")
	// ErrSocketPathTooLong is a data directory too deep for sun_path, e.g.
	// under a long $XDG_STATE_HOME.
	ErrSocketPathTooLong = errors.New("control_socket_path_too_long")
)

// maxSocketPathBytes leaves room for sun_path's NUL (104 bytes on macOS, 108
// on Linux); past it bind fails with a bare EINVAL.
var maxSocketPathBytes = len(unix.RawSockaddrUnix{}.Path) - 1

// staleProbeTimeout bounds the dial that tells a crashed daemon's leftover
// socket (connection refused) from a live one.
const staleProbeTimeout = time.Second

type ListenOptions struct {
	// PeerUID reads the connecting process's uid; tests replace it.
	PeerUID func(net.Conn) (int, error)
	// UID is the only peer uid served; zero means this process's uid, since
	// the daemon never runs as root.
	UID int
	// afterBind observes the socket right after it is bound (tests).
	afterBind func(path string)
}

func listenerAddress(dataDir string) string { return SocketPath(dataDir) }

// Listen serves on <dataDir>/control.sock. The directory must be owned by
// this user and closed to group and others, which is what keeps other
// users away; the socket is 0600 and every peer's uid is checked as well.
func Listen(dataDir string, options ListenOptions) (net.Listener, error) {
	path := SocketPath(dataDir)
	if len(path) > maxSocketPathBytes {
		return nil, fmt.Errorf("%w: %s is %d bytes, the limit is %d; choose a shorter data directory", ErrSocketPathTooLong, path, len(path), maxSocketPathBytes)
	}
	if err := checkPrivateDirectory(dataDir); err != nil {
		return nil, err
	}
	if err := removeStaleSocket(path); err != nil {
		return nil, err
	}
	listener, err := bindOwnerOnly(path)
	if err != nil {
		return nil, err
	}
	if options.afterBind != nil {
		options.afterBind(path)
	}
	if err := os.Chmod(path, 0o600); err != nil {
		listener.Close()
		return nil, err
	}
	if options.PeerUID == nil {
		options.PeerUID = peerUID
	}
	if options.UID == 0 {
		options.UID = os.Getuid()
	}
	return &peerCheckedListener{Listener: listener, options: options}, nil
}

func checkPrivateDirectory(dir string) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return fmt.Errorf("%w: %s is not a directory", ErrUnsafeDirectory, dir)
	}
	if info.Mode().Perm()&0o077 != 0 {
		return fmt.Errorf("%w: %s is accessible to group or others (%o)", ErrUnsafeDirectory, dir, info.Mode().Perm())
	}
	if owner, ok := info.Sys().(*syscall.Stat_t); ok && int(owner.Uid) != os.Getuid() {
		return fmt.Errorf("%w: %s is owned by uid %d", ErrUnsafeDirectory, dir, owner.Uid)
	}
	return nil
}

// removeStaleSocket clears a socket a crashed daemon left. The caller holds
// the daemon lock, so no other daemon can be starting; a socket that still
// answers belongs to something else and is left alone.
func removeStaleSocket(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSocket == 0 {
		return fmt.Errorf("%w: %s is not a socket", ErrUnsafeDirectory, path)
	}
	if conn, err := net.DialTimeout("unix", path, staleProbeTimeout); err == nil {
		conn.Close()
		return fmt.Errorf("%w: %s", ErrSocketInUse, path)
	}
	return os.Remove(path)
}

// umaskMu keeps this package's own umask changes from overlapping.
var umaskMu sync.Mutex

// bindOwnerOnly creates the socket 0600 from birth, not just after the
// chmod, as defence in depth behind the 0700 directory. The umask is
// process-wide: during this one bind, files other goroutines create get
// stricter modes, never looser, and the companion's writers set modes
// explicitly.
func bindOwnerOnly(path string) (net.Listener, error) {
	umaskMu.Lock()
	defer umaskMu.Unlock()
	var listener net.Listener
	var err error
	withUmask(0o077, func() { listener, err = net.Listen("unix", path) })
	return listener, err
}

// withUmask restores the previous umask even if call panics, so the process
// is never left at the stricter mask.
func withUmask(mask int, call func()) {
	previous := syscall.Umask(mask)
	defer syscall.Umask(previous)
	call()
}

// Dial connects to the daemon's control socket in dataDir.
func Dial(ctx context.Context, dataDir string) (net.Conn, error) {
	var dialer net.Dialer
	return dialer.DialContext(ctx, "unix", SocketPath(dataDir))
}

// peerCheckedListener closes, without a response, every connection whose
// peer is another user or cannot be identified.
type peerCheckedListener struct {
	net.Listener
	options ListenOptions
}

func (l *peerCheckedListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if uid, err := l.options.PeerUID(conn); err == nil && uid == l.options.UID {
			return conn, nil
		}
		conn.Close()
	}
}

func peerUID(conn net.Conn) (int, error) {
	unixConn, ok := conn.(*net.UnixConn)
	if !ok {
		return 0, errors.New("not a unix connection")
	}
	raw, err := unixConn.SyscallConn()
	if err != nil {
		return 0, err
	}
	uid, credentialErr := -1, error(nil)
	if err := raw.Control(func(fd uintptr) { uid, credentialErr = socketPeerUID(int(fd)) }); err != nil {
		return 0, err
	}
	return uid, credentialErr
}
