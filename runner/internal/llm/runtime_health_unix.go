// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package llm

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"syscall"
	"time"
)

const runtimeSupervisorArg = "--backplane-runtime-diagnostic-supervisor"
const runtimeSupervisorEnv = "BACKPLANE_RUNTIME_DIAGNOSTIC_SUPERVISOR"

func init() {
	if len(os.Args) != 4 || os.Args[1] != runtimeSupervisorArg || os.Getenv(runtimeSupervisorEnv) != "1" {
		return
	}
	if os.Args[3] != "--version" && os.Args[3] != "--help" {
		os.Exit(2)
	}
	if syscall.Getpgrp() != os.Getpid() {
		os.Exit(2)
	}
	status := os.NewFile(3, "runtime-diagnostic-status")
	gate := os.NewFile(4, "runtime-diagnostic-gate")
	if status == nil || gate == nil {
		os.Exit(2)
	}
	syscall.CloseOnExec(3)
	syscall.CloseOnExec(4)
	parentGone := make(chan struct{})
	go func() {
		_, _ = gate.Read(make([]byte, 1))
		// Monitor from before launch, including a diagnostic that never exits.
		_ = syscall.Kill(-os.Getpid(), syscall.SIGKILL)
		close(parentGone)
	}()
	command := exec.Command(os.Args[2], os.Args[3])
	command.Env = filterEnv(os.Environ(), runtimeSupervisorEnv)
	command.Stdout, command.Stderr = os.Stdout, os.Stderr
	result := byte(0)
	if command.Run() != nil {
		result = 1
	}
	_, _ = status.Write([]byte{result})
	_ = status.Close()
	// Hold the group leader until the parent kills the whole group. Neither
	// a diagnostic's exit nor an inherited output pipe can release ownership.
	<-parentGone
	os.Exit(2)
}

func runOwnedRuntimeDiagnostic(ctx context.Context, path, arg string, output io.Writer) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	self, err := os.Executable()
	if err != nil {
		return err
	}
	statusRead, statusWrite, err := os.Pipe()
	if err != nil {
		return err
	}
	defer statusRead.Close()
	defer statusWrite.Close()
	gateRead, gateWrite, err := os.Pipe()
	if err != nil {
		return err
	}
	defer gateRead.Close()
	defer gateWrite.Close()
	command := exec.Command(self, runtimeSupervisorArg, path, arg)
	command.Env = append(filterEnv(os.Environ(), runtimeSupervisorEnv), runtimeSupervisorEnv+"=1")
	command.ExtraFiles = []*os.File{statusWrite, gateRead}
	command.Stdout, command.Stderr = output, io.Discard
	command.WaitDelay = 200 * time.Millisecond
	setProcessGroup(command)
	if err := command.Start(); err != nil {
		return err
	}
	_ = statusWrite.Close()
	_ = gateRead.Close()
	done := make(chan error, 1)
	go func() {
		result := make([]byte, 1)
		_, err := io.ReadFull(statusRead, result)
		if err == nil && result[0] != 0 {
			err = errors.New("runtime diagnostic failed")
		}
		done <- err
	}()
	select {
	case err = <-done:
	case <-ctx.Done():
		err = ctx.Err()
	}
	// Wait has never run: even if the supervisor crashed, its unreaped PID
	// cannot have been recycled into another process group.
	_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
	waitErr := command.Wait()
	_ = statusRead.Close()
	if errors.Is(waitErr, exec.ErrWaitDelay) {
		return waitErr
	}
	return err
}
