// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"bufio"
	"io"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

// Codex Desktop needs no hooks to run, so its threads are found in
// $CODEX_HOME/sessions/YYYY/MM/DD by their rollouts' own session_meta. A
// thread resumed later appends to the rollout of the day it began, so
// every day is looked at, by modification time.
const (
	// discoveryWindow: rollouts untouched for longer are not offered, like
	// a hook sighting older than the daemon's content poll window.
	discoveryWindow = 24 * time.Hour
	// maxDiscoveredHeaders bounds the remembered headers.
	maxDiscoveredHeaders = 4096
)

// discoveredHeader is what a rollout's first line said; a file is read
// once while it stays the same file.
type discoveredHeader struct {
	info os.FileInfo
	ref  agent.ContentFileRef
	// desktop: the header is a Codex Desktop session's.
	desktop bool
}

var (
	discoveryMu       sync.Mutex
	discoveredHeaders = map[string]discoveredHeader{}
)

type rolloutCandidate struct {
	path string
	info os.FileInfo
}

func (Codex) DiscoverContent(env agent.Env, limit int) []agent.ContentFileRef {
	candidates := recentRollouts(filepath.Join(codexHome(env), "sessions"), time.Now().Add(-discoveryWindow))
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].info.ModTime().After(candidates[j].info.ModTime()) })
	discoveryMu.Lock()
	defer discoveryMu.Unlock()
	var found []agent.ContentFileRef
	for _, candidate := range candidates {
		if len(found) >= limit {
			break
		}
		header, known := discoveredHeaders[candidate.path]
		if !known || !os.SameFile(header.info, candidate.info) {
			header = readDiscoveredHeader(env, candidate)
			if len(discoveredHeaders) >= maxDiscoveredHeaders {
				discoveredHeaders = map[string]discoveredHeader{}
			}
			discoveredHeaders[candidate.path] = header
		}
		if header.desktop {
			found = append(found, header.ref)
		}
	}
	return found
}

// recentRollouts are the regular rollout files, by name, under the day
// directories of sessions modified since since. Symlinks are not followed.
func recentRollouts(sessions string, since time.Time) []rolloutCandidate {
	var candidates []rolloutCandidate
	for _, year := range subdirectories(sessions) {
		for _, month := range subdirectories(year) {
			for _, day := range subdirectories(month) {
				entries, _ := os.ReadDir(day)
				for _, entry := range entries {
					if !entry.Type().IsRegular() || !rolloutName.MatchString(entry.Name()) {
						continue
					}
					if info, err := entry.Info(); err == nil && info.ModTime().After(since) {
						candidates = append(candidates, rolloutCandidate{path: filepath.Join(day, entry.Name()), info: info})
					}
				}
			}
		}
	}
	return candidates
}

func subdirectories(dir string) []string {
	entries, _ := os.ReadDir(dir)
	var found []string
	for _, entry := range entries {
		if entry.IsDir() {
			found = append(found, filepath.Join(dir, entry.Name()))
		}
	}
	return found
}

func (Codex) SessionRelation(env agent.Env, path string) (agent.SessionRelation, bool) {
	file, _, ok := openRollout(env, path)
	if !ok {
		return agent.SessionRelation{}, false
	}
	defer file.Close()
	first, complete := readFirstLine(file)
	meta, ok := readSessionMeta(first)
	if !complete || !ok {
		return agent.SessionRelation{}, false
	}
	parent := meta.parent()
	if parent == "" {
		parent = meta.spawnedBy()
	}
	return agent.SessionRelation{SessionID: meta.ID, ParentSessionID: parent}, true
}

// readFirstLine is a rollout's header line, delimiter included at most
// maxRolloutLineBytes. Only that much of the file is read: a longer first
// line is no header, and draining it to its end could read without bound.
func readFirstLine(file io.Reader) ([]byte, bool) {
	first, _, complete := agent.NextLine(bufio.NewReaderSize(io.LimitReader(file, maxRolloutLineBytes), 64<<10), maxRolloutLineBytes)
	return first, complete
}

// readDiscoveredHeader reads a rollout's first line through the same
// confinement as the usage reader. A first line over maxRolloutLineBytes
// is not judged, so its session is not offered.
func readDiscoveredHeader(env agent.Env, candidate rolloutCandidate) discoveredHeader {
	header := discoveredHeader{info: candidate.info}
	file, _, ok := openRollout(env, candidate.path)
	if !ok {
		return header
	}
	defer file.Close()
	first, complete := readFirstLine(file)
	meta, ok := readSessionMeta(first)
	if !complete || !ok || !desktopOriginators[meta.Originator] {
		return header
	}
	header.desktop = true
	header.ref = agent.ContentFileRef{Path: candidate.path, NativeSessionID: meta.ID, Cwd: meta.Cwd, Harness: DesktopID, ParentSessionID: meta.parent()}
	if header.ref.ParentSessionID == "" {
		header.ref.ParentThreadID = meta.spawnedBy()
	}
	if began, err := time.Parse(time.RFC3339Nano, meta.Timestamp); err == nil {
		header.ref.Began = began.UTC()
	}
	return header
}
