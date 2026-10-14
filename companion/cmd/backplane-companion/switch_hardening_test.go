// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/agent"
	"github.com/Valaris-Studio/backplane/companion/internal/control"
	"github.com/Valaris-Studio/backplane/companion/internal/credentials"
	"github.com/Valaris-Studio/backplane/companion/internal/inbox"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
	"github.com/Valaris-Studio/backplane/companion/internal/uplinktest"
)

// stall holds every request to path on server until the test releases it
// (or the client gives up), like a server that accepts and never answers.
func stall(t *testing.T, server *uplinktest.Server, path string) (release func()) {
	t.Helper()
	gate := make(chan struct{})
	server.Lock()
	server.Stall[path] = gate
	server.Unlock()
	released := false
	release = func() {
		if !released {
			released = true
			close(gate)
		}
	}
	t.Cleanup(release)
	return release
}

func pollCode(t *testing.T, d *pairingDaemon, id string) (int, string) {
	t.Helper()
	status, body := d.call(t, "GET", "/v1/pair/"+id, "")
	if status == http.StatusOK {
		return status, string(body)
	}
	return status, envelopeCode(t, body)
}

// Finding 1: once the code is approved, the switch is storing the
// connection; a cancel then must be refused (not answered "cancelled" while
// the device switches anyway), and the outcome must still be reported.
func TestRun_ACancelAfterApprovalIsRefusedAndTheSwitchStillReportsItsOutcome(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	old := installationID(t, h)
	layout, _ := h.app.layout()
	queueCapturedRecord(t, layout)
	release := stall(t, h.server, "/api/companion/ingest")
	other := uplinktest.New(t)
	other.Lock()
	other.PairingAnswers = []string{"authorization_pending", "granted"}
	other.Unlock()
	daemon := startPairingDaemon(t, h)
	id := daemon.startReplacePairing(t, other)
	waitFor(t, "the approved switch to report persisting", func() bool {
		status, code := pollCode(t, daemon, id)
		return status == http.StatusAccepted && code == control.CodePairingPersisting
	})
	daemon.events.waitFor(t, id, "pending", "persisting")
	status, body := daemon.call(t, "DELETE", "/v1/pair/"+id, "")
	if status != http.StatusConflict || envelopeCode(t, body) != control.CodePairingPersisting {
		t.Fatalf("cancel while the switch persists: %d %s", status, body)
	}
	if status, body := daemon.call(t, "POST", "/v1/pair/start", `{"endpoint":"`+other.URL+`","replace":true}`); status != http.StatusConflict {
		t.Fatalf("a new pairing while the switch persists: %d %s", status, body)
	}
	release()
	status, settled := daemon.pollUntilSettled(t, id)
	if status != http.StatusOK || !strings.Contains(string(settled), `"old_server_revoked":true`) {
		t.Fatalf("settled switch after a refused cancel: %d %s", status, settled)
	}
	if now := installationID(t, h); now == old {
		t.Fatal("the approved switch did not finish")
	}
}

// A server that accepts connections and never answers must not hold the
// switch (and capture) beyond the flush and revoke bounds.
func TestSwitch_ABlackHoledOldServerIsBoundedByTheFlushAndRevokeTimeouts(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	layout, _ := h.app.layout()
	queueCapturedRecord(t, layout)
	stall(t, h.server, "/api/companion/ingest")
	stall(t, h.server, "/api/companion/installation")
	h.app.switchFlushTimeout = 200 * time.Millisecond
	h.app.switchRevokeTimeout = 200 * time.Millisecond
	other := otherServer(t, map[string]string{switchedInstallationID: switchedGrantToken})
	outcome := &switchOutcome{}
	started := time.Now()
	err := h.app.persistSwitch(layout, "", h.app.now().UTC(), outcome)(context.Background(), switchGrant(other, switchedInstallationID, switchedGrantToken))
	if err != nil {
		t.Fatalf("switch from a black-holed server: %v", err)
	}
	if elapsed := time.Since(started); elapsed > 3*time.Second {
		t.Fatalf("switch took %v with 200 ms bounds", elapsed)
	}
	if revoked := outcome.oldServerRevoked(); revoked == nil || *revoked {
		t.Fatalf("old_server_revoked = %v, want false", revoked)
	}
	if id := installationID(t, h); id != switchedInstallationID {
		t.Fatalf("installation after switch: %q", id)
	}
}

func TestSwitch_TheDefaultBoundsStayShortOfThePersistTimeout(t *testing.T) {
	var a app
	if total := a.flushTimeout() + a.revokeTimeout(); total != 25*time.Second {
		t.Fatalf("flush + revoke = %v", total)
	}
}

// Finding 2: the marker that names the old connection stands from before
// adoption until retirement finished.
func TestSwitch_TheRetirementMarkerStandsWhileAdoptingAndIsGoneAfter(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	old := installationID(t, h)
	layout, _ := h.app.layout()
	other := otherServer(t, map[string]string{switchedInstallationID: switchedGrantToken})
	release := stall(t, other, "/api/companion/policy")
	done := make(chan error, 1)
	go func() {
		done <- h.app.persistSwitch(layout, "", h.app.now().UTC(), &switchOutcome{})(context.Background(), switchGrant(other, switchedInstallationID, switchedGrantToken))
	}()
	waitFor(t, "adoption to write the new installation", func() bool { return installationID(t, h) == switchedInstallationID })
	marker, err := state.Load[retiringConnectionMarker](layout.Retiring())
	if err != nil || marker.InstallationID != old || marker.Endpoint != h.server.URL || !marker.AllowLoopbackHTTP {
		t.Fatalf("marker during adoption: %+v %v", marker, err)
	}
	release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(layout.Retiring()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the marker outlived retirement: %v", err)
	}
}

func TestSwitch_AFailedAdoptionKeepsTheOldConnectionAndDropsTheMarker(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	old := installationID(t, h)
	layout, _ := h.app.layout()
	other := otherServer(t, map[string]string{switchedInstallationID: switchedGrantToken})
	// Adoption purges the old captured state first; a policy.json it cannot
	// remove fails it there.
	if err := os.Remove(layout.Policy()); err != nil {
		t.Fatal(err)
	}
	mustMkdir(t, layout.Policy()+"/blocked")
	err := h.app.persistSwitch(layout, "", h.app.now().UTC(), &switchOutcome{})(context.Background(), switchGrant(other, switchedInstallationID, switchedGrantToken))
	if err == nil {
		t.Fatal("adoption past an unremovable policy.json succeeded")
	}
	if id := installationID(t, h); id != old {
		t.Fatalf("a failed switch changed the installation to %q", id)
	}
	if _, err := sharedKeyring().Load(old); err != nil {
		t.Fatalf("a failed switch dropped the current token: %v", err)
	}
	h.server.Lock()
	revoked := h.server.Revoked[old]
	h.server.Unlock()
	if revoked {
		t.Fatal("a failed switch revoked the current installation")
	}
	if _, err := os.Stat(layout.Retiring()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a failed switch left the marker: %v", err)
	}
}

// crashAfterAdoption leaves the device as a kill between adoption and
// retirement would: the new installation is current, the marker names the
// old one, whose device token and agents key are still in the keyring.
func crashAfterAdoption(t *testing.T, h *harness, other *uplinktest.Server) (store.Layout, string) {
	t.Helper()
	h.connect(t)
	old := installationID(t, h)
	layout, _ := h.app.layout()
	keyring := sharedKeyring()
	if err := keyring.Save(credentials.AgentKeyAccount(old), agentKeyFixture); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteJSON(layout.Retiring(), retiringConnectionMarker{InstallationID: old, Endpoint: h.server.URL, AllowLoopbackHTTP: true}); err != nil {
		t.Fatal(err)
	}
	if err := keyring.Save(switchedInstallationID, switchedGrantToken); err != nil {
		t.Fatal(err)
	}
	if err := store.WriteJSON(layout.Installation(), state.Installation{ID: switchedInstallationID, Endpoint: other.URL, AllowLoopbackHTTP: true, ConnectedAt: time.Now().UTC()}); err != nil {
		t.Fatal(err)
	}
	return layout, old
}

func assertRetired(t *testing.T, h *harness, layout store.Layout, old string) {
	t.Helper()
	for _, account := range []string{old, credentials.AgentKeyAccount(old)} {
		if _, err := sharedKeyring().Load(account); !errors.Is(err, credentials.ErrNotFound) {
			t.Fatalf("keyring still holds %s: %v", account, err)
		}
	}
	h.server.Lock()
	revoked := h.server.Revoked[old]
	h.server.Unlock()
	if !revoked {
		t.Fatal("the old installation stayed active on its server")
	}
	if _, err := os.Stat(layout.Retiring()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the marker outlived retirement: %v", err)
	}
	if token, err := sharedKeyring().Load(switchedInstallationID); err != nil || token != switchedGrantToken {
		t.Fatalf("finishing retirement touched the new connection: %v", err)
	}
}

func TestSwitch_ACrashAfterAdoptionIsRetiredByTheNextConnect(t *testing.T) {
	h := pairingHarness(t)
	other := otherServer(t, map[string]string{switchedInstallationID: switchedGrantToken})
	layout, old := crashAfterAdoption(t, h, other)
	if err := h.app.finishRetirement(context.Background(), layout); err != nil {
		t.Fatal(err)
	}
	assertRetired(t, h, layout, old)
}

func TestSwitch_ACrashAfterAdoptionIsRetiredWhenTheNextSessionStarts(t *testing.T) {
	h := pairingHarness(t)
	other := otherServer(t, map[string]string{switchedInstallationID: switchedGrantToken})
	layout, old := crashAfterAdoption(t, h, other)
	h.env[envAllowInsecureLoopback] = "1"
	h.env[envBeaconArtifact] = fakeBeaconManifest(t, h.root)
	_, stop := h.startDaemon(t)
	defer stop()
	waitFor(t, "the session to finish the interrupted retirement", func() bool {
		_, err := os.Stat(layout.Retiring())
		return errors.Is(err, os.ErrNotExist)
	})
	assertRetired(t, h, layout, old)
}

func TestSwitch_ACrashBeforeAdoptionKeepsTheCurrentConnection(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	current := installationID(t, h)
	layout, _ := h.app.layout()
	if err := store.WriteJSON(layout.Retiring(), retiringConnectionMarker{InstallationID: current, Endpoint: h.server.URL, AllowLoopbackHTTP: true}); err != nil {
		t.Fatal(err)
	}
	if err := h.app.finishRetirement(context.Background(), layout); err != nil {
		t.Fatal(err)
	}
	if _, err := sharedKeyring().Load(current); err != nil {
		t.Fatalf("a marker for the current connection retired it: %v", err)
	}
	h.server.Lock()
	revocations := h.server.Revocations
	h.server.Unlock()
	if revocations != 0 {
		t.Fatal("a marker for the current connection revoked it")
	}
	if _, err := os.Stat(layout.Retiring()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a stale marker survived: %v", err)
	}
}

// Finding 5: a hook that read the old policy can land its item after
// adoption already purged the inbox, stamped while the old queue flushed. It
// belongs to the old connection: ConnectedAt is stamped after the flush, so
// the item predates it and must not survive the switch.
func TestSwitch_AHookItemLandingAfterAdoptionWithAFlushTimeStampIsDropped(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	layout, _ := h.app.layout()
	queueCapturedRecord(t, layout)
	var flushedAt time.Time
	h.server.Lock()
	h.server.Respond = func(ids []string) (int, any) {
		flushedAt = time.Now().UTC()
		return http.StatusOK, map[string]any{"acknowledged": ids, "rejected": []any{}}
	}
	h.server.Unlock()
	other := otherServer(t, map[string]string{switchedInstallationID: switchedGrantToken})
	// Adoption purges the inbox, then caches the new policy: holding that
	// request is a moment after adoption's purge.
	release := stall(t, other, "/api/companion/policy")
	done := make(chan error, 1)
	go func() {
		done <- h.app.persistSwitch(layout, "", h.app.now().UTC(), &switchOutcome{})(context.Background(), switchGrant(other, switchedInstallationID, switchedGrantToken))
	}()
	waitFor(t, "adoption to write the new installation", func() bool { return installationID(t, h) == switchedInstallationID })
	h.server.Lock()
	stamp := flushedAt
	h.server.Unlock()
	if stamp.IsZero() {
		t.Fatal("the old queue was not flushed before adoption")
	}
	item := inbox.Item{Agent: "claude_code", Observation: agent.Observation{NativeSessionID: "s-flush", Cwd: h.repo, Event: "stop"}, ReceivedAt: stamp, Payload: map[string]any{}}
	if err := inbox.Write(layout.InboxDir(), item); err != nil {
		t.Fatal(err)
	}
	release()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	installation, _ := state.Load[state.Installation](layout.Installation())
	// With ConnectedAt stamped before the flush this item would postdate it
	// and be kept; stamped after, it predates the new connection.
	if !installation.ConnectedAt.After(stamp) {
		t.Fatalf("ConnectedAt %v does not follow the flush at %v", installation.ConnectedAt, stamp)
	}
	names, err := inbox.List(layout.InboxDir())
	if err != nil || len(names) != 0 {
		t.Fatalf("a hook item from the flush survived the switch: %v %v", names, err)
	}
}

// A marker that cannot be read would otherwise fail every later session and
// connect; it is set aside once, keeping it for diagnosis.
func TestSwitch_ACorruptRetirementMarkerIsQuarantined(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	layout, _ := h.app.layout()
	mustWrite(t, layout.Retiring(), "{not json")
	if err := h.app.finishRetirement(context.Background(), layout); err != nil {
		t.Fatalf("a corrupt marker must not fail retirement: %v", err)
	}
	if _, err := os.Stat(layout.Retiring()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the corrupt marker stayed in place: %v", err)
	}
	quarantined, _ := filepath.Glob(layout.Retiring() + ".corrupt-*")
	if len(quarantined) != 1 {
		t.Fatalf("quarantined markers: %v", quarantined)
	}
	if err := h.app.finishRetirement(context.Background(), layout); err != nil {
		t.Fatalf("after quarantine: %v", err)
	}
	if _, err := sharedKeyring().Load(installationID(t, h)); err != nil {
		t.Fatalf("a corrupt marker retired the current connection: %v", err)
	}
}

// Finding 5a: signing out from the CLI must not leave the daemon's switch
// code approvable, and must wait for a switch that is already persisting.
func TestCLIDisconnect_CancelsADaemonSwitchCodeStillWaiting(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	other := uplinktest.New(t)
	other.Lock()
	other.PairingAnswers = []string{"authorization_pending"}
	other.Unlock()
	daemon := startPairingDaemon(t, h)
	id := daemon.startReplacePairing(t, other)
	if _, err := h.cli(t, "disconnect"); err != nil {
		t.Fatalf("disconnect: %v", err)
	}
	if status, _ := daemon.call(t, "GET", "/v1/pair/"+id, ""); status != http.StatusNotFound {
		t.Fatalf("the switch code is still pending after sign-out: %d", status)
	}
}

func TestCLIDisconnect_IsRefusedWhileASwitchPersists(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	old := installationID(t, h)
	layout, _ := h.app.layout()
	queueCapturedRecord(t, layout)
	release := stall(t, h.server, "/api/companion/ingest")
	other := uplinktest.New(t)
	other.Lock()
	other.PairingAnswers = []string{"authorization_pending", "granted"}
	other.Unlock()
	daemon := startPairingDaemon(t, h)
	id := daemon.startReplacePairing(t, other)
	waitFor(t, "the approved switch to report persisting", func() bool {
		status, code := pollCode(t, daemon, id)
		return status == http.StatusAccepted && code == control.CodePairingPersisting
	})
	if _, err := h.cli(t, "disconnect"); !errors.Is(err, errSwitchInProgress) {
		t.Fatalf("disconnect while a switch persists: %v", err)
	}
	if id := installationID(t, h); id != old {
		t.Fatalf("a refused sign-out changed the installation to %q", id)
	}
	// The switch must finish inside this test: its persist writes the shared
	// mock keyring, which the next test resets.
	release()
	if status, body := daemon.pollUntilSettled(t, id); status != http.StatusOK {
		t.Fatalf("the switch did not settle: %d %s", status, body)
	}
}

// A daemon can stop without its context ending (a capture session that
// failed): a switch code still waiting for approval must not hold that
// shutdown until the code expires. It is cancelled; only a persisting one is
// waited for.
func TestDaemonPairer_IdleCancelsACodeStillWaitingForApproval(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	h.env[envAllowInsecureLoopback] = "1"
	// Codes last 600 server seconds: 6 s here, far beyond the bound below.
	h.app.pairingIntervalUnit = 10 * time.Millisecond
	layout, _ := h.app.layout()
	other := uplinktest.New(t)
	other.Lock()
	other.PairingAnswers = []string{"authorization_pending"}
	other.Unlock()
	pairer := h.app.newDaemonPairer(context.Background(), layout)
	started, err := pairer.Start(context.Background(), other.URL, "", true)
	if err != nil {
		t.Fatal(err)
	}
	returned := make(chan struct{})
	go func() {
		pairer.idle()
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("shutdown waited for a switch code nobody approved")
	}
	if current, err := pairer.Poll(context.Background(), started.ID); err == nil && current.State == control.PairPending {
		t.Fatalf("the waiting code is still pending after shutdown: %+v", current)
	}
	other.Lock()
	polls := other.PairingPolls
	other.Unlock()
	time.Sleep(100 * time.Millisecond)
	other.Lock()
	defer other.Unlock()
	if other.PairingPolls != polls {
		t.Fatal("the cancelled code kept polling the server")
	}
}

// Stopping the daemon while an approved switch persists waits for it: the
// token exists nowhere else, and a persist outliving the daemon would write
// the keyring and data dir with nobody left to report it.
func TestRun_ShutdownWaitsForAnApprovedSwitchToFinishPersisting(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	old := installationID(t, h)
	layout, _ := h.app.layout()
	queueCapturedRecord(t, layout)
	release := stall(t, h.server, "/api/companion/ingest")
	other := uplinktest.New(t)
	other.Lock()
	other.PairingAnswers = []string{"authorization_pending", "granted"}
	other.Unlock()
	h.env[envAllowInsecureLoopback] = "1"
	h.env[envBeaconArtifact] = fakeBeaconManifest(t, h.root)
	delete(h.env, envAPIKey)
	h.app.connectPollInterval = time.Hour
	h.app.pairingIntervalUnit = time.Millisecond
	cancel, done := h.runDaemonAsync(t, "--log", filepath.Join(h.root, "companion.log"))
	waitFor(t, "the control API", func() bool {
		_, err := os.Stat(filepath.Join(h.data, "control.json"))
		return err == nil
	})
	daemon := &pairingDaemon{h: h, data: h.data, client: socketHTTPClient(h.data)}
	id := daemon.startReplacePairing(t, other)
	waitFor(t, "the approved switch to report persisting", func() bool {
		status, code := pollCode(t, daemon, id)
		return status == http.StatusAccepted && code == control.CodePairingPersisting
	})
	cancel()
	select {
	case err := <-done:
		t.Fatalf("the daemon stopped (%v) while a switch was still persisting", err)
	case <-time.After(300 * time.Millisecond):
	}
	release()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("daemon: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the daemon did not stop once the switch finished")
	}
	if now := installationID(t, h); now == old {
		t.Fatal("the switch the daemon waited for did not finish")
	}
}

// Finding 5b: a replace onto the same Backplane would retire an
// installation whose agent access the recovery cannot tell from the new
// one's; the daemon refuses it whichever address names that server.
func TestRun_AReplaceOntoTheSameServerIsRefused(t *testing.T) {
	h := pairingHarness(t)
	h.connect(t)
	h.server.Lock()
	h.server.WebOrigin = "https://app.backplane.example.test"
	h.server.Unlock()
	daemon := startPairingDaemon(t, h)
	for _, endpoint := range []string{h.server.URL + "/", "https://app.backplane.example.test", "https://APP.backplane.example.test:443/"} {
		status, body := daemon.call(t, "POST", "/v1/pair/start", `{"endpoint":"`+endpoint+`","replace":true}`)
		if status != http.StatusConflict || envelopeCode(t, body) != control.CodeSameServer {
			t.Fatalf("replace onto %s: %d %s", endpoint, status, body)
		}
	}
	h.server.Lock()
	defer h.server.Unlock()
	if len(h.server.PairingStarts) != 0 {
		t.Fatal("a same-server replace reached the server")
	}
}

// Finding 7.
func TestSameServer_TreatsExplicitDefaultPortsAsTheSameServer(t *testing.T) {
	for _, pair := range [][2]string{
		{"https://bp.example.dev", "https://BP.example.dev:443/"},
		{"http://127.0.0.1", "http://127.0.0.1:80"},
		{"https://bp.example.dev/base/", "https://bp.example.dev:443/base"},
	} {
		if !sameServer(pair[0], pair[1]) {
			t.Errorf("%s and %s are the same server", pair[0], pair[1])
		}
	}
	for _, pair := range [][2]string{
		{"https://bp.example.dev", "https://bp.example.dev:8443"},
		{"https://bp.example.dev", "http://bp.example.dev"},
		{"https://bp.example.dev", "https://other.example.dev"},
	} {
		if sameServer(pair[0], pair[1]) {
			t.Errorf("%s and %s are different servers", pair[0], pair[1])
		}
	}
}

// The --server check reads the connection under the session lock, so the
// session ends either way and a refused sign-out leaves everything standing.
func TestDisconnect_ServerMismatchUnderTheSessionLockChangesNothing(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	old := installationID(t, h)
	if _, err := h.app.disconnectDevice(context.Background(), "https://elsewhere.example"); !errors.Is(err, errUsage) {
		t.Fatalf("mismatch: %v", err)
	}
	layout, _ := h.app.layout()
	if _, err := os.Stat(layout.DisconnectRequest()); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("a refused sign-out left the disconnect request behind")
	}
	if id := installationID(t, h); id != old || !h.status(t).Connected {
		t.Fatal("a refused sign-out changed the connection")
	}
}
