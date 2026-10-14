// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

const (
	defaultPingInterval   = 15 * time.Second
	defaultStatusDebounce = 250 * time.Millisecond
	defaultWatchInterval  = time.Second
	// Agents' own configs (Codex hook trust) live outside the watched
	// state; this bounds how long a fix made there goes unnoticed.
	defaultAgentProbeInterval = 15 * time.Second
	defaultQueueSize          = 64
	maxRequestBytes           = 64 << 10
	readHeaderTimeout         = 10 * time.Second
	// A request's headers and body must arrive within defaultReadTimeout;
	// the event stream clears its own deadlines to stream indefinitely.
	defaultReadTimeout = 30 * time.Second
	defaultIdleTimeout = 120 * time.Second
	shutdownTimeout    = 2 * time.Second
)

type Config struct {
	// DataDir holds the socket and control.json.
	DataDir string
	Backend Backend
	// Pairer runs device pairing; without one the pairing endpoints answer
	// 501 "pairing unavailable".
	Pairer Pairer
	// AgentAccess lets agents work on bound boards; without one its
	// endpoints answer 501 and no agent_access event is sent.
	AgentAccess AgentAccessService
	// Home is shown as ~ in diagnostics.
	Home                string
	HomeCaseInsensitive bool
	// AllowInsecureLoopback lets pairing use plain HTTP to a loopback IP.
	AllowInsecureLoopback bool
	ReadTimeout           time.Duration
	IdleTimeout           time.Duration
	// Locale localizes messages when a request names no language.
	Locale string
	// WatchPaths are state files whose change republishes status;
	// ProbePaths among them also invalidate the cached probes, ProjectPaths
	// republish projects, and PolicyPath emits policy.changed.
	WatchPaths   []string
	ProbePaths   []string
	ProjectPaths []string
	PolicyPath   string
	Listen       ListenOptions
	// Zero durations and sizes take the contract's values.
	PingInterval   time.Duration
	StatusDebounce time.Duration
	WatchInterval  time.Duration
	// AgentProbeInterval is how often, while a client listens, the agents'
	// integrations are compared with the reported status.
	AgentProbeInterval time.Duration
	QueueSize          int
	Now                func() time.Time
	Logf               func(format string, args ...any)
}

type Server struct {
	config   Config
	handler  http.Handler
	hub      *hub
	watcher  *watcher
	pairings pairingStates

	mu        sync.Mutex
	listener  net.Listener
	http      *http.Server
	published bool
	closed    bool
	stop      context.CancelFunc
	done      sync.WaitGroup
}

func New(config Config) *Server {
	if config.PingInterval == 0 {
		config.PingInterval = defaultPingInterval
	}
	if config.StatusDebounce == 0 {
		config.StatusDebounce = defaultStatusDebounce
	}
	if config.WatchInterval == 0 {
		config.WatchInterval = defaultWatchInterval
	}
	if config.AgentProbeInterval == 0 {
		config.AgentProbeInterval = defaultAgentProbeInterval
	}
	if config.ReadTimeout == 0 {
		config.ReadTimeout = defaultReadTimeout
	}
	if config.IdleTimeout == 0 {
		config.IdleTimeout = defaultIdleTimeout
	}
	if config.QueueSize == 0 {
		config.QueueSize = defaultQueueSize
	}
	if config.Now == nil {
		config.Now = time.Now
	}
	if config.Logf == nil {
		config.Logf = func(string, ...any) {}
	}
	server := &Server{config: config}
	server.hub = newHub(server, config.QueueSize, config.StatusDebounce)
	server.watcher = newWatcher(server, config)
	server.handler = server.recovering(server.routes())
	return server
}

// Handler serves the API without a listener, e.g. for tests.
func (s *Server) Handler() http.Handler { return s.handler }

// Start listens, writes the discovery file and serves until Close. On Unix
// the caller must hold the daemon lock: a leftover socket is replaced.
func (s *Server) Start() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed || s.listener != nil {
		return errors.New("control server already started or closed")
	}
	listener, err := Listen(s.config.DataDir, s.config.Listen)
	if err != nil {
		return err
	}
	s.listener = listener
	s.http = &http.Server{Handler: s.handler, ReadHeaderTimeout: readHeaderTimeout, ReadTimeout: s.config.ReadTimeout, IdleTimeout: s.config.IdleTimeout}
	s.done.Add(1)
	go func() {
		defer s.done.Done()
		if err := s.http.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.config.Logf("control_api_stopped: %v", err)
		}
	}()
	s.startWatcherLocked()
	discovery := map[string]any{"version": 1, "socket": listenerAddress(s.config.DataDir), "pid": os.Getpid(), "started_at": s.config.Now().UTC().Format(time.RFC3339)}
	if err := store.WriteJSON(DiscoveryPath(s.config.DataDir), discovery); err != nil {
		return err
	}
	s.published = true
	return nil
}

// StartWatching follows the state files without a listener, for a server
// used only through Handler.
func (s *Server) StartWatching() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed {
		s.startWatcherLocked()
	}
}

func (s *Server) startWatcherLocked() {
	if s.stop != nil {
		return
	}
	ctx, stop := context.WithCancel(context.Background())
	s.stop = stop
	s.done.Add(1)
	go func() {
		defer s.done.Done()
		s.watcher.run(ctx)
	}()
	s.done.Add(1)
	go func() {
		defer s.done.Done()
		s.watcher.probeAgents(ctx)
	}()
}

// Close stops serving, ends every event stream and removes the discovery
// file; the listener removes its socket.
func (s *Server) Close() error {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil
	}
	s.closed = true
	httpServer, stop, published := s.http, s.stop, s.published
	s.mu.Unlock()
	s.hub.close()
	if stop != nil {
		stop()
	}
	if httpServer != nil {
		ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()
		if err := httpServer.Shutdown(ctx); err != nil {
			httpServer.Close()
		}
	}
	s.done.Wait()
	if published {
		if err := os.Remove(DiscoveryPath(s.config.DataDir)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

// Publish sends an event to every subscriber.
func (s *Server) Publish(eventType string, data any) { s.hub.publish(eventType, data) }

// StatusChanged schedules a debounced status (and attention) event.
func (s *Server) StatusChanged() { s.hub.statusChanged() }

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()
	handle := func(pattern string, handler func(http.ResponseWriter, *http.Request) error) {
		mux.HandleFunc(pattern, func(w http.ResponseWriter, r *http.Request) {
			if err := handler(w, r); err != nil {
				s.writeError(w, r, err)
			}
		})
	}
	handle("GET /v1/status", s.status)
	mux.HandleFunc("GET /v1/events", s.hub.serve)
	handle("POST /v1/pause", s.pause(true))
	handle("POST /v1/resume", s.pause(false))
	handle("POST /v1/queue/flush", s.flushQueue)
	handle("GET /v1/projects", s.projects)
	handle("POST /v1/projects/ignore", s.ignore)
	handle("DELETE /v1/projects/ignore", s.unignore)
	handle("POST /v1/projects/discover", s.discover)
	handle("GET /v1/agents", s.agents)
	handle("POST /v1/agents/{id}/install", s.agentAction(true))
	handle("POST /v1/agents/{id}/uninstall", s.agentAction(false))
	handle("POST /v1/rename", s.rename)
	handle("POST /v1/disconnect", s.disconnect)
	handle("GET /v1/version", s.version)
	handle("GET /v1/diagnostics", s.diagnostics)
	handle("GET /v1/boards", s.boards)
	handle("POST /v1/mappings", s.createMapping)
	handle("PATCH /v1/mappings/{id}", s.updateMapping)
	handle("DELETE /v1/mappings/{id}", s.deleteMapping)
	handle("PATCH /v1/settings", s.updateSettings)
	handle("GET /v1/agent-access", s.agentAccess)
	handle("PUT /v1/mappings/{id}/agent-access", s.setAgentAccess)
	handle("GET /v1/sessions", s.sessions)
	handle("GET /v1/sessions/{id}", s.session)
	handle("GET /v1/sessions/{id}/usage", s.sessionUsage)
	handle("POST /v1/pair/start", s.pairStart)
	handle("GET /v1/pair", s.pairCurrent)
	handle("GET /v1/pair/{id}", s.pairPoll)
	handle("DELETE /v1/pair/{id}", s.pairCancel)
	// Everything else, including a known path with another method.
	handle("/", func(http.ResponseWriter, *http.Request) error {
		return &Error{Status: http.StatusNotFound, Code: CodeNotFound, Message: "no such endpoint"}
	})
	return mux
}

// recovering answers a panicking handler with the internal envelope and
// logs it, so one bad request never takes the daemon's capture down.
func (s *Server) recovering(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			recovered := recover()
			if recovered == nil {
				return
			}
			if recovered == http.ErrAbortHandler {
				panic(recovered)
			}
			s.config.Logf("control_api_panic: %s %s: %v\n%s", r.Method, r.URL.Path, recovered, debug.Stack())
			s.writeJSON(w, http.StatusInternalServerError, map[string]any{"error": map[string]any{"code": CodeInternal, "message": "internal error", "detail": nil}})
		}()
		next.ServeHTTP(w, r)
	})
}

func (s *Server) writeJSON(w http.ResponseWriter, status int, value any) {
	encoded, err := encodeJSON(value)
	if err != nil {
		s.config.Logf("control_api_encode: %v", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	w.Write(append(encoded, '\n'))
}

func (s *Server) writeError(w http.ResponseWriter, r *http.Request, err error) {
	described := s.describe(err, requestLocale(r, s.config.Locale))
	s.writeJSON(w, described.Status, map[string]any{"error": map[string]any{"code": described.Code, "message": described.Message, "detail": described.Detail}})
}

// describe turns any error into the envelope's fields. Unknown errors are
// logged and answered as internal, without their text, which may hold
// local paths.
func (s *Server) describe(err error, locale string) *Error {
	var known *Error
	if errors.As(err, &known) {
		return known
	}
	if upstream := upstreamError(err); upstream != nil {
		return upstream
	}
	if described := s.config.Backend.DescribeError(err, locale); described != nil {
		return described
	}
	switch {
	case errors.Is(err, ErrSameServer):
		return &Error{Status: http.StatusConflict, Code: CodeSameServer, Message: "This device is already connected to that Backplane."}
	case errors.Is(err, ErrPairingPersisting):
		return &Error{Status: http.StatusConflict, Code: CodePairingPersisting, Message: "The pairing was approved and is connecting; it can no longer be cancelled."}
	case errors.Is(err, ErrPairingNotFound):
		return &Error{Status: http.StatusNotFound, Code: CodeNotFound, Message: "No such pairing."}
	case errors.Is(err, ErrAlreadyConnected):
		return &Error{Status: http.StatusConflict, Code: "already_connected", Message: "This device is already connected."}
	}
	s.config.Logf("control_api_internal: %v", err)
	return &Error{Status: http.StatusInternalServerError, Code: CodeInternal, Message: "internal error"}
}

// requestLocale prefers the client's Accept-Language over the daemon's own.
func requestLocale(r *http.Request, fallback string) string {
	if r == nil {
		return fallback
	}
	language := strings.TrimSpace(strings.SplitN(r.Header.Get("Accept-Language"), ",", 2)[0])
	language = strings.TrimSpace(strings.SplitN(language, ";", 2)[0])
	if language == "" || language == "*" {
		return fallback
	}
	return language
}

func invalid(format string, args ...any) *Error {
	return &Error{Status: http.StatusBadRequest, Code: CodeInvalidRequest, Message: fmt.Sprintf(format, args...)}
}

// decodeBody reads a bounded JSON object and refuses unknown members, so a
// misspelled field is an error instead of a silent no-op.
func decodeBody(r *http.Request, value any) error {
	data, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBytes+1))
	if err != nil {
		return invalid("unreadable request body")
	}
	if len(data) > maxRequestBytes {
		return invalid("request body too large")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		return invalid("invalid JSON body: %v", err)
	}
	if decoder.More() {
		return invalid("invalid JSON body: trailing data")
	}
	return nil
}
