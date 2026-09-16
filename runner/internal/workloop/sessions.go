// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const (
	sessionTTL      = 24 * time.Hour
	maxSessionCount = 100
)

// SessionStore maps (agent, card, stage) tuples to Claude session IDs.
// Used to resume LLM sessions across retries, avoiding expensive codebase re-reads.
// Optionally persists to disk so sessions survive process restarts.
type SessionStore struct {
	mu       sync.Mutex
	sessions map[string]sessionEntry
	path     string // empty = in-memory only
}

type sessionEntry struct {
	SessionID string    `json:"session_id"`
	CreatedAt time.Time `json:"created_at"`
	LastUsed  time.Time `json:"last_used"`
}

func NewSessionStore() *SessionStore {
	return &SessionStore{sessions: make(map[string]sessionEntry)}
}

// NewPersistentSessionStore creates a store backed by a JSON file.
// Loads existing sessions from disk on creation.
func NewPersistentSessionStore(path string) *SessionStore {
	s := &SessionStore{
		sessions: make(map[string]sessionEntry),
		path:     path,
	}
	s.load()
	return s
}

func sessionKey(agentID, cardID, stage string) string {
	return fmt.Sprintf("%s:%s:%s", agentID, cardID, stage)
}

// Get returns the session ID for a (agent, card, stage) tuple, or empty string.
func (s *SessionStore) Get(agentID, cardID, stage string) string {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := sessionKey(agentID, cardID, stage)
	entry, ok := s.sessions[key]
	if !ok {
		return ""
	}
	if time.Since(entry.CreatedAt) > sessionTTL {
		delete(s.sessions, key)
		return ""
	}
	entry.LastUsed = time.Now()
	s.sessions[key] = entry
	return entry.SessionID
}

// Set stores a session ID for a (agent, card, stage) tuple.
func (s *SessionStore) Set(agentID, cardID, stage, sessionID string) {
	if sessionID == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	s.sessions[sessionKey(agentID, cardID, stage)] = sessionEntry{
		SessionID: sessionID,
		CreatedAt: now,
		LastUsed:  now,
	}
	s.evictLocked()
	s.saveLocked()
}

// Clear removes all sessions for a given (agent, card) pair across all stages.
func (s *SessionStore) Clear(agentID, cardID string) {
	prefix := agentID + ":" + cardID + ":"
	s.mu.Lock()
	defer s.mu.Unlock()
	for k := range s.sessions {
		if strings.HasPrefix(k, prefix) {
			delete(s.sessions, k)
		}
	}
	s.saveLocked()
}

// evictLocked removes expired entries and, if still over capacity, evicts LRU.
// Caller must hold s.mu.
func (s *SessionStore) evictLocked() {
	now := time.Now()
	for k, e := range s.sessions {
		if now.Sub(e.CreatedAt) > sessionTTL {
			delete(s.sessions, k)
		}
	}
	for len(s.sessions) > maxSessionCount {
		oldestKey := ""
		oldestTime := now
		for k, e := range s.sessions {
			if e.LastUsed.Before(oldestTime) {
				oldestKey = k
				oldestTime = e.LastUsed
			}
		}
		if oldestKey != "" {
			delete(s.sessions, oldestKey)
		}
	}
}

// saveLocked writes sessions to disk. Caller must hold s.mu.
func (s *SessionStore) saveLocked() {
	if s.path == "" {
		return
	}
	data, err := json.Marshal(s.sessions)
	if err != nil {
		slog.Warn("failed to marshal sessions", "error", err)
		return
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0700); err != nil {
		slog.Warn("failed to create session dir", "error", err)
		return
	}
	if err := os.WriteFile(s.path, data, 0600); err != nil {
		slog.Warn("failed to save sessions", "error", err)
	}
}

// load reads sessions from disk, discarding expired entries.
func (s *SessionStore) load() {
	if s.path == "" {
		return
	}
	data, err := os.ReadFile(s.path)
	if err != nil {
		return // file doesn't exist yet — not an error
	}
	var entries map[string]sessionEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		slog.Warn("failed to parse sessions file, starting fresh", "error", err)
		return
	}
	now := time.Now()
	for k, e := range entries {
		if now.Sub(e.CreatedAt) <= sessionTTL {
			s.sessions[k] = e
		}
	}
	slog.Info("loaded sessions from disk", "count", len(s.sessions), "path", s.path)
}
