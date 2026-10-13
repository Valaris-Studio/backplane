// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"go.uber.org/goleak"
)

func TestEvents_FirstEventIsStatus(t *testing.T) {
	server := newTestServer(t, nil)
	stream := server.subscribe(t)
	select {
	case first := <-stream.events:
		var status map[string]any
		if first.kind != "status" || json.Unmarshal([]byte(first.data), &status) != nil || status["paused"] != false {
			t.Fatalf("first event %+v", first)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no first event")
	}
}

func TestEvents_MutationPublishesADebouncedStatus(t *testing.T) {
	server := newTestServer(t, func(config *Config) { config.StatusDebounce = 150 * time.Millisecond })
	stream := server.subscribe(t)
	stream.next(t, "status")
	before := server.backend.statusCalls.Load()
	for range 5 {
		server.do(t, "POST", "/v1/pause", "")
	}
	var status map[string]any
	json.Unmarshal([]byte(stream.next(t, "status").data), &status)
	if status["paused"] != true {
		t.Fatalf("status after pause %v", status)
	}
	time.Sleep(300 * time.Millisecond)
	if built := server.backend.statusCalls.Load() - before; built != 1 {
		t.Fatalf("five mutations within the debounce built %d statuses, want 1", built)
	}
}

func TestEvents_PublishReachesEverySubscriber(t *testing.T) {
	server := newTestServer(t, nil)
	first, second := server.subscribe(t), server.subscribe(t)
	first.next(t, "status")
	second.next(t, "status")
	server.Publish("agents", []string{"claude_code"})
	for _, stream := range []*sseStream{first, second} {
		if event := stream.next(t, "agents"); event.data != `["claude_code"]` {
			t.Fatalf("agents data %q", event.data)
		}
	}
}

func TestEvents_PingIsACommentLine(t *testing.T) {
	server := newTestServer(t, func(config *Config) { config.PingInterval = 20 * time.Millisecond })
	stream := server.subscribe(t)
	if ping := stream.next(t, ":"); ping.data != "ping" {
		t.Fatalf("ping %q", ping.data)
	}
}

// blockingWriter is a client that stops reading: its first write blocks
// until released.
type blockingWriter struct {
	header  http.Header
	wrote   chan struct{}
	release chan struct{}
	once    sync.Once
}

func (w *blockingWriter) Header() http.Header { return w.header }
func (w *blockingWriter) WriteHeader(int)     {}
func (w *blockingWriter) Flush()              {}
func (w *blockingWriter) Write(p []byte) (int, error) {
	w.once.Do(func() { close(w.wrote) })
	<-w.release
	return len(p), nil
}

func TestEvents_SlowClientIsDropped(t *testing.T) {
	server := newTestServer(t, func(config *Config) { config.QueueSize = 4 })
	writer := &blockingWriter{header: http.Header{}, wrote: make(chan struct{}), release: make(chan struct{})}
	request := httptest.NewRequest("GET", "/v1/events", nil)
	done := make(chan struct{})
	go func() {
		server.Handler().ServeHTTP(writer, request)
		close(done)
	}()
	<-writer.wrote
	for index := range 10 {
		server.Publish("agents", index)
	}
	close(writer.release)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("a client more than a queue behind must be dropped")
	}
	if server.hub.count() != 0 {
		t.Fatalf("dropped client still registered: %d", server.hub.count())
	}
}

func TestEvents_ClientWithinTheQueueIsKept(t *testing.T) {
	server := newTestServer(t, func(config *Config) { config.QueueSize = 4 })
	stream := server.subscribe(t)
	stream.next(t, "status")
	for index := range 3 {
		server.Publish("agents", index)
	}
	for range 3 {
		stream.next(t, "agents")
	}
	if server.hub.count() != 1 {
		t.Fatal("a client keeping up must stay subscribed")
	}
}

func TestEvents_ReconnectGetsAFreshStatus(t *testing.T) {
	server := newTestServer(t, nil)
	first := server.subscribe(t)
	first.next(t, "status")
	first.close()
	server.backend.bump()
	second := server.subscribe(t)
	var status map[string]any
	json.Unmarshal([]byte(second.next(t, "status").data), &status)
	if status["generation"] != float64(1) {
		t.Fatalf("reconnect must build a fresh status: %v", status)
	}
}

func TestEvents_ClientDisconnectLeaksNoGoroutines(t *testing.T) {
	defer goleak.VerifyNone(t, goleak.IgnoreCurrent())
	func() {
		server := newTestServer(t, func(config *Config) { config.PingInterval = 10 * time.Millisecond })
		for range 5 {
			stream := server.subscribe(t)
			stream.next(t, "status")
			stream.close()
		}
		deadline := time.Now().Add(3 * time.Second)
		for server.hub.count() != 0 && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		if server.hub.count() != 0 {
			t.Fatalf("clients left registered: %d", server.hub.count())
		}
		server.http.CloseClientConnections()
		server.http.Close()
		server.Close()
	}()
}

func TestEvents_WatchedStateChangeRepublishesStatusAndInvalidatesProbes(t *testing.T) {
	dir := t.TempDir()
	preferences := filepath.Join(dir, "preferences.json")
	health := filepath.Join(dir, "health.json")
	server := newTestServer(t, func(config *Config) {
		config.WatchInterval = 10 * time.Millisecond
		config.WatchPaths = []string{preferences, health}
		config.ProbePaths = []string{preferences}
	})
	stream := server.subscribe(t)
	stream.next(t, "status")
	server.backend.bump()
	os.WriteFile(health, []byte(`{"hook_errors":1}`), 0o600)
	var status map[string]any
	json.Unmarshal([]byte(stream.next(t, "status").data), &status)
	if status["generation"] != float64(1) {
		t.Fatalf("a watched change must republish status: %v", status)
	}
	invalidations := server.backend.invalidations.Load()
	os.WriteFile(preferences, []byte(`{"paused":true}`), 0o600)
	stream.next(t, "status")
	if server.backend.invalidations.Load() == invalidations {
		t.Fatal("a probe-relevant change must invalidate the probes")
	}
}

func TestEvents_AttentionIsPublishedWhenItChanges(t *testing.T) {
	server := newTestServer(t, nil)
	stream := server.subscribe(t)
	stream.next(t, "status")
	stream.next(t, "attention")
	agent := "codex_cli"
	server.backend.mu.Lock()
	server.backend.attention = []AttentionItem{{Code: "needs_trust", Severity: "warning", Agent: &agent, Message: "Trust the hooks."}}
	server.backend.mu.Unlock()
	server.StatusChanged()
	var attention struct {
		Items []AttentionItem `json:"items"`
	}
	json.Unmarshal([]byte(stream.next(t, "attention").data), &attention)
	if len(attention.Items) != 1 || attention.Items[0].Code != "needs_trust" || *attention.Items[0].Agent != "codex_cli" {
		t.Fatalf("attention %+v", attention)
	}
}

func TestEvents_ProjectMutationPublishesProjects(t *testing.T) {
	server := newTestServer(t, nil)
	stream := server.subscribe(t)
	stream.next(t, "status")
	server.do(t, "POST", "/v1/projects/ignore", `{"path":"/src/app"}`)
	var projects map[string]any
	json.Unmarshal([]byte(stream.next(t, "projects").data), &projects)
	if ignored, _ := projects["ignored"].([]any); len(ignored) != 1 {
		t.Fatalf("projects event %v", projects)
	}
}

func TestEvents_AgentMutationPublishesAgents(t *testing.T) {
	server := newTestServer(t, nil)
	stream := server.subscribe(t)
	stream.next(t, "status")
	server.do(t, "POST", "/v1/agents/claude_code/install", "")
	stream.next(t, "agents")
}
