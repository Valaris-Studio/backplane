// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package control

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func socketClient(dataDir string) *http.Client {
	return &http.Client{Timeout: 3 * time.Second, Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return Dial(ctx, dataDir) },
	}}
}

func TestListen_SocketIsOwnerOnly(t *testing.T) {
	dir := shortTempDir(t)
	listener, err := Listen(dir, ListenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	info, err := os.Lstat(SocketPath(dir))
	if err != nil || info.Mode()&os.ModeSocket == 0 || info.Mode().Perm() != 0o600 {
		t.Fatalf("socket mode %v: %v", info.Mode(), err)
	}
}

func TestListen_RefusesAGroupOrWorldAccessibleDirectory(t *testing.T) {
	for _, mode := range []os.FileMode{0o750, 0o705, 0o770, 0o777} {
		dir := shortTempDir(t)
		os.Chmod(dir, mode)
		if listener, err := Listen(dir, ListenOptions{}); !errors.Is(err, ErrUnsafeDirectory) {
			if listener != nil {
				listener.Close()
			}
			t.Fatalf("mode %o: want ErrUnsafeDirectory, got %v", mode, err)
		}
		if _, err := os.Lstat(SocketPath(dir)); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("mode %o: a socket was created", mode)
		}
	}
}

func TestListen_RefusesASymlinkedDirectory(t *testing.T) {
	real := shortTempDir(t)
	link := filepath.Join(shortTempDir(t), "d")
	os.Symlink(real, link)
	if _, err := Listen(link, ListenOptions{}); !errors.Is(err, ErrUnsafeDirectory) {
		t.Fatalf("want ErrUnsafeDirectory, got %v", err)
	}
}

func TestListen_RejectsAPeerWithADifferentUID(t *testing.T) {
	dir := shortTempDir(t)
	listener, err := Listen(dir, ListenOptions{PeerUID: func(net.Conn) (int, error) { return os.Getuid() + 1, nil }})
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "reached") })}
	go server.Serve(listener)
	defer server.Close()
	conn, err := Dial(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	io.WriteString(conn, "GET /v1/status HTTP/1.1\r\nHost: x\r\n\r\n")
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	data, err := io.ReadAll(conn)
	if len(data) != 0 || err != nil && !errors.Is(err, io.EOF) && !isReset(err) {
		t.Fatalf("a foreign peer must be closed without a response: %q %v", data, err)
	}
}

func TestListen_RejectsAPeerWhoseCredentialsCannotBeRead(t *testing.T) {
	dir := shortTempDir(t)
	listener, err := Listen(dir, ListenOptions{PeerUID: func(net.Conn) (int, error) { return 0, errors.New("no credentials") }})
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "reached") })}
	go server.Serve(listener)
	defer server.Close()
	if _, err := socketClient(dir).Get("http://companion/v1/status"); err == nil {
		t.Fatal("a peer of unknown uid was served")
	}
}

func TestListen_ServesAPeerWithTheSameUID(t *testing.T) {
	dir := shortTempDir(t)
	listener, err := Listen(dir, ListenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { io.WriteString(w, "reached") })}
	go server.Serve(listener)
	defer server.Close()
	reply, err := socketClient(dir).Get("http://companion/v1/status")
	if err != nil {
		t.Fatal(err)
	}
	defer reply.Body.Close()
	if data, _ := io.ReadAll(reply.Body); string(data) != "reached" {
		t.Fatalf("same-uid peer: %q", data)
	}
}

func TestPeerUID_ReportsTheConnectingUser(t *testing.T) {
	dir := shortTempDir(t)
	seen := make(chan int, 1)
	listener, err := Listen(dir, ListenOptions{PeerUID: func(conn net.Conn) (int, error) {
		uid, err := peerUID(conn)
		seen <- uid
		return uid, err
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		if conn, err := listener.Accept(); err == nil {
			conn.Close()
		}
	}()
	conn, err := Dial(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	select {
	case uid := <-seen:
		if uid != os.Getuid() {
			t.Fatalf("peer uid %d, want %d", uid, os.Getuid())
		}
	case <-time.After(3 * time.Second):
		t.Fatal("peer credentials never read")
	}
}

func TestListen_ReplacesAStaleSocket(t *testing.T) {
	dir := shortTempDir(t)
	stale, err := net.Listen("unix", SocketPath(dir))
	if err != nil {
		t.Fatal(err)
	}
	stale.(*net.UnixListener).SetUnlinkOnClose(false)
	stale.Close()
	listener, err := Listen(dir, ListenOptions{})
	if err != nil {
		t.Fatalf("a crashed daemon's socket must be replaced: %v", err)
	}
	listener.Close()
}

func TestListen_RefusesWhileAnotherListenerIsLive(t *testing.T) {
	dir := shortTempDir(t)
	live, err := Listen(dir, ListenOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer live.Close()
	go func() {
		for {
			conn, err := live.Accept()
			if err != nil {
				return
			}
			conn.Close()
		}
	}()
	if second, err := Listen(dir, ListenOptions{}); !errors.Is(err, ErrSocketInUse) {
		if second != nil {
			second.Close()
		}
		t.Fatalf("want ErrSocketInUse, got %v", err)
	}
}

func TestListen_RefusesSomethingOtherThanASocketAtThePath(t *testing.T) {
	dir := shortTempDir(t)
	os.WriteFile(SocketPath(dir), []byte("not a socket"), 0o600)
	if _, err := Listen(dir, ListenOptions{}); !errors.Is(err, ErrUnsafeDirectory) {
		t.Fatalf("want ErrUnsafeDirectory, got %v", err)
	}
	if data, _ := os.ReadFile(SocketPath(dir)); string(data) != "not a socket" {
		t.Fatal("a regular file at the socket path was removed")
	}
}

func TestStart_WritesDiscoveryAndCloseRemovesSocketAndDiscovery(t *testing.T) {
	dir := shortTempDir(t)
	backend := &fakeBackend{}
	server := New(Config{DataDir: dir, Backend: backend, WatchInterval: time.Hour, PingInterval: time.Hour})
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Lstat(DiscoveryPath(dir))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("control.json mode: %v %v", info, err)
	}
	var discovery map[string]any
	data, _ := os.ReadFile(DiscoveryPath(dir))
	if json.Unmarshal(data, &discovery) != nil || discovery["version"] != float64(1) || discovery["socket"] != SocketPath(dir) || discovery["pid"] != float64(os.Getpid()) {
		t.Fatalf("discovery %s", data)
	}
	if _, err := time.Parse(time.RFC3339, discovery["started_at"].(string)); err != nil {
		t.Fatalf("started_at %v", discovery["started_at"])
	}
	reply, err := socketClient(dir).Get("http://companion/v1/status")
	if err != nil || reply.StatusCode != 200 {
		t.Fatalf("status over the socket: %v %v", reply, err)
	}
	reply.Body.Close()
	if err := server.Close(); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{SocketPath(dir), DiscoveryPath(dir)} {
		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s left after close", path)
		}
	}
}

func TestStart_RefusesAnUnsafeDirectoryWithoutWritingDiscovery(t *testing.T) {
	dir := shortTempDir(t)
	os.Chmod(dir, 0o755)
	server := New(Config{DataDir: dir, Backend: &fakeBackend{}})
	if err := server.Start(); !errors.Is(err, ErrUnsafeDirectory) {
		t.Fatalf("want ErrUnsafeDirectory, got %v", err)
	}
	if _, err := os.Lstat(DiscoveryPath(dir)); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("discovery written for a refused listener")
	}
	server.Close()
}

func isReset(err error) bool {
	return errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE)
}
