// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package beacon

import (
	"os/exec"
	"syscall"

	"golang.org/x/sys/windows"
)

// hideConsole keeps the console-subsystem beacon-hooks from opening a window
// when the windowless daemon starts it.
func hideConsole(process *exec.Cmd) {
	process.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}
