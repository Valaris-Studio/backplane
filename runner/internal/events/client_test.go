// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package events

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

// newTestServer creates an httptest server that accepts WebSocket connections.
// The handler receives the server-side websocket.Conn and the request context.
func newTestServer(t *testing.T, handler func(conn *websocket.Conn, ctx context.Context)) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Logf("websocket accept: %v", err)
			return
		}
		defer conn.CloseNow()
		handler(conn, r.Context())
	}))
}

// readSubscription reads the initial subscribe message from the client.
func readSubscription(t *testing.T, conn *websocket.Conn, ctx context.Context) {
	t.Helper()
	_, _, err := conn.Read(ctx)
	if err != nil {
		t.Logf("reading subscription: %v", err)
	}
}

func TestClient_ConnectAndReceiveCardEvent(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)

	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		readSubscription(t, conn, ctx)
		event := Event{
			Type:      "card.created",
			Timestamp: "2026-04-12T00:00:00Z",
			EventID:   "evt-1",
			Payload:   EventPayload{EntityType: "card", EntityID: "card-123"},
		}
		data, _ := json.Marshal(event)
		conn.Write(ctx, websocket.MessageText, data)
		// Keep connection open for the client to process
		time.Sleep(200 * time.Millisecond)
	})
	defer server.Close()

	client := newTestClient(server.URL, triggerPoll)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go client.Run(ctx)

	select {
	case <-triggerPoll:
		// Card event triggered the poll channel
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for triggerPoll signal")
	}
}

func TestClient_ExecutionEventTriggersPoll(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)

	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		readSubscription(t, conn, ctx)
		event := Event{
			Type:      "execution.completed",
			Timestamp: "2026-04-12T00:00:00Z",
			EventID:   "evt-exec",
			Payload:   EventPayload{ExecutionID: "exec-1", AgentID: "agent-1"},
		}
		data, _ := json.Marshal(event)
		conn.Write(ctx, websocket.MessageText, data)
		time.Sleep(200 * time.Millisecond)
	})
	defer server.Close()

	client := newTestClient(server.URL, triggerPoll)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go client.Run(ctx)

	select {
	case <-triggerPoll:
		// Execution event triggered the poll channel
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for triggerPoll signal from execution event")
	}
}

func TestClient_ConfigEventTriggersPoll(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)

	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		readSubscription(t, conn, ctx)
		event := Event{
			Type:      "config.updated",
			Timestamp: "2026-04-12T00:00:00Z",
			EventID:   "evt-cfg",
		}
		data, _ := json.Marshal(event)
		conn.Write(ctx, websocket.MessageText, data)
		time.Sleep(200 * time.Millisecond)
	})
	defer server.Close()

	client := newTestClient(server.URL, triggerPoll)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go client.Run(ctx)

	select {
	case <-triggerPoll:
		// Config event triggered the poll channel
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for triggerPoll signal from config event")
	}
}

func TestClient_ApprovalSubscription(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)
	approvalCh := make(chan struct{}, 1)

	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		readSubscription(t, conn, ctx)
		event := Event{
			Type:      "approval.updated",
			Timestamp: "2026-04-12T00:00:00Z",
			EventID:   "evt-appr",
			Payload:   EventPayload{ApprovalID: "apr-42", Status: "approved"},
		}
		data, _ := json.Marshal(event)
		conn.Write(ctx, websocket.MessageText, data)
		time.Sleep(200 * time.Millisecond)
	})
	defer server.Close()

	client := newTestClient(server.URL, triggerPoll)
	unsub := client.SubscribeApproval("apr-42", approvalCh)
	defer unsub()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go client.Run(ctx)

	select {
	case <-approvalCh:
		// Approval event routed to subscriber
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for approval event")
	}
}

func TestClient_ApprovalRoutedByEntityID(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)
	approvalCh := make(chan struct{}, 1)

	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		readSubscription(t, conn, ctx)
		// Event with no approval_id but entity_id set — should still route
		event := Event{
			Type:      "approval.decided",
			Timestamp: "2026-04-12T00:00:00Z",
			EventID:   "evt-appr-2",
			Payload:   EventPayload{EntityID: "apr-fallback", Status: "rejected"},
		}
		data, _ := json.Marshal(event)
		conn.Write(ctx, websocket.MessageText, data)
		time.Sleep(200 * time.Millisecond)
	})
	defer server.Close()

	client := newTestClient(server.URL, triggerPoll)
	unsub := client.SubscribeApproval("apr-fallback", approvalCh)
	defer unsub()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go client.Run(ctx)

	select {
	case <-approvalCh:
		// Routed via entity_id fallback
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for approval event via entity_id fallback")
	}
}

func TestClient_UnsubscribeApproval(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)
	approvalCh := make(chan struct{}, 1)

	var sendEvent func()
	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		readSubscription(t, conn, ctx)
		sendEvent = func() {
			event := Event{
				Type:      "approval.updated",
				Timestamp: "2026-04-12T00:00:00Z",
				EventID:   "evt-unsub",
				Payload:   EventPayload{ApprovalID: "apr-99", Status: "approved"},
			}
			data, _ := json.Marshal(event)
			conn.Write(ctx, websocket.MessageText, data)
		}
		// Keep alive
		<-ctx.Done()
	})
	defer server.Close()

	client := newTestClient(server.URL, triggerPoll)
	unsub := client.SubscribeApproval("apr-99", approvalCh)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go client.Run(ctx)

	// Wait for connection to be established
	for i := 0; i < 50; i++ {
		if client.Connected() {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !client.Connected() {
		t.Fatal("client did not connect")
	}

	// Unsubscribe before sending event
	unsub()

	// Wait for sendEvent to be set up
	for i := 0; i < 50; i++ {
		if sendEvent != nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if sendEvent != nil {
		sendEvent()
	}

	// Verify channel does NOT receive
	select {
	case <-approvalCh:
		t.Fatal("should not receive event after unsubscribe")
	case <-time.After(200 * time.Millisecond):
		// Correct: no event received
	}
}

func TestClient_ReconnectOnDisconnect(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)
	var connectCount atomic.Int32

	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		n := connectCount.Add(1)
		readSubscription(t, conn, ctx)

		if n == 1 {
			// First connection: close immediately after sending one event
			event := Event{
				Type:    "card.created",
				EventID: "evt-first",
				Payload: EventPayload{EntityID: "card-1"},
			}
			data, _ := json.Marshal(event)
			conn.Write(ctx, websocket.MessageText, data)
			time.Sleep(50 * time.Millisecond)
			conn.Close(websocket.StatusNormalClosure, "test disconnect")
			return
		}

		// Second connection: send another event and stay alive
		event := Event{
			Type:    "card.updated",
			EventID: "evt-second",
			Payload: EventPayload{EntityID: "card-2"},
		}
		data, _ := json.Marshal(event)
		conn.Write(ctx, websocket.MessageText, data)
		<-ctx.Done()
	})
	defer server.Close()

	client := newTestClient(server.URL, triggerPoll)
	client.SetReconnectTiming(10*time.Millisecond, 50*time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	go client.Run(ctx)

	// Drain first event
	select {
	case <-triggerPoll:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for first event")
	}

	// Wait for reconnect and second event
	select {
	case <-triggerPoll:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for second event after reconnect")
	}

	if count := connectCount.Load(); count < 2 {
		t.Errorf("connect count = %d, want >= 2", count)
	}
}

func TestClient_ContextCancellation(t *testing.T) {
	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		readSubscription(t, conn, ctx)
		<-ctx.Done()
	})
	defer server.Close()

	triggerPoll := make(chan struct{}, 1)
	client := newTestClient(server.URL, triggerPoll)

	ctx, cancel := context.WithCancel(context.Background())

	done := make(chan error, 1)
	go func() {
		done <- client.Run(ctx)
	}()

	// Wait for connection
	for i := 0; i < 50; i++ {
		if client.Connected() {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	cancel()

	select {
	case err := <-done:
		if err != context.Canceled {
			t.Errorf("Run returned %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for Run to return after cancel")
	}
}

func TestClient_NonBlockingSend(t *testing.T) {
	// Fill triggerPoll so it's at capacity
	triggerPoll := make(chan struct{}, 1)
	triggerPoll <- struct{}{} // Fill it

	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		readSubscription(t, conn, ctx)
		// Send two card events — the second should NOT block
		for i := 0; i < 2; i++ {
			event := Event{
				Type:    "card.created",
				EventID: "evt-nb",
				Payload: EventPayload{EntityID: "card-nb"},
			}
			data, _ := json.Marshal(event)
			conn.Write(ctx, websocket.MessageText, data)
			time.Sleep(50 * time.Millisecond)
		}
		// Close to let test complete
		time.Sleep(100 * time.Millisecond)
	})
	defer server.Close()

	client := newTestClient(server.URL, triggerPoll)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	done := make(chan struct{})
	go func() {
		client.Run(ctx)
		close(done)
	}()

	// If we get here without deadlock, the non-blocking send works.
	// Wait a bit then cancel to complete.
	time.Sleep(500 * time.Millisecond)
	cancel()

	select {
	case <-done:
		// Test passed — no deadlock
	case <-time.After(2 * time.Second):
		t.Fatal("deadlock detected: client.Run did not return")
	}
}

func TestClient_PongResponse(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)
	var pongReceived atomic.Bool

	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		readSubscription(t, conn, ctx)

		// Send a ping message
		ping, _ := json.Marshal(map[string]string{"type": "ping"})
		conn.Write(ctx, websocket.MessageText, ping)

		// Read the pong response
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Logf("reading pong: %v", err)
			return
		}
		var msg map[string]string
		if err := json.Unmarshal(data, &msg); err == nil && msg["type"] == "pong" {
			pongReceived.Store(true)
		}

		<-ctx.Done()
	})
	defer server.Close()

	client := newTestClient(server.URL, triggerPoll)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go client.Run(ctx)

	// Wait for pong to be received
	for i := 0; i < 100; i++ {
		if pongReceived.Load() {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	if !pongReceived.Load() {
		t.Fatal("server did not receive pong response")
	}
}

func TestClient_SubscribeMessage(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)
	var subscribeMsg map[string]any
	var mu sync.Mutex

	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		mu.Lock()
		json.Unmarshal(data, &subscribeMsg)
		mu.Unlock()
		<-ctx.Done()
	})
	defer server.Close()

	client := newTestClient(server.URL, triggerPoll)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go client.Run(ctx)

	// Wait for subscribe message
	time.Sleep(300 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()

	if subscribeMsg == nil {
		t.Fatal("no subscribe message received")
	}

	topics, ok := subscribeMsg["subscribe"].([]any)
	if !ok {
		t.Fatalf("subscribe field type = %T, want []any", subscribeMsg["subscribe"])
	}
	// board.* joined the list for loop mode's keep-alive wake (card 5ffe97cf):
	// board.loop_updated is what tells an idling runner the loop came back on.
	expected := []string{"card.*", "approval.*", "execution.*", "config.*", "agent.*", "board.*", "completion.*"}
	if len(topics) != len(expected) {
		t.Fatalf("subscribe topics count = %d, want %d", len(topics), len(expected))
	}
	for i, exp := range expected {
		if topics[i] != exp {
			t.Errorf("topic[%d] = %v, want %q", i, topics[i], exp)
		}
	}
}

func TestClient_IgnoreMalformedMessages(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)

	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		readSubscription(t, conn, ctx)
		// Send malformed JSON
		conn.Write(ctx, websocket.MessageText, []byte("not json"))
		// Send empty event type
		conn.Write(ctx, websocket.MessageText, []byte(`{"event":"","payload":{}}`))
		// Send valid event
		event := Event{
			Type:    "card.created",
			EventID: "evt-after-bad",
			Payload: EventPayload{EntityID: "card-ok"},
		}
		data, _ := json.Marshal(event)
		conn.Write(ctx, websocket.MessageText, data)
		time.Sleep(200 * time.Millisecond)
	})
	defer server.Close()

	client := newTestClient(server.URL, triggerPoll)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go client.Run(ctx)

	// The valid event should still trigger poll despite bad messages before it
	select {
	case <-triggerPoll:
		// Correct: client recovered from bad messages
	case <-time.After(2 * time.Second):
		t.Fatal("timed out; client may have crashed on malformed messages")
	}
}

func TestRouteEvent_AgentPollRequested_TriggersForMatchingTarget(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)
	c := &Client{
		agentID:     "agent-1",
		triggerPoll: triggerPoll,
	}

	c.routeEvent(Event{
		Type:    "agent.poll_requested",
		Payload: EventPayload{TargetAgentID: "agent-1"},
	})

	select {
	case <-triggerPoll:
		// Correct: matching target triggered poll
	case <-time.After(200 * time.Millisecond):
		t.Fatal("expected triggerPoll signal for matching target_agent_id")
	}
}

func TestRouteEvent_AgentPollRequested_IgnoredForOtherTarget(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)
	c := &Client{
		agentID:     "agent-1",
		triggerPoll: triggerPoll,
	}

	c.routeEvent(Event{
		Type:    "agent.poll_requested",
		Payload: EventPayload{TargetAgentID: "agent-2"},
	})

	select {
	case <-triggerPoll:
		t.Fatal("should not trigger poll for non-matching target_agent_id")
	case <-time.After(100 * time.Millisecond):
		// Correct: nothing on the channel
	}
}

// Regression for the post-merge poll storm: the backend stamps card.* events with
// actor_id = user.id (NOT agent_id), so a self-caused card mutation must be filtered
// on userID. Without it, every self-mutation re-triggers a poll → ~13 polls/sec.
func TestRouteEvent_SelfCausedCardEvent_FilteredByUserID(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)
	c := &Client{
		agentID:     "agent-1",
		userID:      "user-1",
		triggerPoll: triggerPoll,
	}

	// A card event whose actor is THIS runner's user (not its agent id).
	c.routeEvent(Event{
		Type:    "card.updated",
		Payload: EventPayload{ActorID: "user-1", EntityID: "card-9"},
	})

	select {
	case <-triggerPoll:
		t.Fatal("self-caused card event (actor_id == userID) must NOT trigger a poll")
	case <-time.After(100 * time.Millisecond):
		// Correct: filtered.
	}
}

// A card event caused by a DIFFERENT user must still wake the loop — the filter
// must not over-match and starve legitimate cross-actor handoffs.
func TestRouteEvent_OtherUserCardEvent_TriggersPoll(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)
	c := &Client{
		agentID:     "agent-1",
		userID:      "user-1",
		triggerPoll: triggerPoll,
	}

	c.routeEvent(Event{
		Type:    "card.updated",
		Payload: EventPayload{ActorID: "user-2", EntityID: "card-9"},
	})

	select {
	case <-triggerPoll:
		// Correct: a foreign actor's mutation triggers a poll.
	case <-time.After(200 * time.Millisecond):
		t.Fatal("card event from another user should trigger a poll")
	}
}

func TestBackoff(t *testing.T) {
	c := &Client{
		reconnectMin: 1 * time.Second,
		reconnectMax: 30 * time.Second,
	}

	tests := []struct {
		attempt int
		want    time.Duration
	}{
		{0, 1 * time.Second},
		{1, 2 * time.Second},
		{2, 4 * time.Second},
		{3, 8 * time.Second},
		{4, 16 * time.Second},
		{5, 30 * time.Second}, // capped
		{6, 30 * time.Second}, // still capped
		{10, 30 * time.Second},
	}

	for _, tt := range tests {
		got := c.backoff(tt.attempt)
		if got != tt.want {
			t.Errorf("backoff(%d) = %v, want %v", tt.attempt, got, tt.want)
		}
	}
}

func TestBackoff_CustomTiming(t *testing.T) {
	c := &Client{
		reconnectMin: 100 * time.Millisecond,
		reconnectMax: 500 * time.Millisecond,
	}

	tests := []struct {
		attempt int
		want    time.Duration
	}{
		{0, 100 * time.Millisecond},
		{1, 200 * time.Millisecond},
		{2, 400 * time.Millisecond},
		{3, 500 * time.Millisecond}, // capped
	}

	for _, tt := range tests {
		got := c.backoff(tt.attempt)
		if got != tt.want {
			t.Errorf("backoff(%d) = %v, want %v", tt.attempt, got, tt.want)
		}
	}
}

// Card 85f993da: the API key must never ride the URL — query strings land in
// proxy/access logs, leaking agent keys on any self-hosted plain-nginx setup.
func TestNewClient_URLDerivation(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)

	tests := []struct {
		apiURL  string
		wantURL string
	}{
		{"https://api.valaris.dev", "wss://api.valaris.dev/ws/workspaces/my-ws/events"},
		{"http://localhost:8000", "ws://localhost:8000/ws/workspaces/my-ws/events"},
	}

	for _, tt := range tests {
		client := NewClient(tt.apiURL, "key123", "my-ws", "agent-test", "user-test", triggerPoll)
		if client.url != tt.wantURL {
			t.Errorf("NewClient(%q).url = %q, want %q", tt.apiURL, client.url, tt.wantURL)
		}
		if strings.Contains(client.url, "token=") {
			t.Errorf("NewClient(%q).url = %q must not carry a token= query param", tt.apiURL, client.url)
		}
	}
}

// Card 85f993da: the dial itself must carry the API key via the Authorization
// header (the backend's WS auth now accepts it, see events.py
// _authenticate_ws), and the request URL — as observed server-side — must
// carry no token= param anywhere, not just in the pre-dial client.url string.
func TestClient_DialCarriesAuthHeaderNotQueryToken(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)

	var mu sync.Mutex
	var gotAuthHeader string
	var gotRawQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		gotAuthHeader = r.Header.Get("Authorization")
		gotRawQuery = r.URL.RawQuery
		mu.Unlock()
		conn, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer conn.CloseNow()
		readSubscription(t, conn, r.Context())
		<-r.Context().Done()
	}))
	defer server.Close()

	client := NewClient(server.URL, "test-key", "test-ws", "agent-test", "user-test", triggerPoll)
	client.url = "ws" + server.URL[4:] + "/ws/workspaces/test-ws/events"
	client.SetReconnectTiming(50*time.Millisecond, 200*time.Millisecond)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go client.Run(ctx)

	for i := 0; i < 100; i++ {
		if client.Connected() {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !client.Connected() {
		t.Fatal("client never connected")
	}

	mu.Lock()
	defer mu.Unlock()
	if gotAuthHeader != "Bearer test-key" {
		t.Errorf("Authorization header = %q, want %q", gotAuthHeader, "Bearer test-key")
	}
	if strings.Contains(gotRawQuery, "token=") {
		t.Errorf("dial request query string = %q, must not carry a token= param", gotRawQuery)
	}
}

func TestClient_ConnectedStatus(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)

	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		readSubscription(t, conn, ctx)
		<-ctx.Done()
	})
	defer server.Close()

	client := newTestClient(server.URL, triggerPoll)
	if client.Connected() {
		t.Error("client should not be connected before Run")
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go client.Run(ctx)

	// Wait for connection
	for i := 0; i < 50; i++ {
		if client.Connected() {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	if !client.Connected() {
		t.Error("client should be connected after Run starts")
	}

	cancel()
	time.Sleep(100 * time.Millisecond)
	// After cancel, connected may go false — but this is timing-dependent
}

func TestClient_SendHeartbeat_WritesFrame(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)

	received := make(chan map[string]any, 1)

	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		readSubscription(t, conn, ctx)
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				return
			}
			var msg map[string]any
			if err := json.Unmarshal(data, &msg); err != nil {
				continue
			}
			if msg["type"] == "heartbeat" {
				select {
				case received <- msg:
				default:
				}
				return
			}
		}
	})
	defer server.Close()

	client := newTestClient(server.URL, triggerPoll)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go client.Run(ctx)

	for i := 0; i < 50; i++ {
		if client.Connected() {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if !client.Connected() {
		t.Fatal("client never connected")
	}

	payload := map[string]any{"status": "idle", "uptime_seconds": 42}
	if err := client.SendHeartbeat(ctx, payload); err != nil {
		t.Fatalf("SendHeartbeat: %v", err)
	}

	select {
	case msg := <-received:
		if msg["type"] != "heartbeat" {
			t.Errorf("expected type=heartbeat, got %v", msg["type"])
		}
		p, ok := msg["payload"].(map[string]any)
		if !ok {
			t.Fatalf("payload not an object: %T", msg["payload"])
		}
		if p["status"] != "idle" {
			t.Errorf("payload.status = %v, want idle", p["status"])
		}
		if p["uptime_seconds"].(float64) != 42 {
			t.Errorf("payload.uptime_seconds = %v, want 42", p["uptime_seconds"])
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server never received heartbeat frame")
	}
}

func TestClient_SendHeartbeat_ReturnsErrNotConnectedWhenDown(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)
	client := NewClient("http://nowhere.invalid", "k", "ws", "a", "u", triggerPoll)

	err := client.SendHeartbeat(context.Background(), map[string]any{})
	if err != ErrNotConnected {
		t.Errorf("got %v, want ErrNotConnected", err)
	}
}

// newTestClient creates a Client pointing at a test server with fast reconnect timing.
func newTestClient(serverURL string, triggerPoll chan struct{}) *Client {
	client := NewClient(serverURL, "test-key", "test-ws", "agent-test", "user-test", triggerPoll)
	// Override the URL to use the test server directly (the ws:// derivation won't
	// work for httptest servers which use http://)
	client.url = "ws" + serverURL[4:] + "/ws/workspaces/test-ws/events?token=test-key"
	client.SetReconnectTiming(50*time.Millisecond, 200*time.Millisecond)
	return client
}

// Card 54bea6b8: when an approval event arrives, the runner's poll loop
// must be woken in addition to the subscribed approval channel. Otherwise
// a downstream role that could now claim a newly-unblocked card waits up
// to the full poll_interval.
func TestClient_ApprovalEventWakesPollLoop(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)
	approvalCh := make(chan struct{}, 1)

	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		readSubscription(t, conn, ctx)
		event := Event{
			Type:      "approval.granted",
			Timestamp: "2026-04-24T00:00:00Z",
			EventID:   "evt-appr-wake",
			Payload:   EventPayload{ApprovalID: "apr-wake", Status: "approved"},
		}
		data, _ := json.Marshal(event)
		conn.Write(ctx, websocket.MessageText, data)
		time.Sleep(200 * time.Millisecond)
	})
	defer server.Close()

	client := newTestClient(server.URL, triggerPoll)
	unsub := client.SubscribeApproval("apr-wake", approvalCh)
	defer unsub()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go client.Run(ctx)

	gotSub, gotPoll := false, false
	deadline := time.After(2 * time.Second)
	for !gotSub || !gotPoll {
		select {
		case <-approvalCh:
			gotSub = true
		case <-triggerPoll:
			gotPoll = true
		case <-deadline:
			t.Fatalf("timed out: gotSub=%v gotPoll=%v", gotSub, gotPoll)
		}
	}
}

// Approval events WITHOUT a subscribed approvalID must still wake the
// poll loop — the whole point of the fix is that roles other than the
// approval-owner get woken.
func TestClient_ApprovalEventWakesPollEvenWithoutSubscriber(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)

	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		readSubscription(t, conn, ctx)
		event := Event{
			Type:      "approval.granted",
			Timestamp: "2026-04-24T00:00:00Z",
			EventID:   "evt-appr-solo",
			Payload:   EventPayload{ApprovalID: "apr-solo", Status: "approved"},
		}
		data, _ := json.Marshal(event)
		conn.Write(ctx, websocket.MessageText, data)
		time.Sleep(200 * time.Millisecond)
	})
	defer server.Close()

	client := newTestClient(server.URL, triggerPoll)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go client.Run(ctx)

	select {
	case <-triggerPoll:
		// woken without any subscription — expected new behavior
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for triggerPoll from approval event")
	}
}

// FIX #3 (approval park-and-continue): the runner no longer holds a
// synchronous SubscribeApproval wait — a parked approval is resumed by the
// poll cycle's parked-approval check. The load-bearing WS link is therefore
// that ANY approval.* event wakes the poll loop via triggerPoll EVEN WITH NO
// registered subscriber, so a human decision resumes the parked card on the
// next cycle instead of waiting out poll_interval.
func TestClient_ApprovalEventWakesPollLoopWithoutSubscription(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)

	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		readSubscription(t, conn, ctx)
		event := Event{
			Type:      "approval.decided",
			Timestamp: "2026-06-10T00:00:00Z",
			EventID:   "evt-appr-nosub",
			Payload:   EventPayload{ApprovalID: "apr-parked", Status: "approved"},
		}
		data, _ := json.Marshal(event)
		conn.Write(ctx, websocket.MessageText, data)
		time.Sleep(200 * time.Millisecond)
	})
	defer server.Close()

	// Deliberately NO SubscribeApproval registration.
	client := newTestClient(server.URL, triggerPoll)

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go client.Run(ctx)

	select {
	case <-triggerPoll:
		// Approval decision woke the poll loop — the parked-approval check runs.
	case <-time.After(2 * time.Second):
		t.Fatal("approval event must wake the poll loop even without a subscriber")
	}
}

// agent.restart_requested is the operator's "come back fresh" lever. It is
// directed exactly like agent.poll_requested — same target_agent_id contract —
// but it must reach a DIFFERENT channel: waking the poll loop would make a
// restart indistinguishable from a poll and the process would never exit.
func TestRouteEvent_AgentRestartRequested_SignalsForMatchingTarget(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)
	restart := make(chan struct{}, 1)
	c := &Client{
		agentID:          "agent-1",
		triggerPoll:      triggerPoll,
		restartRequested: restart,
	}

	c.routeEvent(Event{
		Type:    "agent.restart_requested",
		Payload: EventPayload{TargetAgentID: "agent-1"},
	})

	select {
	case <-restart:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("expected restart signal for matching target_agent_id")
	}

	select {
	case <-triggerPoll:
		t.Fatal("restart must not also wake the poll loop")
	default:
	}
}

func TestRouteEvent_AgentRestartRequested_IgnoredForOtherTarget(t *testing.T) {
	restart := make(chan struct{}, 1)
	c := &Client{
		agentID:          "agent-1",
		restartRequested: restart,
	}

	c.routeEvent(Event{
		Type:    "agent.restart_requested",
		Payload: EventPayload{TargetAgentID: "agent-2"},
	})

	select {
	case <-restart:
		t.Fatal("restarted on an event addressed to another agent")
	case <-time.After(100 * time.Millisecond):
	}
}

// A runner with no restart channel wired (WS enabled, restart plumbing absent)
// must drop the frame, not panic on a nil-channel send.
func TestRouteEvent_AgentRestartRequested_NoChannelIsSafe(t *testing.T) {
	c := &Client{agentID: "agent-1"}

	c.routeEvent(Event{
		Type:    "agent.restart_requested",
		Payload: EventPayload{TargetAgentID: "agent-1"},
	})
}

// Restart is directed at THIS agent, so it arrives stamped with the agent's own
// id. The self-suppression filter below the directed block would swallow it —
// the exact-match must come first.
func TestRouteEvent_AgentRestartRequested_SurvivesSelfSuppression(t *testing.T) {
	restart := make(chan struct{}, 1)
	c := &Client{
		agentID:          "agent-1",
		userID:           "user-1",
		restartRequested: restart,
	}

	c.routeEvent(Event{
		Type: "agent.restart_requested",
		Payload: EventPayload{
			TargetAgentID: "agent-1",
			AgentID:       "agent-1",
			ActorID:       "user-1",
		},
	})

	select {
	case <-restart:
	case <-time.After(200 * time.Millisecond):
		t.Fatal("self-suppression swallowed a restart directed at this agent")
	}
}
