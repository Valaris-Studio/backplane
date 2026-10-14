// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

var (
	errFakeNotConnected = errors.New("not_connected")
	errFakeUnknownAgent = errors.New("unknown_agent")
)

// fakeBackend stands in for the companion's shared command implementations.
type fakeBackend struct {
	mu            sync.Mutex
	statusCalls   atomic.Int32
	invalidations atomic.Int32
	refreshes     atomic.Int32
	paused        bool
	generation    int
	ignored       []string
	discovered    []string
	discoverErr   error
	connected     bool
	device        Device
	deviceErr     error
	attention     []AttentionItem
	renamed       string
	diagnostics   []DiagnosticFile
	panicVersion  bool
	flush         QueueFlush
	flushErr      error
	flushes       atomic.Int32
	writes        []PolicyWrite
	// order records apply and refresh calls as they happen.
	order []string
}

func (b *fakeBackend) Status(context.Context) (Snapshot, error) {
	b.statusCalls.Add(1)
	b.mu.Lock()
	defer b.mu.Unlock()
	return Snapshot{Status: map[string]any{"paused": b.paused, "generation": b.generation}, Attention: b.attention}, nil
}

func (b *fakeBackend) bump() {
	b.mu.Lock()
	b.generation++
	b.mu.Unlock()
}

func (b *fakeBackend) InvalidateProbes() { b.invalidations.Add(1) }

func (b *fakeBackend) SetPaused(_ context.Context, paused bool) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.paused = paused
	return nil
}

func (b *fakeBackend) Projects(context.Context) (any, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return map[string]any{"mappings": []any{}, "discovered": []any{}, "ignored": append([]string{}, b.ignored...)}, nil
}

func (b *fakeBackend) IgnoreProject(_ context.Context, path string) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.ignored = append(b.ignored, path)
	return path, nil
}

func (b *fakeBackend) DiscoverProject(_ context.Context, path string) (any, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.discoverErr != nil {
		return nil, b.discoverErr
	}
	b.discovered = append(b.discovered, path)
	return map[string]any{"root": path, "reason": "no_origin"}, nil
}

func (b *fakeBackend) UnignoreProject(_ context.Context, path string) (string, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	kept := b.ignored[:0]
	for _, ignored := range b.ignored {
		if ignored != path {
			kept = append(kept, ignored)
		}
	}
	b.ignored = kept
	return path, nil
}

func (b *fakeBackend) Agents(context.Context) (any, error) {
	return []map[string]any{{"id": "claude_code"}}, nil
}

func (b *fakeBackend) InstallAgent(_ context.Context, id string) (any, error) {
	if id != "claude_code" {
		return nil, errFakeUnknownAgent
	}
	return map[string]any{"id": id, "integration": map[string]any{"state": "installed"}}, nil
}

func (b *fakeBackend) UninstallAgent(_ context.Context, id string) (any, error) {
	if id != "claude_code" {
		return nil, errFakeUnknownAgent
	}
	return map[string]any{"id": id, "integration": map[string]any{"state": "not_installed"}}, nil
}

func (b *fakeBackend) Disconnect(context.Context) (any, error) {
	return map[string]any{"connected": false, "server_revoked": true}, nil
}

func (b *fakeBackend) Version(context.Context) (any, error) {
	if b.panicVersion {
		panic("version exploded")
	}
	return map[string]any{"version": "dev"}, nil
}

func (b *fakeBackend) Rename(_ context.Context, name string) (string, error) {
	if !b.connected {
		return "", errFakeNotConnected
	}
	b.renamed = name
	return name, nil
}

func (b *fakeBackend) Device(context.Context) (Device, error) {
	if b.deviceErr != nil {
		return nil, b.deviceErr
	}
	if b.device == nil {
		return nil, errFakeNotConnected
	}
	return b.device, nil
}

func (b *fakeBackend) RefreshPolicy(context.Context) error {
	b.refreshes.Add(1)
	b.mu.Lock()
	b.order = append(b.order, "refresh")
	b.mu.Unlock()
	return nil
}

func (b *fakeBackend) ApplyPolicyWrite(_ context.Context, write PolicyWrite) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.writes = append(b.writes, write)
	b.order = append(b.order, "apply")
	return nil
}

func (b *fakeBackend) Connected(context.Context) bool { return b.connected }

func (b *fakeBackend) Diagnostics(context.Context) ([]DiagnosticFile, error) {
	return b.diagnostics, nil
}

func (b *fakeBackend) FlushQueue(context.Context) (QueueFlush, error) {
	b.flushes.Add(1)
	return b.flush, b.flushErr
}

func (b *fakeBackend) DescribeError(err error, _ string) *Error {
	switch {
	case errors.Is(err, errFakeNotConnected):
		return &Error{Status: http.StatusConflict, Code: "not_connected", Message: "This device is not connected."}
	case errors.Is(err, errFakeUnknownAgent):
		return &Error{Status: http.StatusNotFound, Code: "unknown_agent", Message: "Unknown agent."}
	}
	return nil
}

// testServer serves the control handler over loopback TCP so tests need no
// socket path; the transport tests cover the socket itself.
type testServer struct {
	*Server
	http    *httptest.Server
	backend *fakeBackend
}

func newTestServer(t *testing.T, configure func(*Config)) *testServer {
	t.Helper()
	backend := &fakeBackend{}
	config := Config{DataDir: t.TempDir(), Backend: backend, PingInterval: time.Hour, StatusDebounce: 10 * time.Millisecond, WatchInterval: time.Hour, AgentProbeInterval: time.Hour}
	if configure != nil {
		configure(&config)
	}
	if b, ok := config.Backend.(*fakeBackend); ok {
		backend = b
	}
	server := New(config)
	server.StartWatching()
	httpServer := httptest.NewServer(server.Handler())
	t.Cleanup(func() {
		httpServer.CloseClientConnections()
		httpServer.Close()
		server.Close()
	})
	return &testServer{Server: server, http: httpServer, backend: backend}
}

type response struct {
	status int
	body   []byte
	header http.Header
}

func (r response) json(t *testing.T) map[string]any {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal(r.body, &decoded); err != nil {
		t.Fatalf("not a JSON object (%d): %s", r.status, r.body)
	}
	return decoded
}

// errorCode returns the envelope's code after checking the envelope shape.
func (r response) errorCode(t *testing.T) string {
	t.Helper()
	envelope := r.json(t)
	inner, ok := envelope["error"].(map[string]any)
	if !ok || len(envelope) != 1 {
		t.Fatalf("not an error envelope: %s", r.body)
	}
	if _, ok := inner["message"].(string); !ok {
		t.Fatalf("envelope without message: %s", r.body)
	}
	if _, present := inner["detail"]; !present {
		t.Fatalf("envelope without detail: %s", r.body)
	}
	return inner["code"].(string)
}

func (s *testServer) do(t *testing.T, method, path, body string) response {
	t.Helper()
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	request, _ := http.NewRequest(method, s.http.URL+path, reader)
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	reply, err := s.http.Client().Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer reply.Body.Close()
	data, _ := io.ReadAll(reply.Body)
	return response{status: reply.StatusCode, body: data, header: reply.Header}
}

// sseEvent is one parsed server-sent event; comment lines have kind ":".
type sseEvent struct {
	kind string
	data string
}

type sseStream struct {
	events chan sseEvent
	body   io.ReadCloser
	cancel context.CancelFunc
}

func (s *testServer) subscribe(t *testing.T) *sseStream {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	request, _ := http.NewRequestWithContext(ctx, http.MethodGet, s.http.URL+"/v1/events", nil)
	reply, err := s.http.Client().Do(request)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if reply.StatusCode != http.StatusOK || !strings.HasPrefix(reply.Header.Get("Content-Type"), "text/event-stream") {
		cancel()
		t.Fatalf("events: %d %s", reply.StatusCode, reply.Header.Get("Content-Type"))
	}
	stream := &sseStream{events: make(chan sseEvent, 256), body: reply.Body, cancel: cancel}
	go readEvents(reply.Body, stream.events)
	t.Cleanup(stream.close)
	return stream
}

func (s *sseStream) close() {
	s.cancel()
	s.body.Close()
}

func readEvents(body io.Reader, events chan<- sseEvent) {
	defer close(events)
	scanner := bufio.NewScanner(body)
	var current sseEvent
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case strings.HasPrefix(line, ":"):
			events <- sseEvent{kind: ":", data: strings.TrimSpace(line[1:])}
		case strings.HasPrefix(line, "event: "):
			current.kind = line[len("event: "):]
		case strings.HasPrefix(line, "data: "):
			current.data = line[len("data: "):]
		case line == "" && current.kind != "":
			events <- current
			current = sseEvent{}
		}
	}
}

// next returns the next event of kind, skipping others, or fails.
func (s *sseStream) next(t *testing.T, kind string) sseEvent {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case event, open := <-s.events:
			if !open {
				t.Fatalf("stream ended waiting for %q", kind)
			}
			if event.kind == kind {
				return event
			}
		case <-deadline:
			t.Fatalf("no %q event", kind)
		}
	}
}

// ended reports whether the server closed the stream within the wait.
func (s *sseStream) ended(wait time.Duration) bool {
	deadline := time.After(wait)
	for {
		select {
		case _, open := <-s.events:
			if !open {
				return true
			}
		case <-deadline:
			return false
		}
	}
}

func shortTempDir(t *testing.T) string {
	t.Helper()
	// Unix socket paths are limited to about 104 bytes, which t.TempDir()
	// under a long test name can exceed.
	dir, err := os.MkdirTemp("", "bpc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	os.Chmod(dir, 0o700)
	return dir
}
