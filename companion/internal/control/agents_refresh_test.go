// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"bytes"
	"context"
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// integrationBackend reports one Codex integration whose state changes
// behind the daemon's back, as when the user trusts the hooks in Codex.
type integrationBackend struct {
	*fakeBackend
	mu          sync.Mutex
	integration string
	statusBuilt atomic.Int32
	probes      atomic.Int32
}

func newIntegrationBackend(integration string) *integrationBackend {
	return &integrationBackend{fakeBackend: &fakeBackend{}, integration: integration}
}

func (b *integrationBackend) set(integration string) {
	b.mu.Lock()
	b.integration = integration
	b.mu.Unlock()
}

func (b *integrationBackend) Status(context.Context) (Snapshot, error) {
	b.statusBuilt.Add(1)
	b.mu.Lock()
	defer b.mu.Unlock()
	attention := []AttentionItem{}
	if b.integration == "needs_trust" {
		agent := "codex_cli"
		attention = append(attention, AttentionItem{Code: "needs_trust", Severity: "warning", Agent: &agent, Message: "Trust the hooks."})
	}
	status := map[string]any{"agents": []map[string]any{{"id": "codex_cli", "state": b.integration, "integration": map[string]any{"state": b.integration}}}}
	return Snapshot{Status: status, Attention: attention}, nil
}

func (b *integrationBackend) Agents(context.Context) (any, error) {
	b.probes.Add(1)
	b.mu.Lock()
	defer b.mu.Unlock()
	return []map[string]any{{"id": "codex_cli", "presence": map[string]any{"installed": true}, "integration": map[string]any{"state": b.integration}}}, nil
}

func newIntegrationServer(t *testing.T, integration string, configure ...func(*Config)) (*testServer, *integrationBackend) {
	t.Helper()
	backend := newIntegrationBackend(integration)
	server := newTestServer(t, func(config *Config) {
		config.Backend = backend
		for _, apply := range configure {
			apply(config)
		}
	})
	return server, backend
}

func codexIntegrationState(t *testing.T, event sseEvent) string {
	t.Helper()
	var status struct {
		Agents []struct {
			ID          string `json:"id"`
			Integration struct {
				State string `json:"state"`
			} `json:"integration"`
		} `json:"agents"`
	}
	if err := json.Unmarshal([]byte(event.data), &status); err != nil || len(status.Agents) != 1 {
		t.Fatalf("status %s", event.data)
	}
	return status.Agents[0].Integration.State
}

func attentionItems(t *testing.T, event sseEvent) []AttentionItem {
	t.Helper()
	var attention struct {
		Items []AttentionItem `json:"items"`
	}
	if err := json.Unmarshal([]byte(event.data), &attention); err != nil || attention.Items == nil {
		t.Fatalf("attention %s", event.data)
	}
	return attention.Items
}

// quiet reports whether no event of kind arrives within wait.
func (s *sseStream) quiet(kind string, wait time.Duration) bool {
	deadline := time.After(wait)
	for {
		select {
		case event, open := <-s.events:
			if !open {
				return true
			}
			if event.kind == kind {
				return false
			}
		case <-deadline:
			return true
		}
	}
}

func TestAgents_ProbeThatDiffersFromReportedStatusRepublishesStatusAndAttention(t *testing.T) {
	server, backend := newIntegrationServer(t, "needs_trust")
	stream := server.subscribe(t)
	if state := codexIntegrationState(t, stream.next(t, "status")); state != "needs_trust" {
		t.Fatalf("first status reports %q", state)
	}
	if items := attentionItems(t, stream.next(t, "attention")); len(items) != 1 {
		t.Fatalf("first attention %+v", items)
	}
	backend.set("installed")
	if reply := server.do(t, "GET", "/v1/agents", ""); reply.status != 200 {
		t.Fatalf("agents %d", reply.status)
	}
	if state := codexIntegrationState(t, stream.next(t, "status")); state != "installed" {
		t.Fatalf("status after the fresh probe reports %q, want installed", state)
	}
	if items := attentionItems(t, stream.next(t, "attention")); len(items) != 0 {
		t.Fatalf("attention after the fresh probe still lists %+v", items)
	}
}

func TestAgents_ProbeMatchingReportedStatusPublishesNoStatus(t *testing.T) {
	server, backend := newIntegrationServer(t, "needs_trust")
	stream := server.subscribe(t)
	stream.next(t, "status")
	stream.next(t, "attention")
	server.do(t, "GET", "/v1/agents", "")
	built := backend.statusBuilt.Load()
	if !stream.quiet("status", 200*time.Millisecond) {
		t.Fatal("a probe matching the reported status must not republish status")
	}
	if rebuilt := backend.statusBuilt.Load(); rebuilt != built {
		t.Fatalf("a matching probe built %d extra statuses", rebuilt-built)
	}
}

func TestAgents_ProbeWithoutSubscribersBuildsNoStatus(t *testing.T) {
	server, backend := newIntegrationServer(t, "needs_trust")
	backend.set("installed")
	server.do(t, "GET", "/v1/agents", "")
	time.Sleep(100 * time.Millisecond)
	if built := backend.statusBuilt.Load(); built != 0 {
		t.Fatalf("nobody listens, yet %d statuses were built", built)
	}
}

func TestEvents_ConnectSendsAttentionEvenWhenEmpty(t *testing.T) {
	server, _ := newIntegrationServer(t, "installed")
	stream := server.subscribe(t)
	stream.next(t, "status")
	// A client keeps the attention it had before it reconnected; only an
	// explicit empty list clears it.
	if items := attentionItems(t, stream.next(t, "attention")); len(items) != 0 {
		t.Fatalf("attention on connect %+v", items)
	}
}

// The stale warning survived even a fresh probe when the attention a client
// got on connect was not what the daemon deduplicated against.
func TestAgents_FreshProbeClearsAttentionAClientGotOnConnect(t *testing.T) {
	server, backend := newIntegrationServer(t, "installed")
	earlier := server.subscribe(t)
	earlier.next(t, "status")
	server.StatusChanged()
	earlier.next(t, "attention")
	earlier.close()

	backend.set("needs_trust")
	stream := server.subscribe(t)
	stream.next(t, "status")
	if items := attentionItems(t, stream.next(t, "attention")); len(items) != 1 {
		t.Fatalf("attention on connect %+v", items)
	}
	backend.set("installed")
	server.do(t, "GET", "/v1/agents", "")
	if state := codexIntegrationState(t, stream.next(t, "status")); state != "installed" {
		t.Fatalf("status after the fresh probe reports %q", state)
	}
	if items := attentionItems(t, stream.next(t, "attention")); len(items) != 0 {
		t.Fatalf("attention after the fresh probe still lists %+v", items)
	}
}

func probeEvery(interval time.Duration) func(*Config) {
	return func(config *Config) { config.AgentProbeInterval = interval }
}

// Trusting the hooks in Codex writes only Codex's own config, which the
// daemon does not watch; a listening client still converges unasked.
func TestEvents_OutOfBandIntegrationChangeRepublishesStatusUnasked(t *testing.T) {
	server, backend := newIntegrationServer(t, "needs_trust", probeEvery(20*time.Millisecond))
	stream := server.subscribe(t)
	stream.next(t, "status")
	stream.next(t, "attention")
	backend.set("installed")
	if state := codexIntegrationState(t, stream.next(t, "status")); state != "installed" {
		t.Fatalf("status after the periodic probe reports %q", state)
	}
	if items := attentionItems(t, stream.next(t, "attention")); len(items) != 0 {
		t.Fatalf("attention after the periodic probe still lists %+v", items)
	}
}

func TestEvents_PeriodicProbeOfUnchangedIntegrationsPublishesNoStatus(t *testing.T) {
	server, backend := newIntegrationServer(t, "needs_trust", probeEvery(20*time.Millisecond))
	stream := server.subscribe(t)
	stream.next(t, "status")
	stream.next(t, "attention")
	if !stream.quiet("status", 300*time.Millisecond) {
		t.Fatal("unchanged integrations must not republish status")
	}
	if backend.probes.Load() == 0 {
		t.Fatal("the agents were never probed")
	}
}

func TestEvents_PeriodicProbeSleepsWithoutSubscribers(t *testing.T) {
	_, backend := newIntegrationServer(t, "needs_trust", probeEvery(10*time.Millisecond))
	time.Sleep(150 * time.Millisecond)
	if probes := backend.probes.Load(); probes != 0 {
		t.Fatalf("nobody listens, yet the agents were probed %d times", probes)
	}
}

// The dedup baseline is what every subscriber was sent; one client's
// connect must not move it past what older clients still show.
func TestAttention_ChangeSeenOnlyByANewSubscriberReachesExistingOnes(t *testing.T) {
	server, backend := newIntegrationServer(t, "installed")
	older := server.subscribe(t)
	older.next(t, "status")
	older.next(t, "attention")
	backend.set("needs_trust")
	newer := server.subscribe(t)
	newer.next(t, "status")
	newer.next(t, "attention")
	server.StatusChanged()
	if items := attentionItems(t, older.next(t, "attention")); len(items) != 1 {
		t.Fatalf("older subscriber's attention %+v", items)
	}
}

func TestAgents_SecondSubscriberConnectKeepsOlderSubscriberConverging(t *testing.T) {
	server, backend := newIntegrationServer(t, "needs_trust")
	older := server.subscribe(t)
	older.next(t, "status")
	older.next(t, "attention")
	backend.set("installed")
	newer := server.subscribe(t)
	newer.next(t, "status")
	newer.next(t, "attention")
	server.do(t, "GET", "/v1/agents", "")
	if state := codexIntegrationState(t, older.next(t, "status")); state != "installed" {
		t.Fatalf("older subscriber's status reports %q", state)
	}
	if items := attentionItems(t, older.next(t, "attention")); len(items) != 0 {
		t.Fatalf("older subscriber's attention still lists %+v", items)
	}
}

func TestEvents_SecondSubscriberMatchingTheBroadcastPublishesNoStatus(t *testing.T) {
	server, backend := newIntegrationServer(t, "needs_trust")
	older := server.subscribe(t)
	older.next(t, "status")
	older.next(t, "attention")
	newer := server.subscribe(t)
	newer.next(t, "status")
	built := backend.statusBuilt.Load()
	server.do(t, "GET", "/v1/agents", "")
	if !older.quiet("status", 200*time.Millisecond) {
		t.Fatal("a connect matching the broadcast must not republish status")
	}
	if rebuilt := backend.statusBuilt.Load(); rebuilt != built {
		t.Fatalf("%d extra statuses built", rebuilt-built)
	}
}

// slowBackend's next status build, once armed, captures the state and then
// waits for release: a cold probe cache racing a faster publish.
type slowBackend struct {
	*integrationBackend
	armed   atomic.Bool
	release chan struct{}
}

func (b *slowBackend) Status(ctx context.Context) (Snapshot, error) {
	snapshot, err := b.integrationBackend.Status(ctx)
	if b.armed.CompareAndSwap(true, false) {
		<-b.release
	}
	return snapshot, err
}

func newSlowServer(t *testing.T, integration string) (*testServer, *slowBackend) {
	t.Helper()
	backend := &slowBackend{integrationBackend: newIntegrationBackend(integration), release: make(chan struct{})}
	server := newTestServer(t, func(config *Config) { config.Backend = backend })
	return server, backend
}

// nextState skips status events until one reports want.
func (s *sseStream) nextState(t *testing.T, want string) {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case event, open := <-s.events:
			if !open {
				t.Fatalf("stream ended waiting for %q", want)
			}
			if event.kind == "status" && codexIntegrationState(t, event) == want {
				return
			}
		case <-deadline:
			t.Fatalf("no status reporting %q", want)
		}
	}
}

func baselineReports(t *testing.T, server *testServer, want string) {
	t.Helper()
	expected := integrationsFingerprint([]agentIntegration{{ID: "codex_cli", Integration: []byte(`{"state":"` + want + `"}`)}})
	deadline := time.Now().Add(time.Second)
	for {
		server.hub.mu.Lock()
		got := server.hub.reportedIntegrations
		server.hub.mu.Unlock()
		if bytes.Equal(got, expected) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("baseline %s, want %s", got, expected)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestEvents_SlowConnectNeverOverwritesAFresherBaseline(t *testing.T) {
	server, backend := newSlowServer(t, "needs_trust")
	older := server.subscribe(t)
	older.next(t, "status")
	older.next(t, "attention")

	backend.armed.Store(true)
	connecting := make(chan *sseStream, 1)
	go func() { connecting <- server.subscribe(t) }()
	time.Sleep(100 * time.Millisecond)
	older.close()
	backend.set("installed")
	server.StatusChanged()
	time.Sleep(150 * time.Millisecond)
	close(backend.release)

	newer := <-connecting
	if state := codexIntegrationState(t, newer.next(t, "status")); state != "needs_trust" {
		t.Fatalf("the slow connect's own status reports %q", state)
	}
	// The client whose snapshot lost the race still ends on the fresh state.
	newer.nextState(t, "installed")
	baselineReports(t, server, "installed")

	// A stale baseline would match this real change and swallow it.
	backend.set("needs_trust")
	server.do(t, "GET", "/v1/agents", "")
	newer.nextState(t, "needs_trust")
}

func TestEvents_SlowStatusBuildNeverLandsAfterAFresherOne(t *testing.T) {
	server, backend := newSlowServer(t, "needs_trust")
	stream := server.subscribe(t)
	stream.next(t, "status")
	stream.next(t, "attention")

	backend.armed.Store(true)
	server.StatusChanged()
	time.Sleep(100 * time.Millisecond)
	backend.set("installed")
	server.StatusChanged()
	time.Sleep(100 * time.Millisecond)
	close(backend.release)

	stream.nextState(t, "installed")
	if !stream.quiet("status", 300*time.Millisecond) {
		t.Fatal("a status built before the fresher one was published after it")
	}
	baselineReports(t, server, "installed")
}
