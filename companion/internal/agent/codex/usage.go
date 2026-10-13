// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package codex

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/scope"
)

// Codex's traces carry each turn's token usage, but Codex Desktop exports no
// traces. Every Codex thread's rollout ($CODEX_HOME/sessions/YYYY/MM/DD/
// rollout-<time>-<thread>.jsonl) counts the same usage, so the daemon reads
// it for sessions no trace has counted. Only the usage lines' typed numbers
// are decoded; content is skipped by encoding/json, never retained.
const (
	// maxRolloutLineBytes bounds one line held in memory. Usage lines are a
	// few hundred bytes; a longer line (a tool output) is skipped whole.
	maxRolloutLineBytes = 1 << 20
	usageKeyPrefix      = ID + ":usage:"
	// maxClockSkew: the backend refuses events stamped further ahead.
	maxClockSkew = 24 * time.Hour
)

// beforeOpenRollout runs between the checks and the open; tests swap the
// file there.
var beforeOpenRollout = func(string) {}

// maxRolloutReadBytes bounds one read; the rest waits for the next.
var maxRolloutReadBytes int64 = 64 << 20

// cliOriginators are the clients that are the CLI harness. Every other
// client (Codex Desktop, the IDE extensions) runs on codex-app-server, whose
// telemetry is Codex Desktop's harness.
var cliOriginators = map[string]bool{"codex_cli_rs": true, "codex_exec": true}

var (
	rolloutName    = regexp.MustCompile(`^rollout-[A-Za-z0-9._:-]{1,200}\.jsonl$`)
	modelID        = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@/+-]{0,127}$`)
	rolloutMarkers = [][]byte{[]byte(`"token_usage_record"`), []byte(`"token_count"`), []byte(`"turn_context"`), []byte(`"session_meta"`)}
)

// UsageTranscript takes the rollout path every Codex hook carries, so the
// daemon can poll it; the hook itself is no usage boundary.
func (Codex) UsageTranscript(event string, payload map[string]any) (string, bool) {
	path, _ := payload["transcript_path"].(string)
	if _, supported := eventLabels[event]; !supported || !filepath.IsAbs(path) || filepath.Ext(path) != ".jsonl" || strings.ContainsRune(path, 0) {
		return "", false
	}
	return filepath.Clean(path), true
}

type tokenUsage struct {
	InputTokens           int64 `json:"input_tokens"`
	CachedInputTokens     int64 `json:"cached_input_tokens"`
	CacheWriteInputTokens int64 `json:"cache_write_input_tokens"`
	OutputTokens          int64 `json:"output_tokens"`
	ReasoningOutputTokens int64 `json:"reasoning_output_tokens"`
	TotalTokens           int64 `json:"total_tokens"`
}

func (t tokenUsage) minus(earlier tokenUsage) tokenUsage {
	return tokenUsage{
		InputTokens:           max(t.InputTokens-earlier.InputTokens, 0),
		CachedInputTokens:     max(t.CachedInputTokens-earlier.CachedInputTokens, 0),
		CacheWriteInputTokens: max(t.CacheWriteInputTokens-earlier.CacheWriteInputTokens, 0),
		OutputTokens:          max(t.OutputTokens-earlier.OutputTokens, 0),
		ReasoningOutputTokens: max(t.ReasoningOutputTokens-earlier.ReasoningOutputTokens, 0),
		TotalTokens:           max(t.TotalTokens-earlier.TotalTokens, 0),
	}
}

// rolloutLine names the only members decoded from a rollout line (Codex's
// RolloutLine: session_meta, turn_context, event_msg token_count and
// token_usage_record payloads).
type rolloutLine struct {
	Timestamp string `json:"timestamp"`
	Type      string `json:"type"`
	Payload   *struct {
		Type       string `json:"type"`
		ID         string `json:"id"`
		Originator string `json:"originator"`
		Model      string `json:"model"`
		Info       *struct {
			TotalTokenUsage *tokenUsage `json:"total_token_usage"`
		} `json:"info"`
		RateLimits *struct {
			PlanType *string `json:"plan_type"`
		} `json:"rate_limits"`
		ThreadID   string      `json:"thread_id"`
		ResponseID string      `json:"response_id"`
		Usage      *tokenUsage `json:"usage"`
	} `json:"payload"`
}

// rolloutState is what the lines before a position said about the thread.
type rolloutState struct {
	Offset int64 `json:"offset"`
	// Drain is how far the oversized line starting at Offset was read past.
	// Offset stays at the line's start, where a binary that knows no drain
	// resumes and skips the line whole.
	Drain *agent.Skipped `json:"drain,omitempty"`
	// Thread is the rollout's own thread, from its session_meta.
	Thread string `json:"thread,omitempty"`
	// Harness is the one the session_meta's originator implies.
	Harness string `json:"harness,omitempty"`
	Model   string `json:"model,omitempty"`
	// Desktop: the originator is one Codex Desktop is known to write, not
	// merely a client that is not the CLI.
	Desktop bool `json:"desktop,omitempty"`
	// Plan: the rate limits named a ChatGPT plan, which only a ChatGPT
	// sign-in has, so the session is a subscription.
	Plan bool `json:"plan,omitempty"`
}

// position is where reading resumes.
func (s rolloutState) position() int64 {
	if s.Drain != nil {
		return s.Drain.To
	}
	return s.Offset
}

type rolloutCursor struct {
	rolloutState
	// Records: the rollout writes a record per response, so its token
	// counts, running totals over the same responses, are never counted.
	Records bool `json:"records,omitempty"`
	// Counted is the running total the counted token counts reached.
	Counted tokenUsage `json:"counted"`
	// Pending is the newest token count a read cut short by its budget
	// could not count yet; it holds every uncounted response before it.
	Pending *pendingTotal `json:"pending,omitempty"`
}

type pendingTotal struct {
	Key       string       `json:"key"`
	Timestamp time.Time    `json:"timestamp"`
	Before    rolloutState `json:"before"`
	Tokens    tokenUsage   `json:"tokens"`
}

type rolloutUsage struct {
	key       string
	timestamp time.Time
	// before is the state at the line's start, where a held line is re-read.
	before rolloutState
	tokens tokenUsage
	// runningTotal marks a token count, whose tokens are the thread's total.
	runningTotal bool
}

func (Codex) ReadUsage(read agent.UsageRead, raw json.RawMessage) (agent.UsageResult, error) {
	var cursor rolloutCursor
	if json.Unmarshal(raw, &cursor) != nil {
		cursor = rolloutCursor{}
	}
	file, info, ok := openRollout(read.Env, read.Transcript)
	if !ok {
		encoded, err := json.Marshal(cursor)
		return agent.UsageResult{Cursor: encoded}, err
	}
	defer file.Close()
	if cursor.Offset < 0 || cursor.position() > info.Size() {
		// A rollout that shrank was rewritten: read it from the start.
		cursor = rolloutCursor{}
	}
	budget := maxRolloutReadBytes
	if cursor.Drain != nil {
		budget -= agent.DigestCost(cursor.Offset, cursor.Drain.To)
		if !cursor.Drain.Holds(file, cursor.Offset, info.Size()) {
			// Rewritten since: the line at Offset is read anew.
			cursor.Drain = nil
		}
	}
	if _, err := file.Seek(cursor.position(), io.SeekStart); err != nil {
		encoded, err := json.Marshal(cursor)
		return agent.UsageResult{Cursor: encoded}, err
	}
	scan := scanRollout(file, read, cursor, budget)
	next, entries := settle(read, cursor, scan)
	harness := read.Harness
	if harness != ID && harness != DesktopID {
		harness = scan.state.Harness
	}
	if harness == "" {
		harness = ID
	}
	events := make([]json.RawMessage, 0, len(entries))
	for _, entry := range entries {
		encoded, err := json.Marshal(rolloutEvent(read.SessionID, harness, entry))
		if err != nil {
			return agent.UsageResult{}, err
		}
		events = append(events, encoded)
	}
	result := agent.UsageResult{Events: events, Harness: harness}
	if !scan.reachedEnd {
		result.DeferredFiles = 1
	}
	encoded, err := json.Marshal(next)
	result.Cursor = encoded
	return result, err
}

type rolloutScan struct {
	state   rolloutState
	entries []rolloutUsage
	records bool
	// reachedEnd: the read stopped at the end of what is written, not at
	// its byte budget.
	reachedEnd bool
}

// scanRollout reads on from the cursor's position in file, already
// sought there, at most about budget bytes.
func scanRollout(file *os.File, read agent.UsageRead, cursor rolloutCursor, budget int64) rolloutScan {
	scan := rolloutScan{state: cursor.rolloutState, records: cursor.Records}
	lines := bufio.NewReaderSize(file, 64<<10)
	position, draining := scan.state.position(), scan.state.Drain != nil
	scan.state.Drain = nil
	for budget > 0 {
		if draining {
			size, ended := agent.SkipLine(lines, maxRolloutLineBytes)
			if size == 0 {
				scan.reachedEnd = true
				break
			}
			budget -= size
			position += size
			draining = !ended
			if ended {
				scan.state.Offset = position
			}
			continue
		}
		content, size, ended, oversized := agent.BoundedLine(lines, maxRolloutLineBytes)
		if !ended && !oversized {
			scan.reachedEnd = true
			break
		}
		budget -= size
		if !oversized {
			scan.parse(content, read)
		}
		position += size
		draining = !ended
		if ended {
			scan.state.Offset = position
		}
	}
	if draining {
		drain := agent.Skip(file, scan.state.Offset, position)
		scan.state.Drain = &drain
	}
	return scan
}

func (s *rolloutScan) parse(content []byte, read agent.UsageRead) {
	if !containsAny(content, rolloutMarkers) {
		return
	}
	var line rolloutLine
	if json.Unmarshal(content, &line) != nil || line.Payload == nil {
		return
	}
	payload := line.Payload
	switch {
	case line.Type == "session_meta":
		if nativeID.MatchString(payload.ID) {
			s.state.Thread = payload.ID
		}
		s.state.Harness = DesktopID
		s.state.Desktop = desktopOriginators[payload.Originator]
		if cliOriginators[payload.Originator] {
			s.state.Harness = ID
		}
	case line.Type == "turn_context":
		s.state.Model = ""
		if modelID.MatchString(payload.Model) {
			s.state.Model = payload.Model
		}
	case line.Type == "token_usage_record" && payload.Usage != nil:
		s.records = true
		if payload.ThreadID != read.SessionID {
			// A record copied from another thread, e.g. a fork's parent.
			return
		}
		key := usageKeyPrefix + payload.ThreadID + ":line:" + digest(read.Transcript) + ":" + strconv.FormatInt(s.state.Offset, 10)
		if nativeID.MatchString(payload.ResponseID) {
			key = usageKeyPrefix + payload.ThreadID + ":" + payload.ResponseID
		}
		s.add(line.Timestamp, key, *payload.Usage, false, read.Now)
	case line.Type == "event_msg" && payload.Type == "token_count":
		if payload.Info != nil && payload.Info.TotalTokenUsage != nil && s.state.Thread == read.SessionID {
			total := *payload.Info.TotalTokenUsage
			s.add(line.Timestamp, usageKeyPrefix+s.state.Thread+":total:"+strconv.FormatInt(total.TotalTokens, 10), total, true, read.Now)
		}
		if payload.RateLimits != nil && payload.RateLimits.PlanType != nil && *payload.RateLimits.PlanType != "" {
			s.state.Plan = true
		}
	}
}

func (s *rolloutScan) add(stamp, key string, tokens tokenUsage, runningTotal bool, now time.Time) {
	timestamp, err := time.Parse(time.RFC3339Nano, stamp)
	if err != nil || timestamp.After(now.Add(maxClockSkew)) {
		return
	}
	s.entries = append(s.entries, rolloutUsage{key: key, timestamp: timestamp.UTC(), before: s.state, tokens: tokens, runningTotal: runningTotal})
}

// settle picks the usage to emit and where the next read starts. Lines
// written after read.Until wait, whole, for a later read. Token counts are
// counted only in a rollout without records, and only by a read that
// reached the end: a record for the same response may follow them.
func settle(read agent.UsageRead, cursor rolloutCursor, scan rolloutScan) (rolloutCursor, []rolloutUsage) {
	entries := scan.entries
	if cursor.Pending != nil {
		held := cursor.Pending
		entries = append([]rolloutUsage{{key: held.Key, timestamp: held.Timestamp, before: held.Before, tokens: held.Tokens, runningTotal: true}}, entries...)
	}
	counted := cursor.Counted
	var pending *pendingTotal
	var emitted []rolloutUsage
	for _, entry := range entries {
		if !read.Until.IsZero() && entry.timestamp.After(read.Until) {
			return rolloutCursor{rolloutState: entry.before, Records: scan.records, Counted: counted, Pending: pending}, emitted
		}
		if entry.runningTotal {
			if scan.records {
				continue
			}
			if !scan.reachedEnd {
				pending = &pendingTotal{Key: entry.key, Timestamp: entry.timestamp, Before: entry.before, Tokens: entry.tokens}
				continue
			}
			switch {
			case entry.tokens.TotalTokens == counted.TotalTokens:
				// A repeat: only the rate limits changed.
				continue
			case entry.tokens.TotalTokens < counted.TotalTokens:
				// The total restarted (a compaction, /new): all of it is new.
				counted = entry.tokens
			default:
				entry.tokens, counted = entry.tokens.minus(counted), entry.tokens
			}
		}
		if read.Allowed == nil || read.Allowed(entry.timestamp) {
			emitted = append(emitted, entry)
		}
	}
	return rolloutCursor{rolloutState: scan.state, Records: scan.records, Counted: counted, Pending: pending}, emitted
}

// openRollout opens path only when it is a regular rollout file inside
// $CODEX_HOME/sessions, both compared in their canonical on-disk spelling
// (symlinks resolved, case and Unicode form as on disk), and is still that
// file when opened.
func openRollout(env agent.Env, path string) (*os.File, os.FileInfo, bool) {
	sessions := filepath.Join(codexHome(env), "sessions")
	if !filepath.IsAbs(sessions) || !filepath.IsAbs(path) || !rolloutName.MatchString(filepath.Base(path)) {
		return nil, nil, false
	}
	root, ok := scope.CanonicalDir(sessions)
	if !ok {
		return nil, nil, false
	}
	if linked, err := os.Lstat(path); err != nil || !linked.Mode().IsRegular() {
		return nil, nil, false
	}
	parent, ok := scope.CanonicalDir(filepath.Dir(path))
	if !ok {
		return nil, nil, false
	}
	if relative, err := filepath.Rel(root, parent); err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return nil, nil, false
	}
	real := filepath.Join(parent, filepath.Base(path))
	expected, err := os.Lstat(real)
	if err != nil || !expected.Mode().IsRegular() {
		return nil, nil, false
	}
	// Windows resolves Lstat's file identity lazily in SameFile. Capture it
	// before opening, so a replacement cannot become the expected identity.
	if !os.SameFile(expected, expected) {
		return nil, nil, false
	}
	beforeOpenRollout(real)
	// Non-blocking: a FIFO swapped in since the checks would otherwise block
	// the open, and the daemon's tick with it, until a writer came along.
	// Regular files ignore the flag.
	file, err := os.OpenFile(real, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, false
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || !os.SameFile(info, expected) {
		file.Close()
		return nil, nil, false
	}
	return file, info, true
}

func containsAny(content []byte, markers [][]byte) bool {
	for _, marker := range markers {
		if bytes.Contains(content, marker) {
			return true
		}
	}
	return false
}

func digest(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:8])
}

// rolloutEvent is the Beacon-shaped usage event the backend prices, split
// the way Beacon splits Codex's turn span: Codex counts cached and
// cache-written tokens inside input_tokens and reasoning inside output.
func rolloutEvent(sessionID, harness string, entry rolloutUsage) map[string]any {
	tokens := entry.tokens
	cached, written := max(tokens.CachedInputTokens, 0), max(tokens.CacheWriteInputTokens, 0)
	output := max(tokens.OutputTokens, 0)
	usage := map[string]any{
		"input_tokens":   max(tokens.InputTokens-cached-written, 0),
		"output_tokens":  output,
		"cache_read":     map[string]any{"input_tokens": cached},
		"cache_creation": map[string]any{"input_tokens": written},
		"reasoning":      map[string]any{"output_tokens": min(max(tokens.ReasoningOutputTokens, 0), output)},
	}
	sum := sha256.Sum256([]byte(entry.key))
	raw := map[string]any{"source": "codex_rollout"}
	if entry.before.Plan {
		// The backend and the session tracker read how a session is paid
		// for from Codex's telemetry attribute of this name.
		raw["attributes"] = map[string]any{"auth_mode": "chatgpt"}
	}
	event := map[string]any{
		"schema_version": "1.0",
		"timestamp":      entry.timestamp.Format(time.RFC3339Nano),
		"event":          map[string]any{"id": hex.EncodeToString(sum[:]), "action": "token.usage", "category": "metric", "fidelity": "observed"},
		"harness":        map[string]any{"name": harness, "collection_method": string(agent.IngressPoll)},
		"session":        map[string]any{"id": sessionID},
		"gen_ai":         map[string]any{"usage": usage},
		"raw":            raw,
	}
	if entry.before.Model != "" {
		event["model"] = entry.before.Model
	}
	return event
}
