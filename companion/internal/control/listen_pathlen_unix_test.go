// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package control

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

// kernelSunPathBytes is sizeof(sockaddr_un.sun_path), NUL included.
var kernelSunPathBytes = map[string]int{"darwin": 104, "linux": 108}

// dataDirWithSocketPathLength makes a private data directory whose
// control.sock path is exactly length bytes long.
func dataDirWithSocketPathLength(t *testing.T, length int) string {
	t.Helper()
	dir := shortTempDir(t)
	suffix := len(string(filepath.Separator) + "control.sock")
	for len(dir)+suffix < length {
		room := length - suffix - len(dir) - 1
		if room < 1 {
			t.Fatalf("cannot pad %q to a %d-byte socket path", dir, length)
		}
		dir = filepath.Join(dir, strings.Repeat("d", min(room, 60)))
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if got := len(SocketPath(dir)); got != length {
		t.Fatalf("socket path is %d bytes, want %d", got, length)
	}
	return dir
}

func TestListen_SocketPathTooLongIsClearError(t *testing.T) {
	limit, known := kernelSunPathBytes[runtime.GOOS]
	if !known {
		t.Skip("sun_path size not pinned for " + runtime.GOOS)
	}
	if maxSocketPathBytes != limit-1 {
		t.Fatalf("maxSocketPathBytes = %d, want %d (sun_path minus its NUL)", maxSocketPathBytes, limit-1)
	}
	for _, length := range []int{limit, limit + 40} {
		dir := dataDirWithSocketPathLength(t, length)
		listener, err := Listen(dir, ListenOptions{})
		if !errors.Is(err, ErrSocketPathTooLong) {
			if listener != nil {
				listener.Close()
			}
			t.Fatalf("%d-byte socket path: err %v, want ErrSocketPathTooLong", length, err)
		}
		for _, detail := range []string{SocketPath(dir), strconv.Itoa(length), strconv.Itoa(maxSocketPathBytes)} {
			if !strings.Contains(err.Error(), detail) {
				t.Errorf("error %q does not name %q", err, detail)
			}
		}
		if _, statErr := os.Lstat(SocketPath(dir)); !errors.Is(statErr, os.ErrNotExist) {
			t.Errorf("a socket was left at a refused path: %v", statErr)
		}
	}
}

func TestListen_SocketPathAtTheLimitIsServed(t *testing.T) {
	dir := dataDirWithSocketPathLength(t, maxSocketPathBytes)
	listener, err := Listen(dir, ListenOptions{})
	if err != nil {
		t.Fatalf("%d-byte socket path refused: %v", maxSocketPathBytes, err)
	}
	listener.Close()
}
