// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package control

import (
	"bufio"
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"syscall"
	"testing"
	"time"
)

func startedServer(t *testing.T, configure func(*Config)) (string, *fakeBackend) {
	t.Helper()
	dir := shortTempDir(t)
	backend := &fakeBackend{}
	config := Config{DataDir: dir, Backend: backend, WatchInterval: time.Hour, PingInterval: time.Hour}
	if configure != nil {
		configure(&config)
	}
	server := New(config)
	if err := server.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { server.Close() })
	return dir, backend
}

func TestServer_CutsOffASlowRequestBody(t *testing.T) {
	dir, _ := startedServer(t, func(config *Config) { config.ReadTimeout = 200 * time.Millisecond })
	conn, err := Dial(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	io.WriteString(conn, "POST /v1/rename HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"na")
	conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	started := time.Now()
	io.ReadAll(conn)
	if elapsed := time.Since(started); elapsed > 2*time.Second {
		t.Fatalf("a stalled body held the connection for %v", elapsed)
	}
}

func TestServer_EventStreamOutlivesTheReadTimeout(t *testing.T) {
	dir, _ := startedServer(t, func(config *Config) {
		config.ReadTimeout = 150 * time.Millisecond
		config.PingInterval = 50 * time.Millisecond
	})
	client := &http.Client{Transport: &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return Dial(ctx, dir) }}}
	reply, err := client.Get("http://companion/v1/events")
	if err != nil {
		t.Fatal(err)
	}
	defer reply.Body.Close()
	lines := make(chan string, 64)
	go func() {
		scanner := bufio.NewScanner(reply.Body)
		for scanner.Scan() {
			lines <- scanner.Text()
		}
		close(lines)
	}()
	deadline := time.After(700 * time.Millisecond)
	pings := 0
	for {
		select {
		case line, open := <-lines:
			if !open {
				t.Fatalf("the stream ended after %d pings, within the read timeout's reach", pings)
			}
			if strings.HasPrefix(line, ": ping") {
				pings++
			}
		case <-deadline:
			if pings < 5 {
				t.Fatalf("only %d pings", pings)
			}
			return
		}
	}
}

func TestListen_TheSocketIsOwnerOnlyFromBirth(t *testing.T) {
	previous := syscall.Umask(0o022)
	defer syscall.Umask(previous)
	dir := shortTempDir(t)
	var bornWith os.FileMode
	listener, err := Listen(dir, ListenOptions{afterBind: func(path string) {
		if info, err := os.Lstat(path); err == nil {
			bornWith = info.Mode().Perm()
		}
	}})
	if err != nil {
		t.Fatal(err)
	}
	listener.Close()
	if bornWith&0o077 != 0 {
		t.Fatalf("the socket was created %o before it was restricted", bornWith)
	}
	if current := syscall.Umask(previous); current != 0o022 {
		t.Fatalf("Listen left the umask at %o", current)
	}
	syscall.Umask(0o022)
}
