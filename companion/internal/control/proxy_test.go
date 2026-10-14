// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/uplink"
)

const contractToken = "bpc_contract_c_device_token_0123456789"

// contractC is an in-process fake of the device self-service endpoints
// (contract section C), backed by a small in-memory model.
type contractC struct {
	mu       sync.Mutex
	mappings map[string]map[string]any
	settings map[string]any
	revoked  bool
	fail     int
	// failBody is what fail answers, by default an opaque upstream code.
	failBody map[string]any
	requests []string
	bodies   []map[string]any
}

func newContractC(t *testing.T) (*contractC, *httptest.Server) {
	t.Helper()
	fake := &contractC{mappings: map[string]map[string]any{}, settings: map[string]any{"paused": false, "auto_match_repos": true, "enabled_agents": nil, "exclude_globs": []any{}, "retention_days": nil}}
	server := httptest.NewServer(http.HandlerFunc(fake.handle))
	t.Cleanup(server.Close)
	return fake, server
}

func (c *contractC) reply(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if body != nil {
		json.NewEncoder(w).Encode(body)
	}
}

func (c *contractC) handle(w http.ResponseWriter, r *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.requests = append(c.requests, r.Method+" "+r.URL.EscapedPath()+queryOf(r))
	var body map[string]any
	if raw, _ := io.ReadAll(r.Body); len(raw) > 0 {
		json.Unmarshal(raw, &body)
	}
	c.bodies = append(c.bodies, body)
	switch {
	case c.revoked || r.Header.Get("Authorization") != "Bearer "+contractToken:
		c.reply(w, 401, map[string]any{"detail": "Invalid or revoked device token", "error_code": "invalid_device_token"})
		return
	case c.fail != 0 && c.failBody != nil:
		c.reply(w, c.fail, c.failBody)
		return
	case c.fail != 0:
		c.reply(w, c.fail, map[string]any{"detail": "upstream", "error_code": "upstream_code"})
		return
	}
	path := r.URL.Path
	switch {
	case r.Method == "GET" && path == "/api/companion/boards":
		c.reply(w, 200, map[string]any{"workspaces": []any{map[string]any{"id": "w1", "slug": "acme", "name": "Acme", "boards": []any{map[string]any{"id": "b1", "name": "App", "repos": []any{"github.com/acme/app"}}}}}})
	case r.Method == "GET" && path == "/api/companion/mappings":
		list := []any{}
		for _, mapping := range c.mappings {
			list = append(list, mapping)
		}
		c.reply(w, 200, list)
	case r.Method == "POST" && path == "/api/companion/mappings":
		if body["root_path"] == nil && body["repo_url"] == nil {
			c.reply(w, 422, map[string]any{"detail": "root_path or repo_url required", "error_code": "validation_error"})
			return
		}
		mapping := map[string]any{"id": "m1", "workspace_id": body["workspace_id"], "board_id": body["board_id"], "root_path": body["root_path"], "content_level": body["content_level"], "enabled": true, "origin": "explicit"}
		c.mappings["m1"] = mapping
		c.reply(w, 201, mapping)
	case strings.HasPrefix(path, "/api/companion/mappings/"):
		id := strings.TrimPrefix(path, "/api/companion/mappings/")
		mapping, ok := c.mappings[id]
		if !ok {
			c.reply(w, 404, map[string]any{"detail": "Not found", "error_code": "not_found"})
			return
		}
		if r.Method == "DELETE" {
			delete(c.mappings, id)
			w.WriteHeader(204)
			return
		}
		for key, value := range body {
			mapping[key] = value
		}
		c.reply(w, 200, mapping)
	case r.Method == "PATCH" && path == "/api/companion/settings":
		for key, value := range body {
			c.settings[key] = value
		}
		c.reply(w, 200, c.settings)
	case r.Method == "GET" && path == "/api/companion/sessions":
		c.reply(w, 200, map[string]any{"items": []any{map[string]any{"id": "s1"}}, "next_cursor": nil})
	case r.Method == "GET" && path == "/api/companion/sessions/s1":
		c.reply(w, 200, map[string]any{"id": "s1"})
	case r.Method == "GET" && path == "/api/companion/sessions/s1/usage":
		c.reply(w, 200, map[string]any{"session_id": "s1", "totals": map[string]any{"input": 1}})
	default:
		c.reply(w, 404, map[string]any{"detail": "Not found", "error_code": "not_found"})
	}
}

func queryOf(r *http.Request) string {
	if r.URL.RawQuery == "" {
		return ""
	}
	return "?" + r.URL.RawQuery
}

func (c *contractC) lastRequest() (string, map[string]any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.requests[len(c.requests)-1], c.bodies[len(c.bodies)-1]
}

func proxyServer(t *testing.T) (*testServer, *contractC) {
	t.Helper()
	fake, upstream := newContractC(t)
	client, err := uplink.New(uplink.Options{Endpoint: upstream.URL, AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	device, err := client.WithDeviceToken(contractToken)
	if err != nil {
		t.Fatal(err)
	}
	server := newTestServer(t, nil)
	server.backend.device = device
	server.backend.connected = true
	return server, fake
}

func TestBoards_ProxiesTheServer(t *testing.T) {
	server, fake := proxyServer(t)
	reply := server.do(t, "GET", "/v1/boards", "")
	if reply.status != 200 || !strings.Contains(string(reply.body), `"github.com/acme/app"`) {
		t.Fatalf("boards: %d %s", reply.status, reply.body)
	}
	if request, _ := fake.lastRequest(); request != "GET /api/companion/boards" {
		t.Fatalf("upstream saw %s", request)
	}
}

func TestCreateMapping_RefreshesPolicyAndEmitsPolicyChanged(t *testing.T) {
	server, fake := proxyServer(t)
	events := server.subscribe(t)
	events.next(t, "status")
	reply := server.do(t, "POST", "/v1/mappings", `{"workspace_id":"w1","board_id":"b1","root_path":"/src/app","content_level":"metadata"}`)
	if reply.status != 200 || reply.json(t)["id"] != "m1" {
		t.Fatalf("create: %d %s", reply.status, reply.body)
	}
	if request, body := fake.lastRequest(); request != "POST /api/companion/mappings" || body["board_id"] != "b1" || body["root_path"] != "/src/app" {
		t.Fatalf("upstream saw %s %v", request, body)
	}
	if server.backend.refreshes.Load() != 1 {
		t.Fatalf("policy refreshes: %d", server.backend.refreshes.Load())
	}
	if event := events.next(t, "policy.changed"); event.data != "{}" {
		t.Fatalf("policy.changed data %q", event.data)
	}
}

func TestCreateMapping_RefusesAnIncompleteBody(t *testing.T) {
	server, fake := proxyServer(t)
	for _, body := range []string{
		`{"workspace_id":"w1","board_id":"b1","content_level":"metadata"}`,
		`{"board_id":"b1","root_path":"/src/app","content_level":"metadata"}`,
		`{"workspace_id":"w1","root_path":"/src/app","content_level":"metadata"}`,
		`{"workspace_id":"w1","board_id":"b1","root_path":"/src/app"}`,
		`{"workspace_id":"w1","board_id":"b1","root_path":"relative","content_level":"metadata"}`,
		`{"workspace_id":"w1","board_id":"b1","root_path":"/src/app","content_level":"everything"}`,
	} {
		reply := server.do(t, "POST", "/v1/mappings", body)
		if reply.status != http.StatusBadRequest || reply.errorCode(t) != CodeInvalidRequest {
			t.Fatalf("%s: %d %s", body, reply.status, reply.body)
		}
	}
	if len(fake.requests) != 0 || server.backend.refreshes.Load() != 0 {
		t.Fatal("a refused request reached the server")
	}
}

func TestUpdateMapping_ProxiesThenRefreshesPolicy(t *testing.T) {
	server, fake := proxyServer(t)
	server.do(t, "POST", "/v1/mappings", `{"workspace_id":"w1","board_id":"b1","repo_url":"github.com/acme/app","content_level":"standard"}`)
	reply := server.do(t, "PATCH", "/v1/mappings/m1", `{"enabled":false}`)
	if reply.status != 200 || reply.json(t)["enabled"] != false {
		t.Fatalf("update: %d %s", reply.status, reply.body)
	}
	if request, body := fake.lastRequest(); request != "PATCH /api/companion/mappings/m1" || len(body) != 1 {
		t.Fatalf("upstream saw %s %v", request, body)
	}
	if server.backend.refreshes.Load() != 2 {
		t.Fatalf("policy refreshes: %d", server.backend.refreshes.Load())
	}
}

func TestUpdateMapping_EmptyBodyIsInvalid(t *testing.T) {
	server, _ := proxyServer(t)
	reply := server.do(t, "PATCH", "/v1/mappings/m1", `{}`)
	if reply.status != http.StatusBadRequest || reply.errorCode(t) != CodeInvalidRequest {
		t.Fatalf("empty patch: %d %s", reply.status, reply.body)
	}
}

func TestDeleteMapping_AnswersTheDeletedID(t *testing.T) {
	server, _ := proxyServer(t)
	server.do(t, "POST", "/v1/mappings", `{"workspace_id":"w1","board_id":"b1","root_path":"/src/app","content_level":"full"}`)
	reply := server.do(t, "DELETE", "/v1/mappings/m1", "")
	if reply.status != 200 || reply.json(t)["deleted"] != "m1" {
		t.Fatalf("delete: %d %s", reply.status, reply.body)
	}
}

func TestDeleteMapping_UnknownIsNotFound(t *testing.T) {
	server, _ := proxyServer(t)
	reply := server.do(t, "DELETE", "/v1/mappings/nope", "")
	if reply.status != http.StatusNotFound || reply.errorCode(t) != CodeNotFound {
		t.Fatalf("delete unknown: %d %s", reply.status, reply.body)
	}
	if server.backend.refreshes.Load() != 0 {
		t.Fatal("a failed write must not refresh the policy")
	}
}

func TestUpdateSettings_ProxiesAndRefreshesPolicy(t *testing.T) {
	server, fake := proxyServer(t)
	reply := server.do(t, "PATCH", "/v1/settings", `{"auto_match_repos":false,"enabled_agents":["claude_code"],"exclude_globs":["**/secret"]}`)
	if reply.status != 200 || reply.json(t)["auto_match_repos"] != false {
		t.Fatalf("settings: %d %s", reply.status, reply.body)
	}
	if request, body := fake.lastRequest(); request != "PATCH /api/companion/settings" || len(body) != 3 {
		t.Fatalf("upstream saw %s %v", request, body)
	}
	if server.backend.refreshes.Load() != 1 {
		t.Fatal("settings must refresh the policy")
	}
}

func TestUpdateSettings_UnknownFieldIsInvalid(t *testing.T) {
	server, _ := proxyServer(t)
	reply := server.do(t, "PATCH", "/v1/settings", `{"paused":true}`)
	if reply.status != http.StatusBadRequest || reply.errorCode(t) != CodeInvalidRequest {
		t.Fatalf("pause is local, not a device setting: %d %s", reply.status, reply.body)
	}
}

func TestSessions_ForwardsTheQuery(t *testing.T) {
	server, fake := proxyServer(t)
	reply := server.do(t, "GET", "/v1/sessions?status=active&limit=10&cursor=abc", "")
	if reply.status != 200 || !strings.Contains(string(reply.body), `"s1"`) {
		t.Fatalf("sessions: %d %s", reply.status, reply.body)
	}
	if request, _ := fake.lastRequest(); request != "GET /api/companion/sessions?cursor=abc&limit=10&status=active" {
		t.Fatalf("upstream saw %s", request)
	}
}

func TestSessions_RefusesABadLimit(t *testing.T) {
	server, _ := proxyServer(t)
	for _, query := range []string{"limit=0", "limit=101", "limit=x"} {
		reply := server.do(t, "GET", "/v1/sessions?"+query, "")
		if reply.status != http.StatusBadRequest || reply.errorCode(t) != CodeInvalidRequest {
			t.Fatalf("%s: %d %s", query, reply.status, reply.body)
		}
	}
}

func TestSessionAndUsage_Proxy(t *testing.T) {
	server, _ := proxyServer(t)
	if reply := server.do(t, "GET", "/v1/sessions/s1", ""); reply.status != 200 || reply.json(t)["id"] != "s1" {
		t.Fatalf("session: %d %s", reply.status, reply.body)
	}
	if reply := server.do(t, "GET", "/v1/sessions/s1/usage", ""); reply.status != 200 || reply.json(t)["session_id"] != "s1" {
		t.Fatalf("usage: %d %s", reply.status, reply.body)
	}
	if reply := server.do(t, "GET", "/v1/sessions/other", ""); reply.status != http.StatusNotFound || reply.errorCode(t) != CodeNotFound {
		t.Fatalf("another device's session: %d %s", reply.status, reply.body)
	}
}

func TestProxy_RevokedDeviceIsUnauthorizedDevice(t *testing.T) {
	server, fake := proxyServer(t)
	fake.revoked = true
	reply := server.do(t, "GET", "/v1/boards", "")
	if reply.status != http.StatusUnauthorized || reply.errorCode(t) != CodeUnauthorizedDevice {
		t.Fatalf("revoked: %d %s", reply.status, reply.body)
	}
	if server.backend.invalidations.Load() == 0 {
		t.Fatal("a revoked device must invalidate the status probes")
	}
}

func TestProxy_UpstreamFailureIsServerRejectedWithDetail(t *testing.T) {
	server, fake := proxyServer(t)
	fake.fail = 503
	reply := server.do(t, "GET", "/v1/boards", "")
	if reply.status != http.StatusBadGateway || reply.errorCode(t) != CodeServerRejected {
		t.Fatalf("5xx: %d %s", reply.status, reply.body)
	}
	detail := reply.json(t)["error"].(map[string]any)["detail"].(map[string]any)
	if detail["status"] != float64(503) || detail["error_code"] != "upstream_code" {
		t.Fatalf("detail %v", detail)
	}
}

func TestProxy_UnreachableServerIsServerUnreachable(t *testing.T) {
	server, _ := proxyServer(t)
	client, _ := uplink.New(uplink.Options{Endpoint: "http://127.0.0.1:1", AllowLoopbackHTTP: true})
	server.backend.device, _ = client.WithDeviceToken(contractToken)
	reply := server.do(t, "GET", "/v1/boards", "")
	if reply.status != http.StatusBadGateway || reply.errorCode(t) != CodeServerUnreachable {
		t.Fatalf("unreachable: %d %s", reply.status, reply.body)
	}
}

func TestProxy_NotConnectedUsesTheBackendCode(t *testing.T) {
	server := newTestServer(t, nil)
	reply := server.do(t, "GET", "/v1/boards", "")
	if reply.status != http.StatusConflict || reply.errorCode(t) != "not_connected" {
		t.Fatalf("not connected: %d %s", reply.status, reply.body)
	}
}

func TestPolicyWrites_ApplyTheServersAnswerBeforeTheRefresh(t *testing.T) {
	server, _ := proxyServer(t)
	backend := server.backend
	for _, request := range [][3]string{
		{"POST", "/v1/mappings", `{"workspace_id":"w","board_id":"b","root_path":"/tmp/x","content_level":"standard"}`},
		{"PATCH", "/v1/mappings/m1", `{"enabled":false}`},
		{"DELETE", "/v1/mappings/m1", ""},
		{"PATCH", "/v1/settings", `{"auto_match_repos":false}`},
	} {
		if reply := server.do(t, request[0], request[1], request[2]); reply.status != 200 {
			t.Fatalf("%s %s: %d %s", request[0], request[1], reply.status, reply.body)
		}
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if len(backend.writes) != 4 || backend.writes[0].Mapping == nil || backend.writes[1].Mapping == nil || backend.writes[2].DeletedMappingID != "m1" || backend.writes[3].Settings == nil {
		t.Fatalf("writes: %+v", backend.writes)
	}
	for index := 0; index < len(backend.order); index += 2 {
		if backend.order[index] != "apply" || backend.order[index+1] != "refresh" {
			t.Fatalf("apply must precede each refresh: %v", backend.order)
		}
	}
}

func TestPolicyWrites_ARefusedWriteAppliesNothing(t *testing.T) {
	server, _ := proxyServer(t)
	backend := server.backend
	if reply := server.do(t, "DELETE", "/v1/mappings/unknown", ""); reply.status == 200 {
		t.Fatalf("unknown mapping: %d %s", reply.status, reply.body)
	}
	backend.mu.Lock()
	defer backend.mu.Unlock()
	if len(backend.writes) != 0 {
		t.Fatalf("a refused write was applied: %+v", backend.writes)
	}
}
