// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package collector

import (
	"os/exec"
	"testing"

	"golang.org/x/sys/windows"
)

func TestCollectorRunsWithoutAConsoleWindow(t *testing.T) {
	process := exec.Command("beacon-otelcol")
	configure(process)
	if process.SysProcAttr == nil || !process.SysProcAttr.HideWindow || process.SysProcAttr.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Fatalf("console not hidden: %+v", process.SysProcAttr)
	}
}
