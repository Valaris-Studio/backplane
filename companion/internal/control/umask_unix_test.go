// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package control

import (
	"syscall"
	"testing"
)

func TestWithUmask_RestoresTheUmaskAfterAPanic(t *testing.T) {
	before := syscall.Umask(0o022)
	syscall.Umask(before)
	func() {
		defer func() { recover() }()
		withUmask(0o077, func() { panic("listen blew up") })
	}()
	after := syscall.Umask(before)
	if after != before {
		t.Fatalf("umask %o after a panic, want %o", after, before)
	}
}

func TestWithUmask_AppliesTheMaskDuringTheCall(t *testing.T) {
	var during int
	withUmask(0o077, func() {
		during = syscall.Umask(0o077)
	})
	if during != 0o077 {
		t.Fatalf("umask during the call %o, want 077", during)
	}
}
