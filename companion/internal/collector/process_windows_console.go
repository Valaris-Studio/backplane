// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package collector

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// configure keeps the collector from opening a console window when the
// windowless daemon starts it.
func configure(process *exec.Cmd) {
	process.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}
