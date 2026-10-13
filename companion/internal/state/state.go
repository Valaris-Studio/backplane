// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package state holds the companion's small local state files. Writers that
// may run concurrently (hook shims and the daemon) serialize through one
// short-lived state lock.
package state

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/scope"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

const (
	maxStateBytes     = 1 << 20
	maxDiscovered     = 256
	maxErrorCodeBytes = 64
	// hotPathLockWait bounds how long a hook shim waits to record a counter;
	// losing one count is preferable to slowing the agent.
	hotPathLockWait = 250 * time.Millisecond
)

type Installation struct {
	ID                string    `json:"installation_id"`
	Endpoint          string    `json:"endpoint"`
	AllowLoopbackHTTP bool      `json:"allow_loopback_http,omitempty"`
	Name              string    `json:"name"`
	Platform          string    `json:"platform"`
	ConnectedAt       time.Time `json:"connected_at"`
}

// Preferences are local user choices that apply immediately.
type Preferences struct {
	Paused       bool     `json:"paused"`
	IgnoredPaths []string `json:"ignored_paths,omitempty"`
}

// Admission is daemon-maintained state the shim honors.
type Admission struct {
	Unauthorized bool      `json:"unauthorized"`
	Since        time.Time `json:"since,omitempty"`
	// InstallationID is the installation the server revoked, so a late 401
	// from a replaced installation never marks the current one.
	InstallationID string `json:"installation_id,omitempty"`
}

// RevokedFor reports whether the recorded revocation applies to
// installationID. A flag without an id was written by an older daemon on
// any 401, transient ones included, so it is unverified: capture proceeds
// and the next policy refresh confirms or clears it.
func (a Admission) RevokedFor(installationID string) bool {
	return a.Unauthorized && a.InstallationID != "" && a.InstallationID == installationID
}

type Health struct {
	HookErrors        uint64    `json:"hook_errors"`
	HookLastError     string    `json:"hook_last_error,omitempty"`
	HookLastErrorAt   time.Time `json:"hook_last_error_at,omitempty"`
	InboxDropped      uint64    `json:"inbox_dropped"`
	NormalizeFailures uint64    `json:"normalize_failures"`
	// BeaconEmpty counts events Beacon ran cleanly but mapped to nothing;
	// expected for some events, so a jump signals a Beacon regression.
	BeaconEmpty  uint64 `json:"beacon_empty"`
	DroppedItems uint64 `json:"dropped_items"`
	// SuppressedDeleted counts captures of sessions the owner deleted on the
	// server, dropped locally instead of uploaded.
	SuppressedDeleted uint64 `json:"suppressed_deleted"`
	// UsageCapacityLimitedFiles counts transcripts a usage read left as
	// they were because they hold back more than a cursor keeps, and
	// sessions whose usage state outgrew what loads back; their usage waits
	// until the hold ends.
	UsageCapacityLimitedFiles uint64 `json:"usage_capacity_limited_files,omitempty"`
	// UsageDeferredFiles counts changed transcripts a usage read left for a
	// later one to stay bounded; a steady climb means reads fall behind.
	UsageDeferredFiles uint64    `json:"usage_deferred_files,omitempty"`
	LastPolicyRefresh  time.Time `json:"last_policy_refresh,omitempty"`
	LastPolicyError    string    `json:"last_policy_error,omitempty"`
	LastUploadAt       time.Time `json:"last_upload_at,omitempty"`
	LastDaemonError    string    `json:"last_daemon_error,omitempty"`
	// Agents is keyed by agent id.
	Agents       map[string]AgentActivity `json:"agents,omitempty"`
	AgentRepairs []AgentRepair            `json:"agent_repairs,omitempty"`
	OTel         *OTelHealth              `json:"otel,omitempty"`
	// AgentConditions remembers the last noted integration condition per
	// agent, so an unchanged condition is noted only once.
	AgentConditions map[string]string `json:"agent_conditions,omitempty"`
	// RichCapture counts what rich capture read, staged and settled.
	RichCapture *RichCaptureHealth `json:"rich_capture,omitempty"`
	// Daemon is what the running (or last) daemon was built as, which lags
	// the CLI after an upgrade until the daemon restarts.
	Daemon *DaemonVersion `json:"daemon,omitempty"`
}

// RichCaptureHealth makes what rich capture did not stage measurable.
type RichCaptureHealth struct {
	// OutsideWindow counts session-file records read past, never staged:
	// they lie in a pause, a non-rich stretch or the daemon's downtime.
	OutsideWindow uint64 `json:"content_outside_window"`
	Declared      uint64 `json:"declared"`
	// Copied counts records a fork or resume copied from another session.
	Copied         uint64 `json:"copied,omitempty"`
	SourceReplaced uint64 `json:"source_replaced,omitempty"`
	RecordTooLarge uint64 `json:"record_too_large,omitempty"`
	// SpoolFull counts bodies declared without their body after the spool
	// stayed full past the stall limit.
	SpoolFull uint64 `json:"spool_full,omitempty"`
	// Rejected counts declarations the server rejected, by reason.
	Rejected map[string]uint64 `json:"rejected,omitempty"`
	// EventsOnlyRetries counts rich records resent without their contents.
	EventsOnlyRetries uint64 `json:"events_only_retries,omitempty"`
	// ParseErrors counts session-file lines the agent's parser could not
	// read; they are passed over.
	ParseErrors uint64 `json:"parse_errors,omitempty"`
	// MalformedRefs counts native-record refs written as null: malformed,
	// they could have carried a raw path.
	MalformedRefs uint64 `json:"malformed_refs,omitempty"`
	// SourcesRefused counts session files never opened: outside their
	// agent's content roots, or not a regular file there.
	SourcesRefused uint64 `json:"sources_refused,omitempty"`
	// UnservedHarness counts session files naming a harness their adapter
	// does not serve, captured for the adapter instead.
	UnservedHarness uint64 `json:"unserved_harness,omitempty"`
	// ResumeScanTruncated counts resumed runs the look back's bound cut:
	// what of them lay further back was never read.
	ResumeScanTruncated uint64 `json:"resume_scan_truncated,omitempty"`
	// MissingBodies counts bodies the server asked for that were no longer
	// spooled; each also counts as failed in the spool.
	MissingBodies uint64 `json:"missing_bodies,omitempty"`
	// StalledSources is how many session files a full spool holds back now.
	StalledSources int `json:"stalled_sources,omitempty"`
}

type DaemonVersion struct {
	Version           string    `json:"version"`
	Commit            string    `json:"commit"`
	BeaconCommit      string    `json:"beacon_commit"`
	BeaconHooksSHA256 string    `json:"beacon_hooks_sha256"`
	StartedAt         time.Time `json:"started_at"`
}

// OTelHealth reports the OTLP gate and its collector.
type OTelHealth struct {
	CollectorRunning bool   `json:"collector_running"`
	Forwarded        uint64 `json:"forwarded"`
	Dropped          uint64 `json:"dropped"`
	Expired          uint64 `json:"expired"`
	Evicted          uint64 `json:"evicted"`
	Held             int    `json:"held"`
	LastError        string `json:"last_error,omitempty"`
}

type AgentActivity struct {
	LastObservationAt time.Time `json:"last_observation_at,omitempty"`
	LastUploadAt      time.Time `json:"last_upload_at,omitempty"`
}

// AgentRepair notes one automatic repair of an owned agent integration.
type AgentRepair struct {
	Agent    string    `json:"agent"`
	At       time.Time `json:"at"`
	Problems []string  `json:"problems"`
	Result   string    `json:"result"`
}

const maxAgentRepairs = 20

// NoteCondition records repair unless it describes the same condition as
// the last note for that agent. A real repair is always recorded.
func (h *Health) NoteCondition(repair AgentRepair) {
	condition := repair.Result + ":" + strings.Join(repair.Problems, ",")
	if repair.Result != "repaired" && h.AgentConditions[repair.Agent] == condition {
		return
	}
	if h.AgentConditions == nil {
		h.AgentConditions = map[string]string{}
	}
	h.AgentConditions[repair.Agent] = condition
	h.NoteRepair(repair)
}

// ClearCondition forgets an agent's condition once its integration is healthy.
func (h *Health) ClearCondition(agentID string) bool {
	if _, known := h.AgentConditions[agentID]; !known {
		return false
	}
	delete(h.AgentConditions, agentID)
	return true
}

func (h *Health) NoteRepair(repair AgentRepair) {
	h.AgentRepairs = append(h.AgentRepairs, repair)
	if overflow := len(h.AgentRepairs) - maxAgentRepairs; overflow > 0 {
		h.AgentRepairs = h.AgentRepairs[overflow:]
	}
}

// NoteActivity advances an agent's activity times; it never moves them back.
func (h *Health) NoteActivity(agentID string, observedAt, uploadedAt time.Time) {
	if h.Agents == nil {
		h.Agents = map[string]AgentActivity{}
	}
	activity := h.Agents[agentID]
	if observedAt.After(activity.LastObservationAt) {
		activity.LastObservationAt = observedAt.UTC()
	}
	if uploadedAt.After(activity.LastUploadAt) {
		activity.LastUploadAt = uploadedAt.UTC()
	}
	h.Agents[agentID] = activity
}

type DiscoveredProject struct {
	scope.Project
	// Unmatched means the server refused to auto-map this repository.
	Unmatched bool `json:"unmatched,omitempty"`
	// RefusedRepoURL is the remote that refusal was for, so removing and
	// restoring that same remote does not ask the server again.
	RefusedRepoURL string    `json:"refused_repo_url,omitempty"`
	FirstSeen      time.Time `json:"first_seen"`
}

type Discovered struct {
	Projects []DiscoveredProject `json:"projects"`
}

func (d Discovered) Contains(root string) bool {
	for _, project := range d.Projects {
		if project.Root == root {
			return true
		}
	}
	return false
}

// Knows reports whether project is recorded with its current remote.
func (d Discovered) Knows(project scope.Project) bool {
	for _, known := range d.Projects {
		if known.Root == project.Root {
			return known.RepoURL == project.RepoURL
		}
	}
	return false
}

// adoptRemote brings a recorded root up to its current remote. The refusal
// holds only while the remote is the one refused; any other remote is
// offered for auto-match again.
func (p *DiscoveredProject) adoptRemote(repoURL string) bool {
	if p.RepoURL == repoURL {
		return false
	}
	if p.Unmatched && p.RefusedRepoURL == "" {
		// Written before the refused remote was recorded.
		p.RefusedRepoURL = p.RepoURL
	}
	if repoURL != "" && repoURL != p.RefusedRepoURL {
		p.RefusedRepoURL = ""
	}
	p.RepoURL = repoURL
	p.Unmatched = repoURL != "" && repoURL == p.RefusedRepoURL
	return true
}

// UnmatchedRoots includes a root whose refused remote was removed, so
// restoring that remote is not offered to the server again.
func (d Discovered) UnmatchedRoots() []string {
	var roots []string
	for _, project := range d.Projects {
		if project.Unmatched || project.RefusedRepoURL != "" {
			roots = append(roots, project.Root)
		}
	}
	return roots
}

// Load reads a state file; a missing file yields the zero value.
func Load[T any](path string) (T, error) {
	var value T
	err := store.ReadJSON(path, maxStateBytes, &value)
	if errors.Is(err, os.ErrNotExist) {
		return value, nil
	}
	return value, err
}

// Update applies change under the state lock and writes only when change
// reports a modification.
func Update[T any](ctx context.Context, layout store.Layout, path string, change func(*T) bool) error {
	if err := store.EnsurePrivateDir(filepath.Dir(path)); err != nil {
		return err
	}
	lock, err := store.Lock(ctx, layout.StateLock())
	if err != nil {
		return err
	}
	defer lock.Unlock()
	value, err := Load[T](path)
	if err != nil {
		return err
	}
	if !change(&value) {
		return nil
	}
	return store.WriteJSON(path, value)
}

func RecordHookError(layout store.Layout, code string, now time.Time) error {
	ctx, cancel := context.WithTimeout(context.Background(), hotPathLockWait)
	defer cancel()
	if len(code) > maxErrorCodeBytes {
		code = code[:maxErrorCodeBytes]
	}
	return Update(ctx, layout, layout.Health(), func(health *Health) bool {
		health.HookErrors++
		health.HookLastError = code
		health.HookLastErrorAt = now.UTC()
		return true
	})
}

// RecordDiscovered remembers an unmapped repository and keeps its remote
// current; it never records content, only its root and normalized remote.
func RecordDiscovered(ctx context.Context, layout store.Layout, project scope.Project, now time.Time) error {
	return Update(ctx, layout, layout.Discovered(), func(discovered *Discovered) bool {
		for index := range discovered.Projects {
			if discovered.Projects[index].Root == project.Root {
				return discovered.Projects[index].adoptRemote(project.RepoURL)
			}
		}
		if len(discovered.Projects) >= maxDiscovered {
			return false
		}
		discovered.Projects = append(discovered.Projects, DiscoveredProject{Project: project, FirstSeen: now.UTC()})
		return true
	})
}

func MarkUnmatched(ctx context.Context, layout store.Layout, project scope.Project, now time.Time) error {
	return Update(ctx, layout, layout.Discovered(), func(discovered *Discovered) bool {
		for index := range discovered.Projects {
			if discovered.Projects[index].Root == project.Root {
				known := &discovered.Projects[index]
				changed := known.adoptRemote(project.RepoURL) || !known.Unmatched || known.RefusedRepoURL != project.RepoURL
				known.Unmatched, known.RefusedRepoURL = true, project.RepoURL
				return changed
			}
		}
		if len(discovered.Projects) >= maxDiscovered {
			return false
		}
		discovered.Projects = append(discovered.Projects, DiscoveredProject{Project: project, Unmatched: true, RefusedRepoURL: project.RepoURL, FirstSeen: now.UTC()})
		return true
	})
}

// ForgetDiscovered removes a project that has since been mapped or ignored.
func ForgetDiscovered(ctx context.Context, layout store.Layout, root string) error {
	return Update(ctx, layout, layout.Discovered(), func(discovered *Discovered) bool {
		kept := discovered.Projects[:0]
		for _, project := range discovered.Projects {
			if project.Root != root {
				kept = append(kept, project)
			}
		}
		changed := len(kept) != len(discovered.Projects)
		discovered.Projects = kept
		return changed
	})
}

// ClearUnmatched lets repositories be offered for auto-match again, e.g.
// after the policy (and so the repo catalog) was refreshed.
func ClearUnmatched(ctx context.Context, layout store.Layout) error {
	return Update(ctx, layout, layout.Discovered(), func(discovered *Discovered) bool {
		changed := false
		for index := range discovered.Projects {
			project := &discovered.Projects[index]
			if project.Unmatched || project.RefusedRepoURL != "" {
				project.Unmatched, project.RefusedRepoURL = false, ""
				changed = true
			}
		}
		return changed
	})
}

// maxThreads bounds the thread scope table; the least recently seen thread
// is forgotten first. A variable so tests can use a small bound.
var maxThreads = 4096

// threadRefresh is how stale a thread's seen-at time may get before an
// otherwise unchanged hook rewrites it, keeping eviction roughly LRU without
// a write on every hook.
const threadRefresh = time.Hour

// Thread is what an agent's hooks told the companion about one thread: where
// it runs. Scope is decided from it when the thread's telemetry arrives.
type Thread struct {
	Agent     string    `json:"agent"`
	Cwd       string    `json:"cwd"`
	SessionID string    `json:"session_id"`
	SeenAt    time.Time `json:"seen_at"`
	// FirstSeen is when a hook first named the thread; usage recorded
	// before it belongs to the session it was copied from.
	FirstSeen time.Time `json:"first_seen,omitzero"`
	// Transcript is the agent's local transcript of the thread, where the
	// daemon reads usage the thread's telemetry does not carry.
	Transcript string `json:"transcript,omitempty"`
}

type Threads struct {
	Threads map[string]Thread `json:"threads"`
}

// RecordThread stores thread under threadID, writing only when something
// changed so the hook hot path is usually read-only.
func RecordThread(layout store.Layout, threadID string, thread Thread, now time.Time) error {
	if known, err := Load[Threads](layout.Threads()); err == nil {
		existing, found := known.Threads[threadID]
		sameTranscript := thread.Transcript == "" || thread.Transcript == existing.Transcript
		if found && existing.Cwd == thread.Cwd && existing.Agent == thread.Agent && existing.SessionID == thread.SessionID && sameTranscript && now.Sub(existing.SeenAt) < threadRefresh {
			return nil
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), hotPathLockWait)
	defer cancel()
	return Update(ctx, layout, layout.Threads(), func(threads *Threads) bool {
		if threads.Threads == nil {
			threads.Threads = map[string]Thread{}
		}
		thread.SeenAt, thread.FirstSeen = now.UTC(), now.UTC()
		if existing, found := threads.Threads[threadID]; found {
			if !existing.FirstSeen.IsZero() {
				thread.FirstSeen = existing.FirstSeen
			}
			if thread.Transcript == "" {
				thread.Transcript = existing.Transcript
			}
		}
		threads.Threads[threadID] = thread
		for len(threads.Threads) > maxThreads {
			oldest := ""
			for id, candidate := range threads.Threads {
				if oldest == "" || candidate.SeenAt.Before(threads.Threads[oldest].SeenAt) {
					oldest = id
				}
			}
			delete(threads.Threads, oldest)
		}
		return true
	})
}

// OTelSettings records the loopback gate port that agents exporting
// OpenTelemetry were configured with; it must stay stable across restarts.
type OTelSettings struct {
	GatePort int `json:"gate_port"`
}
