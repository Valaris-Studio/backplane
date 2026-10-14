// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package collector

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

func terminate(process *os.Process) error { return process.Signal(syscall.SIGTERM) }

func alive(pid int) bool {
	process, err := os.FindProcess(pid)
	return err == nil && process.Signal(syscall.Signal(0)) == nil
}

func commandLine(pid int) (string, error) {
	output, err := exec.Command("ps", "-o", "command=", "-p", strconv.Itoa(pid)).Output()
	return strings.TrimSpace(string(output)), err
}
