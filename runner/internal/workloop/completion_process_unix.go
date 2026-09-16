// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package workloop

import (
	"os/exec"
	"syscall"
)

func configureCompletionProcess(command *exec.Cmd) func() {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.Cancel = func() error { return syscall.Kill(-command.Process.Pid, syscall.SIGKILL) }
	return func() {
		if command.Process != nil {
			_ = command.Cancel()
		}
	}
}
