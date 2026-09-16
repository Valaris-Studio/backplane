// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

// HealthProvider supplies runtime health information.
type HealthProvider interface {
	HealthStatus() string
	UptimeSeconds() int64
}

// CircuitBreakerProvider optionally exposes circuit breaker state.
// When the HealthProvider also implements this interface, /healthz
// includes blocked card details in the response.
type CircuitBreakerProvider interface {
	BlockedCardDetails() []valaris.BlockedCardInfo
}

// DefaultHealthBind keeps the unauthenticated health server off the LAN.
const DefaultHealthBind = "127.0.0.1"

// StartHealthServer starts a minimal HTTP server with /healthz and /pollnow endpoints.
// bind is the host to listen on; empty means DefaultHealthBind. The endpoints carry no
// auth and /healthz discloses blocked-card details, so exposing them beyond loopback
// must be an explicit operator choice (daemon.health_bind).
// The triggerPoll channel is optional — when nil, /pollnow returns 501.
// Returns the listener address (useful for tests with port 0) and any startup error.
// The server shuts down when ctx is cancelled.
func StartHealthServer(ctx context.Context, port int, bind string, hp HealthProvider, triggerPoll chan struct{}) (string, error) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		status := hp.HealthStatus()
		code := http.StatusOK
		if status == "draining" || status == "shutting_down" {
			code = http.StatusServiceUnavailable
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)

		body := map[string]any{
			"status":         status,
			"uptime_seconds": hp.UptimeSeconds(),
		}
		if cbp, ok := hp.(CircuitBreakerProvider); ok {
			if blocked := cbp.BlockedCardDetails(); len(blocked) > 0 {
				body["blocked_cards"] = blocked
			}
		}
		json.NewEncoder(w).Encode(body)
	})

	mux.HandleFunc("POST /pollnow", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if triggerPoll == nil {
			w.WriteHeader(http.StatusNotImplemented)
			json.NewEncoder(w).Encode(map[string]string{"status": "not_available"})
			return
		}
		select {
		case triggerPoll <- struct{}{}:
			json.NewEncoder(w).Encode(map[string]string{"status": "triggered"})
		default:
			w.WriteHeader(http.StatusConflict)
			json.NewEncoder(w).Encode(map[string]string{"status": "busy"})
		}
	})

	server := &http.Server{Handler: mux}

	if bind == "" {
		bind = DefaultHealthBind
	}

	ln, err := net.Listen("tcp", net.JoinHostPort(bind, strconv.Itoa(port)))
	if err != nil {
		return "", fmt.Errorf("health server listen: %w", err)
	}

	addr := ln.Addr().String()

	go func() {
		if err := server.Serve(ln); err != http.ErrServerClosed {
			slog.Error("health server error", "error", err)
		}
	}()

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		server.Shutdown(shutdownCtx)
	}()

	return addr, nil
}
