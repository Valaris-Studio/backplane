// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package workloop

import (
	"fmt"
	"os/exec"
)

func configureCompletionProcess(command *exec.Cmd) func() {
	command.Cancel = func() error {
		return exec.Command("taskkill", "/T", "/F", "/PID", fmt.Sprint(command.Process.Pid)).Run()
	}
	return func() {
		if command.Process != nil {
			_ = command.Cancel()
		}
	}
}
