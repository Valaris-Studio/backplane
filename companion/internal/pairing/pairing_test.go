// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package pairing_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/pairing"
	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

const (
	grantedID    = "7a1c0de5-0000-4000-8000-000000000001"
	grantedToken = "bpc_synthetic_device_token_0123456789"
	// Server seconds become test milliseconds.
	unit = time.Millisecond
)

// fakeServer answers the token endpoint from a script, one answer per poll;
// the last answer repeats.
type fakeServer struct {
	*httptest.Server
	mu        sync.Mutex
	answers   []string
	expiresIn int
	polls     []time.Time
	starts    []map[string]any
	revoked   []string
}

func newFakeServer(t *testing.T, answers ...string) *fakeServer {
	t.Helper()
	server := &fakeServer{answers: answers, expiresIn: 600}
	server.Server = httptest.NewServer(http.HandlerFunc(server.handle))
	t.Cleanup(server.Close)
	return server
}

func (s *fakeServer) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	switch r.URL.Path {
	case "/api/companion/pairing":
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		s.starts = append(s.starts, body)
		json.NewEncoder(w).Encode(map[string]any{
			"device_code": "dc_synthetic", "user_code": "BCDF-GHJK",
			"verification_uri":          s.URL + "/companion/pair",
			"verification_uri_complete": s.URL + "/companion/pair#code=BCDF-GHJK",
			"interval":                  5, "expires_in": s.expiresIn,
		})
	case "/api/companion/pairing/token":
		s.polls = append(s.polls, time.Now())
		answer := s.answers[min(len(s.polls), len(s.answers))-1]
		if answer == "granted" {
			json.NewEncoder(w).Encode(map[string]string{"installation_id": grantedID, "device_token": grantedToken})
			return
		}
		w.WriteHeader(http.StatusBadRequest)
		json.NewEncoder(w).Encode(map[string]string{"detail": answer, "error_code": answer})
	case "/api/companion/installation":
		if r.Method != http.MethodDelete {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		s.revoked = append(s.revoked, strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		w.WriteHeader(http.StatusNoContent)
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

func (s *fakeServer) revocations() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.revoked...)
}

func (s *fakeServer) pollTimes() []time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]time.Time(nil), s.polls...)
}

type recordingPersist struct {
	mu     sync.Mutex
	grants []pairing.Grant
	err    error
}

func (p *recordingPersist) persist(_ context.Context, grant pairing.Grant) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.grants = append(p.grants, grant)
	return p.err
}

func (p *recordingPersist) calls() []pairing.Grant {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]pairing.Grant(nil), p.grants...)
}

func newManager(t *testing.T, ctx context.Context, persist *recordingPersist) *pairing.Manager {
	t.Helper()
	manager := pairing.New(ctx, pairing.Config{
		Persist:           persist.persist,
		Platform:          "testos",
		Arch:              "testarch",
		CompanionVersion:  "1.2.3",
		AllowLoopbackHTTP: true,
		IntervalUnit:      unit,
	})
	t.Cleanup(manager.Close)
	return manager
}

func awaitState(t *testing.T, manager *pairing.Manager, id string, want pairing.State) pairing.PairState {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		state, err := manager.Poll(context.Background(), id)
		if err != nil {
			t.Fatalf("poll %s: %v", id, err)
		}
		if state.State == want {
			return state
		}
		if time.Now().After(deadline) {
			t.Fatalf("state = %+v, want %s", state, want)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func TestStart_ReturnsTheCodeAndConnectsOnceApproved(t *testing.T) {
	server := newFakeServer(t, "authorization_pending", "authorization_pending", "granted")
	persist := &recordingPersist{}
	manager := newManager(t, context.Background(), persist)

	started, err := manager.Start(context.Background(), server.URL, "Studio Mac")
	if err != nil {
		t.Fatal(err)
	}
	if started.ID == "" || started.ID == "dc_synthetic" || started.UserCode != "BCDF-GHJK" || started.Interval != 5 {
		t.Fatalf("started = %+v", started)
	}
	if started.VerificationURIComplete != server.URL+"/companion/pair#code=BCDF-GHJK" {
		t.Fatalf("verification_uri_complete = %q", started.VerificationURIComplete)
	}
	if !started.ExpiresAt.After(time.Now()) {
		t.Fatalf("expires_at %v is not in the future", started.ExpiresAt)
	}
	if state, _ := manager.Poll(context.Background(), started.ID); state.State != pairing.StatePending && state.State != pairing.StateConnected {
		t.Fatalf("initial state = %+v", state)
	}

	connected := awaitState(t, manager, started.ID, pairing.StateConnected)
	if connected.InstallationID != grantedID || connected.Err != nil {
		t.Fatalf("connected = %+v", connected)
	}
	grants := persist.calls()
	if len(grants) != 1 {
		t.Fatalf("persisted %d times", len(grants))
	}
	want := pairing.Grant{Endpoint: server.URL, AllowLoopbackHTTP: true, InstallationID: grantedID, DeviceToken: grantedToken, Name: "Studio Mac"}
	if grants[0] != want {
		t.Fatalf("grant = %+v, want %+v", grants[0], want)
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if body := server.starts[0]; body["platform"] != "testos" || body["arch"] != "testarch" || body["companion_version"] != "1.2.3" || body["name"] != "Studio Mac" {
		t.Fatalf("start body = %v", body)
	}
}

func TestPoll_WaitsTheIntervalAndBacksOffOnSlowDown(t *testing.T) {
	server := newFakeServer(t, "authorization_pending", "slow_down", "authorization_pending", "granted")
	manager := newManager(t, context.Background(), &recordingPersist{})
	started, err := manager.Start(context.Background(), server.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	awaitState(t, manager, started.ID, pairing.StateConnected)
	polls := server.pollTimes()
	if len(polls) != 4 {
		t.Fatalf("polled %d times", len(polls))
	}
	if gap := polls[1].Sub(polls[0]); gap < 5*unit {
		t.Fatalf("polled again after %v, faster than the 5-unit interval", gap)
	}
	// RFC 8628 §3.5: slow_down adds 5 seconds to the interval for good.
	for i, gap := range []time.Duration{polls[2].Sub(polls[1]), polls[3].Sub(polls[2])} {
		if gap < 10*unit {
			t.Fatalf("gap %d after slow_down was %v, want at least 10 units", i, gap)
		}
	}
}

func TestPoll_DeniedEndsWithoutPersisting(t *testing.T) {
	server := newFakeServer(t, "authorization_pending", "access_denied")
	persist := &recordingPersist{}
	manager := newManager(t, context.Background(), persist)
	started, _ := manager.Start(context.Background(), server.URL, "")
	awaitState(t, manager, started.ID, pairing.StateDenied)
	if len(persist.calls()) != 0 {
		t.Fatal("a denied pairing persisted something")
	}
}

func TestPoll_ServerExpiryEndsWithoutPersisting(t *testing.T) {
	server := newFakeServer(t, "expired_token")
	persist := &recordingPersist{}
	manager := newManager(t, context.Background(), persist)
	started, _ := manager.Start(context.Background(), server.URL, "")
	awaitState(t, manager, started.ID, pairing.StateExpired)
	if len(persist.calls()) != 0 {
		t.Fatal("an expired pairing persisted something")
	}
}

func TestPoll_StopsAtTheLocalExpiryEvenIfTheServerNeverAnswers(t *testing.T) {
	server := newFakeServer(t, "authorization_pending")
	server.expiresIn = 30
	manager := newManager(t, context.Background(), &recordingPersist{})
	started, _ := manager.Start(context.Background(), server.URL, "")
	awaitState(t, manager, started.ID, pairing.StateExpired)
	count := len(server.pollTimes())
	time.Sleep(30 * unit)
	if len(server.pollTimes()) != count {
		t.Fatal("kept polling after the pairing expired")
	}
}

func TestPoll_AFailedPersistReportsFailed(t *testing.T) {
	server := newFakeServer(t, "granted")
	persist := &recordingPersist{err: errors.New("keyring refused")}
	manager := newManager(t, context.Background(), persist)
	started, _ := manager.Start(context.Background(), server.URL, "")
	failed := awaitState(t, manager, started.ID, pairing.StateFailed)
	if failed.Err == nil || failed.InstallationID != "" {
		t.Fatalf("failed = %+v", failed)
	}
}

func TestCancel_StopsPollingAndForgetsThePairing(t *testing.T) {
	server := newFakeServer(t, "authorization_pending")
	manager := newManager(t, context.Background(), &recordingPersist{})
	started, _ := manager.Start(context.Background(), server.URL, "")
	for len(server.pollTimes()) == 0 {
		time.Sleep(time.Millisecond)
	}
	manager.Cancel(started.ID)
	count := len(server.pollTimes())
	time.Sleep(30 * unit)
	if len(server.pollTimes()) > count+1 {
		t.Fatal("kept polling after Cancel")
	}
	if _, err := manager.Poll(context.Background(), started.ID); !errors.Is(err, pairing.ErrUnknownPairing) {
		t.Fatalf("poll after cancel: %v", err)
	}
	manager.Cancel(started.ID) // idempotent
}

func TestParentContextCancel_StopsThePoller(t *testing.T) {
	server := newFakeServer(t, "authorization_pending")
	ctx, cancel := context.WithCancel(context.Background())
	manager := newManager(t, ctx, &recordingPersist{})
	started, _ := manager.Start(context.Background(), server.URL, "")
	for len(server.pollTimes()) == 0 {
		time.Sleep(time.Millisecond)
	}
	cancel()
	failed := awaitState(t, manager, started.ID, pairing.StateFailed)
	if !errors.Is(failed.Err, context.Canceled) {
		t.Fatalf("err = %v", failed.Err)
	}
	count := len(server.pollTimes())
	time.Sleep(30 * unit)
	if len(server.pollTimes()) > count {
		t.Fatal("kept polling after the context was cancelled")
	}
}

func TestWait_ReturnsWhenTheCallerGivesUp(t *testing.T) {
	server := newFakeServer(t, "authorization_pending")
	manager := newManager(t, context.Background(), &recordingPersist{})
	started, _ := manager.Start(context.Background(), server.URL, "")
	ctx, cancel := context.WithTimeout(context.Background(), 20*unit)
	defer cancel()
	if _, err := manager.Wait(ctx, started.ID); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("wait: %v", err)
	}
}

func TestStart_RefusesAnInsecureEndpoint(t *testing.T) {
	manager := newManager(t, context.Background(), &recordingPersist{})
	if _, err := manager.Start(context.Background(), "http://backplane.example.com", ""); !errors.Is(err, uplink.ErrInsecureEndpoint) {
		t.Fatalf("start over plain HTTP: %v", err)
	}
}

func TestStart_RunsThePreflightFirst(t *testing.T) {
	server := newFakeServer(t, "authorization_pending")
	refusal := errors.New("already_connected")
	manager := pairing.New(context.Background(), pairing.Config{
		Persist:           (&recordingPersist{}).persist,
		Preflight:         func(context.Context) error { return refusal },
		AllowLoopbackHTTP: true,
		IntervalUnit:      unit,
	})
	defer manager.Close()
	if _, err := manager.Start(context.Background(), server.URL, ""); !errors.Is(err, refusal) {
		t.Fatalf("start: %v", err)
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	if len(server.starts) != 0 {
		t.Fatal("started a pairing the preflight refused")
	}
}

func TestPoll_UnknownID(t *testing.T) {
	manager := newManager(t, context.Background(), &recordingPersist{})
	if _, err := manager.Poll(context.Background(), "nope"); !errors.Is(err, pairing.ErrUnknownPairing) {
		t.Fatalf("poll unknown: %v", err)
	}
}

func TestStart_ClampsAHugeExpiresIn(t *testing.T) {
	server := newFakeServer(t, "authorization_pending")
	server.expiresIn = 1_000_000_000
	manager := newManager(t, context.Background(), &recordingPersist{})
	started, err := manager.Start(context.Background(), server.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	if limit := time.Now().Add(pairing.MaxExpiresIn * unit); started.ExpiresAt.After(limit) {
		t.Fatalf("expires_at %v is past the %d-unit clamp", started.ExpiresAt, pairing.MaxExpiresIn)
	}
	if pairing.MaxExpiresIn != 15*60 {
		t.Fatalf("the clamp is 15 minutes of server seconds, got %d", pairing.MaxExpiresIn)
	}
}

func TestStart_RejectsANonPositiveExpiresIn(t *testing.T) {
	for _, expiresIn := range []int{0, -5} {
		server := newFakeServer(t, "authorization_pending")
		server.expiresIn = expiresIn
		manager := newManager(t, context.Background(), &recordingPersist{})
		if _, err := manager.Start(context.Background(), server.URL, ""); err == nil {
			t.Fatalf("expires_in %d accepted", expiresIn)
		}
	}
}

// A Cancel that lands after the token was collected but before the pairing
// turned persisting answered OK: the pairing must then not persist, and the
// collected token, which nobody will hold, is revoked.
func TestCancel_BetweenCollectionAndPersistingStopsThePairingAndRevokesTheToken(t *testing.T) {
	server := newFakeServer(t, "granted")
	persist := &recordingPersist{}
	manager := newManager(t, context.Background(), persist)
	cancelled := make(chan error, 1)
	ids := make(chan string, 1)
	pairing.SetAfterCollect(manager, func() { cancelled <- manager.Cancel(<-ids) })
	started, err := manager.Start(context.Background(), server.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	ids <- started.ID
	if err := <-cancelled; err != nil {
		t.Fatalf("a cancel before persisting must succeed: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(server.revocations()) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := server.revocations(); len(got) != 1 || got[0] != grantedToken {
		t.Fatalf("revocations of the collected token: %v", got)
	}
	time.Sleep(20 * unit)
	if calls := persist.calls(); len(calls) != 0 {
		t.Fatalf("a cancelled pairing persisted %d grants", len(calls))
	}
}

// Idle is how an owner shutting down waits for a grant being stored: it
// returns only once every pairing's poller, persisting included, finished.
func TestIdle_WaitsForAPersistingPairing(t *testing.T) {
	server := newFakeServer(t, "granted")
	release := make(chan struct{})
	persisting := make(chan struct{}, 1)
	ctx, stop := context.WithCancel(context.Background())
	manager := pairing.New(ctx, pairing.Config{
		Persist: func(context.Context, pairing.Grant) error {
			<-release
			return nil
		},
		Persisting:        func(string) { persisting <- struct{}{} },
		AllowLoopbackHTTP: true,
		IntervalUnit:      unit,
	})
	t.Cleanup(manager.Close)
	if _, err := manager.Start(context.Background(), server.URL, ""); err != nil {
		t.Fatal(err)
	}
	<-persisting
	stop()
	idle := make(chan struct{})
	go func() {
		manager.Idle()
		close(idle)
	}()
	select {
	case <-idle:
		t.Fatal("Idle returned while a grant was still being stored")
	case <-time.After(50 * time.Millisecond):
	}
	close(release)
	select {
	case <-idle:
	case <-time.After(2 * time.Second):
		t.Fatal("Idle did not return once the grant was stored")
	}
}

// Once the grant is collected the device token exists only in Persist's
// hands: the pairing reports persisting, refuses Cancel, and still settles.
func TestCancel_RefusedOncePersistingAndThePairingStillSettles(t *testing.T) {
	server := newFakeServer(t, "granted")
	release := make(chan struct{})
	persisting := make(chan string, 1)
	manager := pairing.New(context.Background(), pairing.Config{
		Persist: func(context.Context, pairing.Grant) error {
			<-release
			return nil
		},
		Persisting:        func(id string) { persisting <- id },
		AllowLoopbackHTTP: true,
		IntervalUnit:      unit,
	})
	t.Cleanup(manager.Close)
	started, err := manager.Start(context.Background(), server.URL, "")
	if err != nil {
		t.Fatal(err)
	}
	if id := <-persisting; id != started.ID {
		t.Fatalf("persisting reported for %q, want %q", id, started.ID)
	}
	awaitState(t, manager, started.ID, pairing.StatePersisting)
	if err := manager.Cancel(started.ID); !errors.Is(err, pairing.ErrPersisting) {
		t.Fatalf("cancel while persisting: %v", err)
	}
	close(release)
	awaitState(t, manager, started.ID, pairing.StateConnected)
}
