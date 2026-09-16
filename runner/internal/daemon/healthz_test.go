// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

type mockHP struct {
	status string
	uptime int64
}

func (m *mockHP) HealthStatus() string { return m.status }
func (m *mockHP) UptimeSeconds() int64 { return m.uptime }

// mockCBProvider implements both HealthProvider and CircuitBreakerProvider.
type mockCBProvider struct {
	mockHP
	blocked []valaris.BlockedCardInfo
}

func (m *mockCBProvider) BlockedCardDetails() []valaris.BlockedCardInfo { return m.blocked }

// The health server exposes blocked-card details and a poll trigger with no
// auth, so it must not reach the LAN unless an operator opts in explicitly.
func TestHealthServer_DefaultBindIsLoopback(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	addr, err := StartHealthServer(ctx, 0, "", &mockHP{status: "idle"}, nil)
	if err != nil {
		t.Fatalf("start health server: %v", err)
	}

	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("split host port %q: %v", addr, err)
	}
	if host != "127.0.0.1" {
		t.Errorf("default bind host = %q, want 127.0.0.1", host)
	}
}

func TestHealthServer_ExplicitBindOverridesDefault(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	addr, err := StartHealthServer(ctx, 0, "0.0.0.0", &mockHP{status: "idle"}, nil)
	if err != nil {
		t.Fatalf("start health server: %v", err)
	}

	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("split host port %q: %v", addr, err)
	}
	// A dual-stack wildcard listener reports "::", not the "0.0.0.0" asked for,
	// so assert the property that matters: it is the unspecified address, i.e.
	// the operator's opt-out actually left loopback.
	ip := net.ParseIP(host)
	if ip == nil || !ip.IsUnspecified() {
		t.Errorf("explicit bind host = %q, want an unspecified (wildcard) address", host)
	}
}

func TestHealthServer_OK(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	hp := &mockHP{status: "idle", uptime: 42}
	addr, err := StartHealthServer(ctx, 0, "", hp, nil)
	if err != nil {
		t.Fatalf("start health server: %v", err)
	}

	resp, err := http.Get("http://" + addr + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200", resp.StatusCode)
	}

	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}

	if body["status"] != "idle" {
		t.Errorf("body status = %q, want idle", body["status"])
	}
	if int64(body["uptime_seconds"].(float64)) != 42 {
		t.Errorf("body uptime_seconds = %v, want 42", body["uptime_seconds"])
	}
}

func TestHealthServer_Draining(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	hp := &mockHP{status: "draining", uptime: 100}
	addr, err := StartHealthServer(ctx, 0, "", hp, nil)
	if err != nil {
		t.Fatalf("start health server: %v", err)
	}

	resp, err := http.Get("http://" + addr + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", resp.StatusCode)
	}

	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}

	if body["status"] != "draining" {
		t.Errorf("body status = %q, want draining", body["status"])
	}
}

func TestHealthServer_Shutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())

	hp := &mockHP{status: "idle", uptime: 1}
	addr, err := StartHealthServer(ctx, 0, "", hp, nil)
	if err != nil {
		t.Fatalf("start health server: %v", err)
	}

	// Verify it's running first.
	resp, err := http.Get("http://" + addr + "/healthz")
	if err != nil {
		t.Fatalf("initial GET failed: %v", err)
	}
	resp.Body.Close()

	// Cancel context to trigger shutdown.
	cancel()

	// Poll until the server stops accepting connections.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, 100*time.Millisecond)
		if err != nil {
			// Connection refused — server is down.
			return
		}
		conn.Close()
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("server did not shut down within 3 seconds")
}

func TestPollNow_Triggered(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	trigger := make(chan struct{}, 1)
	hp := &mockHP{status: "idle", uptime: 1}
	addr, err := StartHealthServer(ctx, 0, "", hp, trigger)
	if err != nil {
		t.Fatalf("start health server: %v", err)
	}

	resp, err := http.Post("http://"+addr+"/pollnow", "", nil)
	if err != nil {
		t.Fatalf("POST /pollnow: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200", resp.StatusCode)
	}

	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["status"] != "triggered" {
		t.Errorf("body status = %q, want triggered", body["status"])
	}

	// Verify the channel received the signal.
	select {
	case <-trigger:
		// ok
	default:
		t.Error("trigger channel was not signalled")
	}
}

func TestPollNow_Busy(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	trigger := make(chan struct{}, 1)
	// Pre-fill the channel to simulate an in-flight poll.
	trigger <- struct{}{}

	hp := &mockHP{status: "idle", uptime: 1}
	addr, err := StartHealthServer(ctx, 0, "", hp, trigger)
	if err != nil {
		t.Fatalf("start health server: %v", err)
	}

	resp, err := http.Post("http://"+addr+"/pollnow", "", nil)
	if err != nil {
		t.Fatalf("POST /pollnow: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusConflict {
		t.Errorf("status = %d, want 409", resp.StatusCode)
	}

	var body map[string]string
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	if body["status"] != "busy" {
		t.Errorf("body status = %q, want busy", body["status"])
	}
}

func TestPollNow_NilChannel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	hp := &mockHP{status: "idle", uptime: 1}
	addr, err := StartHealthServer(ctx, 0, "", hp, nil)
	if err != nil {
		t.Fatalf("start health server: %v", err)
	}

	resp, err := http.Post("http://"+addr+"/pollnow", "", nil)
	if err != nil {
		t.Fatalf("POST /pollnow: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusNotImplemented {
		t.Errorf("status = %d, want 501", resp.StatusCode)
	}
}

func TestHealthServer_IncludesBlockedCards(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	hp := &mockCBProvider{
		mockHP:  mockHP{status: "working", uptime: 60},
		blocked: []valaris.BlockedCardInfo{
			{CardID: "card-abc", FailCount: 3, ReworkCount: 0, LastFailAt: "2026-04-15T12:00:00Z", CooldownRemaining: "45m0s"},
		},
	}
	addr, err := StartHealthServer(ctx, 0, "", hp, nil)
	if err != nil {
		t.Fatalf("start health server: %v", err)
	}

	resp, err := http.Get("http://" + addr + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200", resp.StatusCode)
	}

	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}

	blockedRaw, ok := body["blocked_cards"]
	if !ok {
		t.Fatal("response missing blocked_cards field")
	}

	blocked, ok := blockedRaw.([]any)
	if !ok {
		t.Fatalf("blocked_cards is not an array: %T", blockedRaw)
	}
	if len(blocked) != 1 {
		t.Fatalf("expected 1 blocked card, got %d", len(blocked))
	}

	card := blocked[0].(map[string]any)
	if card["card_id"] != "card-abc" {
		t.Errorf("card_id = %q, want card-abc", card["card_id"])
	}
	if int(card["fail_count"].(float64)) != 3 {
		t.Errorf("fail_count = %v, want 3", card["fail_count"])
	}
}

func TestHealthServer_OmitsBlockedCardsWhenEmpty(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	hp := &mockCBProvider{
		mockHP:  mockHP{status: "idle", uptime: 10},
		blocked: nil,
	}
	addr, err := StartHealthServer(ctx, 0, "", hp, nil)
	if err != nil {
		t.Fatalf("start health server: %v", err)
	}

	resp, err := http.Get("http://" + addr + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer resp.Body.Close()

	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}

	if _, ok := body["blocked_cards"]; ok {
		t.Error("response should not include blocked_cards when empty")
	}
}

func TestHealthServer_NoBlockedCardsWithoutCBProvider(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Plain mockHP does not implement CircuitBreakerProvider.
	hp := &mockHP{status: "idle", uptime: 5}
	addr, err := StartHealthServer(ctx, 0, "", hp, nil)
	if err != nil {
		t.Fatalf("start health server: %v", err)
	}

	resp, err := http.Get("http://" + addr + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer resp.Body.Close()

	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode body: %v", err)
	}

	if _, ok := body["blocked_cards"]; ok {
		t.Error("response should not include blocked_cards when provider doesn't implement CircuitBreakerProvider")
	}
}
