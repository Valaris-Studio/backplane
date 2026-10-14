// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package process

import (
	"os"
	"os/exec"
	"testing"
)

func TestAliveTellsARunningProcessFromAnExitedOne(t *testing.T) {
	if !Alive(os.Getpid()) {
		t.Fatal("this process is running")
	}
	exited := exec.Command(os.Args[0], "-test.run=^$")
	if err := exited.Run(); err != nil {
		t.Fatal(err)
	}
	if Alive(exited.Process.Pid) {
		t.Fatalf("pid %d exited and was reaped", exited.Process.Pid)
	}
	if Alive(0) || Alive(-1) {
		t.Fatal("non-positive pids are never alive")
	}
}
