// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package events

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"nhooyr.io/websocket"
)

// Client connects to the Valaris backend WebSocket endpoint and routes events
// to the work loop (via triggerPoll) and approval subscribers.
type Client struct {
	url         string
	apiKey      string
	agentID     string
	userID      string
	triggerPoll chan<- struct{}
	// restartRequested receives one signal per agent.restart_requested frame
	// addressed to this agent. Deliberately separate from triggerPoll: a
	// restart that merely woke the poll loop would be indistinguishable from
	// a poll and the process would never exit. nil when unwired — the send
	// is guarded, so a restart frame is dropped rather than panicking.
	restartRequested chan<- struct{}
	approvalSubs     map[string]chan<- struct{}
	mu               sync.Mutex
	reconnectMin     time.Duration
	reconnectMax     time.Duration
	connected        atomic.Bool

	// conn is the live WebSocket connection; held so outbound frames
	// (heartbeat, future control messages) can be written from goroutines
	// other than the receive loop. writeMu serializes Write calls per the
	// nhooyr.io/websocket contract. Both are nil between connections; a
	// single Write holds writeMu while reading conn.
	conn    *websocket.Conn
	writeMu sync.Mutex

	// keepaliveInterval is how often a live idle connection emits a
	// protocol-level ping so Cloud Run / the load balancer never closes it as
	// idle. Overridable in tests via SetKeepaliveInterval.
	keepaliveInterval time.Duration
	// onKeepalive, when set, is invoked each time a keepalive ping is sent.
	// Test hook only — nil in production.
	onKeepalive func()

	// loopBoardWake is loop mode's wake signal, set via SetLoopBoardWake. Nil
	// in pipeline mode, which subscribes to the same topics but has no board
	// to wake for.
	loopBoardWake chan<- struct{}
	loopBoardID   string
}

// subscribePatterns is the topic list the client asks the backend to route.
// The backend fnmatch-matches event names against these, so an event type
// absent from this list never reaches routeEvent at all.
func subscribePatterns() []string {
	return []string{"card.*", "approval.*", "execution.*", "config.*", "agent.*", "board.*", "completion.*"}
}

// SetLoopBoardWake wires loop mode's wake channel: board.loop_updated for
// boardID with enabled=true sends a coalescing signal on wake, so a runner
// idling on a paused board resumes the moment an operator flips it back on
// instead of waiting out its poll fallback.
func (c *Client) SetLoopBoardWake(boardID string, wake chan<- struct{}) {
	c.loopBoardID = boardID
	c.loopBoardWake = wake
}

// defaultKeepaliveInterval keeps an idle WebSocket warm well under Cloud Run's
// ~300s idle-connection timeout. Without it the connection is closed every
// 5 minutes while the runner is idle, producing a reconnect storm.
const defaultKeepaliveInterval = 2 * time.Minute

// NewClient creates a WebSocket event client.
// triggerPoll is the Loop's TriggerPoll channel — card/execution/config events wake the work loop.
// agentID is this agent's UUID and userID is the authenticated user's UUID — events
// caused by this runner are ignored to prevent self-triggering poll storms. Both are
// needed because the backend stamps execution.* events with agent_id but stamps
// card.*/note.*/config.* events with actor_id=user.id; filtering on agentID alone
// lets self-caused card mutations re-trigger polls forever (see the post-merge storm).
func NewClient(apiURL, apiKey, workspaceSlug, agentID, userID string, triggerPoll chan<- struct{}) *Client {
	wsURL := strings.Replace(apiURL, "https://", "wss://", 1)
	wsURL = strings.Replace(wsURL, "http://", "ws://", 1)
	// The key rides the Authorization header (see connectAndListen's Dial),
	// not a ?token= query param — query strings land in proxy/access logs,
	// leaking agent API keys to any self-hosted plain-nginx setup.
	wsURL = fmt.Sprintf("%s/ws/workspaces/%s/events", wsURL, workspaceSlug)

	return &Client{
		url:               wsURL,
		apiKey:            apiKey,
		agentID:           agentID,
		userID:            userID,
		triggerPoll:       triggerPoll,
		approvalSubs:      make(map[string]chan<- struct{}),
		reconnectMin:      1 * time.Second,
		reconnectMax:      30 * time.Second,
		keepaliveInterval: defaultKeepaliveInterval,
	}
}

// SetReconnectTiming overrides default reconnect intervals (useful for testing).
func (c *Client) SetReconnectTiming(min, max time.Duration) {
	c.reconnectMin = min
	c.reconnectMax = max
}

// SetRestartRequested wires the channel that an operator-issued restart signals.
// Kept out of NewClient's already-long positional signature; a runner that never
// calls it simply ignores agent.restart_requested.
func (c *Client) SetRestartRequested(ch chan<- struct{}) {
	c.restartRequested = ch
}

// SetKeepaliveInterval overrides the idle-connection keepalive period (testing).
func (c *Client) SetKeepaliveInterval(d time.Duration) {
	c.keepaliveInterval = d
}

// Run connects to the WebSocket and processes events until ctx is cancelled.
// Reconnects automatically with exponential backoff on disconnect.
func (c *Client) Run(ctx context.Context) error {
	attempt := 0
	for {
		connectedAt := time.Now()
		err := c.connectAndListen(ctx)
		if ctx.Err() != nil {
			return ctx.Err()
		}

		// A connection that stayed up longer than the max reconnect delay was a
		// real, healthy session; restart backoff from reconnectMin so a
		// long-lived conn that later drops doesn't reconnect at the 30s cap. A
		// conn that fails inside that window keeps escalating, so a tight
		// dial-fail loop still backs off.
		if time.Since(connectedAt) > c.reconnectMax {
			attempt = 0
		}

		delay := c.backoff(attempt)
		attempt++
		slog.Warn("websocket disconnected, reconnecting", "error", err, "delay", delay)

		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(delay):
		}
	}
}

func (c *Client) connectAndListen(ctx context.Context) error {
	dialOpts := &websocket.DialOptions{
		HTTPHeader: http.Header{
			"Authorization": {"Bearer " + c.apiKey},
		},
	}
	conn, _, err := websocket.Dial(ctx, c.url, dialOpts)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.CloseNow()

	c.mu.Lock()
	c.conn = conn
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.conn = nil
		c.mu.Unlock()
	}()

	c.connected.Store(true)
	slog.Info("websocket connected", "url", c.url)

	// Keepalive: while idle the client writes no frames, so Cloud Run closes
	// the connection at its ~300s idle timeout. A protocol-level ping every
	// keepaliveInterval keeps it warm. The goroutine is bound to keepaliveCtx,
	// cancelled when this function returns (conn dies), so no goroutine leaks
	// across reconnects. conn.Ping is concurrency-safe with the read loop (it
	// waits for the Reader below to read the pong) and needs no writeMu.
	keepaliveCtx, stopKeepalive := context.WithCancel(ctx)
	defer stopKeepalive()
	go c.runKeepalive(keepaliveCtx, conn)

	// Subscribe to event topics the runner cares about.
	subscribeMsg := map[string]any{
		"subscribe": subscribePatterns(),
	}
	data, _ := json.Marshal(subscribeMsg)
	c.writeMu.Lock()
	err = conn.Write(ctx, websocket.MessageText, data)
	c.writeMu.Unlock()
	if err != nil {
		c.connected.Store(false)
		return fmt.Errorf("subscribe: %w", err)
	}

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			c.connected.Store(false)
			return fmt.Errorf("read: %w", err)
		}

		// Handle application-level ping/pong (separate from WebSocket protocol ping).
		var msg map[string]any
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		if msg["type"] == "ping" {
			pong, _ := json.Marshal(map[string]string{"type": "pong"})
			c.writeMu.Lock()
			_ = conn.Write(ctx, websocket.MessageText, pong)
			c.writeMu.Unlock()
			continue
		}

		var event Event
		if err := json.Unmarshal(data, &event); err != nil {
			slog.Warn("failed to parse websocket event", "error", err)
			continue
		}
		if event.Type == "" {
			continue
		}

		c.routeEvent(event)
	}
}

// runKeepalive pings the peer every keepaliveInterval until ctx is cancelled
// (which happens when connectAndListen returns and the connection is torn down).
// A failed ping is left to the read loop to surface as a disconnect.
func (c *Client) runKeepalive(ctx context.Context, conn *websocket.Conn) {
	ticker := time.NewTicker(c.keepaliveInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := conn.Ping(ctx); err != nil {
				slog.Debug("keepalive ping failed", "error", err)
				return
			}
			if c.onKeepalive != nil {
				c.onKeepalive()
			}
		}
	}
}

func (c *Client) routeEvent(event Event) {
	// Directed agent events addressed via target_agent_id. Exact-match only —
	// future agent.* events (e.g. agent.heartbeat_ack) must not fall through
	// to the generic prefix cases below.
	if event.Type == "agent.poll_requested" {
		if c.agentID == "" || event.Payload.TargetAgentID != c.agentID {
			return
		}
		select {
		case c.triggerPoll <- struct{}{}:
		default:
			// Channel full — poll already pending
		}
		return
	}

	if event.Type == "agent.restart_requested" {
		if c.agentID == "" || event.Payload.TargetAgentID != c.agentID {
			return
		}
		if c.restartRequested == nil {
			slog.Warn("restart requested but no restart channel is wired — ignoring")
			return
		}
		slog.Info("restart requested by operator — draining after the in-flight card")
		select {
		case c.restartRequested <- struct{}{}:
		default:
			// Channel full — a drain is already under way.
		}
		return
	}

	// Completion acknowledgments may create the next phase on this same
	// runner. Their wake must precede the self-event filter.
	if event.Type == "completion.updated" {
		if c.loopBoardWake != nil && event.Payload.BoardID == c.loopBoardID {
			select {
			case c.loopBoardWake <- struct{}{}:
			default:
			}
		}
		return
	}

	// Skip events caused by this runner to prevent self-triggering poll loops.
	// When multiple agents share a workspace, each agent's mutations generate events
	// that all agents receive. Without this filter, agents enter an infinite
	// discover→event→discover cycle.
	//
	// Two IDs because the backend stamps events inconsistently: execution.* events
	// carry agent_id (== this agent), while card.*/note.*/config.* events carry
	// actor_id = user.id (the authenticated user, NOT the agent). Matching agentID
	// alone misses self-caused card mutations — exactly what produced the ~13/s
	// post-merge poll storm. userID closes that gap.
	if c.agentID != "" && (event.Payload.AgentID == c.agentID || event.Payload.ActorID == c.agentID) {
		return
	}
	if c.userID != "" && event.Payload.ActorID == c.userID {
		return
	}

	// Loop mode's wake. Deliberately NOT a "board." prefix case: this payload
	// carries no actor_id, so the self-filter above is inert for it and the
	// enabled==true gate is the ONLY thing separating an operator's re-enable
	// (wake) from the runner's own rail-tripped disable (must not wake). A nil
	// Enabled means the key was absent — unknown, so no wake.
	if event.Type == "board.loop_updated" {
		if c.loopBoardWake == nil || event.Payload.BoardID != c.loopBoardID {
			return
		}
		if event.Payload.Enabled == nil || !*event.Payload.Enabled {
			return
		}
		select {
		case c.loopBoardWake <- struct{}{}:
		default:
			// Channel full — a wake is already pending.
		}
		return
	}

	switch {
	case strings.HasPrefix(event.Type, "card."),
		strings.HasPrefix(event.Type, "execution."),
		strings.HasPrefix(event.Type, "config."):
		select {
		case c.triggerPoll <- struct{}{}:
		default:
			// Channel full — poll already pending
		}

	case strings.HasPrefix(event.Type, "approval."):
		approvalID := event.Payload.ApprovalID
		if approvalID == "" {
			approvalID = event.Payload.EntityID
		}
		if approvalID == "" {
			return
		}
		c.mu.Lock()
		ch, ok := c.approvalSubs[approvalID]
		c.mu.Unlock()
		if ok {
			select {
			case ch <- struct{}{}:
			default:
			}
		}
		// Card 54bea6b8: also wake the poll loop so roles that could now
		// claim a newly-unblocked card don't wait out the full poll
		// interval. The self-originated filter above already prevents
		// loops when the actor is this agent; approval decisions almost
		// always come from a human actor, so this passes cleanly.
		select {
		case c.triggerPoll <- struct{}{}:
		default:
		}
	}
}

// SubscribeApproval registers a channel to receive a signal when events for
// the given approval ID arrive. Returns an unsubscribe function.
// The channel receives struct{} signals — callers do a confirming HTTP fetch.
func (c *Client) SubscribeApproval(approvalID string, ch chan<- struct{}) func() {
	c.mu.Lock()
	c.approvalSubs[approvalID] = ch
	c.mu.Unlock()
	return func() {
		c.mu.Lock()
		delete(c.approvalSubs, approvalID)
		c.mu.Unlock()
	}
}

// Connected returns whether the client currently has an active WebSocket connection.
func (c *Client) Connected() bool {
	return c.connected.Load()
}

// SendHeartbeat writes a heartbeat frame on the live WebSocket connection.
// Returns ErrNotConnected when there is no active connection so callers can
// skip the heartbeat cycle; the backend treats missing heartbeats as offline
// regardless, so there's no point queueing frames for reconnect.
func (c *Client) SendHeartbeat(ctx context.Context, payload any) error {
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()
	if conn == nil {
		return ErrNotConnected
	}

	frame := map[string]any{
		"type":    "heartbeat",
		"payload": payload,
	}
	data, err := json.Marshal(frame)
	if err != nil {
		return fmt.Errorf("marshaling heartbeat: %w", err)
	}

	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if err := conn.Write(ctx, websocket.MessageText, data); err != nil {
		return fmt.Errorf("writing heartbeat frame: %w", err)
	}
	return nil
}

// ErrNotConnected is returned by SendHeartbeat when the WebSocket is not live.
var ErrNotConnected = fmt.Errorf("websocket not connected")

func (c *Client) backoff(attempt int) time.Duration {
	delay := c.reconnectMin
	for i := 0; i < attempt; i++ {
		delay *= 2
		if delay > c.reconnectMax {
			delay = c.reconnectMax
			break
		}
	}
	return delay
}
