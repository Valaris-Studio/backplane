// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"context"
	"os"
	"slices"
	"sync"
	"time"
)

// fileStamp is enough to notice an atomic rewrite: every write renames a
// new file into place, so the modification time or size changes.
type fileStamp struct {
	exists  bool
	size    int64
	modTime time.Time
}

// watcher notices changes other processes make to the state files (a CLI
// pause, the daemon's own policy refresh, a hook recording a project) and
// turns them into events. Polling a handful of stats needs no platform
// file-notification API.
type watcher struct {
	server *Server
	config Config
	mu     sync.Mutex
	stamps map[string]fileStamp
}

func newWatcher(server *Server, config Config) *watcher {
	return &watcher{server: server, config: config}
}

func (w *watcher) paths() []string {
	paths := slices.Concat(w.config.WatchPaths, w.config.ProbePaths, w.config.ProjectPaths)
	if w.config.PolicyPath != "" {
		paths = append(paths, w.config.PolicyPath)
	}
	slices.Sort(paths)
	return slices.Compact(paths)
}

func stamp(path string) fileStamp {
	info, err := os.Stat(path)
	if err != nil {
		return fileStamp{}
	}
	return fileStamp{exists: true, size: info.Size(), modTime: info.ModTime()}
}

func (w *watcher) snapshot() map[string]fileStamp {
	stamps := map[string]fileStamp{}
	for _, path := range w.paths() {
		stamps[path] = stamp(path)
	}
	return stamps
}

// resync adopts the current state as seen, after a change the server made
// and announced itself.
func (w *watcher) resync() {
	current := w.snapshot()
	w.mu.Lock()
	w.stamps = current
	w.mu.Unlock()
}

func (w *watcher) run(ctx context.Context) {
	if len(w.paths()) == 0 {
		return
	}
	w.resync()
	ticker := time.NewTicker(w.config.WatchInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.check(ctx)
		}
	}
}

func (w *watcher) check(ctx context.Context) {
	current := w.snapshot()
	w.mu.Lock()
	previous := w.stamps
	w.stamps = current
	w.mu.Unlock()
	var changed []string
	for path, stamp := range current {
		if previous[path] != stamp {
			changed = append(changed, path)
		}
	}
	if len(changed) == 0 {
		return
	}
	backend := w.server.config.Backend
	if containsAny(w.config.ProbePaths, changed) {
		backend.InvalidateProbes()
	}
	if containsAny(w.config.ProjectPaths, changed) {
		if projects, err := backend.Projects(ctx); err == nil {
			w.server.hub.publish("projects", projects)
		}
	}
	if w.config.PolicyPath != "" && slices.Contains(changed, w.config.PolicyPath) {
		w.server.hub.publish("policy.changed", struct{}{})
	}
	w.server.hub.statusChanged()
}

// probeAgents compares the agents' integrations with the reported status
// while a client listens; only a difference republishes status.
func (w *watcher) probeAgents(ctx context.Context) {
	ticker := time.NewTicker(w.config.AgentProbeInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if w.server.hub.count() == 0 {
				continue
			}
			if agents, err := w.server.config.Backend.Agents(ctx); err == nil {
				w.server.hub.agentsProbed(agents)
			}
		}
	}
}

func containsAny(paths, changed []string) bool {
	for _, path := range changed {
		if slices.Contains(paths, path) {
			return true
		}
	}
	return false
}
