// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/beacon"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/richcapture"
	"github.com/Valaris-Studio/backplane/companion/internal/scope"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

// Rich capture's read path: the agents' own session files, read past each
// file's cursor, admitted by the capture windows, declared under their
// generation and queued as content-only records beside the hook events.
const (
	// maxContentReadBytes bounds a pass's reading; one longer line is read
	// alone.
	maxContentReadBytes = 16 << 20
	maxContentSources   = 64
	maxChunkUploads     = 4
	// contentPollWindow: files no hook or discovery named for this long are
	// not read; a later sighting resumes from their cursor.
	contentPollWindow = 24 * time.Hour
	// sightingSkew is how long before its first sighting a session's own
	// line may be written: an agent's hook or extension sends it fire and
	// forget, after the line (19 ms seen from Pi).
	sightingSkew = 2 * time.Second
	// resumeScanBytes bounds the look back for a resumed run's start.
	resumeScanBytes = 1 << 20
	// spoolStallLimit: a body the full spool held back this long is declared
	// without it, so reading moves on.
	spoolStallLimit   = 24 * time.Hour
	maxContentRecord  = 3 << 20
	maxKnownSources   = 4096
	sourceRefresh     = time.Minute
	sourceRetention   = usageCursorRetention
	contentCollection = "poll"
)

func contentSpoolDir(layout store.Layout) string { return filepath.Join(layout.RichDir(), "spool") }

// ContentSpool is the connection's spool of bodies waiting for the server.
func ContentSpool(layout store.Layout) *richcapture.Spool {
	return richcapture.OpenSpool(contentSpoolDir(layout))
}

func contentCursors(layout store.Layout) richcapture.Cursors {
	return richcapture.OpenCursors(filepath.Join(layout.RichDir(), "cursors"))
}

// commitFault lets a test stop the content commit at one of its points, on
// the far side of each fsync: "staged" (bodies and sidecars), "committing"
// (the cursor's intent), "enqueued" (the record), "acked" (the spool took
// the acks, the queue has not settled), "chunk" (a chunk's receipt saved),
// and "staging" (before a body is staged, the read under way).
var commitFault = func(point string) error { return nil }

// contentSource is a session file rich capture reads, named by a hook, the
// transcript poll or an agent's discovery.
type contentSource struct {
	Agent     string `json:"agent"`
	Harness   string `json:"harness,omitempty"`
	SessionID string `json:"session_id"`
	Cwd       string `json:"cwd"`
	// FirstSeen bounds the session's content from below: older records were
	// copied in by a fork or resume.
	FirstSeen time.Time `json:"first_seen"`
	SeenAt    time.Time `json:"seen_at"`
	// Behind: the last read stopped short of the file's end, so the file
	// stays due however long ago it was named.
	Behind bool `json:"behind,omitempty"`
	// Draining: the last read stopped inside an oversized line, so the file
	// is read after the others and its drain keeps none of them waiting.
	Draining bool `json:"draining,omitempty"`
}

type contentSources struct {
	Sources map[string]contentSource `json:"sources"`
}

func (d *Daemon) contentSourcesPath() string {
	return filepath.Join(d.config.Layout.RichDir(), "sources.json")
}

func (d *Daemon) loadContentSources() {
	if d.sources != nil {
		return
	}
	loaded, err := state.Load[contentSources](d.contentSourcesPath())
	if err != nil || loaded.Sources == nil {
		loaded = contentSources{Sources: map[string]contentSource{}}
	}
	d.sources = &loaded
	for path := range maps.Clone(loaded.Sources) {
		if key := sourceKey(path); key != path {
			d.respell(path, key)
		}
	}
}

// sourceKey is a session file's one spelling, however it was named (plain,
// verbatim, through a directory link): its directory canonical, else
// cleaned, and its own name.
func sourceKey(path string) string {
	return filepath.Join(scope.CanonicalOrClean(filepath.Dir(path)), filepath.Base(path))
}

// respell moves a source stored under another spelling to its key. Where
// both were stored, the cursor that read furthest in the same file is kept,
// or the newer file's, so the move never rewinds a read.
func (d *Daemon) respell(from, to string) {
	source := d.sources.Sources[from]
	delete(d.sources.Sources, from)
	if kept, known := d.sources.Sources[to]; known {
		if kept.FirstSeen.Before(source.FirstSeen) {
			source.FirstSeen = kept.FirstSeen
		}
		source.SeenAt = latest(source.SeenAt, kept.SeenAt)
		source.Behind = source.Behind || kept.Behind
	}
	d.sources.Sources[to] = source
	d.sourcesDirty = true
	cursors := contentCursors(d.config.Layout)
	moved, movedKnown, _ := cursors.Load(from)
	kept, keptKnown, _ := cursors.Load(to)
	if movedKnown && (!keptKnown || d.readsFurther(to, source.Agent, moved, kept)) {
		moved.Path = to
		cursors.Save(moved)
	}
}

// readsFurther reports whether cursor, rather than other, is where reading
// the file at path resumes: the one the file on disk still matches, the
// further if both do. With no file to judge by, the newer file's.
func (d *Daemon) readsFurther(path, agentID string, cursor, other richcapture.Cursor) bool {
	adapter, err := d.config.Registry.Lookup(agentID)
	contents, ok := adapter.(agent.ContentSource)
	if err != nil || !ok {
		return cursor.ModTime.After(other.ModTime)
	}
	file, _, err := openConfined(path, contents.ContentRoots(d.config.AgentEnv), richcapture.Cursor{}, false)
	if err != nil {
		return cursor.ModTime.After(other.ModTime)
	}
	defer file.Close()
	describes, otherDescribes := file.Describes(cursor), file.Describes(other)
	if describes != otherDescribes {
		return describes
	}
	return describes && cursor.Position() > other.Position()
}

// noteContentSource records a session file, writing only when it is new or
// its sighting is stale.
func (d *Daemon) noteContentSource(path string, source contentSource) {
	if !filepath.IsAbs(path) {
		return
	}
	d.loadContentSources()
	path = sourceKey(path)
	existing, known := d.sources.Sources[path]
	if !known {
		// Named before its directory existed, it was keyed by a spelling
		// that directory now resolves past.
		for stored := range maps.Clone(d.sources.Sources) {
			if filepath.Base(stored) == filepath.Base(path) && stored != path && sourceKey(stored) == path {
				d.respell(stored, path)
			}
		}
		existing, known = d.sources.Sources[path]
	}
	if known && existing.SessionID == source.SessionID && existing.Cwd == source.Cwd && source.SeenAt.Sub(existing.SeenAt) < sourceRefresh {
		return
	}
	if known && existing.SessionID == source.SessionID {
		source.FirstSeen, source.Behind, source.Draining = existing.FirstSeen, existing.Behind, existing.Draining
	}
	if len(d.sources.Sources) >= maxKnownSources && !known {
		d.pruneContentSources(source.SeenAt)
	}
	d.sources.Sources[path] = source
	d.sourcesDirty = true
}

func (d *Daemon) pruneContentSources(now time.Time) {
	for path, source := range d.sources.Sources {
		if now.Sub(source.SeenAt) > sourceRetention {
			delete(d.sources.Sources, path)
		}
	}
	for len(d.sources.Sources) >= maxKnownSources {
		oldest := ""
		for path, source := range d.sources.Sources {
			if oldest == "" || source.SeenAt.Before(d.sources.Sources[oldest].SeenAt) {
				oldest = path
			}
		}
		delete(d.sources.Sources, oldest)
	}
}

func (d *Daemon) saveContentSources() error {
	if !d.sourcesDirty {
		return nil
	}
	if err := store.EnsurePrivateDir(d.config.Layout.RichDir()); err != nil {
		return err
	}
	if err := store.WriteJSON(d.contentSourcesPath(), d.sources); err != nil {
		return err
	}
	d.sourcesDirty = false
	return nil
}

// richCaptureKnown reports whether the latest policy came from a server that
// knows rich capture; content is never sent to one that does not.
func (d *Daemon) richCaptureKnown() (policy.Cached, bool) {
	cached, err := policy.Load(d.config.Layout.Policy())
	return cached, err == nil && cached.Policy.RichCapture.Present
}

// contentHealth accumulates a pass's counts, written once.
type contentHealth struct {
	state.RichCaptureHealth
	stalled int
	touched bool
}

func (h *contentHealth) flush(d *Daemon) {
	if !h.touched {
		return
	}
	state.Update(context.Background(), d.config.Layout, d.config.Layout.Health(), func(health *state.Health) bool {
		if health.RichCapture == nil {
			health.RichCapture = &state.RichCaptureHealth{}
		}
		current := health.RichCapture
		current.OutsideWindow += h.OutsideWindow
		current.Declared += h.Declared
		current.Copied += h.Copied
		current.SourceReplaced += h.SourceReplaced
		current.RecordTooLarge += h.RecordTooLarge
		current.SpoolFull += h.SpoolFull
		current.EventsOnlyRetries += h.EventsOnlyRetries
		current.MissingBodies += h.MissingBodies
		current.ParseErrors += h.ParseErrors
		current.MalformedRefs += h.MalformedRefs
		current.SourcesRefused += h.SourcesRefused
		current.UnservedHarness += h.UnservedHarness
		current.ResumeScanTruncated += h.ResumeScanTruncated
		for reason, count := range h.Rejected {
			if current.Rejected == nil {
				current.Rejected = map[string]uint64{}
			}
			current.Rejected[reason] += count
		}
		current.StalledSources = h.stalled
		return true
	})
	*h = contentHealth{}
}

func (h *contentHealth) reject(reason string) {
	h.touched = true
	if h.Rejected == nil {
		h.Rejected = map[string]uint64{}
	}
	h.Rejected[reason]++
}

// pollContent reads the session files that changed, at most
// maxContentSources of them and maxContentReadBytes in all.
func (d *Daemon) pollContent(ctx context.Context) error {
	cached, known := d.richCaptureKnown()
	if !known || !d.windowsDurable {
		return nil
	}
	d.loadContentSources()
	now := d.config.Now()
	d.discoverContent(now)
	// Known on disk before anything of them is staged: a killed daemon runs
	// no deferred save.
	if err := d.saveContentSources(); err != nil {
		return err
	}
	defer d.saveContentSources()
	var due []string
	for path, source := range d.sources.Sources {
		if source.Behind || now.Sub(source.SeenAt) < contentPollWindow {
			due = append(due, path)
		}
	}
	sort.Slice(due, func(i, j int) bool {
		first, second := d.sources.Sources[due[i]], d.sources.Sources[due[j]]
		if first.Draining != second.Draining {
			return second.Draining
		}
		return first.SeenAt.After(second.SeenAt)
	})
	health := &contentHealth{}
	defer health.flush(d)
	budget := int64(maxContentReadBytes)
	limits := policy.DeviceRichLimits
	if offer := cached.Policy.RichCapture.Offer; offer != nil {
		limits = offer.EffectiveLimits()
	}
	d.lastContentPass = contentPassCounts{}
	// The cap counts files read; one unchanged since it was read to its end
	// costs a stat (after a restart, one full check first).
	readFiles := 0
	for _, path := range due {
		if readFiles >= maxContentSources || budget <= 0 || ctx.Err() != nil {
			break
		}
		if d.unchangedSinceRead(path) {
			continue
		}
		read := contentRead{path: path, source: d.sources.Sources[path], budget: &budget, health: health, limits: limits, excludes: cached.Policy.Installation.ExcludeGlobs, now: now}
		err := d.readContent(ctx, &read)
		if read.read {
			readFiles++
		}
		if errors.Is(err, errStopDrain) {
			return nil
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// discoverContent registers the sessions found without a hook: the threads
// the transcript poll knows and what agents discover themselves.
func (d *Daemon) discoverContent(now time.Time) {
	threads, _ := state.Load[state.Threads](d.config.Layout.Threads())
	for id, thread := range threads.Threads {
		adapter, err := d.config.Registry.Lookup(thread.Agent)
		if err != nil || thread.Transcript == "" || now.Sub(thread.SeenAt) >= contentPollWindow {
			continue
		}
		if _, reads := adapter.(agent.ContentSource); reads {
			d.noteContentSource(thread.Transcript, contentSource{Agent: adapter.ID(), SessionID: id, Cwd: thread.Cwd, FirstSeen: thread.FirstSeen, SeenAt: thread.SeenAt})
		}
	}
	for _, found := range d.discoverSessions() {
		d.noteContentSource(found.ref.Path, contentSource{Agent: found.adapter.ID(), Harness: found.ref.Harness, SessionID: found.ref.NativeSessionID, Cwd: found.ref.Cwd, FirstSeen: now, SeenAt: now})
	}
}

type discoveredSession struct {
	adapter agent.Agent
	ref     agent.ContentFileRef
}

// discoverSessions are the sessions the agents found without a hook, newest
// first per agent, looked for once per tick.
func (d *Daemon) discoverSessions() []discoveredSession {
	if d.discovered != nil {
		return *d.discovered
	}
	found := []discoveredSession{}
	for _, adapter := range d.config.Registry.All() {
		discoverer, discovers := adapter.(agent.ContentDiscoverer)
		if !discovers {
			continue
		}
		for _, ref := range discoverer.DiscoverContent(d.config.AgentEnv, maxContentSources) {
			if ref.NativeSessionID != "" {
				found = append(found, discoveredSession{adapter: adapter, ref: ref})
			}
		}
	}
	d.discovered = &found
	return found
}

type contentRead struct {
	path     string
	source   contentSource
	budget   *int64
	health   *contentHealth
	limits   policy.RichCaptureLimits
	excludes []string
	now      time.Time
	// read: the file had something new and was read.
	read bool
}

// pendingContent is a record being assembled: the declarations of one
// generation from consecutive lines, and where reading resumes once it is
// queued.
type pendingContent struct {
	generation captureGeneration
	startAt    int64
	startItem  int
	end        int64
	parser     json.RawMessage
	contents   []uplink.ContentDeclaration
	keys       []string
	inline     int64
	size       int64
	// lineStart is where the current line's declarations begin.
	lineStart int
}

func (d *Daemon) readContent(ctx context.Context, read *contentRead) error {
	adapter, err := d.config.Registry.Lookup(read.source.Agent)
	if err != nil {
		return nil
	}
	contents, ok := adapter.(agent.ContentSource)
	if !ok {
		return nil
	}
	decision, err := d.decide(ctx, adapter.ID(), read.source.Cwd)
	if err != nil || !decision.InScope && decision.Reason.Transient() {
		return nil
	}
	if !decision.InScope {
		// Paused or disabled now: what is read past here lies outside every
		// rich window, so it is read past, never staged.
		if decision, err = d.resolveIgnoringAdmission(adapter.ID(), read.source.Cwd); err != nil || !decision.InScope {
			return nil
		}
	}
	if !d.everRichFor(adapter, decision.MappingID) {
		// Nothing of a mapping never rich is admissible, so it is not read;
		// once granted, the checkpoint decides where reading starts.
		d.noteReadToEnd(read.path, nil)
		return nil
	}
	cursors := contentCursors(d.config.Layout)
	d.lastContentPass.cursorLoads++
	cursor, known, err := cursors.Load(read.path)
	if err != nil {
		return nil
	}
	if cursor.Committing != nil {
		if cursor, err = d.recoverCommit(cursors, cursor); err != nil {
			return err
		}
	}
	file, change, err := openConfined(read.path, contents.ContentRoots(d.config.AgentEnv), cursor, known)
	if errors.Is(err, errSourceRefused) {
		read.health.touched = true
		read.health.SourcesRefused++
		d.noteReadToEnd(read.path, nil)
		return nil
	}
	if err != nil {
		return nil
	}
	d.lastContentPass.opened++
	defer file.Close()
	if change == richcapture.Unchanged {
		d.noteReadToEnd(read.path, file.Info())
		return nil
	}
	var loaded []byte
	if known {
		loaded, _ = json.Marshal(cursor)
	}
	parser := contents.ContentParser()
	switch change {
	case richcapture.FirstSeen:
		cursor = d.checkpoint(file, parser, read, adapter, decision.MappingID)
	case richcapture.Replaced:
		read.health.touched = true
		read.health.SourceReplaced++
		// Another file holds the session now: its own header says when it
		// began, never the old file's.
		replaced := d.checkpoint(file, parser, read, adapter, decision.MappingID)
		replaced.Offset, replaced.SeenKeys, replaced.Parser, replaced.StalledSince = 0, cursor.SeenKeys, nil, time.Time{}
		replaced.SourceIncarnation = cursor.SourceIncarnation + 1
		cursor = replaced
	}
	if cursor.Harness == "" {
		// Written before cursors recorded a harness.
		_, cursor.Harness = fileHeader(file, parser, read, adapter)
	}
	if !d.everRich(windowKey(cursor.Harness, decision.MappingID)) {
		d.noteReadToEnd(read.path, file.Info())
		return nil
	}
	if err := file.SeekTo(cursor.Offset); err != nil {
		return nil
	}
	*read.budget -= file.Digested()
	read.read = true
	// What this read admits must survive a kill while it stages bodies.
	if err := d.persistWindows(); err != nil {
		return err
	}
	reader := contentReader{
		daemon: d, read: read, file: file, parser: parser, cursor: cursor, cursors: cursors,
		agentID: adapter.ID(), harness: cursor.Harness, mappingID: decision.MappingID, place: decision.Place, loaded: loaded,
		window: d.captureWindowAt(cursor.Harness, decision.MappingID, decision.Cwd),
	}
	return reader.run(ctx)
}

// resolveIgnoringAdmission is the mapping a directory resolves to whatever
// pauses or switches say: the windows decide what of it is admitted.
func (d *Daemon) resolveIgnoringAdmission(agentID, cwd string) (scope.Decision, error) {
	input, err := d.scopeInput()
	if err != nil || input.Policy == nil {
		return scope.Decision{}, err
	}
	resolving := *input.Policy
	resolving.RefreshedAt = d.config.Now()
	resolving.Policy.Installation.Paused, resolving.Policy.Installation.EnabledAgents = false, nil
	input.Policy, input.LocalPaused, input.Unauthorized = &resolving, false, false
	input.AgentID, input.Cwd = agentID, cwd
	decision := scope.Decide(input)
	if decision.PendingAutoMatch != nil {
		return scope.Decision{}, nil
	}
	return decision, nil
}

// unchangedSinceRead reports whether a file is the one last read to its
// end, at the same size and mtime: then a pass needs nothing else of it.
func (d *Daemon) unchangedSinceRead(path string) bool {
	known, found := d.sourceFacts[path]
	if !found {
		return false
	}
	current, err := os.Stat(path)
	return err == nil && os.SameFile(known, current) && current.Size() == known.Size() && current.ModTime().Equal(known.ModTime())
}

// noteReadToEnd records a file nothing of which waits to be read; info nil
// stats it now.
func (d *Daemon) noteReadToEnd(path string, info os.FileInfo) {
	if info == nil {
		var err error
		if info, err = os.Stat(path); err != nil {
			return
		}
	}
	if d.sourceFacts == nil || len(d.sourceFacts) >= maxKnownSources {
		d.sourceFacts = map[string]os.FileInfo{}
	}
	d.sourceFacts[path] = info
}

// everRichFor reports whether any harness the adapter serves was ever rich
// in the mapping.
func (d *Daemon) everRichFor(adapter agent.Agent, mappingID string) bool {
	return slices.ContainsFunc(servedHarnesses(adapter), func(harness string) bool { return d.everRich(windowKey(harness, mappingID)) })
}

func (d *Daemon) everRich(key string) bool {
	for _, window := range d.windows.Windows[key] {
		if window.Generation != nil {
			return true
		}
	}
	return false
}

// checkpoint places a file first seen: a session that began within the
// open generation is read from its start, any other from its current size,
// so enabling capture never reads what was said before.
func (d *Daemon) checkpoint(file *richcapture.SourceFile, parser agent.ContentParser, read *contentRead, adapter agent.Agent, mappingID string) richcapture.Cursor {
	header, harness := fileHeader(file, parser, read, adapter)
	began, fromHeader := read.source.FirstSeen, header != nil
	if fromHeader {
		began = header.Began
	}
	offset := file.Size()
	if windows := d.windows.Windows[windowKey(harness, mappingID)]; len(windows) > 0 {
		last := windows[len(windows)-1]
		switch {
		case !last.Open || last.Generation == nil:
		case !began.Before(last.Generation.AdmittedFrom):
			offset = 0
		default:
			// Resumed: its new run began just before anything sighted it. The
			// run is the file's tail: an untimed or older line ends it, even
			// with newer ones before.
			since := latest(read.source.FirstSeen, last.Generation.AdmittedFrom).Add(-sightingSkew)
			var cut bool
			offset, cut = file.TrailingRun(resumeScanBytes, func(line []byte) bool {
				at, stamped := lineAt(parser, line)
				return stamped && !at.Before(since)
			})
			if cut {
				read.health.touched = true
				read.health.ResumeScanTruncated++
			}
		}
	}
	cursor := file.Mark(offset)
	cursor.Began, cursor.HeaderBegan, cursor.Harness = began, fromHeader, harness
	if fromHeader {
		cursor.ParentSessionID = header.ParentSessionID
	}
	return cursor
}

// lineAt is a line's own time, read without its content when the parser
// can; the Parse fallback only reads it here, and nothing it parses is
// staged. The line is bare, no path, harness or session: a parser must not
// need them to tell a line's time.
func lineAt(parser agent.ContentParser, line []byte) (time.Time, bool) {
	if timestamps, ok := parser.(agent.LineTimestamps); ok {
		return timestamps.LineAt(line)
	}
	record, _, err := parser.Parse(agent.ContentLine{Bytes: line}, nil)
	return record.At, err == nil && !record.At.IsZero()
}

func latest(a, b time.Time) time.Time {
	if a.After(b) {
		return a
	}
	return b
}

// fileHeader is the file's header, nil without one, and the harness it is
// captured for: the header's, else the sighting's, else the adapter's own.
// Only a harness the adapter serves is taken from either; another is
// counted, so a parser and its adapter's harnesses disagreeing shows.
func fileHeader(file *richcapture.SourceFile, parser agent.ContentParser, read *contentRead, adapter agent.Agent) (*agent.ContentHeader, string) {
	var header *agent.ContentHeader
	if first, ok := file.FirstLine(richcapture.MaxLineBytes); ok {
		if parsed, ok := parser.Header(first); ok {
			header = &parsed
		}
	}
	named := []string{read.source.Harness}
	if header != nil {
		named = []string{header.Harness, read.source.Harness}
	}
	served := servedHarnesses(adapter)
	for _, harness := range named {
		if harness == "" {
			continue
		}
		if slices.Contains(served, harness) {
			return header, harness
		}
		read.health.touched = true
		read.health.UnservedHarness++
	}
	return header, adapter.ID()
}

// servedHarnesses are the harnesses an adapter's files are captured for,
// its own first.
func servedHarnesses(adapter agent.Agent) []string {
	served := []string{adapter.ID()}
	if family, ok := adapter.(agent.HarnessFamily); ok {
		served = append(served, family.Harnesses()...)
	}
	return served
}

// recoverCommit finishes a record a crash left between its intent and the
// cursor's advance: if it reached the queue, reading resumes after it.
func (d *Daemon) recoverCommit(cursors richcapture.Cursors, cursor richcapture.Cursor) (richcapture.Cursor, error) {
	queued, err := d.queue.Has(cursor.Committing.CaptureID)
	if err != nil {
		return cursor, err
	}
	if queued {
		cursor.Offset, cursor.Drain = cursor.Committing.End, cursor.Committing.Drain
		cursor.Remember(cursor.Committing.Keys...)
		cursor.Parser = cursor.Committing.Parser
	}
	cursor.Committing = nil
	return cursor, cursors.Save(cursor)
}

type contentReader struct {
	daemon    *Daemon
	read      *contentRead
	file      *richcapture.SourceFile
	parser    agent.ContentParser
	cursor    richcapture.Cursor
	cursors   richcapture.Cursors
	agentID   string
	harness   string
	mappingID string
	place     privacy.Place
	window    func(time.Time) (captureWindow, bool)
	records   []*pendingContent
	current   *pendingContent
	declared  map[string]bool
	// readTo and parser are where reading stands once every record is queued.
	readTo  int64
	parsed  json.RawMessage
	stalled bool
	// parentCursors are the read positions of the session's parent, loaded
	// once per read.
	parentCursors []richcapture.Cursor
	failed        error
	// loaded is the cursor as read from disk (nil for a file first seen),
	// to skip an unchanged save.
	loaded []byte
}

func (r *contentReader) run(ctx context.Context) error {
	r.declared = map[string]bool{}
	r.readTo, r.parsed = r.file.Position(), r.cursor.Parser
	for *r.read.budget > 0 && ctx.Err() == nil {
		line, lineState := r.file.Next(richcapture.MaxLineBytes)
		if lineState == richcapture.LineIncomplete {
			break
		}
		*r.read.budget -= line.End - line.Offset
		if !r.readLine(line, lineState) {
			break
		}
	}
	if r.failed != nil {
		return r.failed
	}
	if r.stalled {
		if r.cursor.StalledSince.IsZero() {
			r.cursor.StalledSince = r.read.now
		}
		r.read.health.touched = true
		r.read.health.stalled++
	} else {
		r.cursor.StalledSince = time.Time{}
	}
	return r.commit()
}

// readLine admits and declares one line; false stops the read before it.
func (r *contentReader) readLine(line richcapture.Line, lineState richcapture.LineState) bool {
	if lineState == richcapture.LineDraining {
		r.lineDone(line)
		return true
	}
	parsedBefore := r.parsed
	declarer := r.declarer()
	if lineState == richcapture.LineOversized {
		r.read.health.touched = true
		r.read.health.RecordTooLarge++
		window, admitted := r.windowFor(agent.ContentRecord{At: r.read.now})
		if !admitted || window.Generation == nil {
			r.read.health.OutsideWindow++
			r.lineDone(line)
			return true
		}
		declared := declarer.TooLarge(line.Offset, r.read.now)
		if !r.add(*window.Generation, line, 0, declared, parsedBefore) {
			return false
		}
		r.lineDone(line)
		return true
	}
	record, next, err := r.parser.Parse(agent.ContentLine{Bytes: line.Bytes, Path: r.read.path, Offset: line.Offset, Harness: r.harness, NativeSessionID: r.read.source.SessionID}, r.parsed)
	r.parsed = next
	if err != nil {
		r.read.health.touched = true
		r.read.health.ParseErrors++
	}
	if err != nil || len(record.Items) == 0 {
		r.lineDone(line)
		return true
	}
	if record.Copied {
		r.read.health.touched = true
		r.read.health.Copied++
		r.lineDone(line)
		return true
	}
	window, admitted := r.windowFor(record)
	if record.At.Before(r.lowerBound(window, admitted)) {
		// Older than the session itself: copied in by a fork or resume.
		r.lineDone(line)
		return true
	}
	if !admitted || window.Generation == nil {
		r.read.health.touched = true
		r.read.health.OutsideWindow++
		r.lineDone(line)
		return true
	}
	declarer.AdmittedFrom = window.Generation.AdmittedFrom
	for index, item := range record.Items {
		key := declarer.Key(item)
		if r.cursor.Seen(key) || r.declared[key] {
			continue
		}
		if r.parentDeclared(declarer, item) {
			r.read.health.touched = true
			r.read.health.Copied++
			continue
		}
		if !r.add(*window.Generation, line, index, declarer.Declare(record, item, line.Offset), parsedBefore) {
			return false
		}
	}
	r.lineDone(line)
	return true
}

// lowerBound is the earliest time a record of the session may be its own.
// A header proving the session began within the record's generation bounds
// it (amendment 19), so a file noticed late keeps its first turn; otherwise
// the session's first sighting does: less its skew for a file with a
// header, a resumed one sighted late; exactly for one without, whose first
// sighting is the fence against what a fork copied in.
func (r *contentReader) lowerBound(window captureWindow, admitted bool) time.Time {
	if admitted && window.Generation != nil && r.cursor.HeaderBegan && !r.cursor.Began.Before(window.Generation.AdmittedFrom) {
		return r.cursor.Began
	}
	if r.cursor.HeaderBegan {
		return r.read.source.FirstSeen.Add(-sightingSkew)
	}
	return r.read.source.FirstSeen
}

func (r *contentReader) windowFor(record agent.ContentRecord) (captureWindow, bool) {
	if record.Cwd == "" {
		return r.window(record.At)
	}
	return r.daemon.captureWindowAt(r.harness, r.mappingID, record.Cwd)(record.At)
}

func (r *contentReader) declarer() richcapture.Declarer {
	excludes := r.read.excludes
	return richcapture.Declarer{
		Harness: r.harness, NativeSessionID: r.read.source.SessionID, Kind: r.parser.Kind(), Parser: r.parser.Version(),
		Place: r.place, Limits: r.read.limits, ObservedAt: r.read.now, SessionBegan: r.cursor.Began,
		Excluded: func(path string) bool { return scope.ExcludedPath(excludes, path) },
	}
}

// parentDeclared reports whether the session's parent already declared the
// item: then it is the parent's, copied here by the fork.
func (r *contentReader) parentDeclared(declarer richcapture.Declarer, item agent.ContentItem) bool {
	parent := r.cursor.ParentSessionID
	if parent == "" {
		return false
	}
	if r.parentCursors == nil {
		r.parentCursors = []richcapture.Cursor{}
		for path, source := range r.daemon.sources.Sources {
			if source.Agent == r.agentID && source.SessionID == parent {
				if cursor, found, err := r.cursors.Load(path); err == nil && found {
					r.parentCursors = append(r.parentCursors, cursor)
				}
			}
		}
	}
	declarer.NativeSessionID = parent
	key := declarer.Key(item)
	for index := range r.parentCursors {
		if r.parentCursors[index].Seen(key) {
			return true
		}
	}
	return false
}

// add stages a declared item's body and adds it to the record of its
// generation; false when the spool is full and the read must stop.
func (r *contentReader) add(generation captureGeneration, line richcapture.Line, index int, declared richcapture.Declared, parsedBefore json.RawMessage) bool {
	if declared.MalformedRefs > 0 {
		r.read.health.touched = true
		r.read.health.MalformedRefs += uint64(declared.MalformedRefs)
	}
	if declared.Body != nil {
		if err := commitFault("staging"); err != nil {
			r.failed = err
			r.dropLine(line, parsedBefore)
			return false
		}
		_, err := r.daemon.spool.Stage(richcapture.Body{
			ContentKey: declared.Declaration.ContentKey, MappingID: r.mappingID, Harness: r.harness,
			NativeSessionID: r.read.source.SessionID, OccurredAt: declared.Declaration.OccurredAt,
		}, declared.Body)
		switch {
		case errors.Is(err, richcapture.ErrSpoolFull) && !r.cursor.StalledSince.IsZero() && r.read.now.Sub(r.cursor.StalledSince) >= spoolStallLimit:
			declared = richcapture.WithoutBody(declared, "collection_failed", "spool_full")
			r.read.health.touched = true
			r.read.health.SpoolFull++
		case err != nil:
			r.stalled = true
			r.dropLine(line, parsedBefore)
			return false
		}
	}
	declaration := declared.Declaration
	if declaration.Validate() != nil {
		// A parser's item the server would refuse: dropped alone, never the
		// record carrying the others.
		r.read.health.touched = true
		r.read.health.reject("invalid_on_device")
		return true
	}
	encoded, _ := json.Marshal(declaration)
	inline := int64(0)
	if declaration.InlineText != nil {
		inline = *declaration.ByteCount
	}
	current := r.current
	if current == nil || current.generation != generation || len(current.contents) >= r.read.limits.MaxContentsPerRecord ||
		current.inline+inline > r.read.limits.MaxInlineBytesPerRecord || current.size+int64(len(encoded)) > maxContentRecord {
		if current != nil && current.lineStart < len(current.contents) {
			// The line goes on in the next record; this one ends before it.
			current.end, current.parser = line.Offset, parsedBefore
		}
		r.current = &pendingContent{generation: generation, startAt: line.Offset, startItem: index, end: line.Offset, parser: parsedBefore}
		r.records = append(r.records, r.current)
		current = r.current
	}
	current.contents = append(current.contents, declaration)
	current.keys = append(current.keys, declaration.ContentKey)
	current.inline += inline
	current.size += int64(len(encoded))
	r.declared[declaration.ContentKey] = true
	r.read.health.touched = true
	r.read.health.Declared++
	return true
}

// lineDone moves the read position past a line wholly handled.
func (r *contentReader) lineDone(line richcapture.Line) {
	r.readTo = line.End
	if r.current != nil {
		r.current.end, r.current.parser = line.End, r.parsed
		r.current.lineStart = len(r.current.contents)
	}
}

// dropLine forgets a line the read stops before: its declarations wait for
// the next read.
func (r *contentReader) dropLine(line richcapture.Line, parsedBefore json.RawMessage) {
	r.parsed = parsedBefore
	if r.current == nil {
		return
	}
	for _, key := range r.current.keys[r.current.lineStart:] {
		delete(r.declared, key)
		r.read.health.Declared--
	}
	r.current.contents = r.current.contents[:r.current.lineStart]
	r.current.keys = r.current.keys[:r.current.lineStart]
	if len(r.current.contents) == 0 {
		r.records = r.records[:len(r.records)-1]
	}
	r.current = nil
}

// commit queues each record in order: bodies staged, intent saved, record
// queued, cursor advanced. A crash at any point replays or resumes it.
func (r *contentReader) commit() error {
	d := r.daemon
	if len(r.records) > 0 {
		if err := d.persistWindows(); err != nil {
			return err
		}
	}
	for _, pending := range r.records {
		if err := commitFault("staged"); err != nil {
			return err
		}
		captureID := contentCaptureID(r.agentID, pending.generation.ID, r.cursor.Identity, r.cursor.SourceIncarnation, pending.startAt, pending.startItem)
		// A record ending inside an oversized line ends, as a binary that
		// knows no drain reads it, at the line's start.
		end := r.file.Mark(pending.end)
		r.cursor.Committing = &richcapture.Commit{CaptureID: captureID, End: end.Offset, Drain: end.Drain, Keys: pending.keys, Parser: pending.parser}
		if err := r.cursors.Save(r.cursor); err != nil {
			return err
		}
		if err := commitFault("committing"); err != nil {
			return err
		}
		record, err := d.contentRecord(captureID, r, pending)
		if err != nil {
			return err
		}
		if known, err := d.queue.Has(captureID); err != nil {
			return err
		} else if !known {
			err = d.queue.Enqueue(captureID, record)
			if errors.Is(err, queue.ErrCapacity) {
				r.cursor.Committing = nil
				r.cursors.Save(r.cursor)
				*r.read.budget -= r.file.Digested()
				return errStopDrain
			}
			if err != nil {
				return err
			}
		}
		if err := commitFault("enqueued"); err != nil {
			return err
		}
		r.cursor.Offset, r.cursor.Drain, r.cursor.Parser, r.cursor.Committing = end.Offset, end.Drain, pending.parser, nil
		r.cursor.Remember(pending.keys...)
		if err := r.cursors.Save(r.cursor); err != nil {
			return err
		}
	}
	// The file as read now, so a pass with nothing new finds it Unchanged.
	// Size is the size at open; a file that grew during the read leaves
	// Offset past it, and the next pass sees it Grown.
	marked := r.file.Mark(r.readTo)
	*r.read.budget -= r.file.Digested()
	r.cursor.Identity, r.cursor.Size, r.cursor.ModTime, r.cursor.PrefixSHA256 = marked.Identity, marked.Size, marked.ModTime, marked.PrefixSHA256
	r.cursor.Offset, r.cursor.Drain, r.cursor.Parser = marked.Offset, marked.Drain, r.parsed
	draining := r.cursor.Drain != nil
	if behind := r.cursor.Position() < r.file.Size(); behind != r.read.source.Behind || draining != r.read.source.Draining {
		source := r.read.source
		source.Behind, source.Draining = behind, draining
		d.sources.Sources[r.read.path] = source
		d.sourcesDirty = true
	}
	if err := r.saveCursor(); err != nil {
		return err
	}
	if info := r.file.Info(); r.cursor.Position() == info.Size() {
		d.noteReadToEnd(r.read.path, info)
	} else {
		delete(d.sourceFacts, r.read.path)
	}
	return nil
}

func (r *contentReader) saveCursor() error {
	if r.unchangedSince(r.loaded) {
		return nil
	}
	return r.cursors.Save(r.cursor)
}

// unchangedSince reports whether the cursor is the one loaded, field for
// field: then saving it again would only cost an fsync.
func (r *contentReader) unchangedSince(loaded []byte) bool {
	current, err := json.Marshal(r.cursor)
	return err == nil && loaded != nil && bytes.Equal(current, loaded)
}

// contentCaptureID = sha256(agent ‖ "content" ‖ generation ‖ file id ‖
// start offset)[:32]; a record continuing a line past its first item adds
// that item's index. Replacements add their durable source incarnation.
func contentCaptureID(agentID, generationID, fileIdentity string, incarnation uint64, startAt int64, startItem int) string {
	source := agentID + "\x00content\x00" + generationID + "\x00" + fileIdentity + "\x00" + itoa64(startAt)
	if startItem > 0 {
		source += "\x00" + itoa64(int64(startItem))
	}
	if incarnation > 0 {
		source += "\x00incarnation\x00" + strconv.FormatUint(incarnation, 10)
	}
	sum := sha256.Sum256([]byte(source))
	return hex.EncodeToString(sum[:])[:32]
}

func (d *Daemon) contentRecord(captureID string, r *contentReader, pending *pendingContent) ([]byte, error) {
	generationID := pending.generation.ID
	record := uplink.Record{
		CaptureID: captureID, MappingID: r.mappingID, Harness: r.harness, CollectionMethod: contentCollection,
		NativeSessionID: r.read.source.SessionID, ParentNativeSessionID: r.envelopeParent(), CapturedAt: r.read.now.UTC(),
		Beacon: uplink.BeaconProvenance{Commit: beacon.Commit}, Events: []json.RawMessage{}, Contents: pending.contents,
		CaptureGeneration: &uplink.CaptureGeneration{ID: generationID, Profile: "rich", AdmittedFrom: pending.generation.AdmittedFrom.UTC(), PolicyRevision: pending.generation.PolicyRevision},
	}
	if err := record.ValidateRich(); err != nil {
		return nil, err
	}
	return encodeRecord(record)
}

// envelopeParent is the session the records name as this one's parent. An
// agent whose files state their relation is asked for the file's current
// header, accepted only when it is this session's (a hook may name another
// thread's file); for the others (Pi) the file is the session's own, and
// its header's fork parent is the cursor's.
func (r *contentReader) envelopeParent() string {
	adapter, err := r.daemon.config.Registry.Lookup(r.agentID)
	if err != nil {
		return ""
	}
	if _, reads := adapter.(agent.SessionRelations); reads {
		return r.daemon.ownParent(adapter, r.read.path, r.read.source.SessionID)
	}
	return r.cursor.ParentSessionID
}

func itoa64(value int64) string { return strconv.FormatInt(value, 10) }

func encodeRecord(record uplink.Record) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(record); err != nil {
		return nil, err
	}
	return bytes.TrimSpace(buffer.Bytes()), nil
}
