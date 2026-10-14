// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package control

import (
	"context"
	"io"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"
)

// Qualified natively in DK-W1; compiled everywhere through GOOS=windows vet.
func TestListen_ServesThisUsersPipe(t *testing.T) {
	root := t.TempDir()
	listener, err := Listen(root, ListenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "reached") })}
	go server.Serve(listener)
	defer server.Close()
	if address := listenerAddress(root); !strings.HasPrefix(address, `\\.\pipe\backplane-companion-S-`) {
		t.Fatalf("pipe %s", address)
	}
	client := &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return Dial(ctx, root) },
	}}
	reply, err := client.Get("http://companion/v1/status")
	if err != nil {
		t.Fatal(err)
	}
	defer reply.Body.Close()
	if data, _ := io.ReadAll(reply.Body); string(data) != "reached" {
		t.Fatalf("pipe served %q", data)
	}
}

func TestListen_RefusesASecondListener(t *testing.T) {
	root := t.TempDir()
	first, err := Listen(root, ListenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer first.Close()
	if second, err := Listen(root, ListenOptions{}); err == nil {
		second.Close()
		t.Fatal("a second listener joined the user's pipe")
	}
}

func TestListen_PeerSIDIsThisUser(t *testing.T) {
	root := t.TempDir()
	listener, err := Listen(root, ListenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, _ := listener.(*sidCheckedListener).Listener.Accept()
		accepted <- conn
	}()
	client, err := Dial(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server := <-accepted
	defer server.Close()
	want, _ := currentUserSID()
	if sid, err := pipeClientSID(server); err != nil || sid != want {
		t.Fatalf("peer SID %s, %v; want %s", sid, err, want)
	}
}
