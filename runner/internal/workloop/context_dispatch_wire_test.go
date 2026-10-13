// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

const invocationWireRoot = "/api/workspaces/workspace/executions/" + runnerDispatchExecution

type invocationWireHTTP struct {
	fixture        *invocationHTTP
	mu             sync.Mutex
	requests       []string
	rejected       []string
	ackStatuses    []int
	replaySuccess  bool
	snapshotHeader string
}

func (w *invocationWireHTTP) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	isSnapshot := strings.HasSuffix(request.URL.Path, "/dispatch-context")
	isPreparation := strings.HasSuffix(request.URL.Path, "/dispatch-preparations")
	if !isSnapshot && !isPreparation {
		w.fixture.ServeHTTP(response, request)
		return
	}
	method, path := http.MethodGet, invocationWireRoot+"/dispatch-context"
	if isPreparation {
		method, path = http.MethodPost, invocationWireRoot+"/dispatch-preparations"
	}
	w.mu.Lock()
	w.requests = append(w.requests, request.Method+" "+request.URL.Path)
	w.mu.Unlock()
	if request.URL.Path != path || request.Method != method {
		w.mu.Lock()
		w.rejected = append(w.rejected, request.Method+" "+request.URL.Path)
		w.mu.Unlock()
		status := http.StatusMethodNotAllowed
		if request.URL.Path != path {
			status = http.StatusNotFound
		}
		http.Error(response, "wrong bound route or method", status)
		return
	}
	if isPreparation {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			http.Error(response, "unreadable body", http.StatusBadRequest)
			return
		}
		request.Body = io.NopCloser(bytes.NewReader(body))
		var fields map[string]json.RawMessage
		var channels struct {
			Resume bool `json:"resume"`
		}
		if json.Unmarshal(body, &fields) != nil || json.Unmarshal(fields["channel_contract"], &channels) != nil {
			http.Error(response, "invalid declaration", http.StatusUnprocessableEntity)
			return
		}
		// The API requires this member, and a fresh call must send null rather
		// than the empty string that an uninitialized Go string would encode.
		if !channels.Resume && string(fields["resume_session_id"]) != "null" {
			http.Error(response, "fresh resume_session_id must be null", http.StatusUnprocessableEntity)
			return
		}
	}
	wrapped := &invocationWireResponse{ResponseWriter: response, beforeHeader: func(status int) int {
		if isSnapshot {
			response.Header().Del(runnerDispatchHeader)
			if w.snapshotHeader != "" {
				response.Header().Set(runnerDispatchHeader, w.snapshotHeader)
			}
		}
		if isPreparation && status == http.StatusCreated {
			if w.replaySuccess {
				status = http.StatusOK
			}
			w.mu.Lock()
			w.ackStatuses = append(w.ackStatuses, status)
			w.mu.Unlock()
		}
		return status
	}}
	w.fixture.ServeHTTP(wrapped, request)
}

type invocationWireResponse struct {
	http.ResponseWriter
	beforeHeader func(int) int
}

func (w *invocationWireResponse) WriteHeader(status int) {
	w.ResponseWriter.WriteHeader(w.beforeHeader(status))
}

func (w *invocationWireResponse) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return w.ResponseWriter.(http.Hijacker).Hijack()
}

func newInvocationWireCase(t *testing.T, fixture *invocationHTTP) (*invocationCase, *invocationWireHTTP) {
	t.Helper()
	c := newInvocationCase(t, fixture, "continue_project")
	wire := &invocationWireHTTP{fixture: fixture, snapshotHeader: "1"}
	server := httptest.NewServer(wire)
	t.Cleanup(server.Close)
	client := valaris.NewClient(server.URL, "synthetic-key")
	client.Agent = c.loop.client.Agent
	c.loop.client = client
	return c, wire
}

func TestContextDispatchWireFreshPreparationUsesExactBoundRoutesAndNullResume(t *testing.T) {
	c, wire := newInvocationWireCase(t, newInvocationHTTP())
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.run(ctx); err != nil {
		t.Fatalf("valid exact-wire invocation: %v", err)
	}
	c.assertPreparedCall(t, invocationExpectedPrompt("Fresh card é"))
	wire.mu.Lock()
	defer wire.mu.Unlock()
	want := []string{"GET " + invocationWireRoot + "/dispatch-context", "POST " + invocationWireRoot + "/dispatch-preparations"}
	if !reflect.DeepEqual(wire.requests, want) || len(wire.rejected) != 0 {
		t.Errorf("actual bound requests = %v; rejected=%v", wire.requests, wire.rejected)
	}
	c.http.mu.Lock()
	defer c.http.mu.Unlock()
	resume, present := c.http.payloads[0]["resume_session_id"]
	if !present || resume != nil {
		t.Errorf("fresh preparation requires explicit null resume, got present=%t value=%#v", present, resume)
	}
}

func TestContextDispatchWireAcceptsReplay200WithUnchangedRequestIdentity(t *testing.T) {
	fixture := newInvocationHTTP()
	fixture.responses = []string{"close"}
	c, wire := newInvocationWireCase(t, fixture)
	wire.replaySuccess = true
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := c.run(ctx); err != nil {
		t.Fatalf("valid HTTP200 acknowledgement after ambiguous transport: %v", err)
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if len(fixture.queries) != 1 || len(fixture.payloads) != 2 {
		t.Fatalf("refresh/preparation counts=%d/%d, want1/2", len(fixture.queries), len(fixture.payloads))
	}
	if !reflect.DeepEqual(fixture.payloads[0], fixture.payloads[1]) {
		t.Error("HTTP200 retry changed the complete request identity")
	}
	call := c.current.LastCall()
	if c.current.CallCount() != 1 || c.stale.CallCount() != 0 || call == nil || call.Prompt != fixture.payloads[1]["input_prompt"] {
		t.Errorf("replay acknowledgement did not dispatch the prepared bytes exactly once: current=%d stale=%d", c.current.CallCount(), c.stale.CallCount())
	}
	wire.mu.Lock()
	defer wire.mu.Unlock()
	if !reflect.DeepEqual(wire.ackStatuses, []int{http.StatusOK}) {
		t.Errorf("control did not deliver HTTP200: %v", wire.ackStatuses)
	}
	// This checks runner wire handling only. The synthetic server does not
	// commit receipts; a real post-commit response loss is a separate API gate.
}

func TestContextDispatchWirePreservesActualFullCardRead(t *testing.T) {
	fixture := newInvocationHTTP()
	body, err := os.ReadFile("testdata/context_dispatch_card_read.json")
	if err != nil {
		t.Fatal(err)
	}
	var card map[string]any
	if err := json.Unmarshal(body, &card); err != nil {
		t.Fatal(err)
	}
	fixture.snapshot["card"] = card
	fixture.snapshot["dispatch"].(map[string]any)["input_template"] = `{{ index .Card "title" }}|{{ index .Card "column_type" }}|{{ index .Card "position" }}|{{if eq (index .Card "due_date") nil}}null{{end}}|{{ index .Card "has_pending_approval" }}|{{ index .Card "depends_on_count" }}|{{ index (index .Card "labels") 1 }}|{{ index (index (index .Card "participants") 0) "pipeline_role" }}|{{ index (index (index (index .Card "participants") 0) "user") "name" }}|{{ index (index (index (index .Card "participants") 0) "agent") "name" }}|{{if eq (index (index (index (index .Card "participants") 0) "user") "avatar_url") nil}}null{{end}}|{{ index .Card "description" }}|{{ index .ContextSources "approved" }}`
	c, _ := newInvocationWireCase(t, fixture)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := c.run(ctx); err != nil {
		t.Fatal(err)
	}
	want := "Actual card é🧪|backlog|1041.25|null|true|2|🧪|operator-research-47|Reader é|Configured agent 🧪|null|" + card["description"].(string) + "|" + invocationSource
	c.assertPreparedCall(t, want)
}

func TestContextDispatchWireRejectsInvalidSnapshotBeforePreparation(t *testing.T) {
	for _, name := range []string{
		"wrong_execution", "wrong_bound_card", "wrong_bound_agent", "wrong_bound_workspace", "wrong_bound_reservation", "wrong_bound_role",
		"unsupported_protocol", "missing_header", "unsupported_header", "dispatch_not_object", "missing_input_template", "invalid_required_indices",
	} {
		t.Run(name, func(t *testing.T) {
			fixture := newInvocationHTTP()
			binding := fixture.snapshot["context_binding"].(map[string]any)
			switch name {
			case "wrong_execution":
				fixture.snapshot["execution_id"] = runnerDispatchCard
			case "wrong_bound_card":
				binding["card_id"] = runnerDispatchBoard
			case "wrong_bound_agent":
				binding["agent_id"] = runnerDispatchCard
			case "wrong_bound_workspace":
				binding["workspace_id"] = runnerDispatchBoard
			case "wrong_bound_reservation":
				binding["reservation_id"] = runnerDispatchCard
			case "wrong_bound_role":
				binding["role"] = "another-configured-role"
			case "unsupported_protocol":
				fixture.snapshot["protocol_version"] = 2
			case "dispatch_not_object":
				fixture.snapshot["dispatch"] = []any{}
			case "missing_input_template":
				delete(fixture.snapshot["dispatch"].(map[string]any), "input_template")
			case "invalid_required_indices":
				fixture.snapshot["dispatch"].(map[string]any)["required_source_indices"] = []int{1}
			}
			c, wire := newInvocationWireCase(t, fixture)
			if name == "missing_header" {
				wire.snapshotHeader = ""
			} else if name == "unsupported_header" {
				wire.snapshotHeader = "2"
			}
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			if err := c.run(ctx); err == nil {
				t.Error("invalid required snapshot accepted")
			}
			fixture.mu.Lock()
			defer fixture.mu.Unlock()
			if len(fixture.queries) != 1 || len(fixture.payloads) != 0 || c.current.CallCount()+c.stale.CallCount() != 0 {
				t.Errorf("invalid snapshot escaped its boundary: refresh=%d prepare=%d current=%d stale=%d", len(fixture.queries), len(fixture.payloads), c.current.CallCount(), c.stale.CallCount())
			}
		})
	}
}

func TestContextDispatchWireFixtureRefusesWrongRoutesAndMethods(t *testing.T) {
	fixture := newInvocationHTTP()
	wire := &invocationWireHTTP{fixture: fixture, snapshotHeader: "1"}
	for _, test := range []struct {
		method, path string
		status       int
	}{
		{http.MethodPost, invocationWireRoot + "/dispatch-context", http.StatusMethodNotAllowed},
		{http.MethodGet, invocationWireRoot + "/dispatch-preparations", http.StatusMethodNotAllowed},
		{http.MethodGet, "/api/workspaces/foreign/executions/" + runnerDispatchExecution + "/dispatch-context", http.StatusNotFound},
		{http.MethodPost, "/api/agents/" + runnerDispatchAgent + "/executions/" + runnerDispatchExecution + "/dispatch-preparations", http.StatusNotFound},
	} {
		response := httptest.NewRecorder()
		wire.ServeHTTP(response, httptest.NewRequest(test.method, test.path, strings.NewReader("{}")))
		if response.Code != test.status {
			t.Errorf("%s %s: status=%d want%d", test.method, test.path, response.Code, test.status)
		}
	}
	if len(fixture.queries)+len(fixture.payloads) != 0 {
		t.Error("rejected wire reached permissive inherited fixture")
	}
}
