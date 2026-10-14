// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/scope"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// Usage and content read from a transcript can predate the boundary that
// reads them by any amount, so they are uploaded only if they happened while
// the daemon saw capture allowed for the session's agent and mapping.
// Pauses, disconnects, revocations, mappings not yet on the device and the
// daemon's own downtime all fall outside every window. A window that may
// capture rich content belongs to a capture generation.
const (
	// windowPersistInterval bounds how much of an open window a crash
	// forgets; the forgotten stretch is then treated as not allowed.
	windowPersistInterval = time.Minute
	windowRetention       = usageCursorRetention
	maxWindowsPerKey      = 256
)

type captureWindow struct {
	From     time.Time `json:"from"`
	LastSeen time.Time `json:"last_seen"`
	// The path exclusions and mappings in force throughout the window; a
	// change to either ends it. A session's usage counts only if its
	// directory resolves under them to the mapping it is drained for.
	IgnoredPaths []string          `json:"ignored_paths,omitempty"`
	ExcludeGlobs []string          `json:"exclude_globs,omitempty"`
	Mappings     []mappingSnapshot `json:"mappings,omitempty"`
	// Generation is the rich capture generation the window belongs to; nil
	// for a window without rich capture.
	Generation *captureGeneration `json:"generation,omitempty"`
	// Resumable: an earlier daemon run left the window open. The run's first
	// window continues its generation if nothing changed meanwhile.
	Resumable bool `json:"resumable,omitempty"`
	// Open is only true within the daemon run that observed it.
	Open bool `json:"open,omitempty"`
}

// captureGeneration is persisted identity, never derived: a window copies it
// from the window it continues, or makes it fresh.
type captureGeneration struct {
	ID             string    `json:"id"`
	AdmittedFrom   time.Time `json:"admitted_from"`
	PolicyRevision string    `json:"policy_revision"`
}

type captureWindows struct {
	Windows map[string][]captureWindow `json:"windows"`
}

func windowKey(agentID, mappingID string) string { return agentID + "\x00" + mappingID }

func mappingOfKey(key string) string {
	_, mapping, _ := strings.Cut(key, "\x00")
	return mapping
}

// mappingSnapshot is what decides which mapping a directory resolves to,
// and what it captures there.
type mappingSnapshot struct {
	ID                string    `json:"id"`
	RootPath          string    `json:"root_path,omitempty"`
	RepoURLNormalized string    `json:"repo_url_normalized,omitempty"`
	Enabled           bool      `json:"enabled,omitempty"`
	ContentLevel      string    `json:"content_level,omitempty"`
	RichSince         time.Time `json:"rich_since,omitzero"`
}

// captureSettings are one mapping's settings: its own snapshot first, then
// every mapping that can change how a directory resolves to it, and the
// installation's exclusions.
type captureSettings struct {
	IgnoredPaths []string          `json:"ignored_paths"`
	ExcludeGlobs []string          `json:"exclude_globs"`
	Mappings     []mappingSnapshot `json:"mappings"`
}

// rich reports whether the mapping captures rich content: rich and granted.
func (s captureSettings) rich() bool {
	return len(s.Mappings) > 0 && s.Mappings[0].ContentLevel == string(privacy.Rich) && !s.Mappings[0].RichSince.IsZero()
}

// revision is the opaque policy_revision of a generation.
func (s captureSettings) revision() string {
	encoded, _ := json.Marshal(s)
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func (w captureWindow) sameSettings(current captureSettings) bool {
	return slices.Equal(w.IgnoredPaths, current.IgnoredPaths) && slices.Equal(w.ExcludeGlobs, current.ExcludeGlobs) &&
		slices.Equal(w.Mappings, current.Mappings)
}

func (w *captureWindows) windowAt(key string, at time.Time, admitted func(int, captureWindow) bool) (captureWindow, bool) {
	for index, window := range w.Windows[key] {
		if !at.Before(window.From) && (window.Open || !at.After(window.LastSeen)) && admitted(index, window) {
			return window, true
		}
	}
	return captureWindow{}, false
}

func newGeneration(from time.Time, settings captureSettings) *captureGeneration {
	id := make([]byte, 16)
	rand.Read(id)
	return &captureGeneration{ID: hex.EncodeToString(id), AdmittedFrom: from, PolicyRevision: settings.revision()}
}

// observeCaptureWindows extends the windows of every agent and mapping that
// capture is allowed for now, and closes the rest at their last sighting.
// It reports whether the windows are durable: a generation is used only once
// persisted.
func (d *Daemon) observeCaptureWindows() bool {
	now := d.config.Now()
	if d.windows == nil {
		d.windows = d.loadCaptureWindows()
	}
	allowed, settings := d.allowedCapture()
	changed := false
	for key, windows := range d.windows.Windows {
		last := &windows[len(windows)-1]
		if last.Open && (!allowed[key] || !last.sameSettings(settings[mappingOfKey(key)])) {
			last.Open, changed = false, true
		}
	}
	for key := range allowed {
		windows := d.windows.Windows[key]
		if count := len(windows); count > 0 && windows[count-1].Open {
			windows[count-1].LastSeen = now
			continue
		}
		current := settings[mappingOfKey(key)]
		window := captureWindow{From: now, LastSeen: now, IgnoredPaths: current.IgnoredPaths, ExcludeGlobs: current.ExcludeGlobs, Mappings: current.Mappings, Open: true}
		if current.rich() {
			// A restart with unchanged settings continues the generation;
			// anything else in between started a new one.
			if count := len(windows); count > 0 && windows[count-1].Resumable && windows[count-1].Generation != nil && windows[count-1].sameSettings(current) {
				continued := *windows[count-1].Generation
				window.Generation = &continued
			} else {
				window.Generation = newGeneration(now, current)
			}
		}
		d.windows.Windows[key] = append(windows, window)
		changed = true
	}
	if !d.windowsResumed {
		d.windowsResumed = true
		for _, windows := range d.windows.Windows {
			for index := range windows {
				if windows[index].Resumable {
					windows[index].Resumable, changed = false, true
				}
			}
		}
	}
	for key, windows := range d.windows.Windows {
		kept := windows[:0]
		for _, window := range windows {
			if window.Open || now.Sub(window.LastSeen) <= windowRetention {
				kept = append(kept, window)
			}
		}
		if excess := len(kept) - maxWindowsPerKey; excess > 0 {
			kept = kept[excess:]
		}
		if len(kept) != len(windows) {
			changed = true
		}
		if len(kept) == 0 {
			delete(d.windows.Windows, key)
		} else {
			d.windows.Windows[key] = kept
		}
	}
	if changed || now.Sub(d.windowsPersistedAt) >= windowPersistInterval {
		if err := d.persistWindows(); err != nil {
			return !changed
		}
	}
	return true
}

// persistWindows writes the windows as observed now. Content is committed
// only after this pass's windows are durable, so what it was admitted by
// survives a crash.
func (d *Daemon) persistWindows() error {
	now := d.config.Now()
	if !d.windowsPersistedAt.IsZero() && !d.windowsPersistedAt.Before(now) {
		return nil
	}
	if err := store.WriteJSON(d.config.Layout.CaptureWindows(), d.windows); err != nil {
		return err
	}
	d.windowsPersistedAt = now
	return nil
}

// allowedCapture names the agent and mapping pairs capture is allowed for,
// with each mapping's settings in force. An unreadable state allows nothing.
func (d *Daemon) allowedCapture() (map[string]bool, map[string]captureSettings) {
	allowed := map[string]bool{}
	input, err := d.scopeInput()
	if err != nil || input.Policy == nil {
		return allowed, nil
	}
	for _, adapter := range d.config.Registry.All() {
		_, reads := adapter.(agent.UsageSource)
		_, content := adapter.(agent.ContentSource)
		if !reads && !content {
			continue
		}
		// Each harness an adapter serves is windowed apart, so a harness
		// switched off alone closes its own windows, never its siblings'.
		for _, harness := range servedHarnesses(adapter) {
			input.AgentID = harness
			if !scope.Admits(input) {
				continue
			}
			for _, mapping := range input.Policy.Policy.Mappings {
				if mapping.Enabled {
					allowed[windowKey(harness, mapping.ID)] = true
				}
			}
		}
	}
	ignored := nilIfEmpty(slices.Sorted(slices.Values(input.IgnoredPaths)))
	excludes := nilIfEmpty(slices.Sorted(slices.Values(input.Policy.Policy.Installation.ExcludeGlobs)))
	snapshots := map[string]mappingSnapshot{}
	for _, mapping := range input.Policy.Policy.Mappings {
		snapshot := mappingSnapshot{ID: mapping.ID, RootPath: mapping.RootPath, RepoURLNormalized: mapping.RepoURLNormalized, Enabled: mapping.Enabled, ContentLevel: mapping.ContentLevel}
		if since, granted := input.Policy.Policy.RichSince(mapping.ID); granted && mapping.ContentLevel == string(privacy.Rich) {
			snapshot.RichSince = since.UTC()
		}
		snapshots[mapping.ID] = snapshot
	}
	settings := map[string]captureSettings{}
	for _, mapping := range snapshots {
		related := []mappingSnapshot{}
		for _, other := range snapshots {
			if other.ID != mapping.ID && resolvesAlike(mapping, other) {
				related = append(related, other)
			}
		}
		slices.SortFunc(related, func(a, b mappingSnapshot) int { return strings.Compare(a.ID, b.ID) })
		settings[mapping.ID] = captureSettings{IgnoredPaths: ignored, ExcludeGlobs: excludes, Mappings: append([]mappingSnapshot{mapping}, related...)}
	}
	return allowed, settings
}

// resolvesAlike reports whether other can change how a directory resolves
// to mapping: its root contains or lies in mapping's, or they share a
// repository.
func resolvesAlike(mapping, other mappingSnapshot) bool {
	if mapping.RepoURLNormalized != "" && other.RepoURLNormalized == mapping.RepoURLNormalized {
		return true
	}
	if mapping.RootPath == "" || other.RootPath == "" {
		return false
	}
	root, otherRoot := filepath.Clean(mapping.RootPath), filepath.Clean(other.RootPath)
	return pathWithin(root, otherRoot) || pathWithin(otherRoot, root)
}

func pathWithin(root, path string) bool {
	relative, err := filepath.Rel(root, path)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func nilIfEmpty(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	return values
}

// loadCaptureWindows closes every window a previous run left open: nothing
// observed the pause state while the daemon was down.
func (d *Daemon) loadCaptureWindows() *captureWindows {
	loaded, err := state.Load[captureWindows](d.config.Layout.CaptureWindows())
	if err != nil || loaded.Windows == nil {
		loaded = captureWindows{Windows: map[string][]captureWindow{}}
	}
	for key, windows := range loaded.Windows {
		if len(windows) == 0 || strings.TrimSpace(key) == "" {
			delete(loaded.Windows, key)
			continue
		}
		for index := range windows {
			if windows[index].Open {
				windows[index].Open, windows[index].Resumable = false, true
			}
		}
	}
	return &loaded
}

// captureWindowAt finds the window capture was allowed in at a moment, for
// a session of the agent working in cwd that is drained for the mapping:
// the window's own exclusions and mappings must resolve cwd to that same
// mapping, in scope.
func (d *Daemon) captureWindowAt(agentID, mappingID, cwd string) func(time.Time) (captureWindow, bool) {
	if d.windows == nil {
		d.observeCaptureWindows()
	}
	key := windowKey(agentID, mappingID)
	resolved := map[int]bool{}
	admitted := func(index int, window captureWindow) bool {
		if verdict, known := resolved[index]; known {
			return verdict
		}
		now := d.config.Now()
		mappings := make([]policy.Mapping, len(window.Mappings))
		for position, mapping := range window.Mappings {
			mappings[position] = policy.Mapping{ID: mapping.ID, RootPath: mapping.RootPath, RepoURLNormalized: mapping.RepoURLNormalized, Enabled: mapping.Enabled, ContentLevel: mapping.ContentLevel}
		}
		decision := scope.Decide(scope.Input{
			AgentID: agentID, Cwd: cwd, Home: d.config.Home, TempDirs: d.config.TempDirs, IgnoredPaths: window.IgnoredPaths, Now: now,
			Policy: &policy.Cached{RefreshedAt: now, Policy: policy.Policy{
				Installation: policy.Installation{ID: "capture-window", ExcludeGlobs: window.ExcludeGlobs},
				Mappings:     mappings,
			}},
		})
		resolved[index] = decision.InScope && decision.MappingID == mappingID
		return resolved[index]
	}
	return func(at time.Time) (captureWindow, bool) { return d.windows.windowAt(key, at, admitted) }
}

// captureAllowedAt is captureWindowAt's verdict alone, for usage.
func (d *Daemon) captureAllowedAt(agentID, mappingID, cwd string) func(time.Time) bool {
	window := d.captureWindowAt(agentID, mappingID, cwd)
	return func(at time.Time) bool {
		_, allowed := window(at)
		return allowed
	}
}
