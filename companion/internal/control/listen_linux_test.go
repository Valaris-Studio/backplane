// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"context"
	"testing"
	"time"
)

// Uses the real SO_PEERCRED lookup, not an injected PeerUID.
func TestListen_LinuxPeerCredAcceptsSameUID(t *testing.T) {
	dir := shortTempDir(t)
	listener, err := Listen(dir, ListenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			conn.Close()
		}
		accepted <- err
	}()
	conn, err := Dial(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	select {
	case err := <-accepted:
		if err != nil {
			t.Fatalf("accept: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("same-uid peer was not accepted")
	}
}
