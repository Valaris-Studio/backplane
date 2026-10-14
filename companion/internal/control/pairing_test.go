// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sync"
	"testing"
	"time"
)

type fakePairer struct {
	mu        sync.Mutex
	started   []string
	states    map[string]PairState
	cancelled []string
	startErr  error
}

func (p *fakePairer) Start(_ context.Context, endpoint, name string, replace bool) (Pairing, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.startErr != nil {
		return Pairing{}, p.startErr
	}
	started := endpoint + "|" + name
	if replace {
		started += "|replace"
	}
	p.started = append(p.started, started)
	p.states["p1"] = PairState{State: PairPending}
	return Pairing{ID: "p1", UserCode: "BCDF-GHJK", VerificationURI: "https://bp.example/companion/pair", VerificationURIComplete: "https://bp.example/companion/pair?code=BCDF-GHJK", ExpiresAt: time.Date(2026, 9, 28, 10, 10, 0, 0, time.UTC), Interval: 5}, nil
}

func (p *fakePairer) Poll(_ context.Context, id string) (PairState, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	state, ok := p.states[id]
	if !ok {
		return PairState{}, ErrPairingNotFound
	}
	return state, nil
}

func (p *fakePairer) Cancel(id string) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	state, ok := p.states[id]
	if !ok {
		return ErrPairingNotFound
	}
	if state.State == PairPersisting {
		return ErrPairingPersisting
	}
	p.cancelled = append(p.cancelled, id)
	delete(p.states, id)
	return nil
}

func (p *fakePairer) Current() (Pairing, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if state, ok := p.states["p1"]; !ok || state.State != PairPending && state.State != PairPersisting {
		return Pairing{}, false
	}
	return Pairing{ID: "p1", UserCode: "BCDF-GHJK", VerificationURI: "https://bp.example/companion/pair", VerificationURIComplete: "https://bp.example/companion/pair?code=BCDF-GHJK", ExpiresAt: time.Date(2026, 9, 28, 10, 10, 0, 0, time.UTC), Interval: 5, Endpoint: "https://bp.example"}, true
}

func (p *fakePairer) set(id string, state PairState) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.states[id] = state
}

func pairingServer(t *testing.T) (*testServer, *fakePairer) {
	t.Helper()
	pairer := &fakePairer{states: map[string]PairState{}}
	return newTestServer(t, func(config *Config) { config.Pairer = pairer }), pairer
}

func TestPairStart_WithoutAPairerIsUnavailable(t *testing.T) {
	server := newTestServer(t, nil)
	for _, request := range [][2]string{{"POST", "/v1/pair/start"}, {"GET", "/v1/pair/p1"}, {"DELETE", "/v1/pair/p1"}} {
		reply := server.do(t, request[0], request[1], `{"endpoint":"https://bp.example"}`)
		if reply.status != http.StatusNotImplemented || reply.errorCode(t) != CodeInvalidRequest || reply.json(t)["error"].(map[string]any)["message"] != "pairing unavailable" {
			t.Fatalf("%v: %d %s", request, reply.status, reply.body)
		}
	}
}

func TestPairStart_AnswersTheDeviceCodeFlow(t *testing.T) {
	server, pairer := pairingServer(t)
	reply := server.do(t, "POST", "/v1/pair/start", `{"endpoint":"https://bp.example","name":"laptop"}`)
	if reply.status != 200 {
		t.Fatalf("start: %d %s", reply.status, reply.body)
	}
	body := reply.json(t)
	for key, want := range map[string]any{"pairing_id": "p1", "user_code": "BCDF-GHJK", "verification_uri": "https://bp.example/companion/pair", "verification_uri_complete": "https://bp.example/companion/pair?code=BCDF-GHJK", "expires_at": "2026-09-28T10:10:00Z", "interval": float64(5)} {
		if body[key] != want {
			t.Fatalf("%s = %v, want %v (%s)", key, body[key], want, reply.body)
		}
	}
	if len(pairer.started) != 1 || pairer.started[0] != "https://bp.example|laptop" {
		t.Fatalf("pairer saw %v", pairer.started)
	}
}

func TestPairStart_RefusesANonHTTPSEndpoint(t *testing.T) {
	server, pairer := pairingServer(t)
	for _, body := range []string{`{"endpoint":"http://bp.example"}`, `{"endpoint":"bp.example"}`, `{}`, `{"endpoint":"https://"}`, `{"endpoint":"https://bp.example","name":"` + string(make([]byte, 81)) + `"}`} {
		reply := server.do(t, "POST", "/v1/pair/start", body)
		if reply.status != http.StatusBadRequest || reply.errorCode(t) != CodeInvalidRequest {
			t.Fatalf("%s: %d %s", body, reply.status, reply.body)
		}
	}
	if len(pairer.started) != 0 {
		t.Fatal("a refused request reached the pairer")
	}
}

func TestPairStart_WhileConnectedIsAlreadyConnected(t *testing.T) {
	server, pairer := pairingServer(t)
	server.backend.connected = true
	reply := server.do(t, "POST", "/v1/pair/start", `{"endpoint":"https://bp.example"}`)
	if reply.status != http.StatusConflict || reply.errorCode(t) != "already_connected" || len(pairer.started) != 0 {
		t.Fatalf("start while connected: %d %s", reply.status, reply.body)
	}
}

// Switching servers pairs the new one while the current connection keeps
// capturing; only an approved code retires it.
func TestPairStart_ReplaceWhileConnectedStartsThePairing(t *testing.T) {
	server, pairer := pairingServer(t)
	server.backend.connected = true
	reply := server.do(t, "POST", "/v1/pair/start", `{"endpoint":"https://other.example","replace":true}`)
	if reply.status != 200 || reply.json(t)["pairing_id"] != "p1" {
		t.Fatalf("replace while connected: %d %s", reply.status, reply.body)
	}
	if len(pairer.started) != 1 || pairer.started[0] != "https://other.example||replace" {
		t.Fatalf("pairer saw %v", pairer.started)
	}
}

func TestPairStart_ReplaceFalseWhileConnectedIsAlreadyConnected(t *testing.T) {
	server, pairer := pairingServer(t)
	server.backend.connected = true
	reply := server.do(t, "POST", "/v1/pair/start", `{"endpoint":"https://other.example","replace":false}`)
	if reply.status != http.StatusConflict || reply.errorCode(t) != "already_connected" || len(pairer.started) != 0 {
		t.Fatalf("replace:false while connected: %d %s", reply.status, reply.body)
	}
}

func TestPairPoll_ConnectedByReplaceReportsWhetherTheOldServerRevoked(t *testing.T) {
	server, pairer := pairingServer(t)
	server.do(t, "POST", "/v1/pair/start", `{"endpoint":"https://bp.example","replace":true}`)
	revoked := false
	pairer.set("p1", PairState{State: PairConnected, InstallationID: "inst-2", OldServerRevoked: &revoked})
	reply := server.do(t, "GET", "/v1/pair/p1", "")
	body := reply.json(t)
	if reply.status != 200 || body["installation_id"] != "inst-2" || body["old_server_revoked"] != false {
		t.Fatalf("replace poll: %d %s", reply.status, reply.body)
	}
}

func TestPairPoll_ConnectedWithoutReplaceOmitsOldServerRevoked(t *testing.T) {
	server, pairer := pairingServer(t)
	server.do(t, "POST", "/v1/pair/start", `{"endpoint":"https://bp.example"}`)
	pairer.set("p1", PairState{State: PairConnected, InstallationID: "inst-1"})
	reply := server.do(t, "GET", "/v1/pair/p1", "")
	if _, present := reply.json(t)["old_server_revoked"]; reply.status != 200 || present {
		t.Fatalf("plain pairing poll: %d %s", reply.status, reply.body)
	}
}

// An approved code whose grant is being stored (a switch flushing the old
// server) is neither pending nor connected, and can no longer be cancelled.
func TestPairPoll_PersistingIsAcceptedWithItsOwnCode(t *testing.T) {
	server, pairer := pairingServer(t)
	server.do(t, "POST", "/v1/pair/start", `{"endpoint":"https://bp.example","replace":true}`)
	pairer.set("p1", PairState{State: PairPersisting})
	reply := server.do(t, "GET", "/v1/pair/p1", "")
	if reply.status != http.StatusAccepted || reply.errorCode(t) != CodePairingPersisting {
		t.Fatalf("persisting poll: %d %s", reply.status, reply.body)
	}
}

func TestPairCancel_WhilePersistingIsAConflict(t *testing.T) {
	server, pairer := pairingServer(t)
	server.do(t, "POST", "/v1/pair/start", `{"endpoint":"https://bp.example","replace":true}`)
	pairer.set("p1", PairState{State: PairPersisting})
	reply := server.do(t, "DELETE", "/v1/pair/p1", "")
	if reply.status != http.StatusConflict || reply.errorCode(t) != CodePairingPersisting || len(pairer.cancelled) != 0 {
		t.Fatalf("cancel while persisting: %d %s", reply.status, reply.body)
	}
}

// Signing out must not leave a code approvable that would connect again.
func TestDisconnect_CancelsAPendingPairingFirst(t *testing.T) {
	server, pairer := pairingServer(t)
	server.do(t, "POST", "/v1/pair/start", `{"endpoint":"https://bp.example","replace":true}`)
	reply := server.do(t, "POST", "/v1/disconnect", "")
	if reply.status != 200 || len(pairer.cancelled) != 1 || pairer.cancelled[0] != "p1" {
		t.Fatalf("disconnect: %d %s, cancelled %v", reply.status, reply.body, pairer.cancelled)
	}
}

func TestDisconnect_WhileASwitchPersistsIsRefused(t *testing.T) {
	server, pairer := pairingServer(t)
	server.do(t, "POST", "/v1/pair/start", `{"endpoint":"https://bp.example","replace":true}`)
	pairer.set("p1", PairState{State: PairPersisting})
	reply := server.do(t, "POST", "/v1/disconnect", "")
	if reply.status != http.StatusConflict || reply.errorCode(t) != CodePairingPersisting {
		t.Fatalf("disconnect while a switch persists: %d %s", reply.status, reply.body)
	}
}

func TestPairPoll_PendingIsAccepted(t *testing.T) {
	server, _ := pairingServer(t)
	server.do(t, "POST", "/v1/pair/start", `{"endpoint":"https://bp.example"}`)
	reply := server.do(t, "GET", "/v1/pair/p1", "")
	if reply.status != http.StatusAccepted || reply.errorCode(t) != CodePairingPending {
		t.Fatalf("pending poll: %d %s", reply.status, reply.body)
	}
}

func TestPairPoll_ConnectedAnswersTheInstallation(t *testing.T) {
	server, pairer := pairingServer(t)
	events := server.subscribe(t)
	events.next(t, "status")
	pairer.set("p1", PairState{State: PairConnected, InstallationID: "inst-1"})
	reply := server.do(t, "GET", "/v1/pair/p1", "")
	if reply.status != 200 || reply.json(t)["connected"] != true || reply.json(t)["installation_id"] != "inst-1" {
		t.Fatalf("connected poll: %d %s", reply.status, reply.body)
	}
	var pairing map[string]any
	json.Unmarshal([]byte(events.next(t, "pairing").data), &pairing)
	if pairing["pairing_id"] != "p1" || pairing["state"] != "connected" {
		t.Fatalf("pairing event %v", pairing)
	}
	if server.backend.invalidations.Load() == 0 {
		t.Fatal("a new connection must invalidate the status probes")
	}
}

func TestPairPoll_TerminalStatesAreClientErrors(t *testing.T) {
	server, pairer := pairingServer(t)
	for state, want := range map[string]string{PairDenied: "pairing_denied", PairExpired: "pairing_expired", PairFailed: "pairing_failed"} {
		pairer.set("p1", PairState{State: state})
		reply := server.do(t, "GET", "/v1/pair/p1", "")
		if reply.status < 400 || reply.status >= 500 || reply.errorCode(t) != want {
			t.Fatalf("%s poll: %d %s", state, reply.status, reply.body)
		}
	}
}

func TestPairPoll_UnknownIDIsNotFound(t *testing.T) {
	server, _ := pairingServer(t)
	reply := server.do(t, "GET", "/v1/pair/nope", "")
	if reply.status != http.StatusNotFound || reply.errorCode(t) != CodeNotFound {
		t.Fatalf("unknown poll: %d %s", reply.status, reply.body)
	}
}

func TestPairCancel_CancelsAndUnknownIsNotFound(t *testing.T) {
	server, pairer := pairingServer(t)
	server.do(t, "POST", "/v1/pair/start", `{"endpoint":"https://bp.example"}`)
	reply := server.do(t, "DELETE", "/v1/pair/p1", "")
	if reply.status != 200 || reply.json(t)["cancelled"] != true || len(pairer.cancelled) != 1 {
		t.Fatalf("cancel: %d %s", reply.status, reply.body)
	}
	reply = server.do(t, "DELETE", "/v1/pair/p1", "")
	if reply.status != http.StatusNotFound || reply.errorCode(t) != CodeNotFound {
		t.Fatalf("cancel twice: %d %s", reply.status, reply.body)
	}
}

func TestPairStart_PairerErrorIsReported(t *testing.T) {
	server, pairer := pairingServer(t)
	pairer.startErr = errors.New("boom")
	reply := server.do(t, "POST", "/v1/pair/start", `{"endpoint":"https://bp.example"}`)
	if reply.status != http.StatusInternalServerError || reply.errorCode(t) != CodeInternal {
		t.Fatalf("pairer failure: %d %s", reply.status, reply.body)
	}
}

// A pairing settles in the background; the event must not wait for a poll,
// and a poll after it must not repeat it.
func TestPairingSettled_PublishesOnceWithoutAPoll(t *testing.T) {
	server, pairer := pairingServer(t)
	events := server.subscribe(t)
	events.next(t, "status")
	server.do(t, "POST", "/v1/pair/start", `{"endpoint":"https://bp.example"}`)
	events.next(t, "pairing")
	invalidations := server.backend.invalidations.Load()
	pairer.set("p1", PairState{State: PairConnected, InstallationID: "inst-1"})
	server.PairingSettled("p1", PairConnected)
	var settled map[string]any
	json.Unmarshal([]byte(events.next(t, "pairing").data), &settled)
	if settled["pairing_id"] != "p1" || settled["state"] != PairConnected {
		t.Fatalf("settled event %v", settled)
	}
	if server.backend.invalidations.Load() == invalidations {
		t.Fatal("a connection made in the background must invalidate the status probes")
	}
	server.do(t, "GET", "/v1/pair/p1", "")
	server.PairingSettled("p1", PairConnected)
	for {
		select {
		case event := <-events.events:
			if event.kind == "pairing" {
				t.Fatalf("a settled state was published twice: %s", event.data)
			}
		case <-time.After(100 * time.Millisecond):
			return
		}
	}
}

func TestPairingSettled_IgnoresADeniedStateAlreadyPolled(t *testing.T) {
	server, pairer := pairingServer(t)
	events := server.subscribe(t)
	events.next(t, "status")
	pairer.set("p1", PairState{State: PairDenied})
	server.do(t, "GET", "/v1/pair/p1", "")
	events.next(t, "pairing")
	invalidations := server.backend.invalidations.Load()
	server.PairingSettled("p1", PairDenied)
	if server.backend.invalidations.Load() != invalidations {
		t.Fatal("a pairing that connected nothing must not invalidate the status probes")
	}
	select {
	case event := <-events.events:
		if event.kind == "pairing" {
			t.Fatalf("repeated %s", event.data)
		}
	case <-time.After(100 * time.Millisecond):
	}
}
