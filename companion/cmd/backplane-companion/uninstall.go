// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/service"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// daemonExitTimeout is how long uninstall waits for a daemon to release its
// lock. The wait follows the lock, not the service: Remove deletes the
// service in an earlier step, and the daemon it stopped may still be exiting.
var daemonExitTimeout = 10 * time.Second

const daemonExitPoll = 100 * time.Millisecond

type uninstallResult struct {
	Uninstalled   bool `json:"uninstalled"`
	ServerRevoked bool `json:"server_revoked"`
}

// uninstall --purge removes everything this companion set up on the
// machine: every agent's hooks, the service, the device token and the whole
// data directory. It is safe to run again after a partial failure.
func (a *app) uninstall(ctx context.Context, args []string) error {
	flags := newFlags("uninstall")
	purge := flags.Bool("purge", false, "remove every trace of the companion")
	if err := flags.Parse(args); err != nil || flags.NArg() != 0 || !*purge {
		return fmt.Errorf("%w: uninstall --purge", errUsage)
	}
	root, err := a.dataRoot()
	if err != nil {
		return err
	}
	if err := a.refuseUnsafeDataRoot(root); err != nil {
		return err
	}
	// Hooks first: once the service and data are gone they would call a
	// companion with nothing to record into.
	if _, err := a.agentReports("uninstall", nil, false); err != nil {
		return err
	}
	manager, _, err := a.serviceManager()
	if err != nil {
		return err
	}
	// A daemon that outlived the service manager's own wait is waited for
	// below, once more, before anything is deleted.
	if err := manager.Uninstall(ctx); err != nil && !errors.Is(err, service.ErrDaemonStillRunning) {
		return err
	}
	layout := store.Layout{Root: root}
	if !waitForDaemonExit(ctx, layout, daemonExitTimeout) {
		// A daemon started outside the service would keep running over a
		// deleted directory; the user stops it and runs this again.
		return errDaemonRunning
	}
	disconnected, err := a.disconnectDevice(ctx, "")
	if err != nil {
		return err
	}
	defaultRoot := a.dataDirOverride == "" && a.getenv(store.EnvHome) == ""
	if err := removeDataRoot(root, defaultRoot); err != nil {
		return err
	}
	return a.printJSON(uninstallResult{Uninstalled: true, ServerRevoked: disconnected.ServerRevoked})
}

// removeDataRoot also removes the vendor folder that only the default
// Windows root nests under (%LOCALAPPDATA%\Backplane), and only when empty.
func removeDataRoot(root string, defaultRoot bool) error {
	if err := os.RemoveAll(root); err != nil {
		return err
	}
	if vendor := filepath.Dir(root); defaultRoot && filepath.Base(vendor) == "Backplane" {
		_ = os.Remove(vendor) // fails, and keeps it, when anything else lives there
	}
	return nil
}

// refuseUnsafeDataRoot keeps a mistaken BACKPLANE_COMPANION_HOME from
// turning the purge into deleting the home folder or anything above it.
func (a *app) refuseUnsafeDataRoot(root string) error {
	root = filepath.Clean(root)
	home := filepath.Clean(a.home)
	if !filepath.IsAbs(root) || filepath.Dir(root) == root {
		return fmt.Errorf("%w: refusing to remove %s", store.ErrUnsafePath, root)
	}
	sameOrInside := func(path, dir string) bool {
		if a.goos == "darwin" || a.goos == "windows" {
			path, dir = strings.ToLower(path), strings.ToLower(dir)
		}
		return path == dir || strings.HasPrefix(path, strings.TrimSuffix(dir, string(filepath.Separator))+string(filepath.Separator))
	}
	if a.home != "" && sameOrInside(home, root) {
		return fmt.Errorf("%w: %s holds the home folder", store.ErrUnsafePath, root)
	}
	return nil
}

func waitForDaemonExit(ctx context.Context, layout store.Layout, timeout time.Duration) bool {
	if _, err := os.Stat(layout.Root); errors.Is(err, os.ErrNotExist) {
		return true
	}
	deadline := time.Now().Add(timeout)
	for daemonRunning(layout) {
		if time.Now().After(deadline) || ctx.Err() != nil {
			return false
		}
		time.Sleep(daemonExitPoll)
	}
	return true
}
