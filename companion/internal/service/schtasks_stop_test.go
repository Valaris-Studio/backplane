// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package service

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// exitingDaemon is a daemon that keeps its lock for a few checks after
// schtasks /End, as a terminated process does until Windows has closed its
// handles.
type exitingDaemon struct {
	ended        bool
	checksToExit int
}

func (d *exitingDaemon) running() bool {
	if !d.ended {
		return true
	}
	if d.checksToExit > 0 {
		d.checksToExit--
		return true
	}
	return false
}

func shortDaemonExitWait(t *testing.T, timeout time.Duration) {
	previousTimeout, previousPoll := daemonExitTimeout, daemonExitPoll
	daemonExitTimeout, daemonExitPoll = timeout, time.Millisecond
	t.Cleanup(func() { daemonExitTimeout, daemonExitPoll = previousTimeout, previousPoll })
}

// ownedTaskRunner answers schtasks for our installed task; endOutput is
// what /End returns.
func ownedTaskRunner(daemon *exitingDaemon, endErr error, onDelete func()) *fakeRunner {
	return &fakeRunner{respond: func(command string) (string, error) {
		switch {
		case strings.HasPrefix(command, "schtasks /Query"):
			return "<Description>" + ownershipMarker + "</Description>", nil
		case strings.HasPrefix(command, "schtasks /End"):
			daemon.ended = true
			return "", endErr
		case strings.HasPrefix(command, "schtasks /Delete"):
			if onDelete != nil {
				onDelete()
			}
		}
		return "", nil
	}}
}

func TestScheduledTaskStop_WaitsForTheDaemonToExit(t *testing.T) {
	shortDaemonExitWait(t, time.Second)
	daemon := &exitingDaemon{checksToExit: 5}
	spec := windowsTaskSpec(t)
	spec.IsRunning = daemon.running
	manager, _ := New("windows", spec, ownedTaskRunner(daemon, nil, nil))
	if err := manager.Stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if daemon.checksToExit != 0 || daemon.running() {
		t.Fatal("stop returned while the daemon still held its lock")
	}
}

func TestScheduledTaskStop_TaskNotRunningIsSuccess(t *testing.T) {
	shortDaemonExitWait(t, time.Second)
	daemon := &exitingDaemon{ended: true}
	spec := windowsTaskSpec(t)
	spec.IsRunning = daemon.running
	manager, _ := New("windows", spec, ownedTaskRunner(daemon, errors.New("ERROR: The task is not running"), nil))
	if err := manager.Stop(context.Background()); err != nil {
		t.Fatalf("an already stopped task: %v", err)
	}
}

func TestScheduledTaskStop_ADaemonThatNeverExitsIsAnError(t *testing.T) {
	shortDaemonExitWait(t, 20*time.Millisecond)
	spec := windowsTaskSpec(t)
	spec.IsRunning = func() bool { return true }
	manager, _ := New("windows", spec, ownedTaskRunner(&exitingDaemon{}, nil, nil))
	if err := manager.Stop(context.Background()); !errors.Is(err, ErrDaemonStillRunning) {
		t.Fatalf("stop reported %v for a daemon that is still running", err)
	}
}

func TestScheduledTaskStop_EndFailingWhileTheDaemonRunsIsAnError(t *testing.T) {
	shortDaemonExitWait(t, 20*time.Millisecond)
	spec := windowsTaskSpec(t)
	spec.IsRunning = func() bool { return true }
	endErr := errors.New("ERROR: Access is denied")
	manager, _ := New("windows", spec, ownedTaskRunner(&exitingDaemon{}, endErr, nil))
	err := manager.Stop(context.Background())
	if !errors.Is(err, ErrDaemonStillRunning) || !errors.Is(err, endErr) {
		t.Fatalf("stop hid why the daemon kept running: %v", err)
	}
}

func TestScheduledTaskUninstall_WaitsForTheDaemonBeforeReturning(t *testing.T) {
	shortDaemonExitWait(t, time.Second)
	daemon := &exitingDaemon{checksToExit: 5}
	spec := windowsTaskSpec(t)
	spec.DataDir = t.TempDir()
	spec.IsRunning = daemon.running
	taskFile := filepath.Join(spec.DataDir, "service", "companion-task.xml")
	mustWriteFile(t, taskFile)
	// schtasks /End reports an error for a task that just ended; the
	// daemon's exit, not that answer, decides.
	runner := ownedTaskRunner(daemon, errors.New("ERROR: The task is not running"), nil)
	manager, _ := New("windows", spec, runner)
	if err := manager.Uninstall(context.Background()); err != nil {
		t.Fatalf("uninstall: %v", err)
	}
	if daemon.running() {
		t.Fatal("uninstall returned while the daemon still held its files")
	}
	if runner.ran("schtasks /Delete /TN "+taskName+" /F") != 1 {
		t.Fatalf("task not deleted: %v", runner.calls)
	}
	if _, err := os.Stat(taskFile); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("task file left")
	}
}

func TestScheduledTaskUninstall_StillDeletesTheTaskWhenTheDaemonOutlivesTheWait(t *testing.T) {
	shortDaemonExitWait(t, 20*time.Millisecond)
	spec := windowsTaskSpec(t)
	spec.DataDir = t.TempDir()
	spec.IsRunning = func() bool { return true }
	runner := ownedTaskRunner(&exitingDaemon{}, nil, nil)
	manager, _ := New("windows", spec, runner)
	if err := manager.Uninstall(context.Background()); !errors.Is(err, ErrDaemonStillRunning) {
		t.Fatalf("uninstall reported %v for a daemon still running", err)
	}
	if runner.ran("schtasks /Delete /TN "+taskName+" /F") != 1 {
		t.Fatal("the task must still be deleted so it cannot start at the next logon")
	}
}

func TestScheduledTaskUninstall_AnUninstalledTaskNeedsNoWait(t *testing.T) {
	shortDaemonExitWait(t, 20*time.Millisecond)
	spec := windowsTaskSpec(t)
	spec.DataDir = t.TempDir()
	spec.IsRunning = func() bool { return false }
	runner := &fakeRunner{respond: func(command string) (string, error) {
		if strings.HasPrefix(command, "schtasks /Query") {
			return "", errExit
		}
		return "", nil
	}}
	manager, _ := New("windows", spec, runner)
	if err := manager.Uninstall(context.Background()); err != nil {
		t.Fatalf("second uninstall: %v", err)
	}
	if runner.ran("schtasks /End") != 0 || runner.ran("schtasks /Delete") != 0 {
		t.Fatalf("touched a task that does not exist: %v", runner.calls)
	}
}

func mustWriteFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("task"), 0o600); err != nil {
		t.Fatal(err)
	}
}

// A /Delete failure leaves the task able to start at the next logon, so it
// must not read as "the daemon is still exiting", which Remove tolerates.
func TestScheduledTaskUninstall_DeleteFailureTakesPrecedenceOverAStillRunningDaemon(t *testing.T) {
	shortDaemonExitWait(t, 20*time.Millisecond)
	spec := windowsTaskSpec(t)
	spec.DataDir = t.TempDir()
	spec.IsRunning = func() bool { return true }
	deleteErr := errors.New("ERROR: Access is denied")
	runner := &fakeRunner{respond: func(command string) (string, error) {
		switch {
		case strings.HasPrefix(command, "schtasks /Query"):
			return "<Description>" + ownershipMarker + "</Description>", nil
		case strings.HasPrefix(command, "schtasks /Delete"):
			return "", deleteErr
		}
		return "", nil
	}}
	manager, _ := New("windows", spec, runner)
	err := manager.Uninstall(context.Background())
	if !errors.Is(err, deleteErr) {
		t.Fatalf("delete failure lost: %v", err)
	}
	if errors.Is(err, ErrDaemonStillRunning) {
		t.Fatalf("a failed delete reads as a daemon still exiting: %v", err)
	}
}

func TestScheduledTaskUninstall_TaskFileFailureTakesPrecedenceOverAStillRunningDaemon(t *testing.T) {
	shortDaemonExitWait(t, 20*time.Millisecond)
	spec := windowsTaskSpec(t)
	spec.DataDir = t.TempDir()
	spec.IsRunning = func() bool { return true }
	// A non-empty directory where the task file goes cannot be removed.
	mustWriteFile(t, filepath.Join(spec.DataDir, "service", "companion-task.xml", "blocker"))
	manager, _ := New("windows", spec, ownedTaskRunner(&exitingDaemon{}, nil, nil))
	err := manager.Uninstall(context.Background())
	if err == nil || errors.Is(err, ErrDaemonStillRunning) {
		t.Fatalf("task file failure hidden behind the daemon wait: %v", err)
	}
}
