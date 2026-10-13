// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build linux

package collector

import (
	"os/exec"
	"syscall"
)

// The kernel terminates the collector if the daemon dies without stopping it.
func configure(process *exec.Cmd) {
	process.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM}
}
