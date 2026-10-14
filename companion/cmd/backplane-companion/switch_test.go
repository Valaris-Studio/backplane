// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/pairing"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/queue"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

const (
	switchedInstallationID = "d4d4d4d4-0000-4000-8000-00000000000d"
	switchedGrantToken     = "bpc_synthetic_grant_token_d_0123456789"
	racingInstallationID   = "e5e5e5e5-0000-4000-8000-00000000000e"
	racingGrantToken       = "bpc_synthetic_grant_token_e_0123456789"
	queuedCaptureID        = "0123456789abcdef0123456789abcdef"
)

// otherServer is the Backplane a switch moves to, ready to honour grantID's
// token as an approved pairing would have issued it.
func otherServer(t *testing.T, grants map[string]string) *uplinktest.Server {
	t.Helper()
	other := uplinktest.New(t)
	other.Lock()
	defer other.Unlock()
	for id, token := range grants {
		other.GrantTokens[token] = id
		other.Installed[id] = true
	}
	return other
}

func queueCapturedRecord(t *testing.T, layout store.Layout) {
	t.Helper()
	if err := queue.Open(layout).Enqueue(queuedCaptureID, []byte(`{"capture_id":"`+queuedCaptureID+`"}`)); err != nil {
		t.Fatal(err)
	}
}

func queuedRecords(t *testing.T, layout store.Layout) int {
	t.Helper()
	stats, err := queue.Open(layout).Stats()
	if err != nil {
		t.Fatal(err)
	}
	return stats.Records
}

func switchGrant(other *uplinktest.Server, id, token string) pairing.Grant {
	return pairing.Grant{Endpoint: other.URL, AllowLoopbackHTTP: true, InstallationID: id, DeviceToken: token}
}

func TestSwitch_GrantFlushesTheOldQueueThenRetiresTheOldConnection(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	old := installationID(t, h)
	layout, _ := h.app.layout()
	queueCapturedRecord(t, layout)
	other := otherServer(t, map[string]string{switchedInstallationID: switchedGrantToken})
	outcome := &switchOutcome{}
	persist := h.app.persistSwitch(layout, "", h.app.now().UTC(), outcome)
	if err := persist(context.Background(), switchGrant(other, switchedInstallationID, switchedGrantToken)); err != nil {
		t.Fatalf("switch: %v", err)
	}
	records := h.server.Records()
	if len(records) != 1 || records[0]["capture_id"] != queuedCaptureID {
		t.Fatalf("the old server must receive what was queued before the switch, got %v", records)
	}
	if got := queuedRecords(t, layout); got != 0 {
		t.Fatalf("%d records left queued for the new server", got)
	}
	installation, _ := state.Load[state.Installation](layout.Installation())
	if installation.ID != switchedInstallationID || installation.Endpoint != other.URL {
		t.Fatalf("installation after switch: %+v", installation)
	}
	if _, err := sharedKeyring().Load(old); !errors.Is(err, credentials.ErrNotFound) {
		t.Fatalf("the old token stayed in the keyring: %v", err)
	}
	if token, err := sharedKeyring().Load(switchedInstallationID); err != nil || token != switchedGrantToken {
		t.Fatalf("the new token is not in the keyring: %v", err)
	}
	h.server.Lock()
	oldRevoked := h.server.Revoked[old]
	h.server.Unlock()
	if !oldRevoked {
		t.Fatal("the old installation was not revoked on its server")
	}
	cached, err := policy.Load(layout.Policy())
	if err != nil || cached.Policy.Installation.ID != switchedInstallationID {
		t.Fatalf("the new server's policy is not cached: %+v %v", cached.Policy.Installation, err)
	}
	if revoked := outcome.oldServerRevoked(); revoked == nil || !*revoked {
		t.Fatalf("old_server_revoked = %v, want true", revoked)
	}
}

func TestSwitch_AnUnreachableOldServerStillSwitchesAndSaysSo(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	old := installationID(t, h)
	layout, _ := h.app.layout()
	queueCapturedRecord(t, layout)
	h.server.Close()
	other := otherServer(t, map[string]string{switchedInstallationID: switchedGrantToken})
	outcome := &switchOutcome{}
	started := time.Now()
	persist := h.app.persistSwitch(layout, "", h.app.now().UTC(), outcome)
	if err := persist(context.Background(), switchGrant(other, switchedInstallationID, switchedGrantToken)); err != nil {
		t.Fatalf("switch with the old server down: %v", err)
	}
	if elapsed := time.Since(started); elapsed > defaultSwitchFlushTimeout {
		t.Fatalf("switch took %v; the flush must stay bounded", elapsed)
	}
	if id := installationID(t, h); id != switchedInstallationID {
		t.Fatalf("installation after switch: %q", id)
	}
	if _, err := sharedKeyring().Load(old); !errors.Is(err, credentials.ErrNotFound) {
		t.Fatalf("the old token stayed in the keyring: %v", err)
	}
	if got := queuedRecords(t, layout); got != 0 {
		t.Fatalf("%d of the old server's records would upload to the new one", got)
	}
	if revoked := outcome.oldServerRevoked(); revoked == nil || *revoked {
		t.Fatalf("old_server_revoked = %v, want false", revoked)
	}
}

// A switch whose code was approved after another connection won keeps that
// connection: nothing is retired, and the late grant is revoked as a
// superseded plain pairing would be.
func TestSwitch_AConnectionMadeWhileTheSwitchWaitedWinsAndIsNotRetired(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	layout, _ := h.app.layout()
	other := otherServer(t, map[string]string{switchedInstallationID: switchedGrantToken, racingInstallationID: racingGrantToken})
	switchStartedAt := h.app.now().UTC()
	time.Sleep(5 * time.Millisecond)
	if err := h.app.persistPairing(layout, "", h.app.now().UTC())(context.Background(), switchGrant(other, racingInstallationID, racingGrantToken)); err != nil {
		t.Fatalf("racing pairing: %v", err)
	}
	outcome := &switchOutcome{}
	err := h.app.persistSwitch(layout, "", switchStartedAt, outcome)(context.Background(), switchGrant(other, switchedInstallationID, switchedGrantToken))
	if !errors.Is(err, errPairingSuperseded) {
		t.Fatalf("a late switch must be superseded, got %v", err)
	}
	if id := installationID(t, h); id != racingInstallationID {
		t.Fatalf("installation after the race: %q", id)
	}
	if token, err := sharedKeyring().Load(racingInstallationID); err != nil || token != racingGrantToken {
		t.Fatalf("the winning connection's token was retired: %v", err)
	}
	if _, err := sharedKeyring().Load(switchedInstallationID); !errors.Is(err, credentials.ErrNotFound) {
		t.Fatalf("the superseded grant left a keyring entry: %v", err)
	}
	other.Lock()
	racingRevoked, switchedRevoked := other.Revoked[racingInstallationID], other.Revoked[switchedInstallationID]
	other.Unlock()
	if racingRevoked || !switchedRevoked {
		t.Fatalf("server revocations: winner %v, superseded %v", racingRevoked, switchedRevoked)
	}
	if outcome.oldServerRevoked() != nil {
		t.Fatal("a superseded switch reported retiring a connection")
	}
}

// startReplacePairing asks the daemon to pair with other while connected.
func (d *pairingDaemon) startReplacePairing(t *testing.T, other *uplinktest.Server) string {
	t.Helper()
	status, body := d.call(t, "POST", "/v1/pair/start", `{"endpoint":"`+other.URL+`","replace":true}`)
	if status != http.StatusOK {
		t.Fatalf("pair/start replace: %d %s", status, body)
	}
	var started struct {
		ID string `json:"pairing_id"`
	}
	if json.Unmarshal(body, &started) != nil || started.ID == "" {
		t.Fatalf("pair/start replace answered %s", body)
	}
	return started.ID
}

func assertStillConnectedTo(t *testing.T, h *harness, daemon *pairingDaemon, old string, layout store.Layout) {
	t.Helper()
	if id := installationID(t, h); id != old {
		t.Fatalf("installation changed to %q while the switch was unapproved", id)
	}
	if _, err := sharedKeyring().Load(old); err != nil {
		t.Fatalf("the current token left the keyring: %v", err)
	}
	if got := daemon.status(t); !got.Connected || got.InstallationID != old {
		t.Fatalf("status during an unapproved switch: %+v", got)
	}
	if got := queuedRecords(t, layout); got != 1 {
		t.Fatalf("queue during an unapproved switch: %d records", got)
	}
	h.server.Lock()
	defer h.server.Unlock()
	if h.server.Revocations != 0 {
		t.Fatal("the current installation was revoked before the switch was approved")
	}
}

func TestRun_ASwitchWaitingForApprovalOrCancelledChangesNothing(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	old := installationID(t, h)
	layout, _ := h.app.layout()
	// The old server refuses uploads, so the queued record shows the queue
	// was neither flushed nor purged.
	h.server.Lock()
	h.server.Status["/api/companion/ingest"] = http.StatusServiceUnavailable
	h.server.Unlock()
	queueCapturedRecord(t, layout)
	other := uplinktest.New(t)
	other.Lock()
	other.PairingAnswers = []string{"authorization_pending"}
	other.Unlock()
	daemon := startPairingDaemon(t, h)
	id := daemon.startReplacePairing(t, other)
	waitFor(t, "the new server to be polled", func() bool {
		other.Lock()
		defer other.Unlock()
		return other.PairingPolls > 0
	})
	assertStillConnectedTo(t, h, daemon, old, layout)
	if status, body := daemon.call(t, "DELETE", "/v1/pair/"+id, ""); status != http.StatusOK {
		t.Fatalf("cancel: %d %s", status, body)
	}
	assertStillConnectedTo(t, h, daemon, old, layout)
}

func TestRun_AnApprovedSwitchMovesCaptureToTheNewServerWithoutARestart(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	old := installationID(t, h)
	other := uplinktest.New(t)
	other.Lock()
	other.PairingAnswers = []string{"authorization_pending", "granted"}
	other.Unlock()
	daemon := startPairingDaemon(t, h)
	id := daemon.startReplacePairing(t, other)
	status, body := daemon.pollUntilSettled(t, id)
	if status != http.StatusOK || !strings.Contains(string(body), `"old_server_revoked":true`) || !strings.Contains(string(body), uplinktest.PairedInstallationID) {
		t.Fatalf("settled switch: %d %s", status, body)
	}
	installation, _ := state.Load[state.Installation](store.Layout{Root: h.data}.Installation())
	if installation.ID != uplinktest.PairedInstallationID || installation.Endpoint != other.URL {
		t.Fatalf("installation after switch: %+v", installation)
	}
	if _, err := sharedKeyring().Load(old); !errors.Is(err, credentials.ErrNotFound) {
		t.Fatalf("the old token stayed in the keyring: %v", err)
	}
	h.server.Lock()
	oldRevoked := h.server.Revoked[old]
	h.server.Unlock()
	if !oldRevoked {
		t.Fatal("the old installation was not revoked")
	}
	waitFor(t, "a heartbeat on the new server", func() bool {
		other.Lock()
		defer other.Unlock()
		return len(other.Heartbeats) > 0
	})
}

func TestConnect_WhileConnectedPointsAtReplace(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	err := h.run(t, "connect", "--endpoint", h.server.URL, "--allow-insecure-loopback")
	if !errors.Is(err, errAlreadyConnected) || !strings.Contains(localizedError(err, "en"), "--replace") {
		t.Fatalf("connect while connected: %v", err)
	}
}

func TestConnect_ReplaceSwitchesServersAndRetiresTheOldConnection(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	old := installationID(t, h)
	other := uplinktest.New(t)
	if err := h.run(t, "connect", "--endpoint", other.URL, "--allow-insecure-loopback", "--replace"); err != nil {
		t.Fatalf("connect --replace: %v", err)
	}
	var output struct {
		Connected        bool   `json:"connected"`
		InstallationID   string `json:"installation_id"`
		Endpoint         string `json:"endpoint"`
		OldServerRevoked *bool  `json:"old_server_revoked"`
	}
	if err := json.Unmarshal(h.stdout.Bytes(), &output); err != nil || !output.Connected || output.Endpoint != other.URL || output.InstallationID == old || output.OldServerRevoked == nil || !*output.OldServerRevoked {
		t.Fatalf("connect --replace output: %s", h.stdout)
	}
	if _, err := (credentials.Keyring{}).Load(old); !errors.Is(err, credentials.ErrNotFound) {
		t.Fatalf("the old token stayed in the keyring: %v", err)
	}
	h.server.Lock()
	defer h.server.Unlock()
	if !h.server.Revoked[old] {
		t.Fatal("the old installation was not revoked")
	}
}

func TestDisconnect_ServerMismatchIsAUsageErrorAndChangesNothing(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	old := installationID(t, h)
	if err := h.run(t, "disconnect", "--server", "https://elsewhere.example"); !errors.Is(err, errUsage) {
		t.Fatalf("disconnect --server mismatch: %v", err)
	}
	if id := installationID(t, h); id != old || !h.status(t).Connected {
		t.Fatal("a refused disconnect changed the connection")
	}
	if err := h.run(t, "disconnect", "--server", h.server.URL+"/"); err != nil {
		t.Fatalf("disconnect --server for the current server: %v", err)
	}
	if h.status(t).Connected {
		t.Fatal("still connected after disconnect --server")
	}
}

type connectionsView struct {
	Connections []struct {
		InstallationID string `json:"installation_id"`
		Endpoint       string `json:"endpoint"`
		Connected      bool   `json:"connected"`
		Revoked        bool   `json:"revoked"`
	} `json:"connections"`
}

func (h *harness) connections(t *testing.T) connectionsView {
	t.Helper()
	if err := h.run(t, "status"); err != nil {
		t.Fatal(err)
	}
	var view connectionsView
	var fields map[string]json.RawMessage
	if json.Unmarshal(h.stdout.Bytes(), &fields) != nil || !strings.HasPrefix(string(fields["connections"]), "[") || json.Unmarshal(h.stdout.Bytes(), &view) != nil {
		t.Fatalf("status has no connections array: %s", h.stdout)
	}
	return view
}

func TestStatus_ListsTheOneConnection(t *testing.T) {
	h := newHarness(t)
	if view := h.connections(t); len(view.Connections) != 0 {
		t.Fatalf("connections before connecting: %+v", view)
	}
	h.connect(t)
	view := h.connections(t)
	if len(view.Connections) != 1 {
		t.Fatalf("want exactly one connection, got %+v", view)
	}
	connection := view.Connections[0]
	if connection.InstallationID != installationID(t, h) || connection.Endpoint != h.server.URL || !connection.Connected || connection.Revoked {
		t.Fatalf("connection: %+v", connection)
	}
}
