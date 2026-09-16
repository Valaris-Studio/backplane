// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

//go:build !windows

package llm

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestReviewDiagnosticLeaderExitDoesNotLeaveChild(t *testing.T) {
	root := t.TempDir()
	marker := filepath.Join(root, "survivor")
	path := filepath.Join(root, "codex")
	t.Setenv("REVIEW_MARKER", marker)
	body := "#!/bin/sh\n(/bin/sleep 0.6; printf orphan > \"$REVIEW_MARKER\") &\nprintf 'codex-cli 0.154.0\\n'\nexit 0\n"
	if err := os.WriteFile(path, []byte(body), 0700); err != nil {
		t.Fatal(err)
	}
	_, reason := runRuntimeDiagnostic(context.Background(), path, "--version")
	time.Sleep(800 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatalf("diagnostic descendant survived leader exit: reason=%q", reason)
	}
}

func TestRuntimeHealthSupervisorPipeFailureReapsChildren(t *testing.T) {
	root := t.TempDir()
	marker := filepath.Join(root, "survivor")
	path := filepath.Join(root, "codex")
	t.Setenv("REVIEW_MARKER", marker)
	body := "#!/bin/sh\n(/bin/sleep 0.6; printf orphan > \"$REVIEW_MARKER\") &\nkill -KILL \"$PPID\"\nexit 0\n"
	if err := os.WriteFile(path, []byte(body), 0700); err != nil {
		t.Fatal(err)
	}
	_, reason := runRuntimeDiagnostic(context.Background(), path, "--version")
	if reason == "" {
		t.Fatal("missing supervisor status was accepted")
	}
	time.Sleep(800 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("supervisor failure leaked its process group")
	}
}

func TestRuntimeHealthSupervisorDoesNotPassControlDescriptors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "codex")
	body := "#!/bin/sh\nif (: >&3) 2>/dev/null; then exit 80; fi\nif (: <&4) 2>/dev/null; then exit 81; fi\nprintf 'codex-cli 0.154.0\\n'\n"
	if err := os.WriteFile(path, []byte(body), 0700); err != nil {
		t.Fatal(err)
	}
	output, reason := runRuntimeDiagnostic(context.Background(), path, "--version")
	if reason != "" || output != "codex-cli 0.154.0\n" {
		t.Fatalf("diagnostic inherited control pipes: output=%q reason=%q", output, reason)
	}
}

func TestRuntimeHealthExplicitCancellationReapsStartedChildren(t *testing.T) {
	root := t.TempDir()
	marker := filepath.Join(root, "survivor")
	started := filepath.Join(root, "started")
	path := filepath.Join(root, "codex")
	t.Setenv("REVIEW_MARKER", marker)
	t.Setenv("REVIEW_STARTED", started)
	body := "#!/bin/sh\n(/bin/sleep 0.6; printf orphan > \"$REVIEW_MARKER\") &\nprintf started > \"$REVIEW_STARTED\"\nwait\n"
	if err := os.WriteFile(path, []byte(body), 0700); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan string, 1)
	go func() { _, reason := runRuntimeDiagnostic(ctx, path, "--version"); done <- reason }()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		if time.Now().After(deadline) {
			cancel()
			<-done
			t.Fatal("diagnostic did not start")
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	select {
	case reason := <-done:
		if reason == "" {
			t.Fatal("canceled diagnostic accepted")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancel did not terminate the owned diagnostic")
	}
	time.Sleep(800 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("explicit cancellation leaked a diagnostic descendant")
	}
}

func TestRuntimeHealthParentDeathClosesSupervisorGate(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "codex")
	marker := filepath.Join(root, "survivor")
	started := filepath.Join(root, "started")
	body := "#!/bin/sh\n(/bin/sleep 0.6; printf orphan > \"$REVIEW_MARKER\") &\nprintf started > \"$REVIEW_STARTED\"\nwait\n"
	if err := os.WriteFile(path, []byte(body), 0700); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(os.Args[0], "-test.run=^TestRuntimeHealthParentProcess$")
	command.Env = append(os.Environ(), "TMPDIR="+root, "BACKPLANE_TEST_RUNTIME_PARENT=1", "BACKPLANE_TEST_RUNTIME_PATH="+path, "REVIEW_MARKER="+marker, "REVIEW_STARTED="+started)
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = command.Process.Kill(); _ = command.Wait() }()
	deadline := time.Now().Add(2 * time.Second)
	for {
		if _, err := os.Stat(started); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("diagnostic child did not start")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = command.Wait()
	time.Sleep(800 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("parent death leaked a diagnostic descendant")
	}
}

func TestRuntimeHealthParentProcess(t *testing.T) {
	if os.Getenv("BACKPLANE_TEST_RUNTIME_PARENT") != "1" {
		return
	}
	_, _ = runRuntimeDiagnostic(context.Background(), os.Getenv("BACKPLANE_TEST_RUNTIME_PATH"), "--version")
}
