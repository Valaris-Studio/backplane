// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package control

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net"

	"github.com/Microsoft/go-winio"
	"github.com/Valaris-Studio/backplane/companion/internal/scope"
	"golang.org/x/sys/windows"
)

var (
	ErrUnsafeDirectory = errors.New("unsafe_control_directory")
	ErrSocketInUse     = errors.New("control_socket_in_use")
)

type ListenOptions struct {
	// PeerSID reads the connecting client's user SID; tests replace it.
	PeerSID func(net.Conn) (string, error)
}

func currentUserSID() (string, error) {
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String(), nil
}

func scopedPipeName(sid, dataDir string) (string, error) {
	canonical, ok := scope.CanonicalDir(dataDir)
	if !ok {
		return "", ErrUnsafeDirectory
	}
	path, err := windows.UTF16PtrFromString(canonical)
	if err != nil {
		return "", errors.Join(ErrUnsafeDirectory, err)
	}
	handle, err := windows.CreateFile(path, windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", errors.Join(ErrUnsafeDirectory, err)
	}
	defer windows.CloseHandle(handle)
	// Junctions can survive Go path normalization; the handle names their target.
	buffer := make([]uint16, windows.MAX_LONG_PATH)
	length, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 0)
	if err != nil || length == 0 || int(length) >= len(buffer) {
		return "", errors.Join(ErrUnsafeDirectory, err)
	}
	resolved := windows.UTF16ToString(buffer[:length])
	return fmt.Sprintf("%s-%x", PipeName(sid), sha256.Sum256([]byte(resolved))), nil
}

func listenerAddress(dataDir string) string {
	sid, err := currentUserSID()
	if err != nil {
		return ""
	}
	name, _ := scopedPipeName(sid, dataDir)
	return name
}

// Listen creates the user's control pipe for this data directory. go-winio
// creates the first instance with FILE_FLAG_FIRST_PIPE_INSTANCE, so a pipe another process
// already squats on fails here instead of being joined, and it rejects
// remote clients.
func Listen(dataDir string, options ListenOptions) (net.Listener, error) {
	sid, err := currentUserSID()
	if err != nil {
		return nil, err
	}
	descriptor, err := pipeSecurityDescriptor(sid)
	if err != nil {
		return nil, err
	}
	name, err := scopedPipeName(sid, dataDir)
	if err != nil {
		return nil, err
	}
	listener, err := winio.ListenPipe(name, &winio.PipeConfig{SecurityDescriptor: descriptor})
	if err != nil {
		return nil, errors.Join(ErrSocketInUse, err)
	}
	if options.PeerSID == nil {
		options.PeerSID = pipeClientSID
	}
	return &sidCheckedListener{Listener: listener, userSID: sid, peerSID: options.PeerSID}, nil
}

// pipeClientSID is the user of the process at the other end of the pipe.
// A client process that exits and whose id is reused before this lookup
// could be misread, which is why the DACL, not this check, is the boundary.
func pipeClientSID(conn net.Conn) (string, error) {
	pipe, ok := conn.(interface{ Fd() uintptr })
	if !ok {
		return "", errUnidentifiedPipeUser
	}
	var pid uint32
	if err := windows.GetNamedPipeClientProcessId(windows.Handle(pipe.Fd()), &pid); err != nil {
		return "", err
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(process)
	var token windows.Token
	if err := windows.OpenProcessToken(process, windows.TOKEN_QUERY, &token); err != nil {
		return "", err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String(), nil
}

// Dial connects to this user's control pipe for the resolved data directory.
func Dial(ctx context.Context, dataDir string) (net.Conn, error) {
	sid, err := currentUserSID()
	if err != nil {
		return nil, err
	}
	name, err := scopedPipeName(sid, dataDir)
	if err != nil {
		return nil, err
	}
	return winio.DialPipeContext(ctx, name)
}
