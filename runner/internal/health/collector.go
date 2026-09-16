// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package health

import (
	"os"
	"runtime"
	"sync"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
	"github.com/Valaris-Studio/backplane/runner/internal/version"
)

// Collector accumulates runtime health metrics.
// Thread-safe for concurrent reads and writes.
type Collector struct {
	mu sync.RWMutex

	startedAt time.Time
	hostname  string

	// Counters (since process start).
	cardsProcessed int
	cardsFailed    int
	cardsSkipped   int

	// Current state.
	status         string // idle, working, draining, shutting_down
	currentCardID  string
	currentBoardID string
	lastError      string
	lastErrorAt    time.Time

	// Config snapshot (set once at startup).
	pollInterval string
	cardTimeout  string
	healthPort   int

	// Config validation errors detected during startup/refresh.
	configErrors   []valaris.ConfigError
	configErrorsMu sync.RWMutex
}

// NewCollector creates a health collector with config snapshot.
func NewCollector(pollInterval, cardTimeout time.Duration, healthPort int) *Collector {
	hostname, _ := os.Hostname()
	return &Collector{
		startedAt:    time.Now(),
		hostname:     hostname,
		status:       "idle",
		pollInterval: pollInterval.String(),
		cardTimeout:  cardTimeout.String(),
		healthPort:   healthPort,
	}
}

func (c *Collector) SetStatus(s string) {
	c.mu.Lock()
	c.status = s
	c.mu.Unlock()
}

func (c *Collector) SetCurrentCard(cardID, boardID string) {
	c.mu.Lock()
	c.currentCardID = cardID
	c.currentBoardID = boardID
	c.mu.Unlock()
}

func (c *Collector) ClearCurrentCard() {
	c.SetCurrentCard("", "")
}

func (c *Collector) RecordSuccess() {
	c.mu.Lock()
	c.cardsProcessed++
	c.lastError = ""
	c.lastErrorAt = time.Time{}
	c.mu.Unlock()
}

func (c *Collector) RecordFailure(errMsg string) {
	c.mu.Lock()
	c.cardsFailed++
	c.lastError = errMsg
	c.lastErrorAt = time.Now()
	c.mu.Unlock()
}

func (c *Collector) RecordSkip() {
	c.mu.Lock()
	c.cardsSkipped++
	c.mu.Unlock()
}

func (c *Collector) SetConfigErrors(errs []valaris.ConfigError) {
	c.configErrorsMu.Lock()
	c.configErrors = errs
	c.configErrorsMu.Unlock()
}

func (c *Collector) ConfigErrors() []valaris.ConfigError {
	c.configErrorsMu.RLock()
	defer c.configErrorsMu.RUnlock()
	result := make([]valaris.ConfigError, len(c.configErrors))
	copy(result, c.configErrors)
	return result
}

// HealthStatus implements daemon.HealthProvider.
func (c *Collector) HealthStatus() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.status
}

// UptimeSeconds implements daemon.HealthProvider.
func (c *Collector) UptimeSeconds() int64 {
	return int64(time.Since(c.startedAt).Seconds())
}

// Report builds the heartbeat payload.
func (c *Collector) Report() *valaris.HealthReport {
	c.mu.RLock()
	defer c.mu.RUnlock()

	// Start from the non-nil-slice factory so empty collections serialize as
	// `[]` not `null` — the backend uses that to clear stale state (T0.4).
	report := valaris.NewHealthReport()
	report.Version = version.Version
	report.GoVersion = runtime.Version()
	report.Hostname = c.hostname
	report.StartedAt = c.startedAt.UTC().Format(time.RFC3339)
	report.UptimeSeconds = int64(time.Since(c.startedAt).Seconds())
	report.CardsProcessed = c.cardsProcessed
	report.CardsFailed = c.cardsFailed
	report.CardsSkipped = c.cardsSkipped
	report.Status = c.status
	report.CurrentCardID = c.currentCardID
	report.CurrentBoardID = c.currentBoardID
	report.LastErrorMsg = c.lastError
	report.PollInterval = c.pollInterval
	report.CardTimeout = c.cardTimeout
	report.HealthPort = c.healthPort

	if !c.lastErrorAt.IsZero() {
		report.LastErrorAt = c.lastErrorAt.UTC().Format(time.RFC3339)
	}
	report.ConfigErrors = c.ConfigErrors()
	return report
}
