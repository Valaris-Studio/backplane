// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"
)

// statusBuildTimeout bounds a status built for subscribers; the probes it
// may run (service manager, keyring) are cached, but a cold cache is not.
const statusBuildTimeout = 10 * time.Second

var pingFrame = []byte(": ping\n\n")

type subscriber struct {
	queue   chan []byte
	dropped chan struct{}
	once    sync.Once
}

func (s *subscriber) drop() { s.once.Do(func() { close(s.dropped) }) }

// hub fans events out to the /v1/events streams. Each subscriber has a
// bounded queue; one that falls a full queue behind is dropped rather than
// slowing the daemon, and gets a fresh status when it reconnects.
type hub struct {
	server   *Server
	size     int
	debounce time.Duration

	mu            sync.Mutex
	subscribers   map[*subscriber]struct{}
	pendingStatus *time.Timer
	// lastAttention and reportedIntegrations are what every subscriber was
	// last sent, the baseline a change is noticed against; nil is unknown.
	lastAttention        []byte
	reportedIntegrations []byte
	// baselineGeneration counts baseline writes, so a connect whose slow
	// snapshot predates one never adopts it as the baseline.
	baselineGeneration uint64
	// building keeps status builds in order: a slow one never publishes
	// after, or records a baseline over, a fresher one.
	building sync.Mutex
	closed   bool
	done     chan struct{}
}

func newHub(server *Server, size int, debounce time.Duration) *hub {
	return &hub{server: server, size: size, debounce: debounce, subscribers: map[*subscriber]struct{}{}, done: make(chan struct{})}
}

func encodeEvent(eventType string, data any) ([]byte, error) {
	payload, err := encodeJSON(data)
	if err != nil {
		return nil, err
	}
	// Compact JSON holds no newline, so one data line carries it.
	frame := append([]byte("event: "+eventType+"\ndata: "), payload...)
	return append(frame, '\n', '\n'), nil
}

func (h *hub) publish(eventType string, data any) {
	frame, err := encodeEvent(eventType, data)
	if err != nil {
		h.server.config.Logf("control_api_event_encode: %v", err)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for subscriber := range h.subscribers {
		select {
		case subscriber.queue <- frame:
		default:
			delete(h.subscribers, subscriber)
			subscriber.drop()
		}
	}
}

func (h *hub) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.subscribers)
}

// statusChanged coalesces changes within the debounce into one status
// built when it fires, and builds nothing while nobody listens.
func (h *hub) statusChanged() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || h.pendingStatus != nil || len(h.subscribers) == 0 {
		return
	}
	h.pendingStatus = time.AfterFunc(h.debounce, h.publishStatus)
}

func (h *hub) publishStatus() {
	h.building.Lock()
	defer h.building.Unlock()
	h.mu.Lock()
	h.pendingStatus = nil
	idle := h.closed || len(h.subscribers) == 0
	h.mu.Unlock()
	if idle {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), statusBuildTimeout)
	defer cancel()
	snapshot, err := h.server.config.Backend.Status(ctx)
	if err != nil {
		h.server.config.Logf("control_api_status: %v", err)
		return
	}
	h.recordIntegrations(snapshot.Status)
	h.publish("status", snapshot.Status)
	h.publishAttention(snapshot.Attention)
}

func attentionBody(items []AttentionItem) (map[string]any, []byte) {
	if items == nil {
		items = []AttentionItem{}
	}
	body := map[string]any{"items": items}
	encoded, _ := json.Marshal(body)
	return body, encoded
}

// publishAttention sends the attention list when it differs from the last.
func (h *hub) publishAttention(items []AttentionItem) {
	body, encoded := attentionBody(items)
	h.mu.Lock()
	unchanged := bytes.Equal(encoded, h.lastAttention)
	h.lastAttention = encoded
	h.baselineGeneration++
	h.mu.Unlock()
	if !unchanged {
		h.publish("attention", body)
	}
}

type agentIntegration struct {
	ID          string          `json:"id"`
	Integration json.RawMessage `json:"integration"`
}

// integrationsFingerprint is each agent's integration by id: what the user
// changes in the agent itself (trusting hooks, fixing its config), in files
// the daemon does not watch. Nil when entries carry no agents.
func integrationsFingerprint(entries []agentIntegration) []byte {
	byID := map[string]any{}
	for _, entry := range entries {
		var integration any
		json.Unmarshal(entry.Integration, &integration)
		byID[entry.ID] = integration
	}
	fingerprint, _ := json.Marshal(byID)
	return fingerprint
}

func statusIntegrations(status any) []byte {
	encoded, err := encodeJSON(status)
	if err != nil {
		return nil
	}
	var report struct {
		Agents []agentIntegration `json:"agents"`
	}
	if json.Unmarshal(encoded, &report) != nil {
		return nil
	}
	return integrationsFingerprint(report.Agents)
}

func (h *hub) recordIntegrations(status any) {
	fingerprint := statusIntegrations(status)
	h.mu.Lock()
	h.reportedIntegrations = fingerprint
	h.baselineGeneration++
	h.mu.Unlock()
}

// connected reconciles the baseline with the snapshot one connecting
// client got, built since generation. Alone, that snapshot is the
// baseline. Beside older clients it may show a change they missed; and a
// baseline written while it was built may be fresher than it. Either way
// the baseline becomes unknown and a status goes to everyone, since the
// next change compared against a wrong baseline would look like none.
func (h *hub) connected(generation uint64, integrations, attention []byte) {
	h.mu.Lock()
	rebroadcast := false
	current := generation == h.baselineGeneration
	switch {
	case current && len(h.subscribers) == 1:
		h.reportedIntegrations, h.lastAttention = integrations, attention
	case current && h.reportedIntegrations != nil && h.lastAttention != nil && bytes.Equal(integrations, h.reportedIntegrations) && bytes.Equal(attention, h.lastAttention):
		h.mu.Unlock()
		return
	default:
		h.reportedIntegrations, h.lastAttention = nil, nil
		rebroadcast = true
	}
	h.baselineGeneration++
	h.mu.Unlock()
	if rebroadcast {
		h.statusChanged()
	}
}

// agentsProbed schedules a status when an agents probe found an integration
// other than the one every subscriber was sent, or the baseline is unknown,
// so a problem fixed out of band clears from status and attention.
func (h *hub) agentsProbed(agents any) {
	encoded, err := encodeJSON(agents)
	if err != nil {
		return
	}
	var entries []agentIntegration
	if json.Unmarshal(encoded, &entries) != nil {
		return
	}
	fresh := integrationsFingerprint(entries)
	h.mu.Lock()
	stale := h.reportedIntegrations == nil || !bytes.Equal(fresh, h.reportedIntegrations)
	h.mu.Unlock()
	if stale {
		h.statusChanged()
	}
}

func (h *hub) close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return
	}
	h.closed = true
	close(h.done)
	if h.pendingStatus != nil {
		h.pendingStatus.Stop()
		h.pendingStatus = nil
	}
	for subscriber := range h.subscribers {
		delete(h.subscribers, subscriber)
		subscriber.drop()
	}
}

// subscribe also returns the baseline generation the subscriber's first
// status is built against.
func (h *hub) subscribe() (*subscriber, uint64, bool) {
	subscriber := &subscriber{queue: make(chan []byte, h.size), dropped: make(chan struct{})}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, 0, false
	}
	h.subscribers[subscriber] = struct{}{}
	return subscriber, h.baselineGeneration, true
}

func (h *hub) unsubscribe(subscriber *subscriber) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.subscribers, subscriber)
	subscriber.drop()
}

// serve streams events. It subscribes before building the first status so
// no change made meanwhile is missed; the status is written first and the
// queued events follow in order.
func (h *hub) serve(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		h.server.writeError(w, r, &Error{Status: http.StatusInternalServerError, Code: CodeInternal, Message: "streaming unsupported"})
		return
	}
	subscriber, generation, open := h.subscribe()
	if !open {
		h.server.writeError(w, r, &Error{Status: http.StatusServiceUnavailable, Code: CodeInternal, Message: "shutting down"})
		return
	}
	defer h.unsubscribe(subscriber)
	// The server's read timeout bounds ordinary requests; a stream lives
	// until the client leaves. Test recorders do not support deadlines.
	controller := http.NewResponseController(w)
	controller.SetReadDeadline(time.Time{})
	controller.SetWriteDeadline(time.Time{})
	snapshot, err := h.server.config.Backend.Status(r.Context())
	if err != nil {
		h.server.writeError(w, r, err)
		return
	}
	status, err := encodeEvent("status", snapshot.Status)
	if err != nil {
		h.server.writeError(w, r, err)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(status); err != nil {
		return
	}
	// Always, even empty: a reconnecting client still holds the list it had.
	attentionItems, attentionEncoded := attentionBody(snapshot.Attention)
	if attention, err := encodeEvent("attention", attentionItems); err == nil {
		w.Write(attention)
	}
	if access := h.server.agentAccessEvent(r.Context()); access != nil {
		w.Write(access)
	}
	h.connected(generation, statusIntegrations(snapshot.Status), attentionEncoded)
	flusher.Flush()
	ping := time.NewTicker(h.server.config.PingInterval)
	defer ping.Stop()
	for {
		// A dropped subscriber ends even with frames still queued.
		select {
		case <-subscriber.dropped:
			return
		default:
		}
		var frame []byte
		select {
		case <-subscriber.dropped:
			return
		case <-h.done:
			return
		case <-r.Context().Done():
			return
		case <-ping.C:
			frame = pingFrame
		case frame = <-subscriber.queue:
		}
		if _, err := w.Write(frame); err != nil {
			return
		}
		flusher.Flush()
	}
}
