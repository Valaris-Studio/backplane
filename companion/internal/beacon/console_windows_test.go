// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build windows

package beacon

import (
	"os/exec"
	"testing"

	"golang.org/x/sys/windows"
)

func TestBeaconRunsWithoutAConsoleWindow(t *testing.T) {
	process := exec.Command("beacon-hooks")
	hideConsole(process)
	if process.SysProcAttr == nil || !process.SysProcAttr.HideWindow || process.SysProcAttr.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Fatalf("console not hidden: %+v", process.SysProcAttr)
	}
}
