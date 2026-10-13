// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"bytes"
	"net/http"
	"testing"
)

func TestQueueFlush_AnswersScheduledWhenTheBackendSchedulesARetry(t *testing.T) {
	server := newTestServer(t, nil)
	server.backend.flush = QueueFlush{Scheduled: true}
	reply := server.do(t, "POST", "/v1/queue/flush", "")
	if reply.status != 200 || string(bytes.TrimSpace(reply.body)) != `{"scheduled":true}` || server.backend.flushes.Load() != 1 {
		t.Fatalf("flush: %d %s", reply.status, reply.body)
	}
}

func TestQueueFlush_NoOpAnswersNotScheduledWithTheReason(t *testing.T) {
	for _, reason := range []string{FlushReasonQueueEmpty, FlushReasonNotConnected, FlushReasonRevoked, FlushReasonDaemonNotRunning} {
		server := newTestServer(t, nil)
		server.backend.flush = QueueFlush{Reason: reason}
		reply := server.do(t, "POST", "/v1/queue/flush", "")
		if reply.status != 200 || string(bytes.TrimSpace(reply.body)) != `{"scheduled":false,"reason":"`+reason+`"}` {
			t.Fatalf("%s: %d %s", reason, reply.status, reply.body)
		}
	}
}

func TestQueueFlush_BackendErrorIsAnEnvelope(t *testing.T) {
	server := newTestServer(t, nil)
	server.backend.flushErr = errFakeNotConnected
	reply := server.do(t, "POST", "/v1/queue/flush", "")
	if reply.status != http.StatusConflict || reply.errorCode(t) != "not_connected" {
		t.Fatalf("flush error: %d %s", reply.status, reply.body)
	}
}

func TestQueueFlush_WrongMethodIsANotFoundEnvelope(t *testing.T) {
	server := newTestServer(t, nil)
	reply := server.do(t, "GET", "/v1/queue/flush", "")
	if reply.status != http.StatusNotFound || reply.errorCode(t) != CodeNotFound || server.backend.flushes.Load() != 0 {
		t.Fatalf("GET /v1/queue/flush: %d %s", reply.status, reply.body)
	}
}
