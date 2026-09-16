// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package llm

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
)

// Card 40424fb3 — verify spawned subprocesses join their own process group.
// Without Setpgid the child inherits the runner's pgid; killing the runner
// pgid does NOT cascade to claude or any tools it forked, so the subtree
// orphans on crash. This test guards against that regression.
func TestExecuteSetsProcessGroup(t *testing.T) {
	dir := t.TempDir()
	// A shim that prints its own pgid then exits 0. Output goes to stdout
	// but Execute parses stream-json from stdout, so an unparseable line is
	// fine — we only care that the binary launched in its own pgroup.
	fake := filepath.Join(dir, "fake-claude.sh")
	pidFile := filepath.Join(dir, "child.pid")
	script := `#!/bin/sh
echo $$ > ` + pidFile + `
exit 0
`
	if err := os.WriteFile(fake, []byte(script), 0o755); err != nil {
		t.Fatalf("write fake: %v", err)
	}

	cli := &ClaudeCLI{ClaudeBin: fake}
	_, _ = cli.Execute(context.Background(), "prompt", Options{})

	pidBytes, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("read pid file: %v", err)
	}
	var pid int
	if _, err := fmtSscan(string(pidBytes), &pid); err != nil {
		t.Fatalf("parse pid: %v", err)
	}

	// Child should be its own pgroup leader → getpgid(pid) == pid.
	pgid, err := syscall.Getpgid(pid)
	// On a fast system the child has already exited by the time this runs;
	// Getpgid then returns ESRCH. The Unit-of-truth assertion is on the cmd
	// configuration, exercised below.
	if err == nil && pgid != pid {
		t.Errorf("child pgid = %d, want %d (own pgroup leader)", pgid, pid)
	}

	// Configuration check: independent of timing, build a cmd via the same
	// helper the production path uses and assert SysProcAttr.Setpgid is set.
	cmd := exec.Command(fake)
	setProcessGroup(cmd)
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setpgid {
		t.Error("setProcessGroup did not set SysProcAttr.Setpgid=true")
	}
}

// Tiny shim so we don't pull in fmt at the top of the test file just to
// parse a number from a file (test stays self-contained).
func fmtSscan(s string, v *int) (int, error) {
	n := 0
	consumed := 0
	for _, r := range s {
		if r < '0' || r > '9' {
			break
		}
		n = n*10 + int(r-'0')
		consumed++
	}
	*v = n
	if consumed == 0 {
		return 0, errZero
	}
	return consumed, nil
}

type sentinelErr string

func (e sentinelErr) Error() string { return string(e) }

const errZero sentinelErr = "no digits"
