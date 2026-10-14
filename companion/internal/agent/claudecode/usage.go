// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package claudecode

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
)

// Claude Code's hooks carry no token usage; its transcript does, on every
// assistant line. At each response boundary the daemon reads the lines added
// since the previous boundary and keeps only usage metadata. Deduplication
// follows ccusage (github.com/ccusage/ccusage, adapters/claude).
const (
	// maxUsageLineBytes bounds one transcript line held in memory; a longer
	// line (a huge tool input) is skipped whole.
	maxUsageLineBytes = 32 << 20
	// maxUsageReadBytes bounds one read across the session's transcripts;
	// the rest waits for the next boundary.
	maxUsageReadBytes = 256 << 20
	// maxSubagentScan bounds the walk of a session's subagent directory.
	maxSubagentScan = 16384
	// maxSkippedRuns bounds the runs a transcript's cursor remembers past a
	// held request; a read that would need more leaves the file as it was
	// and reports it capacity-limited.
	maxSkippedRuns = 128
	// maxHeldRequests bounds the requests held by their boundary that a
	// read reads again behind remembered runs, as for maxSkippedRuns.
	maxHeldRequests = 1024
	// maxParentMessages bounds the remembered parent responses that a
	// sidechain may replay; each costs a 16-character digest in the cursor.
	maxParentMessages = 20000
	// subagentSettle: a subagent transcript written this recently may be
	// mid-response, so its last request waits for a later read.
	subagentSettle = 10 * time.Second
)

// usageBoundaries are the hooks after which usage is read. SessionEnd and
// SessionStart are final: nothing of the session is still being written,
// so a tail held back at the last Stop (the agent crashed) is emitted.
var usageBoundaries = map[string]bool{"Stop": true, "SessionEnd": true, "SessionStart": true}

// finalStartSources are the SessionStart sources that begin a run of the
// session; a compaction starts one mid-turn, with a response in flight.
var finalStartSources = map[string]bool{"startup": true, "resume": true}

// maxSubagentReads bounds how many changed subagent transcripts one read
// opens, newest first; unchanged ones are skipped without opening them.
var maxSubagentReads = 1024

const (
	// usageKeyPrefix starts the key whose sha256 is the event id; for a
	// request it is claude_code:usage:<message.id>:<requestId>, the id the
	// backend deduplicates on.
	usageKeyPrefix = ID + ":usage:"
	syntheticModel = "<synthetic>"
	// maxClockSkew: the backend refuses events stamped further ahead.
	maxClockSkew = 24 * time.Hour
)

var (
	// Claude model ids as Claude Code records them: Anthropic's own, with a
	// context tag or Vertex's @date, and Bedrock's [region.]anthropic.claude-.
	modelID     = regexp.MustCompile(`^(?:[a-z]{2,4}\.)?(?:anthropic\.)?claude-[A-Za-z0-9._:@/\[\]+-]{1,120}$`)
	usageLabel  = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
	semverStart = regexp.MustCompile(`^\d+\.\d+\.\d+`)
	usageMarker = []byte(`"usage"`)
)

func (ClaudeCode) UsageTranscript(event string, payload map[string]any) (string, bool) {
	path, _ := payload["transcript_path"].(string)
	if source, _ := payload["source"].(string); event == "SessionStart" && !finalStartSources[source] {
		return "", false
	}
	if !usageBoundaries[event] || !filepath.IsAbs(path) || filepath.Ext(path) != ".jsonl" || strings.ContainsRune(path, 0) {
		return "", false
	}
	return filepath.Clean(path), true
}

type usageCursor struct {
	// Files are where each transcript's unread lines start.
	Files map[string]fileCursor `json:"files"`
	// Parents are digests of the session's own response ids, oldest first,
	// so a sidechain replaying one is recognized in any later read.
	Parents []string `json:"parents,omitempty"`
}

type fileCursor struct {
	Offset int64 `json:"offset"`
	// ModTime with Offset at the file's size means nothing new to read.
	ModTime time.Time `json:"mod_time"`
	// Skips are what reads went past after Offset, in file order, so a read
	// from a request held back before them does not read them again. Offset
	// stays at a line start, where a binary that knows no skips resumes.
	Skips []skippedRun `json:"skips,omitempty"`
}

// skippedRun runs from an oversized line's start up to the next request
// found, or where the read stopped: nothing in it is usage. A read
// reaching From resumes at To, still inside an oversized line when
// Draining (the last run only).
type skippedRun struct {
	From int64 `json:"from"`
	agent.Skipped
	Draining bool `json:"draining,omitempty"`
}

type claudeTokens struct {
	InputTokens              int64 `json:"input_tokens"`
	CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
	OutputTokens             int64 `json:"output_tokens"`
	CacheCreation            *struct {
		Ephemeral5m int64 `json:"ephemeral_5m_input_tokens"`
		Ephemeral1h int64 `json:"ephemeral_1h_input_tokens"`
	} `json:"cache_creation"`
}

// transcriptEntry names the only members decoded from a transcript line;
// encoding/json skips message content without keeping it.
type transcriptEntry struct {
	Type        string `json:"type"`
	Timestamp   string `json:"timestamp"`
	Version     string `json:"version"`
	SessionID   string `json:"sessionId"`
	RequestID   string `json:"requestId"`
	IsSidechain bool   `json:"isSidechain"`
	Message     *struct {
		ID    string `json:"id"`
		Model string `json:"model"`
		Usage *struct {
			claudeTokens
			ServiceTier string `json:"service_tier"`
			Speed       string `json:"speed"`
			Iterations  []struct {
				claudeTokens
				Type  string  `json:"type"`
				Model *string `json:"model"`
			} `json:"iterations"`
		} `json:"usage"`
	} `json:"message"`
}

type usageEntry struct {
	key       string
	messageID string
	start     int64
	timestamp time.Time
	model     string
	tokens    claudeTokens
	tier      string
	speed     string
	sidechain bool
	advisors  []advisorUsage
}

type advisorUsage struct {
	model  string
	tokens claudeTokens
}

func (e *usageEntry) total() int64 {
	return e.tokens.InputTokens + e.tokens.OutputTokens + e.tokens.CacheReadInputTokens + e.tokens.CacheCreationInputTokens
}

// moreComplete is ccusage's choice among copies of one request: the
// session's own copy over a sidechain's, then the larger count (later
// content blocks carry the final output tokens), then one naming its speed.
func (e *usageEntry) moreComplete(than *usageEntry) bool {
	if e.sidechain != than.sidechain {
		return than.sidechain
	}
	if e.total() != than.total() {
		return e.total() > than.total()
	}
	return e.speed != "" && than.speed == ""
}

func (ClaudeCode) ReadUsage(read agent.UsageRead, raw json.RawMessage) (agent.UsageResult, error) {
	var cursor usageCursor
	if json.Unmarshal(raw, &cursor) != nil {
		cursor = usageCursor{}
	}
	reader := usageReader{read: read, final: read.Event == "SessionEnd" || read.Event == "SessionStart", budget: maxUsageReadBytes, byKey: map[string]*usageEntry{}, parents: map[string]bool{}}
	for _, digest := range cursor.Parents {
		reader.parents[digest] = true
	}
	next := usageCursor{Files: map[string]fileCursor{}, Parents: cursor.Parents}
	result := agent.UsageResult{}
	next.Files[read.Transcript] = reader.readFile(read.Transcript, false, cursor.Files[read.Transcript])
	var changed []subagentFile
	for _, candidate := range subagentTranscripts(read.Transcript) {
		previous, known := cursor.Files[candidate.path]
		if known && previous.Offset == candidate.size && previous.ModTime.Equal(candidate.modTime) {
			next.Files[candidate.path] = previous
			continue
		}
		changed = append(changed, candidate)
	}
	sort.SliceStable(changed, func(i, j int) bool { return changed[i].modTime.After(changed[j].modTime) })
	for index, candidate := range changed {
		if index >= maxSubagentReads || reader.budget <= 0 {
			if previous, known := cursor.Files[candidate.path]; known {
				next.Files[candidate.path] = previous
			}
			result.DeferredFiles++
			continue
		}
		next.Files[candidate.path] = reader.readFile(candidate.path, true, cursor.Files[candidate.path])
	}
	for _, entry := range reader.entries {
		if !entry.sidechain && entry.messageID != "" {
			next.Parents = append(next.Parents, digest(entry.messageID))
		}
	}
	if excess := len(next.Parents) - maxParentMessages; excess > 0 {
		next.Parents = next.Parents[excess:]
	}
	events := make([]json.RawMessage, 0, len(reader.entries))
	for _, entry := range reader.entries {
		if read.Allowed != nil && !read.Allowed(entry.timestamp) {
			continue
		}
		for _, event := range usageEvents(read.SessionID, entry) {
			encoded, err := json.Marshal(event)
			if err != nil {
				return agent.UsageResult{}, err
			}
			events = append(events, encoded)
		}
	}
	encoded, err := json.Marshal(next)
	result.Events, result.Cursor, result.CapacityLimitedFiles = events, encoded, reader.capacityLimited
	return result, err
}

type usageReader struct {
	read    agent.UsageRead
	final   bool
	budget  int64
	entries []*usageEntry
	byKey   map[string]*usageEntry
	parents map[string]bool
	// capacityLimited counts files left as they were for holding back
	// more than a cursor keeps.
	capacityLimited int
}

// readFile reads the complete lines after the cursor and returns where the
// next read starts. While the session is live, a request whose lines may
// still be written is left for the next read, so it is emitted once and
// complete. A file whose held requests would need more than the cursor
// keeps is left as it was, nothing of it emitted, and reported limited.
func (r *usageReader) readFile(path string, subagent bool, previous fileCursor) fileCursor {
	offset := previous.Offset
	file, err := os.Open(path)
	if err != nil {
		return previous
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return previous
	}
	if offset < 0 || offset > info.Size() {
		offset = 0
	}
	skips := orderedSkips(previous.Skips, offset, info.Size())
	if _, err := file.Seek(offset, io.SeekStart); err != nil {
		return previous
	}
	lines := bufio.NewReaderSize(file, 64<<10)
	var found []*usageEntry
	var passed []skippedRun
	position, unfinished, draining := offset, false, false
	// running is the run being read past since the last request found; it
	// begins at the first oversized line after it.
	running, runFrom := false, int64(0)
	closeRun := func(to int64, draining bool) skippedRun {
		r.budget -= agent.DigestCost(runFrom, to)
		running = false
		return skippedRun{From: runFrom, Skipped: agent.Skip(file, runFrom, to), Draining: draining}
	}
	// heldAgain are the requests held by the boundary that the read reads
	// again before the runs it remembers end.
	heldAgain := map[string]bool{}
	for {
		if r.budget <= 0 {
			unfinished = true
			break
		}
		if len(skips) > 0 && position == skips[0].From {
			skip := skips[0]
			r.budget -= agent.DigestCost(skip.From, skip.To)
			if !skip.Holds(file, skip.From, info.Size()) {
				// Rewritten since: the rest is read anew.
				skips = nil
				continue
			}
			if _, err := file.Seek(skip.To, io.SeekStart); err != nil {
				return previous
			}
			lines.Reset(file)
			skips = skips[1:]
			position, draining = skip.To, skip.Draining
			if draining {
				running, runFrom = true, skip.From
			} else {
				passed = append(passed, skip)
			}
			continue
		}
		if draining {
			size, ended := agent.SkipLine(lines, maxUsageLineBytes)
			if size == 0 {
				unfinished = true
				break
			}
			r.budget -= size
			position += size
			draining = !ended
			continue
		}
		content, size, ended, oversized := agent.BoundedLine(lines, maxUsageLineBytes)
		if !ended && !oversized {
			unfinished = size > 0
			break
		}
		r.budget -= size
		if oversized {
			if !running {
				running, runFrom = true, position
			}
			position += size
			draining = !ended
			continue
		}
		if entry, ok := r.parse(content, path, position, subagent); ok {
			found = append(found, entry)
			if running {
				passed = append(passed, closeRun(position, false))
			}
			if len(skips) > 0 && !r.final && r.heldByBoundary(entry) {
				heldAgain[entry.key] = true
				if len(heldAgain) > maxHeldRequests {
					r.capacityLimited++
					return previous
				}
			}
		}
		position += size
	}
	readTo := position
	if running {
		passed = append(passed, closeRun(readTo, draining))
	}
	// Runs the read stopped before stay for the next.
	passed = append(passed, skips...)
	if !r.final && len(found) > 0 {
		// Requests that may still be streaming: the last one while a line is
		// being written or a subagent is active, and any begun after the
		// boundary's hook. Each waits whole, from its first line.
		held := map[string]bool{}
		if unfinished || subagent && r.read.Now.Sub(info.ModTime()) < subagentSettle {
			held[found[len(found)-1].key] = true
		}
		for _, entry := range found {
			if r.heldByBoundary(entry) {
				held[entry.key] = true
			}
		}
		for index, entry := range found {
			if held[entry.key] {
				position, found = entry.start, found[:index]
				break
			}
		}
	}
	if position == readTo && draining {
		// Inside an oversized line: resume from its run's start.
		position = runFrom
	}
	next := fileCursor{Offset: position, ModTime: info.ModTime()}
	for _, run := range passed {
		if run.From >= position {
			next.Skips = append(next.Skips, run)
		}
	}
	if len(next.Skips) > maxSkippedRuns {
		r.capacityLimited++
		return previous
	}
	for _, entry := range found {
		r.add(entry)
	}
	return next
}

// heldByBoundary reports whether entry began after the boundary's hook.
func (r *usageReader) heldByBoundary(entry *usageEntry) bool {
	return !r.read.Until.IsZero() && entry.timestamp.After(r.read.Until)
}

// orderedSkips are the skipped runs a read from offset can still use: in
// order, after offset, within the file; the first that is not ends them.
func orderedSkips(skips []skippedRun, offset, size int64) []skippedRun {
	from := offset
	for index, skip := range skips {
		if index == maxSkippedRuns || skip.From < from || skip.To < skip.From || skip.To > size || skip.Draining && index != len(skips)-1 {
			return skips[:index]
		}
		from = skip.To
	}
	return skips
}

func (r *usageReader) parse(content []byte, path string, start int64, subagent bool) (*usageEntry, bool) {
	if !bytes.Contains(content, usageMarker) {
		return nil, false
	}
	var line transcriptEntry
	if json.Unmarshal(content, &line) != nil || line.Message == nil || line.Message.Usage == nil {
		return nil, false
	}
	if line.Type != "" && line.Type != "assistant" || line.Version != "" && !semverStart.MatchString(line.Version) {
		return nil, false
	}
	// A resumed session's transcript starts with its first session's
	// responses, which that session already counted.
	if line.SessionID != "" && line.SessionID != r.read.SessionID {
		return nil, false
	}
	timestamp, err := time.Parse(time.RFC3339Nano, line.Timestamp)
	if err != nil || timestamp.After(r.read.Now.Add(maxClockSkew)) {
		return nil, false
	}
	usage := line.Message.Usage
	entry := &usageEntry{
		start: start, timestamp: timestamp.UTC(), tokens: usage.claudeTokens,
		sidechain: line.IsSidechain || subagent,
	}
	if nativeID.MatchString(line.Message.ID) {
		entry.messageID = line.Message.ID
	}
	requestID := ""
	if nativeID.MatchString(line.RequestID) {
		requestID = line.RequestID
	}
	switch {
	case entry.messageID != "" && requestID != "":
		entry.key = usageKeyPrefix + entry.messageID + ":" + requestID
	case entry.messageID != "":
		entry.key = usageKeyPrefix + entry.messageID + ":@" + line.Timestamp
	default:
		entry.key = usageKeyPrefix + "line:" + digest(path) + ":" + strconv.FormatInt(start, 10)
	}
	if line.Message.Model == syntheticModel {
		// Claude Code's own placeholder messages (errors, interruptions).
		return nil, false
	}
	if modelID.MatchString(line.Message.Model) {
		entry.model = line.Message.Model
	}
	if usageLabel.MatchString(usage.ServiceTier) {
		entry.tier = usage.ServiceTier
	}
	if usageLabel.MatchString(usage.Speed) {
		entry.speed = usage.Speed
	}
	for _, iteration := range usage.Iterations {
		if iteration.Type == "advisor_message" && iteration.Model != nil && modelID.MatchString(*iteration.Model) {
			entry.advisors = append(entry.advisors, advisorUsage{model: *iteration.Model, tokens: iteration.claudeTokens})
		}
	}
	return entry, true
}

// add keeps one entry per request, at the position of its first copy.
func (r *usageReader) add(entry *usageEntry) {
	if entry.sidechain && entry.messageID != "" && r.parents[digest(entry.messageID)] {
		// A sidechain (a /btw aside) replaying one of the session's own
		// responses under a new request id.
		return
	}
	if existing, found := r.byKey[entry.key]; found {
		if entry.moreComplete(existing) {
			entry.start, entry.timestamp = existing.start, existing.timestamp
			*existing = *entry
		}
		return
	}
	r.byKey[entry.key] = entry
	r.entries = append(r.entries, entry)
	if !entry.sidechain && entry.messageID != "" {
		r.parents[digest(entry.messageID)] = true
	}
}

type subagentFile struct {
	path    string
	size    int64
	modTime time.Time
}

// subagentTranscripts lists the session's subagent transcripts, which
// Claude Code writes under <session>/subagents/, nested for workflows.
func subagentTranscripts(transcript string) []subagentFile {
	root := filepath.Join(strings.TrimSuffix(transcript, ".jsonl"), "subagents")
	var found []subagentFile
	scanned := 0
	filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if scanned++; err != nil || scanned > maxSubagentScan {
			return filepath.SkipAll
		}
		if !entry.Type().IsRegular() || filepath.Ext(path) != ".jsonl" {
			return nil
		}
		if info, err := entry.Info(); err == nil {
			found = append(found, subagentFile{path: path, size: info.Size(), modTime: info.ModTime()})
		}
		return nil
	})
	return found
}

func digest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:8])
}

// usageEventID is stable for a request, so a replayed or re-read request
// is recognized upstream instead of counted twice.
func usageEventID(key string) string {
	sum := sha256.Sum256([]byte(key))
	return hex.EncodeToString(sum[:])
}

func usageEvents(sessionID string, entry *usageEntry) []map[string]any {
	events := []map[string]any{}
	if entry.total() > 0 {
		events = append(events, usageEvent(sessionID, entry.key, entry.timestamp, entry.model, entry.tier, entry.speed, entry.tokens))
	}
	for index, advisor := range entry.advisors {
		key := entry.key + ":advisor:" + strconv.Itoa(index)
		events = append(events, usageEvent(sessionID, key, entry.timestamp, advisor.model, entry.tier, entry.speed, advisor.tokens))
	}
	return events
}

// usageEvent is the Beacon-shaped event the backend prices (the contract is
// pinned by backend/tests/test_session_cost.py). It carries no cost: the
// backend estimates it.
func usageEvent(sessionID, key string, timestamp time.Time, model, tier, speed string, tokens claudeTokens) map[string]any {
	count := func(value int64) int64 { return max(value, 0) }
	cacheWrites := map[string]any{"input_tokens": count(tokens.CacheCreationInputTokens)}
	if tokens.CacheCreation != nil {
		oneHour := count(tokens.CacheCreation.Ephemeral1h)
		cacheWrites["input_tokens"] = max(count(tokens.CacheCreationInputTokens), count(tokens.CacheCreation.Ephemeral5m)+oneHour)
		cacheWrites["ephemeral_1h_input_tokens"] = oneHour
	}
	usage := map[string]any{
		"input_tokens":   count(tokens.InputTokens),
		"output_tokens":  count(tokens.OutputTokens),
		"cache_read":     map[string]any{"input_tokens": count(tokens.CacheReadInputTokens)},
		"cache_creation": cacheWrites,
	}
	if tier != "" {
		usage["service_tier"] = tier
	}
	// Fast mode bills above the standard rates; the backend flags the row.
	if speed != "" {
		usage["speed"] = speed
	}
	event := map[string]any{
		"schema_version": "1.0",
		"timestamp":      timestamp.Format(time.RFC3339Nano),
		"event":          map[string]any{"id": usageEventID(key), "action": "token.usage", "category": "metric", "fidelity": "observed"},
		"harness":        map[string]any{"name": ID, "collection_method": string(agent.IngressPoll)},
		"session":        map[string]any{"id": sessionID},
		"gen_ai":         map[string]any{"usage": usage},
	}
	if model != "" {
		event["model"] = model
	}
	return event
}
