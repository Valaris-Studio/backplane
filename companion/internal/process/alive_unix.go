// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package process

import (
	"errors"
	"os"
	"syscall"
)

// Alive reports whether pid runs. Signal 0 checks existence without
// signalling; EPERM means it exists under another user.
func Alive(pid int) bool {
	if pid <= 0 {
		return false
	}
	running, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	err = running.Signal(syscall.Signal(0))
	return err == nil || errors.Is(err, syscall.EPERM)
}
