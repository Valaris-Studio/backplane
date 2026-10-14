// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"errors"
	"fmt"
	"net"
	"regexp"
)

var errUnidentifiedPipeUser = errors.New("control pipe user unknown")

// sidPattern is the SID string form (S-1-authority-subauthority...). The
// SID is spliced into SDDL, so anything else could smuggle in more ACEs.
var sidPattern = regexp.MustCompile(`^S-1-[0-9]+(-[0-9]+)+$`)

// PipeName is the per-user Windows control pipe prefix. An endpoint also
// includes the digest of its canonical data directory.
func PipeName(sid string) string { return `\\.\pipe\backplane-companion-` + sid }

// pipeSecurityDescriptor grants the user, and only the user, full access: a
// protected DACL (no inherited entries) with one allow entry. No SYSTEM or
// Administrators entry is needed, since nothing but the user's own processes
// talks to the pipe. The user is also the owner, because an elevated
// creator's default owner is Administrators, and an owner can always
// rewrite the DACL.
func pipeSecurityDescriptor(sid string) (string, error) {
	if !sidPattern.MatchString(sid) {
		return "", fmt.Errorf("%w: invalid SID %q", errUnidentifiedPipeUser, sid)
	}
	return "O:" + sid + "D:P(A;;GA;;;" + sid + ")", nil
}

// sidCheckedListener closes, without a response, every connection whose
// client is another user or cannot be identified. The DACL already keeps
// other users out; this holds even if the pipe was created some other way.
type sidCheckedListener struct {
	net.Listener
	userSID string
	peerSID func(net.Conn) (string, error)
}

func (l *sidCheckedListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		if sid, err := l.peerSID(conn); err == nil && l.userSID != "" && sid == l.userSID {
			return conn, nil
		}
		conn.Close()
	}
}
