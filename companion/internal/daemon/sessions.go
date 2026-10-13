// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"bytes"
	"encoding/json"
	"strings"
	"time"
)

// Session events tell a local subscriber (the desktop app) what is being
// captured, from what this daemon queued. They carry identifiers, times and
// token counts only: no prompt, command, output or local path.
const (
	SessionStarted = "started"
	SessionUpdated = "updated"
	SessionEnded   = "ended"
	// sessionUpdateInterval bounds how often one session's updates are
	// published, so a busy agent cannot fill a subscriber's queue.
	sessionUpdateInterval = 2 * time.Second
	maxTrackedSessions    = 1024
	// maxUsageIDsPerSession bounds the per-request token entries kept to
	// recognize a re-read of the same request.
	maxUsageIDsPerSession = 4096
)

// sessionEndEvents are the agents' own session-end hooks.
var sessionEndEvents = map[string]bool{"SessionEnd": true, "session_shutdown": true}

type SessionEvent struct {
	Kind    string         `json:"kind"`
	Session SessionSummary `json:"session"`
}

type SessionSummary struct {
	NativeSessionID string `json:"native_session_id"`
	Harness         string `json:"harness"`
	// Repo is the normalized host/owner/repo, empty when unknown.
	Repo string `json:"repo"`
	// MappingID is the server id of the mapping that captured the session,
	// so a folder bound by path (no repo) can still name its board.
	MappingID   *string      `json:"mapping_id"`
	StartedAt   time.Time    `json:"started_at"`
	LastEventAt time.Time    `json:"last_event_at"`
	Tokens      *TokenTotals `json:"tokens,omitempty"`
	// CostBasis and AuthKind are null unless the harness reports how it is
	// paid for; only Codex does (its telemetry's auth_mode).
	CostBasis *string `json:"cost_basis"`
	AuthKind  *string `json:"auth_kind"`
	// HistoryDeleted says why the session's earlier history is gone from
	// Backplane (owner, retention or unknown), null while it is intact;
	// Tokens then count only what came after.
	HistoryDeleted *string `json:"history_deleted"`
}

// codexAuthKinds mirror the backend's reading of Codex's auth_mode
// (agent_usage._CODEX_AUTH_MODES): a ChatGPT sign-in is a plan, an API key
// is billed per token.
var codexAuthKinds = map[string]string{
	"chatgpt":           "subscription",
	"chatgptauthtokens": "subscription",
	"apikey":            "api",
	"api_key":           "api",
}

// costBasis mirrors the backend: an API key's cost is real spend, a plan's
// is what the same tokens would cost through the API.
func costBasis(authKind string) string {
	if authKind == "api" {
		return "spend"
	}
	return "api_equivalent"
}

type TokenTotals struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cache_read"`
	CacheWrite int64 `json:"cache_write"`
}

type trackedSession struct {
	summary     SessionSummary
	announced   bool
	dirty       bool
	ended       bool
	publishedAt time.Time
	// usage holds each request's latest token counts by event id, so a
	// later, larger copy of a request replaces the earlier one.
	usage map[string]requestUsage
}

type requestUsage struct {
	tokens TokenTotals
	at     time.Time
}

type sessionTracker struct {
	sessions map[string]*trackedSession
}

func sessionKey(harness, sessionID string) string { return harness + "\x00" + sessionID }

// noteQueued records a record just queued for a session.
func (t *sessionTracker) noteQueued(harness, sessionID, repo, mappingID string, at time.Time, event string, events []json.RawMessage) {
	if sessionID == "" {
		return
	}
	if t.sessions == nil {
		t.sessions = map[string]*trackedSession{}
	}
	key := sessionKey(harness, sessionID)
	tracked, known := t.sessions[key]
	if !known {
		if len(t.sessions) >= maxTrackedSessions {
			t.evictOldest()
		}
		tracked = &trackedSession{summary: SessionSummary{NativeSessionID: sessionID, Harness: harness, StartedAt: at.UTC()}}
		t.sessions[key] = tracked
	}
	if repo != "" {
		tracked.summary.Repo = repo
	}
	if mappingID != "" {
		tracked.summary.MappingID = &mappingID
	}
	if at.After(tracked.summary.LastEventAt) {
		tracked.summary.LastEventAt = at.UTC()
	}
	if at.Before(tracked.summary.StartedAt) {
		tracked.summary.StartedAt = at.UTC()
	}
	if tracked.noteUsage(events, at) {
		tracked.summary.Tokens = tracked.totals()
	}
	if authKind := recordedAuthKind(events); authKind != "" {
		basis := costBasis(authKind)
		tracked.summary.AuthKind, tracked.summary.CostBasis = &authKind, &basis
	}
	tracked.dirty = true
	tracked.ended = tracked.ended || sessionEndEvents[event]
}

func (t *sessionTracker) evictOldest() {
	oldest := ""
	for key, tracked := range t.sessions {
		if oldest == "" || tracked.summary.LastEventAt.Before(t.sessions[oldest].summary.LastEventAt) {
			oldest = key
		}
	}
	delete(t.sessions, oldest)
}

// flush returns the events due now: a new session is announced once, an end
// always goes out, and other changes wait out the update interval.
func (t *sessionTracker) flush(now time.Time) []SessionEvent {
	var due []SessionEvent
	for key, tracked := range t.sessions {
		kind := ""
		switch {
		case !tracked.dirty:
		case !tracked.announced && !tracked.ended:
			kind = SessionStarted
		case tracked.ended:
			kind = SessionEnded
		case now.Sub(tracked.publishedAt) >= sessionUpdateInterval:
			kind = SessionUpdated
		}
		if kind == "" {
			continue
		}
		summary := tracked.summary
		if summary.Tokens != nil {
			copied := *summary.Tokens
			summary.Tokens = &copied
		}
		if summary.AuthKind != nil {
			authKind, basis := *summary.AuthKind, *summary.CostBasis
			summary.AuthKind, summary.CostBasis = &authKind, &basis
		}
		if summary.HistoryDeleted != nil {
			reason := *summary.HistoryDeleted
			summary.HistoryDeleted = &reason
		}
		due = append(due, SessionEvent{Kind: kind, Session: summary})
		tracked.announced, tracked.dirty, tracked.publishedAt = true, false, now
		if tracked.ended {
			delete(t.sessions, key)
		}
	}
	return due
}

// noteHistoryDeleted marks a tracked session whose history was deleted
// through `through`, for `reason`, and forgets the usage it counted from by
// then. A session this daemon never tracked is left untracked.
func (t *sessionTracker) noteHistoryDeleted(harness, sessionID string, through time.Time, reason string) {
	tracked, known := t.sessions[sessionKey(harness, sessionID)]
	if !known {
		return
	}
	forgot := false
	for id, request := range tracked.usage {
		if !request.at.After(through) {
			delete(tracked.usage, id)
			forgot = true
		}
	}
	if forgot {
		tracked.summary.Tokens = tracked.totals()
	}
	if forgot || tracked.summary.HistoryDeleted == nil || *tracked.summary.HistoryDeleted != reason {
		tracked.summary.HistoryDeleted = &reason
		tracked.dirty = true
	}
}

// noteUsage folds the token.usage events of a record into the session and
// reports whether any were found. An event without a timestamp counts as
// observed when its record was.
func (s *trackedSession) noteUsage(events []json.RawMessage, recordedAt time.Time) bool {
	found := false
	for _, line := range events {
		if !bytes.Contains(line, []byte(`"usage"`)) {
			continue
		}
		var event struct {
			Event struct {
				ID string `json:"id"`
			} `json:"event"`
			GenAI struct {
				Usage *struct {
					InputTokens   int64           `json:"input_tokens"`
					OutputTokens  int64           `json:"output_tokens"`
					CacheRead     json.RawMessage `json:"cache_read"`
					CacheCreation json.RawMessage `json:"cache_creation"`
				} `json:"usage"`
			} `json:"gen_ai"`
		}
		if json.Unmarshal(line, &event) != nil || event.GenAI.Usage == nil || event.Event.ID == "" {
			continue
		}
		if s.usage == nil {
			s.usage = map[string]requestUsage{}
		}
		if _, known := s.usage[event.Event.ID]; !known && len(s.usage) >= maxUsageIDsPerSession {
			continue
		}
		usage := event.GenAI.Usage
		s.usage[event.Event.ID] = requestUsage{
			tokens: TokenTotals{Input: usage.InputTokens, Output: usage.OutputTokens, CacheRead: tokenCount(usage.CacheRead), CacheWrite: tokenCount(usage.CacheCreation)},
			at:     eventTime(line, recordedAt),
		}
		found = true
	}
	return found
}

// recordedAuthKind reads the last auth mode a record's events report.
func recordedAuthKind(events []json.RawMessage) string {
	kind := ""
	for _, line := range events {
		if !bytes.Contains(line, []byte(`"auth_mode"`)) {
			continue
		}
		var event struct {
			Raw struct {
				Attributes struct {
					AuthMode string `json:"auth_mode"`
				} `json:"attributes"`
			} `json:"raw"`
		}
		if json.Unmarshal(line, &event) == nil {
			if known, ok := codexAuthKinds[strings.ToLower(event.Raw.Attributes.AuthMode)]; ok {
				kind = known
			}
		}
	}
	return kind
}

func (s *trackedSession) totals() *TokenTotals {
	var totals TokenTotals
	for _, request := range s.usage {
		totals.Input += request.tokens.Input
		totals.Output += request.tokens.Output
		totals.CacheRead += request.tokens.CacheRead
		totals.CacheWrite += request.tokens.CacheWrite
	}
	return &totals
}

// tokenCount reads a cache member written either as a count or as an object
// carrying input_tokens.
func tokenCount(raw json.RawMessage) int64 {
	var count int64
	if json.Unmarshal(raw, &count) == nil {
		return count
	}
	var object struct {
		InputTokens int64 `json:"input_tokens"`
	}
	json.Unmarshal(raw, &object)
	return object.InputTokens
}

func (d *Daemon) publishSessions() {
	if d.config.Sessions == nil {
		return
	}
	for _, event := range d.sessions.flush(d.config.Now()) {
		d.config.Sessions(event)
	}
}
