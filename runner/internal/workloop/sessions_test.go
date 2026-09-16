// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"fmt"
	"path/filepath"
	"testing"
	"time"
)

func TestSessionStore_GetSet(t *testing.T) {
	s := NewSessionStore()

	if got := s.Get("a1", "c1", "implement"); got != "" {
		t.Errorf("empty store should return empty: got %q", got)
	}

	s.Set("a1", "c1", "implement", "sess-1")
	if got := s.Get("a1", "c1", "implement"); got != "sess-1" {
		t.Errorf("got %q, want %q", got, "sess-1")
	}

	// Different stage on same card.
	s.Set("a1", "c1", "review", "sess-2")
	if got := s.Get("a1", "c1", "review"); got != "sess-2" {
		t.Errorf("got %q, want %q", got, "sess-2")
	}
}

func TestSessionStore_SetEmptyIgnored(t *testing.T) {
	s := NewSessionStore()
	s.Set("a1", "c1", "implement", "sess-1")
	s.Set("a1", "c1", "implement", "") // should not overwrite
	if got := s.Get("a1", "c1", "implement"); got != "sess-1" {
		t.Errorf("empty set should not overwrite: got %q", got)
	}
}

func TestSessionStore_Clear(t *testing.T) {
	s := NewSessionStore()
	s.Set("a1", "c1", "implement", "sess-1")
	s.Set("a1", "c1", "review", "sess-2")
	s.Set("a1", "c2", "implement", "sess-3") // different card

	s.Clear("a1", "c1")

	if got := s.Get("a1", "c1", "implement"); got != "" {
		t.Errorf("cleared session should be empty: got %q", got)
	}
	if got := s.Get("a1", "c1", "review"); got != "" {
		t.Errorf("cleared session should be empty: got %q", got)
	}
	// Different card should be unaffected.
	if got := s.Get("a1", "c2", "implement"); got != "sess-3" {
		t.Errorf("other card should be unaffected: got %q", got)
	}
}

func TestSessionStore_Overwrite(t *testing.T) {
	s := NewSessionStore()
	s.Set("a1", "c1", "implement", "sess-old")
	s.Set("a1", "c1", "implement", "sess-new")
	if got := s.Get("a1", "c1", "implement"); got != "sess-new" {
		t.Errorf("overwrite should take effect: got %q", got)
	}
}

func TestPersistentSessionStore_SaveLoad(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sessions.json")

	// Create and populate.
	s1 := NewPersistentSessionStore(path)
	s1.Set("a1", "c1", "implement", "sess-persist")
	s1.Set("a1", "c2", "review", "sess-review")

	// Create a new store from the same file — should load sessions.
	s2 := NewPersistentSessionStore(path)
	if got := s2.Get("a1", "c1", "implement"); got != "sess-persist" {
		t.Errorf("loaded session = %q, want %q", got, "sess-persist")
	}
	if got := s2.Get("a1", "c2", "review"); got != "sess-review" {
		t.Errorf("loaded session = %q, want %q", got, "sess-review")
	}
}

func TestPersistentSessionStore_ClearPersists(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sessions.json")

	s1 := NewPersistentSessionStore(path)
	s1.Set("a1", "c1", "implement", "sess-1")
	s1.Clear("a1", "c1")

	s2 := NewPersistentSessionStore(path)
	if got := s2.Get("a1", "c1", "implement"); got != "" {
		t.Errorf("cleared session should not persist: got %q", got)
	}
}

func TestSessionStore_TTLExpiry(t *testing.T) {
	s := NewSessionStore()

	// Manually inject an expired entry.
	key := sessionKey("a1", "c1", "implement")
	s.mu.Lock()
	s.sessions[key] = sessionEntry{
		SessionID: "expired-sess",
		CreatedAt: time.Now().Add(-25 * time.Hour),
		LastUsed:  time.Now().Add(-25 * time.Hour),
	}
	s.mu.Unlock()

	if got := s.Get("a1", "c1", "implement"); got != "" {
		t.Errorf("expired session should return empty: got %q", got)
	}
}

func TestPersistentSessionStore_LoadSkipsExpired(t *testing.T) {
	path := filepath.Join(t.TempDir(), "sessions.json")

	// Create store with one entry, then tamper with the file to make it expired.
	s1 := NewPersistentSessionStore(path)
	s1.Set("a1", "c1", "implement", "sess-old")

	// Overwrite the entry's created_at to 25h ago.
	s1.mu.Lock()
	key := sessionKey("a1", "c1", "implement")
	entry := s1.sessions[key]
	entry.CreatedAt = time.Now().Add(-25 * time.Hour)
	s1.sessions[key] = entry
	s1.saveLocked()
	s1.mu.Unlock()

	s2 := NewPersistentSessionStore(path)
	if got := s2.Get("a1", "c1", "implement"); got != "" {
		t.Errorf("expired session should not be loaded: got %q", got)
	}
}

func TestSessionStore_LRUEviction(t *testing.T) {
	s := NewSessionStore()

	// Fill beyond maxSessionCount.
	for i := 0; i < maxSessionCount+10; i++ {
		s.Set("a1", fmt.Sprintf("card-%d", i), "implement", fmt.Sprintf("sess-%d", i))
	}

	s.mu.Lock()
	count := len(s.sessions)
	s.mu.Unlock()

	if count > maxSessionCount {
		t.Errorf("session count = %d, want <= %d", count, maxSessionCount)
	}
}
