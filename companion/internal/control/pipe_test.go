// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"errors"
	"net"
	"regexp"
	"strings"
	"testing"
)

const userSID = "S-1-5-21-1-2-3-1001"

func TestPipeName_IsPerUserSID(t *testing.T) {
	if name := PipeName(userSID); name != `\\.\pipe\backplane-companion-S-1-5-21-1-2-3-1001` {
		t.Fatalf("pipe name %s", name)
	}
}

func TestPipeSecurityDescriptor_GrantsOnlyUserSID(t *testing.T) {
	// Owned by the user, protected DACL (P) with a single allow ACE.
	sddl, err := pipeSecurityDescriptor(userSID)
	if err != nil || sddl != "O:"+userSID+"D:P(A;;GA;;;"+userSID+")" {
		t.Fatalf("sddl %s, %v", sddl, err)
	}
}

func TestPipeSecurityDescriptor_NoEveryoneOrAdminsACE(t *testing.T) {
	sddl, err := pipeSecurityDescriptor(userSID)
	if err != nil {
		t.Fatal(err)
	}
	aces := regexp.MustCompile(`\(([^)]*)\)`).FindAllStringSubmatch(sddl, -1)
	if len(aces) != 1 {
		t.Fatalf("want exactly one ACE, got %d in %s", len(aces), sddl)
	}
	for _, ace := range aces {
		fields := strings.Split(ace[1], ";")
		if len(fields) != 6 || fields[5] != userSID {
			t.Fatalf("ACE %s is not for the user", ace[1])
		}
	}
	for _, other := range []string{"WD", "BA", "SY", "AU", "BU", "AN", "IU", "S-1-1-0", "S-1-5-32-544", "S-1-5-18"} {
		if strings.Contains(sddl, ";"+other+")") {
			t.Fatalf("sddl grants %s: %s", other, sddl)
		}
	}
}

func TestPipeSecurityDescriptor_RejectsAMalformedSID(t *testing.T) {
	for _, sid := range []string{"", "WD", "BA", "S-1", "S-1-5-21-1)(A;;GA;;;WD", "S-1-5-21-1-2-3-1001)", "s-1-5-21-1", "S-1-5-21-1\n"} {
		if sddl, err := pipeSecurityDescriptor(sid); err == nil {
			t.Errorf("SID %q accepted: %s", sid, sddl)
		}
	}
}

// acceptQueue is a listener that hands out prepared connections.
type acceptQueue struct {
	conns  chan net.Conn
	closed []net.Conn
}

func (q *acceptQueue) Accept() (net.Conn, error) {
	conn, ok := <-q.conns
	if !ok {
		return nil, net.ErrClosed
	}
	return conn, nil
}
func (q *acceptQueue) Close() error   { return nil }
func (q *acceptQueue) Addr() net.Addr { return nil }

type peerConn struct {
	net.Conn
	sid    string
	err    error
	closed bool
}

func (c *peerConn) Close() error { c.closed = true; return nil }

func peerSIDOf(conn net.Conn) (string, error) {
	peer := conn.(*peerConn)
	return peer.sid, peer.err
}

func TestSIDCheckedListener_AcceptsTheUser(t *testing.T) {
	user := &peerConn{sid: userSID}
	queue := &acceptQueue{conns: make(chan net.Conn, 1)}
	queue.conns <- user
	listener := &sidCheckedListener{Listener: queue, userSID: userSID, peerSID: peerSIDOf}
	conn, err := listener.Accept()
	if err != nil || conn != user || user.closed {
		t.Fatalf("user refused: %v", err)
	}
}

func TestSIDCheckedListener_RejectsAnotherUsersSIDAndUnidentifiedPeers(t *testing.T) {
	other := &peerConn{sid: "S-1-5-21-1-2-3-1002"}
	unknown := &peerConn{err: errors.New("no client process")}
	empty := &peerConn{}
	user := &peerConn{sid: userSID}
	queue := &acceptQueue{conns: make(chan net.Conn, 4)}
	for _, conn := range []*peerConn{other, unknown, empty, user} {
		queue.conns <- conn
	}
	listener := &sidCheckedListener{Listener: queue, userSID: userSID, peerSID: peerSIDOf}
	conn, err := listener.Accept()
	if err != nil || conn != user {
		t.Fatalf("got %v, %v", conn, err)
	}
	for name, peer := range map[string]*peerConn{"other user": other, "unidentified": unknown, "empty SID": empty} {
		if !peer.closed {
			t.Errorf("%s was served", name)
		}
	}
}

func TestSIDCheckedListener_NeverServesWithoutAUserSID(t *testing.T) {
	anyone := &peerConn{sid: ""}
	queue := &acceptQueue{conns: make(chan net.Conn, 1)}
	queue.conns <- anyone
	close(queue.conns)
	listener := &sidCheckedListener{Listener: queue, userSID: "", peerSID: peerSIDOf}
	if conn, err := listener.Accept(); err == nil {
		t.Fatalf("served %v with no user SID", conn)
	}
	if !anyone.closed {
		t.Fatal("peer left open")
	}
}
