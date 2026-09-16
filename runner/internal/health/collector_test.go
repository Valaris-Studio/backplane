// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package health

import (
	"sync"
	"testing"
	"time"
)

func TestCollector_InitialState(t *testing.T) {
	c := NewCollector(2*time.Minute, 30*time.Minute, 0)

	if c.HealthStatus() != "idle" {
		t.Errorf("initial status should be idle, got %q", c.HealthStatus())
	}
	if c.UptimeSeconds() < 0 {
		t.Error("uptime should be non-negative")
	}

	report := c.Report()
	if report.CardsProcessed != 0 || report.CardsFailed != 0 || report.CardsSkipped != 0 {
		t.Error("initial counters should be 0")
	}
	if report.Status != "idle" {
		t.Errorf("report status should be idle, got %q", report.Status)
	}
	if report.CurrentCardID != "" || report.CurrentBoardID != "" {
		t.Error("initial card should be empty")
	}
	if report.PollInterval != "2m0s" {
		t.Errorf("poll interval should be 2m0s, got %q", report.PollInterval)
	}
	if report.CardTimeout != "30m0s" {
		t.Errorf("card timeout should be 30m0s, got %q", report.CardTimeout)
	}
}

func TestCollector_RecordSuccess(t *testing.T) {
	c := NewCollector(time.Minute, time.Minute, 0)

	// Set an error first, then record success — should clear it.
	c.RecordFailure("some error")
	c.RecordSuccess()

	report := c.Report()
	if report.CardsProcessed != 1 {
		t.Errorf("expected 1 card processed, got %d", report.CardsProcessed)
	}
	if report.CardsFailed != 1 {
		t.Errorf("expected 1 card failed, got %d", report.CardsFailed)
	}
	if report.LastErrorMsg != "" {
		t.Error("success should clear lastError")
	}
	if report.LastErrorAt != "" {
		t.Error("success should clear lastErrorAt")
	}
}

func TestCollector_RecordFailure(t *testing.T) {
	c := NewCollector(time.Minute, time.Minute, 0)

	c.RecordFailure("git push failed")

	report := c.Report()
	if report.CardsFailed != 1 {
		t.Errorf("expected 1 card failed, got %d", report.CardsFailed)
	}
	if report.LastErrorMsg != "git push failed" {
		t.Errorf("expected error message, got %q", report.LastErrorMsg)
	}
	if report.LastErrorAt == "" {
		t.Error("lastErrorAt should be set")
	}
}

func TestCollector_SetCurrentCard(t *testing.T) {
	c := NewCollector(time.Minute, time.Minute, 0)

	c.SetCurrentCard("card-123", "board-456")
	report := c.Report()
	if report.CurrentCardID != "card-123" {
		t.Errorf("expected card-123, got %q", report.CurrentCardID)
	}
	if report.CurrentBoardID != "board-456" {
		t.Errorf("expected board-456, got %q", report.CurrentBoardID)
	}

	c.ClearCurrentCard()
	report = c.Report()
	if report.CurrentCardID != "" || report.CurrentBoardID != "" {
		t.Error("clear should empty card fields")
	}
}

func TestCollector_RecordSkip(t *testing.T) {
	c := NewCollector(time.Minute, time.Minute, 0)

	c.RecordSkip()
	c.RecordSkip()
	c.RecordSkip()

	report := c.Report()
	if report.CardsSkipped != 3 {
		t.Errorf("expected 3 skips, got %d", report.CardsSkipped)
	}
}

func TestCollector_Report(t *testing.T) {
	c := NewCollector(2*time.Minute, 30*time.Minute, 0)

	c.SetStatus("working")
	c.SetCurrentCard("c1", "b1")
	c.RecordSuccess()
	c.RecordSuccess()
	c.RecordFailure("timeout")
	c.RecordSkip()

	report := c.Report()
	if report.Version == "" {
		t.Error("version should be set")
	}
	if report.GoVersion == "" {
		t.Error("go version should be set")
	}
	if report.Hostname == "" {
		t.Error("hostname should be set")
	}
	if report.StartedAt == "" {
		t.Error("started_at should be set")
	}
	if report.UptimeSeconds < 0 {
		t.Error("uptime should be non-negative")
	}
	if report.CardsProcessed != 2 {
		t.Errorf("expected 2 processed, got %d", report.CardsProcessed)
	}
	if report.CardsFailed != 1 {
		t.Errorf("expected 1 failed, got %d", report.CardsFailed)
	}
	if report.CardsSkipped != 1 {
		t.Errorf("expected 1 skipped, got %d", report.CardsSkipped)
	}
	if report.Status != "working" {
		t.Errorf("expected working, got %q", report.Status)
	}
	if report.CurrentCardID != "c1" {
		t.Errorf("expected c1, got %q", report.CurrentCardID)
	}
	if report.LastErrorMsg != "timeout" {
		t.Errorf("expected 'timeout', got %q", report.LastErrorMsg)
	}
}

func TestCollector_ReportHealthPort(t *testing.T) {
	c := NewCollector(time.Minute, time.Minute, 8081)
	report := c.Report()
	if report.HealthPort != 8081 {
		t.Errorf("expected health_port 8081, got %d", report.HealthPort)
	}

	// Zero port should remain zero (omitted in JSON via omitempty).
	c2 := NewCollector(time.Minute, time.Minute, 0)
	report2 := c2.Report()
	if report2.HealthPort != 0 {
		t.Errorf("expected health_port 0 for unset, got %d", report2.HealthPort)
	}
}

func TestCollector_Concurrency(t *testing.T) {
	c := NewCollector(time.Minute, time.Minute, 0)

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(4)
		go func() {
			defer wg.Done()
			c.RecordSuccess()
		}()
		go func() {
			defer wg.Done()
			c.RecordFailure("err")
		}()
		go func() {
			defer wg.Done()
			c.Report()
		}()
		go func() {
			defer wg.Done()
			c.SetCurrentCard("c", "b")
		}()
	}
	wg.Wait()

	report := c.Report()
	if report.CardsProcessed != 100 {
		t.Errorf("expected 100 processed, got %d", report.CardsProcessed)
	}
	if report.CardsFailed != 100 {
		t.Errorf("expected 100 failed, got %d", report.CardsFailed)
	}
}
