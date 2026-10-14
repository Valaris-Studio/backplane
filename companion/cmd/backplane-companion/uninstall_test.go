// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// fullyInstalled is a connected darwin install with the service and Claude
// Code's hooks set up, the state Remove Companion starts from.
func fullyInstalled(t *testing.T) (*harness, *recordingRunner, string) {
	t.Helper()
	h := newHarness(t)
	h.app.goos, h.app.uid = "darwin", 501
	runner := &recordingRunner{}
	h.app.serviceRunner = runner
	h.connect(t)
	installation, err := state.Load[state.Installation](store.Layout{Root: h.data}.Installation())
	if err != nil || installation.ID == "" {
		t.Fatalf("no installation after connect: %v", err)
	}
	for _, step := range [][]string{{"agents", "install", "claude_code"}, {"service", "install"}} {
		if err := h.run(t, step...); err != nil {
			t.Fatal(step, err)
		}
	}
	return h, runner, installation.ID
}

func plistPath(h *harness) string {
	return filepath.Join(h.home, "Library", "LaunchAgents", "dev.backplane.companion.plist")
}

func claudeIntegrationState(t *testing.T, h *harness) string {
	t.Helper()
	if err := h.run(t, "agents", "status", "claude_code"); err != nil {
		t.Fatal(err)
	}
	var reports []agentActionReport
	if err := json.Unmarshal(h.stdout.Bytes(), &reports); err != nil || len(reports) != 1 || reports[0].Integration == nil {
		t.Fatalf("agents status: %s %v", h.stdout, err)
	}
	return string(reports[0].Integration.State)
}

func TestUninstallPurge_RemovesHooksServiceKeyringAndDataDir(t *testing.T) {
	h, _, installationID := fullyInstalled(t)
	if state := claudeIntegrationState(t, h); state != "installed" {
		t.Fatalf("precondition: claude hooks installed, got %s", state)
	}
	if err := h.run(t, "uninstall", "--purge"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(h.data); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the data dir must be gone: %v", err)
	}
	if _, err := os.Lstat(plistPath(h)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the LaunchAgent must be gone: %v", err)
	}
	if _, err := h.app.keyring.Load(installationID); err == nil {
		t.Fatal("the keyring entry must be gone")
	}
	if state := claudeIntegrationState(t, h); state == "installed" {
		t.Fatal("Claude Code's hooks must be removed")
	}
	if !h.server.Revoked[installationID] {
		t.Fatal("the installation is revoked on the server, best effort")
	}
}

func TestUninstallPurge_ReportsTheUninstall(t *testing.T) {
	h, _, _ := fullyInstalled(t)
	if err := h.run(t, "uninstall", "--purge"); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Uninstalled   bool `json:"uninstalled"`
		ServerRevoked bool `json:"server_revoked"`
	}
	if err := json.Unmarshal(h.stdout.Bytes(), &result); err != nil || !result.Uninstalled || !result.ServerRevoked {
		t.Fatalf("uninstall output: %s %v", h.stdout, err)
	}
}

func TestUninstallPurge_IsIdempotentAndCreatesNothing(t *testing.T) {
	h, _, _ := fullyInstalled(t)
	for attempt := range 2 {
		if err := h.run(t, "uninstall", "--purge"); err != nil {
			t.Fatalf("attempt %d: %v", attempt, err)
		}
		if _, err := os.Lstat(h.data); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("attempt %d left or recreated the data dir: %v", attempt, err)
		}
	}
}

func TestUninstallPurge_WorksWhenNeverConnected(t *testing.T) {
	h := newHarness(t)
	h.app.goos, h.app.uid = "darwin", 501
	h.app.serviceRunner = &recordingRunner{}
	if err := h.run(t, "uninstall", "--purge"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(h.data); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("nothing is left behind: %v", err)
	}
}

func TestUninstall_WithoutPurgeIsAUsageErrorAndRemovesNothing(t *testing.T) {
	h, _, installationID := fullyInstalled(t)
	for _, args := range [][]string{{"uninstall"}, {"uninstall", "--purge", "extra"}, {"uninstall", "--nope"}} {
		if err := h.run(t, args...); !errors.Is(err, errUsage) {
			t.Fatalf("%v: want a usage error, got %v", args, err)
		}
	}
	if _, err := os.Stat(h.data); err != nil {
		t.Fatalf("the data dir must survive: %v", err)
	}
	if _, err := os.Stat(plistPath(h)); err != nil {
		t.Fatalf("the LaunchAgent must survive: %v", err)
	}
	if _, err := h.app.keyring.Load(installationID); err != nil {
		t.Fatalf("the keyring entry must survive: %v", err)
	}
}

func TestUninstallPurge_RefusesADataDirThatIsHomeOrAnAncestorOfIt(t *testing.T) {
	h := newHarness(t)
	h.app.goos, h.app.uid = "darwin", 501
	h.app.serviceRunner = &recordingRunner{}
	sentinel := filepath.Join(h.home, "keep.txt")
	mustWrite(t, sentinel, "precious")
	for _, root := range []string{h.home, h.home + string(filepath.Separator), h.root, string(filepath.Separator)} {
		h.env[store.EnvHome] = root
		if err := h.run(t, "uninstall", "--purge"); !errors.Is(err, store.ErrUnsafePath) {
			t.Fatalf("%s: want %v, got %v", root, store.ErrUnsafePath, err)
		}
		if _, err := os.Stat(sentinel); err != nil {
			t.Fatalf("%s: the home folder was touched: %v", root, err)
		}
	}
}

func TestUninstallPurge_RefusesWhileADaemonRunsOutsideTheService(t *testing.T) {
	shortPurgeExitWait(t, 50*time.Millisecond)
	h, _, _ := fullyInstalled(t)
	if err := h.run(t, "service", "uninstall"); err != nil {
		t.Fatal(err)
	}
	layout := store.Layout{Root: h.data}
	lock, err := store.Lock(context.Background(), layout.DaemonLock())
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Unlock()
	if err := store.WriteJSON(layout.DaemonPID(), daemonProcess{PID: os.Getpid()}); err != nil {
		t.Fatal(err)
	}
	if err := h.run(t, "uninstall", "--purge"); !errors.Is(err, errDaemonRunning) {
		t.Fatalf("want %v, got %v", errDaemonRunning, err)
	}
	if _, err := os.Stat(layout.Installation()); err != nil {
		t.Fatalf("the data dir must survive a refused purge: %v", err)
	}
}

func shortPurgeExitWait(t *testing.T, timeout time.Duration) {
	previous := daemonExitTimeout
	daemonExitTimeout = timeout
	t.Cleanup(func() { daemonExitTimeout = previous })
}

// Remove runs service uninstall and then the purge as separate processes:
// by the purge the task is gone, and a daemon still exiting from the
// service stop must be waited for, not refused.
func TestUninstallPurge_WaitsForTheDaemonAfterTheTaskWasDeleted(t *testing.T) {
	shortPurgeExitWait(t, 5*time.Second)
	h, _, _ := fullyInstalled(t)
	if err := h.run(t, "service", "uninstall"); err != nil {
		t.Fatal(err)
	}
	layout := store.Layout{Root: h.data}
	lock, err := store.Lock(context.Background(), layout.DaemonLock())
	if err != nil {
		t.Fatal(err)
	}
	if err := store.WriteJSON(layout.DaemonPID(), daemonProcess{PID: os.Getpid()}); err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(300 * time.Millisecond)
		lock.Unlock()
	}()
	if err := h.run(t, "uninstall", "--purge"); err != nil {
		t.Fatalf("purge refused a daemon that was exiting: %v", err)
	}
	if _, err := os.Stat(h.data); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("data dir left")
	}
}

func TestRemoveDataRoot_RemovesTheEmptyVendorFolderOfTheDefaultRoot(t *testing.T) {
	local := t.TempDir()
	root := filepath.Join(local, "Backplane", "Companion")
	if err := os.MkdirAll(filepath.Join(root, "queue"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := removeDataRoot(root, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(local, "Backplane")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the empty vendor folder must be gone: %v", err)
	}
}

func TestRemoveDataRoot_KeepsAVendorFolderThatHoldsAnythingElse(t *testing.T) {
	local := t.TempDir()
	root := filepath.Join(local, "Backplane", "Companion")
	sibling := filepath.Join(local, "Backplane", "Other")
	for _, dir := range []string{root, sibling} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := removeDataRoot(root, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the data dir must be gone: %v", err)
	}
	if _, err := os.Stat(sibling); err != nil {
		t.Fatalf("a neighbour must survive: %v", err)
	}
}

func TestRemoveDataRoot_NeverRemovesTheParentOfAnOverriddenRoot(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "Backplane")
	root := filepath.Join(parent, "Companion")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := removeDataRoot(root, false); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(parent); err != nil {
		t.Fatalf("an override's parent is the user's, and stays: %v", err)
	}
}

func TestRemoveDataRoot_LeavesAParentNotNamedForTheVendor(t *testing.T) {
	parent := filepath.Join(t.TempDir(), "state")
	root := filepath.Join(parent, "backplane-companion")
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := removeDataRoot(root, true); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(parent); err != nil {
		t.Fatalf("a shared parent such as ~/.local/state stays: %v", err)
	}
}
