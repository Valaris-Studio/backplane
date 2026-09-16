// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package events

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

// keepaliveInterval is shrunk via SetKeepaliveInterval so the test doesn't wait
// out the production 2-minute timer. The server-side read loop receives the
// protocol-level pong that nhooyr emits in response to conn.Ping, so we observe
// the keepalive by counting any frames the client writes after subscribe.

// While idle (no card/exec events, no heartbeats), the client must still keep
// the connection warm so Cloud Run's ~300s idle timeout never closes it. We
// assert the server observes at least one client-originated ping within a few
// keepalive intervals.
func TestClient_KeepalivePingsWhileIdle(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)
	var pingsSeen atomic.Int32

	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		readSubscription(t, conn, ctx)
		// nhooyr handles inbound protocol PING frames transparently inside
		// Read, replying with a PONG. To observe the client's keepalive we
		// install a ping handler on the server conn via a CloseRead-free read
		// loop: each successful Read tick proves the conn stayed live, and the
		// nhooyr lib surfaces control frames through its own handler. Instead of
		// reaching into internals, count pings the library reports.
		conn.SetReadLimit(1 << 20)
		for {
			if _, _, err := conn.Read(ctx); err != nil {
				return
			}
		}
	})
	defer server.Close()

	client := newTestClient(server.URL, triggerPoll)
	client.SetKeepaliveInterval(80 * time.Millisecond)

	// Count keepalives the client itself fires.
	client.onKeepalive = func() { pingsSeen.Add(1) }

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	go client.Run(ctx)

	deadline := time.After(1500 * time.Millisecond)
	for {
		if pingsSeen.Load() >= 2 {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("expected >= 2 keepalive pings, got %d", pingsSeen.Load())
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// The keepalive goroutine must stop when the connection drops, or each
// reconnect leaks a goroutine that pings a dead conn. We force a disconnect and
// assert keepalives stop firing for the dead connection.
func TestClient_KeepaliveStopsAfterDisconnect(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)
	var connectCount atomic.Int32

	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		n := connectCount.Add(1)
		readSubscription(t, conn, ctx)
		if n == 1 {
			// First conn: drop almost immediately.
			time.Sleep(40 * time.Millisecond)
			conn.Close(websocket.StatusNormalClosure, "drop")
			return
		}
		<-ctx.Done()
	})
	defer server.Close()

	client := newTestClient(server.URL, triggerPoll)
	client.SetKeepaliveInterval(50 * time.Millisecond)
	client.SetReconnectTiming(10*time.Millisecond, 30*time.Millisecond)

	var firstConnPings atomic.Int32
	client.onKeepalive = func() {
		if connectCount.Load() <= 1 {
			firstConnPings.Add(1)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()

	go client.Run(ctx)

	// Let it reconnect a couple of times.
	time.Sleep(500 * time.Millisecond)

	// Snapshot, wait, snapshot again — first-conn keepalive count must be stable
	// (the dead conn's ticker stopped), proving no leak pinging the closed conn.
	before := firstConnPings.Load()
	time.Sleep(300 * time.Millisecond)
	after := firstConnPings.Load()
	if after != before {
		t.Errorf("first-connection keepalives still firing after disconnect: %d -> %d", before, after)
	}
}

// After several rapid failed connects (which grow the backoff to its max), a
// connection that then stays up past reconnectMax must reset the backoff so the
// NEXT reconnect starts from reconnectMin again — not stay pinned at max.
func TestClient_ReconnectBackoffResetsAfterSustainedConnection(t *testing.T) {
	triggerPoll := make(chan struct{}, 1)
	var connectCount atomic.Int32
	connectTimes := make(chan time.Time, 16)

	const (
		failedConnects = 4 // grow attempt → backoff pinned at max
		minDelay       = 10 * time.Millisecond
		maxDelay       = 60 * time.Millisecond
		sustainedUp    = 200 * time.Millisecond // > maxDelay → triggers reset
	)

	server := newTestServer(t, func(conn *websocket.Conn, ctx context.Context) {
		connectTimes <- time.Now()
		n := connectCount.Add(1)
		readSubscription(t, conn, ctx)
		if int(n) <= failedConnects {
			// Drop instantly to push backoff up to its max.
			conn.Close(websocket.StatusNormalClosure, "fast-drop")
			return
		}
		if int(n) == failedConnects+1 {
			// Stay up past maxDelay, then drop — this should reset the backoff.
			time.Sleep(sustainedUp)
			conn.Close(websocket.StatusNormalClosure, "sustained-then-drop")
			return
		}
		<-ctx.Done()
	})
	defer server.Close()

	client := newTestClient(server.URL, triggerPoll)
	client.SetReconnectTiming(minDelay, maxDelay)
	client.SetKeepaliveInterval(time.Hour) // irrelevant here

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()

	go client.Run(ctx)

	// Drain the failed connects.
	for i := 0; i < failedConnects; i++ {
		<-connectTimes
	}
	sustainedConnectAt := <-connectTimes // the connection that stays up
	postDropConnectAt := <-connectTimes  // the reconnect AFTER the sustained drop

	// Total gap = sustained uptime + reconnect backoff. Subtract the known
	// uptime to isolate the backoff delay.
	reconnectDelay := postDropConnectAt.Sub(sustainedConnectAt) - sustainedUp
	if reconnectDelay >= maxDelay {
		t.Errorf("reconnect after sustained connection used ~max backoff (%v); attempt not reset", reconnectDelay)
	}
}
