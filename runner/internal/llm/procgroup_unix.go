// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package llm

import (
	"os/exec"
	"syscall"
)

// setProcessGroup makes the child process the leader of its own process group.
// Without this, an orphaned subtree (claude + every tool it spawns) survives
// the runner's death; the operator finds them via `ps aux` instead of via the
// board. Setting Setpgid lets the runner kill the whole tree on shutdown by
// signalling the negative pgid (-pgid).
//
// Card 40424fb3.
func setProcessGroup(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.Setpgid = true
}
