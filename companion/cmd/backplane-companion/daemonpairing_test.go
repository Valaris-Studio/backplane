// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/control"
	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/pairing"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

// pairingDaemon is a daemon waiting for a connection, reached only through
// its control socket, as the desktop app reaches it.
type pairingDaemon struct {
	h       *harness
	data    string
	logPath string
	client  *http.Client
	events  *pairingEvents
}

// pairingHarness keeps the data directory short enough for the control
// socket and shares the keyring with the daemon; connect may run before
// startPairingDaemon.
func pairingHarness(t *testing.T) *harness {
	t.Helper()
	h := newHarness(t)
	h.data = shortDataDir(t)
	h.env[store.EnvHome] = h.data
	h.app.keyring = sharedKeyring()
	return h
}

// startPairingDaemon runs the daemon as the desktop app reaches it. Its
// connection poll is an hour, so a session that starts after pairing proves
// the pairing woke it rather than a poll or a restart.
func startPairingDaemon(t *testing.T, h *harness, answers ...string) *pairingDaemon {
	t.Helper()
	h.env[envAllowInsecureLoopback] = "1"
	h.env[envBeaconArtifact] = fakeBeaconManifest(t, h.root)
	delete(h.env, envAPIKey)
	h.app.connectPollInterval = time.Hour
	h.app.pairingIntervalUnit = time.Millisecond
	h.server.Lock()
	h.server.PairingAnswers = answers
	h.server.Unlock()
	logPath := filepath.Join(h.root, "companion.log")
	cancel, done := h.runDaemonAsync(t, "--log", logPath)
	t.Cleanup(func() {
		cancel()
		if err := <-done; err != nil {
			t.Errorf("daemon: %v", err)
		}
	})
	waitFor(t, "the control API", func() bool {
		_, err := os.Stat(filepath.Join(h.data, "control.json"))
		return err == nil
	})
	return &pairingDaemon{h: h, data: h.data, logPath: logPath, client: socketHTTPClient(h.data), events: subscribePairingEvents(t, h.data)}
}

func (d *pairingDaemon) call(t *testing.T, method, path, body string) (int, []byte) {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request, _ := http.NewRequest(method, "http://companion"+path, reader)
	reply, err := d.client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer reply.Body.Close()
	data, _ := io.ReadAll(reply.Body)
	return reply.StatusCode, data
}

func (d *pairingDaemon) start(t *testing.T) string {
	t.Helper()
	status, body := d.call(t, "POST", "/v1/pair/start", `{"endpoint":"`+d.h.server.URL+`"}`)
	if status != http.StatusOK {
		t.Fatalf("pair/start: %d %s", status, body)
	}
	var started struct {
		ID       string `json:"pairing_id"`
		UserCode string `json:"user_code"`
	}
	if json.Unmarshal(body, &started) != nil || started.ID == "" || started.UserCode != "BCDF-GHJK" {
		t.Fatalf("pair/start answered %s", body)
	}
	return started.ID
}

// pollUntilSettled polls as the desktop app does, until the pairing leaves
// pending, and returns the last answer.
func (d *pairingDaemon) pollUntilSettled(t *testing.T, id string) (int, []byte) {
	t.Helper()
	var status int
	var body []byte
	waitFor(t, "the pairing to settle", func() bool {
		status, body = d.call(t, "GET", "/v1/pair/"+id, "")
		return status != http.StatusAccepted
	})
	return status, body
}

type pairingEvents struct {
	mu     sync.Mutex
	states map[string][]string
}

// subscribePairingEvents records the pairing events of the SSE stream.
func subscribePairingEvents(t *testing.T, data string) *pairingEvents {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	streaming := &http.Client{Transport: &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return control.Dial(ctx, data) },
	}}
	request, _ := http.NewRequestWithContext(ctx, "GET", "http://companion/v1/events", nil)
	reply, err := streaming.Do(request)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	events := &pairingEvents{states: map[string][]string{}}
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		defer reply.Body.Close()
		scanner := bufio.NewScanner(reply.Body)
		eventType := ""
		for scanner.Scan() {
			line := scanner.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				eventType = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: ") && eventType == "pairing":
				var event struct {
					ID    string `json:"pairing_id"`
					State string `json:"state"`
				}
				json.Unmarshal([]byte(strings.TrimPrefix(line, "data: ")), &event)
				events.mu.Lock()
				events.states[event.ID] = append(events.states[event.ID], event.State)
				events.mu.Unlock()
			}
		}
	}()
	t.Cleanup(func() {
		cancel()
		<-finished
	})
	return events
}

func (e *pairingEvents) waitFor(t *testing.T, id string, want ...string) {
	t.Helper()
	waitFor(t, "pairing events "+strings.Join(want, ","), func() bool {
		e.mu.Lock()
		defer e.mu.Unlock()
		return strings.Join(e.states[id], ",") == strings.Join(want, ",")
	})
}

type daemonConnection struct {
	Connected      bool   `json:"connected"`
	InstallationID string `json:"installation_id"`
}

func (d *pairingDaemon) status(t *testing.T) daemonConnection {
	t.Helper()
	_, body := d.call(t, "GET", "/v1/status", "")
	var status daemonConnection
	json.Unmarshal(body, &status)
	return status
}

func TestRun_PairsThroughTheControlAPIAndCapturesWithoutARestart(t *testing.T) {
	h := pairingHarness(t)
	daemon := startPairingDaemon(t, h, "authorization_pending", "authorization_pending", "granted")
	waitForLog(t, daemon.logPath, "not_connected")
	id := daemon.start(t)
	status, body := daemon.pollUntilSettled(t, id)
	if status != http.StatusOK || !strings.Contains(string(body), `"installation_id":"`+uplinktest.PairedInstallationID+`"`) {
		t.Fatalf("settled poll: %d %s", status, body)
	}
	daemon.events.waitFor(t, id, "pending", "persisting", "connected")
	if token, err := sharedKeyring().Load(uplinktest.PairedInstallationID); err != nil || token != uplinktest.DeviceToken {
		t.Fatalf("the paired token is not in the keyring: %v", err)
	}
	// The same persistence as connect --browser: the CLI sees the connection.
	if report := h.lifecycleStatus(t); !report.Connected {
		t.Fatalf("CLI status after pairing through the daemon: %+v", report)
	}
	waitForLog(t, daemon.logPath, "started")
	waitFor(t, "a heartbeat under the paired installation", func() bool {
		h.server.Lock()
		defer h.server.Unlock()
		return len(h.server.Heartbeats) > 0
	})
	if got := daemon.status(t); !got.Connected || got.InstallationID != uplinktest.PairedInstallationID {
		t.Fatalf("API status after pairing: %+v", got)
	}
}

func TestRun_PairingDeniedThroughTheControlAPIConnectsNothing(t *testing.T) {
	h := pairingHarness(t)
	daemon := startPairingDaemon(t, h, "authorization_pending", "access_denied")
	id := daemon.start(t)
	status, body := daemon.pollUntilSettled(t, id)
	if status != http.StatusForbidden || envelopeCode(t, body) != "pairing_denied" {
		t.Fatalf("denied poll: %d %s", status, body)
	}
	daemon.events.waitFor(t, id, "pending", "denied")
	assertNothingPaired(t, daemon)
}

func TestRun_PairingExpiredThroughTheControlAPIConnectsNothing(t *testing.T) {
	h := pairingHarness(t)
	daemon := startPairingDaemon(t, h, "expired_token")
	id := daemon.start(t)
	status, body := daemon.pollUntilSettled(t, id)
	if status != http.StatusGone || envelopeCode(t, body) != "pairing_expired" {
		t.Fatalf("expired poll: %d %s", status, body)
	}
	daemon.events.waitFor(t, id, "pending", "expired")
	assertNothingPaired(t, daemon)
}

func TestRun_PairingFailureThroughTheControlAPIIsReported(t *testing.T) {
	h := pairingHarness(t)
	daemon := startPairingDaemon(t, h, "granted")
	// The grant cannot be stored, the last step pairing can fail at.
	mustMkdir(t, filepath.Join(daemon.data, "installation.json", "blocked"))
	id := daemon.start(t)
	status, body := daemon.pollUntilSettled(t, id)
	if status != http.StatusUnprocessableEntity || envelopeCode(t, body) != "pairing_failed" {
		t.Fatalf("failed poll: %d %s", status, body)
	}
	daemon.events.waitFor(t, id, "pending", "persisting", "failed")
	if _, err := sharedKeyring().Load(uplinktest.PairedInstallationID); !errors.Is(err, credentials.ErrNotFound) {
		t.Fatalf("a failed pairing left a keyring entry: %v", err)
	}
}

func TestRun_PairingCancelledThroughTheControlAPIStopsPolling(t *testing.T) {
	h := pairingHarness(t)
	daemon := startPairingDaemon(t, h, "authorization_pending")
	id := daemon.start(t)
	waitFor(t, "the first pairing poll", func() bool {
		h.server.Lock()
		defer h.server.Unlock()
		return h.server.PairingPolls > 0
	})
	if status, body := daemon.call(t, "DELETE", "/v1/pair/"+id, ""); status != http.StatusOK || !strings.Contains(string(body), `"cancelled":true`) {
		t.Fatalf("cancel: %d %s", status, body)
	}
	if status, body := daemon.call(t, "GET", "/v1/pair/"+id, ""); status != http.StatusNotFound || envelopeCode(t, body) != control.CodeNotFound {
		t.Fatalf("poll after cancel: %d %s", status, body)
	}
	if status, _ := daemon.call(t, "DELETE", "/v1/pair/"+id, ""); status != http.StatusNotFound {
		t.Fatalf("cancelling twice: %d", status)
	}
	h.server.Lock()
	polls := h.server.PairingPolls
	h.server.Unlock()
	time.Sleep(50 * time.Millisecond)
	h.server.Lock()
	defer h.server.Unlock()
	if h.server.PairingPolls != polls {
		t.Fatal("a cancelled pairing kept polling the server")
	}
}

func TestRun_CurrentPairingIsTheOnePendingUntilItSettlesOrIsCancelled(t *testing.T) {
	h := pairingHarness(t)
	daemon := startPairingDaemon(t, h, "authorization_pending")
	if status, _ := daemon.call(t, "GET", "/v1/pair", ""); status != http.StatusNotFound {
		t.Fatalf("no pairing yet: %d", status)
	}
	id := daemon.start(t)
	status, body := daemon.call(t, "GET", "/v1/pair", "")
	var current struct {
		ID                      string `json:"pairing_id"`
		UserCode                string `json:"user_code"`
		VerificationURIComplete string `json:"verification_uri_complete"`
		ExpiresAt               string `json:"expires_at"`
	}
	if status != http.StatusOK || json.Unmarshal(body, &current) != nil || current.ID != id || current.UserCode != "BCDF-GHJK" || current.VerificationURIComplete == "" || current.ExpiresAt == "" {
		t.Fatalf("current pairing: %d %s", status, body)
	}
	daemon.call(t, "DELETE", "/v1/pair/"+id, "")
	if status, _ := daemon.call(t, "GET", "/v1/pair", ""); status != http.StatusNotFound {
		t.Fatalf("a cancelled pairing is not current: %d", status)
	}
}

func TestRun_AnEndpointNamingAForeignApprovalPageFailsThePairing(t *testing.T) {
	h := pairingHarness(t)
	daemon := startPairingDaemon(t, h)
	attacker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"device_code": "dc_synthetic", "user_code": "BCDF-GHJK",
			"verification_uri":          "https://evil.example/companion/pair",
			"verification_uri_complete": "https://evil.example/companion/pair#code=BCDF-GHJK",
			"interval":                  5, "expires_in": 600,
		})
	}))
	t.Cleanup(attacker.Close)
	status, body := daemon.call(t, "POST", "/v1/pair/start", `{"endpoint":"`+attacker.URL+`"}`)
	if status != http.StatusUnprocessableEntity || envelopeCode(t, body) != "pairing_failed" {
		t.Fatalf("foreign approval page: %d %s", status, body)
	}
	if status, _ := daemon.call(t, "GET", "/v1/pair", ""); status != http.StatusNotFound {
		t.Fatalf("a refused pairing is never current: %d", status)
	}
}

func TestRun_CurrentPairingEndsWhenThePairingSettles(t *testing.T) {
	h := pairingHarness(t)
	daemon := startPairingDaemon(t, h, "authorization_pending", "access_denied")
	id := daemon.start(t)
	daemon.events.waitFor(t, id, "pending", "denied")
	if status, body := daemon.call(t, "GET", "/v1/pair", ""); status != http.StatusNotFound {
		t.Fatalf("a denied pairing is not current: %d %s", status, body)
	}
}

func TestRun_PairingWhileConnectedIsAlreadyConnected(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	daemon := startPairingDaemon(t, h)
	status, body := daemon.call(t, "POST", "/v1/pair/start", `{"endpoint":"`+h.server.URL+`"}`)
	if status != http.StatusConflict || envelopeCode(t, body) != "already_connected" {
		t.Fatalf("pair/start while connected: %d %s", status, body)
	}
	h.server.Lock()
	defer h.server.Unlock()
	if len(h.server.PairingStarts) != 0 {
		t.Fatal("started a pairing while already connected")
	}
}

func TestRun_PairingReplacesAnInstallationTheServerRevoked(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	first := installationID(t, h)
	h.server.RevokeAll()
	daemon := startPairingDaemon(t, h, "granted")
	waitForLog(t, daemon.logPath, "device_revoked")
	waitFor(t, "the daemon to record the revocation", func() bool { return !daemon.status(t).Connected })
	id := daemon.start(t)
	if status, body := daemon.pollUntilSettled(t, id); status != http.StatusOK {
		t.Fatalf("pairing after a revoke: %d %s", status, body)
	}
	if second := installationID(t, h); second != uplinktest.PairedInstallationID || second == first {
		t.Fatalf("installation after pairing: %q (was %q)", second, first)
	}
	if _, err := sharedKeyring().Load(first); !errors.Is(err, credentials.ErrNotFound) {
		t.Fatal("the revoked installation's token stayed in the keyring")
	}
	waitFor(t, "a new session under the paired installation", func() bool {
		return linesContaining(logText(daemon.logPath), "started") == 2 && daemon.status(t).Connected
	})
}

func assertNothingPaired(t *testing.T, daemon *pairingDaemon) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(daemon.data, "installation.json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("an unapproved pairing persisted an installation")
	}
	if _, err := sharedKeyring().Load(uplinktest.PairedInstallationID); !errors.Is(err, credentials.ErrNotFound) {
		t.Fatalf("an unapproved pairing left a keyring entry: %v", err)
	}
	if daemon.status(t).Connected {
		t.Fatal("status says connected after an unapproved pairing")
	}
}

// Only one pairing can become this device's connection: two approved codes
// would leave one installation active on the server with nobody holding it.
func TestRun_ANewerPairingSupersedesAnOlderOne(t *testing.T) {
	h := pairingHarness(t)
	daemon := startPairingDaemon(t, h, "authorization_pending")
	older := daemon.start(t)
	newer := daemon.start(t)
	if status, body := daemon.call(t, "GET", "/v1/pair/"+older, ""); status != http.StatusNotFound || envelopeCode(t, body) != control.CodeNotFound {
		t.Fatalf("superseded pairing poll: %d %s", status, body)
	}
	if status, body := daemon.call(t, "GET", "/v1/pair/"+newer, ""); status != http.StatusAccepted {
		t.Fatalf("current pairing poll: %d %s", status, body)
	}
}

// Two codes approved in Backplane can both deliver a token; only one may
// become this device's connection, and the other must not stay active on
// the server with a token nobody holds.
func TestPersistPairing_ConcurrentApprovalsKeepExactlyOneInstallation(t *testing.T) {
	h := pairingHarness(t)
	layout, err := h.app.layout()
	if err != nil {
		t.Fatal(err)
	}
	grants := map[string]string{"a1a1a1a1-0000-4000-8000-00000000000a": "bpc_synthetic_grant_token_a_0123456789", "b2b2b2b2-0000-4000-8000-00000000000b": "bpc_synthetic_grant_token_b_0123456789"}
	h.server.Lock()
	for id, token := range grants {
		h.server.GrantTokens[token] = id
		h.server.Installed[id] = true
	}
	h.server.Unlock()
	startedAt := h.app.now().UTC()
	results := make(chan error, len(grants))
	for id, token := range grants {
		go func() {
			persist := h.app.persistPairing(layout, "", startedAt)
			results <- persist(context.Background(), pairing.Grant{Endpoint: h.server.URL, AllowLoopbackHTTP: true, InstallationID: id, DeviceToken: token})
		}()
	}
	var failures []error
	for range grants {
		if err := <-results; err != nil {
			failures = append(failures, err)
		}
	}
	if len(failures) != 1 || !errors.Is(failures[0], errPairingSuperseded) {
		t.Fatalf("want exactly one superseded grant, got %v", failures)
	}
	winner := installationID(t, h)
	loser := ""
	for id := range grants {
		if id != winner {
			loser = id
		}
	}
	if _, ok := grants[winner]; !ok {
		t.Fatalf("installation.json names %q", winner)
	}
	if token, err := sharedKeyring().Load(winner); err != nil || token != grants[winner] {
		t.Fatalf("the winner's token is not in the keyring: %v", err)
	}
	if _, err := sharedKeyring().Load(loser); !errors.Is(err, credentials.ErrNotFound) {
		t.Fatalf("the superseded grant left a keyring entry: %v", err)
	}
	h.server.Lock()
	loserRevoked, winnerRevoked := h.server.Revoked[loser], h.server.Revoked[winner]
	h.server.Unlock()
	if !loserRevoked || winnerRevoked {
		t.Fatalf("server revocations: loser %v, winner %v", loserRevoked, winnerRevoked)
	}
	if report := h.lifecycleStatus(t); !report.Connected {
		t.Fatalf("status after the race: %+v", report)
	}
}

// A connection made before the pairing started is not a rival: pairing
// replaces it (the server revoked it, or it would have failed preflight).
func TestPersistPairing_ReplacesAConnectionOlderThanThePairing(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	first := installationID(t, h)
	h.server.RevokeAll()
	layout, _ := h.app.layout()
	h.server.Lock()
	h.server.GrantTokens["bpc_synthetic_grant_token_c_0123456789"] = "c3c3c3c3-0000-4000-8000-00000000000c"
	h.server.Unlock()
	persist := h.app.persistPairing(layout, first, h.app.now().UTC())
	if err := persist(context.Background(), pairing.Grant{Endpoint: h.server.URL, AllowLoopbackHTTP: true, InstallationID: "c3c3c3c3-0000-4000-8000-00000000000c", DeviceToken: "bpc_synthetic_grant_token_c_0123456789"}); err != nil {
		t.Fatalf("pairing must replace a revoked connection: %v", err)
	}
	if id := installationID(t, h); id != "c3c3c3c3-0000-4000-8000-00000000000c" {
		t.Fatalf("installation.json names %q", id)
	}
}
