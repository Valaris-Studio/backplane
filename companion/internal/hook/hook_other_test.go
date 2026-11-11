// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !unix

package hook

import (
	"errors"
	"testing"
)

// Headless mode is Unix-only, so no supported topology has the hook socket
// elsewhere: it refuses with the code headless already uses.
func TestListen_RefusesOnThisPlatform(t *testing.T) {
	if _, err := Listen(`C:\hook.sock`, Options{PeerUID: 10000}); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("want ErrUnsupportedPlatform, got %v", err)
	}
	if err := CheckDirectory(`C:\hook.sock`); !errors.Is(err, ErrUnsupportedPlatform) {
		t.Fatalf("CheckDirectory: want ErrUnsupportedPlatform, got %v", err)
	}
}
