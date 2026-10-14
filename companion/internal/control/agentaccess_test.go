// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

// fakeAgentAccess answers the AgentAccess shape for known mappings.
type fakeAgentAccess struct {
	mu      sync.Mutex
	enabled map[string]bool
	sets    int
	setErr  error
}

func newFakeAgentAccess() *fakeAgentAccess {
	return &fakeAgentAccess{enabled: map[string]bool{"m1": false, "auto": false}}
}

func (f *fakeAgentAccess) snapshot() map[string]any {
	mappings := []any{}
	for _, id := range []string{"m1", "auto"} {
		mappings = append(mappings, map[string]any{"mapping_id": id, "enabled": f.enabled[id], "agents": []any{}})
	}
	return map[string]any{"key": map[string]any{"present": f.enabled["m1"], "key_prefix": nil, "server_state": "unknown"}, "prerequisites": map[string]any{"uvx": true}, "mappings": mappings, "warnings": []any{}}
}

func (f *fakeAgentAccess) AgentAccess(context.Context) (any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snapshot(), nil
}

func (f *fakeAgentAccess) SetAgentAccess(_ context.Context, id string, enabled bool) (any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.sets++
	if f.setErr != nil {
		return nil, f.setErr
	}
	if _, known := f.enabled[id]; !known {
		return nil, &Error{Status: http.StatusNotFound, Code: CodeNotFound, Message: "no such mapping"}
	}
	if id == "auto" && enabled {
		return nil, &Error{Status: http.StatusConflict, Code: CodeMappingRootUnknown, Message: "folder unknown"}
	}
	f.enabled[id] = enabled
	return f.snapshot(), nil
}

func agentAccessServer(t *testing.T) (*testServer, *fakeAgentAccess) {
	t.Helper()
	access := newFakeAgentAccess()
	server := newTestServer(t, func(config *Config) { config.AgentAccess = access })
	return server, access
}

func TestControl_AgentAccessGet_ReturnsTheSnapshot(t *testing.T) {
	server, _ := agentAccessServer(t)
	reply := server.do(t, "GET", "/v1/agent-access", "")
	body := reply.json(t)
	if reply.status != http.StatusOK || body["mappings"] == nil || body["warnings"] == nil {
		t.Fatalf("GET %d %s", reply.status, reply.body)
	}
}

func TestControl_AgentAccessPut_Idempotent(t *testing.T) {
	server, access := agentAccessServer(t)
	stream := server.subscribe(t)
	stream.next(t, "agent_access")
	first := server.do(t, "PUT", "/v1/mappings/m1/agent-access", `{"enabled":true}`)
	second := server.do(t, "PUT", "/v1/mappings/m1/agent-access", `{"enabled":true}`)
	if first.status != http.StatusOK || second.status != http.StatusOK || string(first.body) != string(second.body) {
		t.Fatalf("PUT not idempotent: %d %s / %d %s", first.status, first.body, second.status, second.body)
	}
	if access.sets != 2 || !access.enabled["m1"] {
		t.Fatalf("service calls %d", access.sets)
	}
	event := stream.next(t, "agent_access")
	var published map[string]any
	if json.Unmarshal([]byte(event.data), &published) != nil || published["key"].(map[string]any)["present"] != true {
		t.Fatalf("published %s", event.data)
	}
}

func TestControl_AgentAccessPut_UnknownMappingIsNotFound(t *testing.T) {
	server, _ := agentAccessServer(t)
	reply := server.do(t, "PUT", "/v1/mappings/nope/agent-access", `{"enabled":true}`)
	if reply.status != http.StatusNotFound || reply.errorCode(t) != CodeNotFound {
		t.Fatalf("unknown mapping %d %s", reply.status, reply.body)
	}
}

func TestControl_AgentAccessPut_UnknownRootIsConflict(t *testing.T) {
	server, _ := agentAccessServer(t)
	reply := server.do(t, "PUT", "/v1/mappings/auto/agent-access", `{"enabled":true}`)
	if reply.status != http.StatusConflict || reply.errorCode(t) != CodeMappingRootUnknown {
		t.Fatalf("unknown root %d %s", reply.status, reply.body)
	}
}

func TestControl_AgentAccessPut_RequiresABooleanEnabled(t *testing.T) {
	server, access := agentAccessServer(t)
	for _, body := range []string{`{}`, `{"enabled":"yes"}`, `{"enabled":true,"extra":1}`, `not json`} {
		reply := server.do(t, "PUT", "/v1/mappings/m1/agent-access", body)
		if reply.status != http.StatusBadRequest || reply.errorCode(t) != CodeInvalidRequest {
			t.Errorf("body %s: %d %s", body, reply.status, reply.body)
		}
	}
	if access.sets != 0 {
		t.Fatal("an invalid body reached the service")
	}
}

func TestControl_AgentAccessPut_UnreachableServerIsBadGateway(t *testing.T) {
	server, access := agentAccessServer(t)
	access.setErr = uplink.ErrUnavailable
	reply := server.do(t, "PUT", "/v1/mappings/m1/agent-access", `{"enabled":true}`)
	if reply.status != http.StatusBadGateway || reply.errorCode(t) != CodeServerUnreachable {
		t.Fatalf("unreachable %d %s", reply.status, reply.body)
	}
}

func TestControl_AgentAccessUnavailableWithoutAService(t *testing.T) {
	server := newTestServer(t, nil)
	for _, request := range [][2]string{{"GET", "/v1/agent-access"}, {"PUT", "/v1/mappings/m1/agent-access"}} {
		reply := server.do(t, request[0], request[1], `{"enabled":true}`)
		if reply.status != http.StatusNotImplemented {
			t.Errorf("%s %s: %d", request[0], request[1], reply.status)
		}
	}
}

func TestSSE_AgentAccessAfterAttentionOnConnect(t *testing.T) {
	server, _ := agentAccessServer(t)
	stream := server.subscribe(t)
	var kinds []string
	deadline := time.After(3 * time.Second)
	for len(kinds) < 3 {
		select {
		case event := <-stream.events:
			if event.kind != ":" {
				kinds = append(kinds, event.kind)
			}
		case <-deadline:
			t.Fatalf("events so far %v", kinds)
		}
	}
	if kinds[0] != "status" || kinds[1] != "attention" || kinds[2] != "agent_access" {
		t.Fatalf("connect events %v", kinds)
	}
}

func TestSSE_NoAgentAccessEventWithoutAService(t *testing.T) {
	server := newTestServer(t, nil)
	stream := server.subscribe(t)
	stream.next(t, "attention")
	server.Publish("probe", map[string]any{})
	deadline := time.After(3 * time.Second)
	for {
		select {
		case event := <-stream.events:
			switch event.kind {
			case "agent_access":
				t.Fatal("agent_access sent without a service")
			case "probe":
				return
			}
		case <-deadline:
			t.Fatal("stream stalled")
		}
	}
}
