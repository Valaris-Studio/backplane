// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

// Package daemon drains the inbox: it re-checks scope against the freshest
// policy, resolves pending auto-matches, normalizes with Beacon, queues the
// record durably and uploads it.
package daemon

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"sync"
	"sync/atomic"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/richcapture"
	"github.com/Valaris-Studio/backplane/companion/internal/scope"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

const (
	PolicyInterval      = 5 * time.Minute
	policyRetryInterval = time.Minute
	PollInterval        = time.Second
	// ReconcileInterval re-checks owned agent integrations, e.g. after an
	// agent update rewrote its settings.
	ReconcileInterval = 30 * time.Minute
	maxItemsPerTick   = 256
	maxBatchesPerTick = 8
	maxBatchRecords   = 32
	// Leaves room for the {"records":[...]} envelope within the 8 MiB limit.
	maxBatchBytes = 8<<20 - 4<<10
)

var ErrAlreadyRunning = errors.New("daemon_already_running")

// ErrRevoked ends a run: the server revoked the device credential, so
// nothing can be uploaded until the device connects again. The queue is kept.
var ErrRevoked = errors.New("device_revoked")

type API interface {
	Policy(context.Context) (policy.Policy, error)
	ResolveMapping(ctx context.Context, repoURL string) (policy.Mapping, error)
	Ingest(context.Context, []json.RawMessage) (uplink.Ack, error)
	ReportStatus(context.Context, uplink.StatusReport) (bool, error)
}

type Normalizer interface {
	Normalize(context.Context, beacon.Request) (beacon.Result, error)
}

type Config struct {
	Layout     store.Layout
	Client     API
	Normalizer Normalizer
	Registry   *agent.Registry
	Home       string
	TempDirs   []string
	Now        func() time.Time
	// AgentEnv locates agent configuration for reconciliation; a zero value
	// disables it.
	AgentEnv agent.Env
	// OTel enables the OTLP gate, the collector and its runtime source.
	OTel *OTelConfig
	// InstallationID attributes a recorded revocation to this installation.
	InstallationID string
	// Sessions, when set, receives session events from the tick loop.
	Sessions func(SessionEvent)
	// Flush, when set, lets the control API skip the upload backoff once.
	Flush *FlushSignal
}

type Daemon struct {
	config            Config
	queue             *queue.Queue
	nextPolicyRefresh time.Time
	nextReconcile     time.Time
	resolveMu         sync.Mutex
	resolved          map[string]resolvedThread
	otelBackpressure  atomic.Bool
	// observed collects each agent's newest drained observation per pass.
	observed  map[string]time.Time
	heartbeat heartbeatState
	// revoked is set from the tick loop and from the OTLP gate's resolver.
	revoked        atomic.Bool
	nextUsagePrune time.Time
	// windows are the capture windows, owned by the tick loop.
	windows            *captureWindows
	windowsPersistedAt time.Time
	// lastFlushSkip is when a flush last skipped the backoff (tick loop only).
	lastFlushSkip time.Time
	sessionsSeen  map[string]bool
	sessions      sessionTracker
	// rolloutMarks and telemetryHarness are owned by the tick loop.
	rolloutMarks     map[string]rolloutMark
	telemetryHarness map[string]string
	// discovered is what the agents' discovery found this tick, nil until
	// asked, so the usage and content passes walk the directories once.
	discovered *[]discoveredSession
	// spool holds rich capture's bodies until the server settles them.
	spool *richcapture.Spool
	// sources are the session files rich capture reads, owned by the tick
	// loop; sourcesDirty marks them for saving.
	sources      *contentSources
	sourcesDirty bool
	// windowsDurable: the windows, and so their generations, are persisted.
	windowsDurable bool
	// windowsResumed: this run's first observation has run.
	windowsResumed bool
	nextSpoolSweep time.Time
	// lastContentPass counts what the last content pass examined.
	lastContentPass contentPassCounts
	// sourceFacts are each session file as last read to its end, in memory
	// only: unchanged since, it costs a stat.
	sourceFacts map[string]os.FileInfo
}

type contentPassCounts struct {
	cursorLoads, opened int
}

func New(config Config) *Daemon {
	if config.Now == nil {
		config.Now = time.Now
	}
	return &Daemon{config: config, queue: queue.Open(config.Layout).WithClock(config.Now), spool: ContentSpool(config.Layout).WithClock(config.Now)}
}

// Run holds the daemon lock for its lifetime so only one instance drains.
func (d *Daemon) Run(ctx context.Context) error {
	lock, acquired, err := store.TryLock(d.config.Layout.DaemonLock())
	if err != nil {
		return err
	}
	if !acquired {
		return ErrAlreadyRunning
	}
	defer lock.Unlock()
	return d.RunLocked(ctx)
}

// RunLocked runs the loop; the caller already holds the daemon lock.
func (d *Daemon) RunLocked(ctx context.Context) error {
	if d.config.OTel != nil {
		stop := d.startOTel(ctx)
		defer stop()
	}
	defer d.config.Flush.Attach()()
	ticker := time.NewTicker(PollInterval)
	defer ticker.Stop()
	for {
		err := d.Tick(ctx)
		if errors.Is(err, ErrRevoked) {
			return err
		}
		if err != nil && ctx.Err() == nil {
			d.recordDaemonError(err)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		case <-d.config.Flush.Wake():
		}
	}
}

func (d *Daemon) Tick(ctx context.Context) error {
	err := d.tick(ctx)
	if d.revoked.Load() {
		return ErrRevoked
	}
	return err
}

func (d *Daemon) tick(ctx context.Context) error {
	defer d.publishSessions()
	d.discovered = nil
	if !d.config.Now().Before(d.nextPolicyRefresh) {
		d.refreshPolicy(ctx)
	}
	if d.config.AgentEnv.Home != "" && !d.config.Now().Before(d.nextReconcile) {
		d.reconcileAgents(ctx)
	}
	d.windowsDurable = d.observeCaptureWindows()
	if d.config.OTel != nil {
		// Recomputed every tick, whatever the inbox drain does, so the gate
		// never acts on a stale flag.
		defer d.updateOTelBackpressure()
	}
	if err := d.drainInbox(ctx); err != nil {
		return err
	}
	if d.config.OTel != nil {
		if err := d.drainOTel(ctx); err != nil {
			return err
		}
	}
	// After the telemetry, so a trace already delivered claims its session.
	if err := d.pollTranscripts(ctx); err != nil {
		return err
	}
	d.sweepSpool()
	if err := d.pollContent(ctx); err != nil {
		return err
	}
	if err := d.upload(ctx); err != nil {
		return err
	}
	if _, err := d.uploadContent(ctx, false); err != nil {
		return err
	}
	d.sendHeartbeat(ctx)
	return nil
}

func (d *Daemon) refreshPolicy(ctx context.Context) {
	now := d.config.Now()
	fresh, err := d.config.Client.Policy(ctx)
	if err != nil {
		d.nextPolicyRefresh = now.Add(policyRetryInterval)
		if errors.Is(err, uplink.ErrDeviceRevoked) {
			d.nextPolicyRefresh = now.Add(PolicyInterval)
			d.markRevoked(ctx)
		}
		d.recordPolicyError(err)
		return
	}
	d.nextPolicyRefresh = now.Add(PolicyInterval)
	revert := d.negotiateRichCapture(&fresh, now)
	if err := policy.Save(d.config.Layout.Policy(), policy.Cached{Policy: fresh, RefreshedAt: now.UTC()}); err != nil {
		d.recordPolicyError(err)
		return
	}
	if revert {
		if err := d.revertToEventsOnly(ctx); err != nil {
			d.recordDaemonError(err)
		}
	}
	// A new repo catalog may now match repositories refused earlier.
	state.ClearUnmatched(ctx, d.config.Layout)
	if d.setUnauthorized(ctx, false) {
		d.queue.RecordSuccess()
	}
	state.Update(ctx, d.config.Layout, d.config.Layout.Health(), func(health *state.Health) bool {
		health.LastPolicyRefresh, health.LastPolicyError = now.UTC(), ""
		return true
	})
}

// markRevoked records the backend's invalid_device_token 401, answered only
// for an unknown or revoked device token.
func (d *Daemon) markRevoked(ctx context.Context) {
	d.revoked.Store(true)
	d.setUnauthorized(ctx, true)
}

// setUnauthorized records the admission state and reports whether it changed.
func (d *Daemon) setUnauthorized(ctx context.Context, unauthorized bool) bool {
	changed := false
	state.Update(ctx, d.config.Layout, d.config.Layout.Admission(), func(admission *state.Admission) bool {
		if admission.Unauthorized == unauthorized {
			return false
		}
		admission.Unauthorized, admission.Since, changed = unauthorized, d.config.Now().UTC(), true
		admission.InstallationID = ""
		if unauthorized {
			admission.InstallationID = d.config.InstallationID
		}
		return true
	})
	return changed
}

func (d *Daemon) recordPolicyError(err error) {
	state.Update(context.Background(), d.config.Layout, d.config.Layout.Health(), func(health *state.Health) bool {
		health.LastPolicyError = errorCode(err)
		return true
	})
}

// reconcileAgents repoints stale owned integrations (e.g. after the
// companion moved). It never re-adds hooks the user removed and never
// installs into an agent the user has not set up; those conditions are only
// noted, once per change.
func (d *Daemon) reconcileAgents(ctx context.Context) {
	d.nextReconcile = d.config.Now().Add(ReconcileInterval)
	for _, adapter := range d.config.Registry.All() {
		status := adapter.Status(d.config.AgentEnv)
		if status.State != agent.Broken {
			state.Update(ctx, d.config.Layout, d.config.Layout.Health(), func(health *state.Health) bool {
				return health.ClearCondition(adapter.ID())
			})
			continue
		}
		changed, err := adapter.Repair(d.config.AgentEnv)
		if errors.Is(err, agent.ErrConfigChanged) {
			continue
		}
		note := state.AgentRepair{Agent: adapter.ID(), At: d.config.Now().UTC(), Problems: status.Problems, Result: "unrepaired"}
		switch {
		case err != nil:
			note.Result = "failed:" + errorCode(err)
		case changed:
			note.Result = "repaired"
		}
		state.Update(ctx, d.config.Layout, d.config.Layout.Health(), func(health *state.Health) bool {
			health.NoteCondition(note)
			return true
		})
	}
}

func (d *Daemon) recordDaemonError(err error) {
	state.Update(context.Background(), d.config.Layout, d.config.Layout.Health(), func(health *state.Health) bool {
		health.LastDaemonError = errorCode(err)
		return true
	})
}

func (d *Daemon) scopeInput() (scope.Input, error) {
	return ScopeInput(d.config.Layout, d.config.InstallationID, d.config.Home, d.config.TempDirs, d.config.Now())
}

// ScopeInput is what capture decides a directory's scope against: the cached
// policy and the local preferences, admission and refused repositories. Agent
// access decides its folders against the same input.
func ScopeInput(layout store.Layout, installationID, home string, tempDirs []string, now time.Time) (scope.Input, error) {
	input := scope.Input{Home: home, TempDirs: tempDirs, Now: now}
	cached, err := policy.Load(layout.Policy())
	if err == nil {
		input.Policy = &cached
	}
	preferences, err := state.Load[state.Preferences](layout.Preferences())
	if err != nil {
		return input, err
	}
	admission, err := state.Load[state.Admission](layout.Admission())
	if err != nil {
		return input, err
	}
	discovered, err := state.Load[state.Discovered](layout.Discovered())
	if err != nil {
		return input, err
	}
	input.LocalPaused, input.IgnoredPaths = preferences.Paused, preferences.IgnoredPaths
	input.Unauthorized = admission.RevokedFor(installationID)
	input.UnmatchedRoots = discovered.UnmatchedRoots()
	return input, nil
}

// errStopDrain ends a drain pass early while keeping the current item, so
// each session's events stay in order for the next pass.
var errStopDrain = errors.New("stop_drain")

func (d *Daemon) drainInbox(ctx context.Context) error {
	names, err := inbox.List(d.config.Layout.InboxDir())
	if err != nil {
		return err
	}
	if len(names) > maxItemsPerTick {
		names = names[:maxItemsPerTick]
	}
	d.observed = map[string]time.Time{}
	defer d.flushObserved(ctx)
	for _, name := range names {
		if ctx.Err() != nil {
			return nil
		}
		err := d.drainItem(ctx, name)
		if errors.Is(err, errStopDrain) {
			return nil
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// observed is one admitted observation from an ingress, awaiting
// normalization. The inbox is the hook ingress; another ingress (an OTLP
// scope proxy, a plugin) supplies the same value and reuses process.
type observed struct {
	captureID string
	adapter   agent.Agent
	// harness overrides the adapter id when one adapter serves several
	// harnesses (Codex CLI and Desktop).
	harness string
	// ingress overrides the adapter's when an observation arrived another
	// way (Claude Code usage is read from its transcript, not its hooks).
	ingress agent.Ingress
	// parentSessionID is the root session of a subagent thread.
	parentSessionID string
	observation     agent.Observation
	payload         map[string]any
	receivedAt      time.Time
}

// captureID is derived from the source item, so replaying an item after a
// crash yields the same id and is recognized instead of uploaded twice.
func captureID(agentID, sourceKey string) string {
	sum := sha256.Sum256([]byte(agentID + "\x00" + sourceKey))
	return hex.EncodeToString(sum[:16])
}

func (d *Daemon) drainItem(ctx context.Context, name string) error {
	dir := d.config.Layout.InboxDir()
	item, err := inbox.Read(dir, name)
	if err != nil {
		d.countDropped()
		return inbox.Remove(dir, name)
	}
	adapter, err := d.config.Registry.Lookup(item.Agent)
	if err != nil {
		d.countDropped()
		return inbox.Remove(dir, name)
	}
	err = d.process(ctx, observed{
		captureID:   captureID(adapter.ID(), name),
		adapter:     adapter,
		observation: item.Observation,
		payload:     item.Payload,
		receivedAt:  item.ReceivedAt,
	})
	if err != nil {
		return err
	}
	d.noteSessionSeen(adapter, item)
	if _, reads := adapter.(agent.ContentSource); reads && item.ContentFile != "" {
		d.noteContentSource(item.ContentFile, contentSource{Agent: adapter.ID(), SessionID: item.Observation.NativeSessionID, Cwd: item.Observation.Cwd, FirstSeen: item.ReceivedAt, SeenAt: item.ReceivedAt})
	}
	if err := d.drainUsage(ctx, adapter, item); err != nil {
		return err
	}
	return inbox.Remove(dir, name)
}

// process takes an observation to the durable queue. A nil result means the
// source copy may be deleted: the record is queued, was already queued, or
// the observation was deliberately dropped. errStopDrain keeps the source.
func (d *Daemon) process(ctx context.Context, item observed) error {
	if known, err := d.queue.Has(item.captureID); err != nil || known {
		return err
	}
	decision, err := d.decide(ctx, item.adapter.ID(), item.observation.Cwd)
	if err != nil {
		return err
	}
	if !decision.InScope {
		if decision.Reason.Transient() {
			return errStopDrain
		}
		if decision.Discovered != nil {
			state.RecordDiscovered(ctx, d.config.Layout, *decision.Discovered, d.config.Now())
		}
		return nil
	}
	events, err := d.normalize(ctx, item, decision.ContentLevel)
	if errors.Is(err, beacon.ErrNoEvents) {
		state.Update(ctx, d.config.Layout, d.config.Layout.Health(), func(health *state.Health) bool {
			health.BeaconEmpty++
			return true
		})
		return nil
	}
	if errors.Is(err, beacon.ErrNormalize) {
		d.countNormalizeFailure()
		return nil
	}
	if err != nil {
		return errStopDrain
	}
	// At the metadata level Beacon saw only sizes and hashes; at the standard
	// level it still derives what the level keeps on the device, such as an
	// edit's diff, so the event filter runs on what it made.
	if decision.ContentLevel == privacy.Standard {
		for index, line := range events.Events {
			if events.Events[index], err = applyEventLevel(line, privacy.Standard); err != nil {
				d.countDropped()
				return nil
			}
		}
	}
	return d.enqueue(item, decision.MappingID, decision.Place, decision.ContentLevel, events)
}

// enqueue places, builds and durably queues the record. An ingress whose
// events are already normalized (e.g. Beacon's OTLP collector) enters here.
func (d *Daemon) enqueue(item observed, mappingID string, place privacy.Place, level privacy.ContentLevel, events beacon.Result) error {
	deletedHistory, historyDeleted := state.DeletedThrough(d.config.Layout, mappingID, item.harnessID(), item.observation.NativeSessionID, d.config.Now())
	through := deletedHistory.DeletedThrough
	if historyDeleted {
		// The server drops these too; leaving them out saves the upload.
		if !item.receivedAt.After(through) {
			events.Events = nil
		} else {
			events.Events = eventsObservedAfter(events.Events, through, item.receivedAt)
		}
		if len(events.Events) == 0 {
			state.Update(context.Background(), d.config.Layout, d.config.Layout.Health(), func(health *state.Health) bool {
				health.SuppressedDeleted++
				return true
			})
			return nil
		}
	}
	placed, err := placeEvents(events.Events, place, level)
	if err != nil {
		d.countDropped()
		return nil
	}
	events.Events = placed
	record, err := buildRecord(item, mappingID, events)
	if err != nil {
		d.countDropped()
		return nil
	}
	err = d.queue.Enqueue(item.captureID, record)
	if err == nil && mappingID != "" && len(place.Roots) > 0 {
		// Best effort: agent access reads it to find a repository's clones.
		state.RecordMappedRoot(context.Background(), d.config.Layout, place.Roots[0], mappingID, d.config.Now())
	}
	if err == nil {
		d.sessions.noteQueued(item.harnessID(), item.observation.NativeSessionID, place.RepoURL, mappingID, item.receivedAt, item.observation.Event, events.Events)
		if historyDeleted {
			d.sessions.noteHistoryDeleted(item.harnessID(), item.observation.NativeSessionID, through, deletedHistory.Reason)
		}
	}
	if err == nil && item.receivedAt.After(d.observed[item.adapter.ID()]) {
		d.observed[item.adapter.ID()] = item.receivedAt
	}
	switch {
	case errors.Is(err, queue.ErrCapacity):
		return errStopDrain
	case errors.Is(err, queue.ErrInvalidRecord):
		d.countDropped()
		return nil
	}
	// On success Enqueue has fsynced the record, so the source may go.
	return err
}

// decide re-checks scope with the freshest policy and resolves a pending
// auto-match so the returned decision names a concrete mapping.
func (d *Daemon) decide(ctx context.Context, agentID, cwd string) (scope.Decision, error) {
	input, err := d.scopeInput()
	if err != nil {
		return scope.Decision{}, err
	}
	input.AgentID, input.Cwd = agentID, cwd
	decision := scope.Decide(input)
	if decision.PendingAutoMatch == nil {
		return decision, nil
	}
	pending := *decision.PendingAutoMatch
	mapping, err := d.config.Client.ResolveMapping(ctx, pending.RepoURL)
	switch {
	case isMappingRefusal(err):
		state.MarkUnmatched(ctx, d.config.Layout, scope.Project{Root: pending.Root, RepoURL: pending.RepoURL}, d.config.Now())
		return scope.Decision{Reason: scope.ReasonUnmapped}, nil
	case errors.Is(err, uplink.ErrDeviceRevoked):
		d.markRevoked(ctx)
		return scope.Decision{}, errStopDrain
	case err != nil:
		return scope.Decision{}, errStopDrain
	}
	cached := input.Policy.WithMapping(mapping)
	if err := policy.Save(d.config.Layout.Policy(), cached); err != nil {
		return scope.Decision{}, err
	}
	state.ForgetDiscovered(ctx, d.config.Layout, pending.Root)
	input.Policy = &cached
	return scope.Decide(input), nil
}

// isMappingRefusal reports the server declining to map a repository: no
// accessible match, ambiguous, auto-match disabled or an unparseable URL.
// 403 here is a refusal, not an auth failure; only a revoked-token 401 is.
func isMappingRefusal(err error) bool {
	return errors.Is(err, uplink.ErrNotFound) || errors.Is(err, uplink.ErrConflict) || errors.Is(err, uplink.ErrForbidden) || errors.Is(err, uplink.ErrUnprocessable)
}

func (d *Daemon) normalize(ctx context.Context, item observed, level privacy.ContentLevel) (beacon.Result, error) {
	command, ok := item.adapter.BeaconCommand(item.observation.Event)
	if !ok {
		return beacon.Result{}, beacon.ErrNormalize
	}
	// Applying the (possibly just resolved) mapping's level can only remove
	// content: the shim already stored at most the standard level.
	payload := privacy.ReduceEditContent(item.payload, item.adapter.ID(), level)
	payload = privacy.ApplyContentLevel(privacy.ReduceToolOutput(payload, item.adapter.ToolOutput(item.observation.Event), level), level)
	return d.config.Normalizer.Normalize(ctx, beacon.Request{
		Platform:  item.adapter.BeaconPlatform(),
		Command:   command,
		Event:     item.observation.Event,
		SessionID: item.observation.NativeSessionID,
		Cwd:       item.observation.Cwd,
		Payload:   item.adapter.PrepareBeaconInput(item.observation.Event, payload),
	})
}

// placeEvents rewrites every event so no local path leaves the device.
func placeEvents(events []json.RawMessage, place privacy.Place, level privacy.ContentLevel) ([]json.RawMessage, error) {
	placed := make([]json.RawMessage, len(events))
	for index, line := range events {
		var event map[string]any
		decoder := json.NewDecoder(bytes.NewReader(line))
		decoder.UseNumber()
		if err := decoder.Decode(&event); err != nil {
			return nil, err
		}
		encoded, err := encodeEvent(privacy.PlaceEvent(privacy.WorkingDirectoryName(event, level), place))
		if err != nil {
			return nil, err
		}
		placed[index] = encoded
	}
	return placed, nil
}

func encodeEvent(event map[string]any) (json.RawMessage, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(event); err != nil {
		return nil, err
	}
	return json.RawMessage(bytes.TrimSpace(buffer.Bytes())), nil
}

func (item observed) harnessID() string {
	if item.harness != "" {
		return item.harness
	}
	return item.adapter.ID()
}

func (item observed) collectionMethod() agent.Ingress {
	if item.ingress != "" {
		return item.ingress
	}
	return item.adapter.Ingress()
}

func buildRecord(item observed, mappingID string, result beacon.Result) ([]byte, error) {
	record := uplink.Record{
		CaptureID:             item.captureID,
		MappingID:             mappingID,
		Harness:               item.harnessID(),
		CollectionMethod:      string(item.collectionMethod()),
		NativeSessionID:       item.observation.NativeSessionID,
		ParentNativeSessionID: item.parentSessionID,
		CapturedAt:            item.receivedAt.UTC(),
		Beacon:                uplink.BeaconProvenance{Commit: beacon.Commit, SchemaVersion: &result.SchemaVersion},
		Events:                result.Events,
	}
	if item.observation.HarnessVersion != "" {
		record.HarnessVersion = &item.observation.HarnessVersion
	}
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(record); err != nil {
		return nil, err
	}
	return bytes.TrimSpace(buffer.Bytes()), nil
}

func (d *Daemon) flushObserved(ctx context.Context) {
	if len(d.observed) == 0 {
		return
	}
	state.Update(ctx, d.config.Layout, d.config.Layout.Health(), func(health *state.Health) bool {
		for agentID, observedAt := range d.observed {
			health.NoteActivity(agentID, observedAt, time.Time{})
		}
		return true
	})
}

// uploadedHarnesses names the agents whose records in batch were acknowledged.
func uploadedHarnesses(batch queue.Batch, ack uplink.Ack) map[string]bool {
	acknowledged := map[string]bool{}
	for _, captureID := range ack.Acknowledged {
		acknowledged[captureID] = true
	}
	harnesses := map[string]bool{}
	for index, raw := range batch.Records {
		var record struct {
			Harness string `json:"harness"`
		}
		if acknowledged[batch.IDs[index]] && json.Unmarshal(raw, &record) == nil && record.Harness != "" {
			harnesses[record.Harness] = true
		}
	}
	return harnesses
}

func (d *Daemon) upload(ctx context.Context) error {
	admission, err := state.Load[state.Admission](d.config.Layout.Admission())
	// Taken even when revoked, so a flush never outlives the state it met.
	skipBackoff := d.config.Flush.take()
	if err != nil || admission.RevokedFor(d.config.InstallationID) {
		return err
	}
	for range maxBatchesPerTick {
		ready, err := d.queue.Ready()
		if err != nil || ctx.Err() != nil {
			return err
		}
		// Only the first attempt skips the backoff; a failure records it as
		// any other, so the next wait still escalates.
		if !ready {
			now := d.config.Now()
			if !skipBackoff || now.Sub(d.lastFlushSkip) < FlushFloor {
				return nil
			}
			d.lastFlushSkip = now
		}
		skipBackoff = false
		batch, err := d.queue.Next(maxBatchRecords, maxBatchBytes)
		if err != nil || len(batch.IDs) == 0 {
			return err
		}
		if !d.send(ctx, batch) {
			return nil
		}
	}
	return nil
}

// Drain uploads everything queued, ignoring the retry backoff, until the
// queue is empty, an upload fails or ctx ends. Switching servers sends the
// old server what it captured before the queue is purged; the caller holds
// the session, so no tick loop uploads alongside.
func (d *Daemon) Drain(ctx context.Context) {
	for ctx.Err() == nil {
		batch, err := d.queue.Next(maxBatchRecords, maxBatchBytes)
		if err != nil || len(batch.IDs) == 0 || !d.send(ctx, batch) {
			break
		}
	}
	// The bodies the declarations asked for, best effort within ctx.
	d.drainUploads(ctx)
}

// send uploads one batch and reports whether uploading may continue.
func (d *Daemon) send(ctx context.Context, batch queue.Batch) bool {
	ack, err := d.config.Client.Ingest(ctx, batch.Records)
	if err == nil {
		err = d.settleContent(ctx, batch, ack)
		if err == nil {
			err = commitFault("acked")
		}
		if err != nil {
			d.queue.RecordFailure(errorCode(err))
			return false
		}
	}
	switch {
	case err == nil:
		if _, settleErr := d.queue.Settle(batch, ack); settleErr != nil {
			d.queue.RecordFailure(errorCode(settleErr))
			return false
		}
		d.noteDeletedHistory(ctx, batch, ack)
		now := d.config.Now()
		state.Update(ctx, d.config.Layout, d.config.Layout.Health(), func(health *state.Health) bool {
			health.LastUploadAt = now.UTC()
			for harness := range uploadedHarnesses(batch, ack) {
				health.NoteActivity(harness, time.Time{}, now)
			}
			return true
		})
		return true
	case errors.Is(err, uplink.ErrUnprocessable), errors.Is(err, uplink.ErrTooLarge):
		if len(batch.IDs) == 1 {
			// Rejected whole, as an older server answers rich members.
			if settleErr := d.settleContent(ctx, batch, uplink.Ack{Rejected: []uplink.Rejection{{CaptureID: batch.IDs[0], Reason: "unprocessable"}}}); settleErr != nil {
				return false
			}
		}
		return d.queue.RecordUnprocessable(batch) == nil
	case errors.Is(err, uplink.ErrDeviceRevoked):
		d.markRevoked(ctx)
	}
	if ctx.Err() == nil {
		d.queue.RecordFailure(errorCode(err))
	}
	return false
}

func (d *Daemon) countDropped() {
	state.Update(context.Background(), d.config.Layout, d.config.Layout.Health(), func(health *state.Health) bool {
		health.DroppedItems++
		return true
	})
}

func (d *Daemon) countNormalizeFailure() {
	state.Update(context.Background(), d.config.Layout, d.config.Layout.Health(), func(health *state.Health) bool {
		health.NormalizeFailures++
		return true
	})
}

var knownErrors = []error{
	uplink.ErrDeviceRevoked, uplink.ErrUnauthorized, uplink.ErrForbidden, uplink.ErrNotFound, uplink.ErrConflict,
	uplink.ErrTooLarge, uplink.ErrUnprocessable, uplink.ErrUnavailable, uplink.ErrUnexpectedStatus,
	uplink.ErrInvalidResponse, queue.ErrMalformedAck, queue.ErrNoProgress, policy.ErrInvalid, store.ErrUnsafePath,
	agent.ErrConfigInvalid, agent.ErrConfigSymlink, agent.ErrConfigForeign,
	context.Canceled, context.DeadlineExceeded,
}

func errorCode(err error) string {
	for _, known := range knownErrors {
		if errors.Is(err, known) {
			return known.Error()
		}
	}
	return "internal_error"
}
