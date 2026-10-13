// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Valaris-Studio/backplane/companion/internal/daemon"
	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/scope"
	"github.com/Valaris-Studio/backplane/companion/internal/state"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// nullableMembers are the members whose null is a scalar or object, never
// an array; any other null fails the walk.
var nullableMembers = map[string]bool{
	"service": true, "retention_days": true, "last_observation_at": true, "last_upload_at": true,
	"oldest_pending_at": true, "policy_refreshed_at": true, "account": true, "web_origin": true,
	"detail": true, "workspace_name": true, "cost_basis": true, "auth_kind": true, "agent": true, "mapping_id": true,
	"suggested_device_name": true, "history_deleted": true,
}

func nullArrays(value any, path string, found *[]string) {
	switch typed := value.(type) {
	case map[string]any:
		for key, member := range typed {
			if member == nil && !nullableMembers[key] {
				*found = append(*found, path+"."+key)
			}
			nullArrays(member, path+"."+key, found)
		}
	case []any:
		for index, item := range typed {
			if item == nil {
				*found = append(*found, path+"[]")
			}
			nullArrays(item, path+"["+itoa(index)+"]", found)
		}
	}
}

func assertNoNullArray(t *testing.T, name string, data []byte) {
	t.Helper()
	var decoded any
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("%s is not JSON: %s", name, data)
	}
	var found []string
	nullArrays(decoded, name, &found)
	if len(found) > 0 {
		t.Fatalf("%s has nulls where arrays belong: %v\n%s", name, found, data)
	}
}

// emptyEverything leaves every list the companion reports empty or unset:
// a policy with no mappings, catalog or globs, all agents enabled (null),
// a repair without problems, and a discovered project.
func emptyEverything(t *testing.T, h *harness) {
	t.Helper()
	layout := store.Layout{Root: h.data}
	cached, _ := policy.Load(layout.Policy())
	cached.Policy.Mappings, cached.Policy.RepoCatalog = nil, nil
	cached.Policy.Installation.EnabledAgents, cached.Policy.Installation.ExcludeGlobs = nil, nil
	cached.Policy.Installation.AutoMatchRepos = false
	if err := policy.Save(layout.Policy(), cached); err != nil {
		t.Fatal(err)
	}
	state.Update(context.Background(), layout, layout.Health(), func(health *state.Health) bool {
		health.NoteRepair(state.AgentRepair{Agent: "claude_code", At: time.Now(), Result: "unrepaired"})
		return true
	})
	project := scope.Project{Root: filepath.Join(h.home, "code", "other"), RepoURL: "github.com/acme/other"}
	mustMkdir(t, project.Root)
	state.RecordDiscovered(context.Background(), layout, project, time.Now())
}

func TestAPI_NoResponseCarriesANullArray(t *testing.T) {
	h := newHarness(t)
	endpoint, _ := meServer(t, h, answerMe)
	h.connectTo(t, endpoint)
	emptyEverything(t, h)
	api := h.api(t)
	api.eventuallyAccount(t)
	for _, request := range [][3]string{
		{"GET", "/v1/status", ""}, {"GET", "/v1/projects", ""}, {"GET", "/v1/agents", ""}, {"GET", "/v1/version", ""},
		{"POST", "/v1/pause", ""}, {"POST", "/v1/resume", ""},
		{"POST", "/v1/projects/ignore", `{"path":` + quoted(h.repo) + `}`}, {"DELETE", "/v1/projects/ignore", `{"path":` + quoted(h.repo) + `}`},
		{"POST", "/v1/agents/claude_code/install", ""}, {"POST", "/v1/agents/claude_code/uninstall", ""},
		{"GET", "/v1/nope", ""}, {"POST", "/v1/pair/start", `{"endpoint":"https://bp.example"}`},
	} {
		_, body := api.call(t, request[0], request[1], request[2])
		assertNoNullArray(t, request[0]+" "+request[1], body)
	}
	_, body := api.call(t, "POST", "/v1/disconnect", "")
	assertNoNullArray(t, "POST /v1/disconnect", body)
	_, body = api.call(t, "GET", "/v1/status", "")
	assertNoNullArray(t, "GET /v1/status (disconnected)", body)
}

func TestAPIStatus_AllAgentsEnabledIsTheirListNotNull(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	emptyEverything(t, h)
	_, body := h.api(t).call(t, "GET", "/v1/status", "")
	var status struct {
		Capture struct {
			EnabledAgents []string `json:"enabled_agents"`
		} `json:"capture"`
	}
	json.Unmarshal(body, &status)
	if strings.Join(status.Capture.EnabledAgents, ",") != "claude_code,codex_cli,pi_cli" {
		t.Fatalf("null (every agent) must be listed, not emptied: %v", status.Capture.EnabledAgents)
	}
	if err := h.run(t, "status"); err != nil || !strings.Contains(h.stdout.String(), `"enabled_agents": null`) {
		t.Fatalf("the CLI keeps null for every agent: %s", h.stdout)
	}
}

type collectedEvents struct {
	events chan [2]string
}

func (h *harness) collectEvents(t *testing.T, api *apiClient) *collectedEvents {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	request, _ := http.NewRequestWithContext(ctx, "GET", api.server.URL+"/v1/events", nil)
	reply, err := api.server.Client().Do(request)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	collected := &collectedEvents{events: make(chan [2]string, 256)}
	go func() {
		scanner := bufio.NewScanner(reply.Body)
		scanner.Buffer(make([]byte, 1<<20), 1<<20)
		kind := ""
		for scanner.Scan() {
			line := scanner.Text()
			switch {
			case strings.HasPrefix(line, "event: "):
				kind = line[len("event: "):]
			case strings.HasPrefix(line, "data: "):
				collected.events <- [2]string{kind, line[len("data: "):]}
			}
		}
		close(collected.events)
	}()
	t.Cleanup(func() {
		cancel()
		reply.Body.Close()
	})
	return collected
}

func (c *collectedEvents) next(t *testing.T, kind string) string {
	t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case event := <-c.events:
			if event[0] == kind {
				return event[1]
			}
		case <-deadline:
			t.Fatalf("no %s event", kind)
		}
	}
}

func TestEvents_NoEventCarriesANullArray(t *testing.T) {
	h := newHarness(t)
	h.connect(t)
	emptyEverything(t, h)
	api := h.api(t)
	events := h.collectEvents(t, api)
	assertNoNullArray(t, "status event", []byte(events.next(t, "status")))
	// Sent on connect even when empty, the case most likely to carry a null.
	assertNoNullArray(t, "attention event", []byte(events.next(t, "attention")))
	api.call(t, "POST", "/v1/pause", "")
	assertNoNullArray(t, "status event after pause", []byte(events.next(t, "status")))
	api.call(t, "POST", "/v1/projects/ignore", `{"path":`+quoted(h.repo)+`}`)
	assertNoNullArray(t, "projects event", []byte(events.next(t, "projects")))
	api.call(t, "POST", "/v1/agents/claude_code/install", "")
	assertNoNullArray(t, "agents event", []byte(events.next(t, "agents")))
	sessionPublisher(api.Server)(daemon.SessionEvent{Kind: daemon.SessionStarted, Session: daemon.SessionSummary{NativeSessionID: "s", Harness: "claude_code"}})
	assertNoNullArray(t, "session event", []byte(events.next(t, "session")))
}

func TestEvents_AgentsEventHasTheGETShape(t *testing.T) {
	h := newHarness(t)
	api := h.api(t)
	events := h.collectEvents(t, api)
	events.next(t, "status")
	api.call(t, "POST", "/v1/agents/claude_code/install", "")
	published := events.next(t, "agents")
	_, listed := api.call(t, "GET", "/v1/agents", "")
	if !jsonEqual(decodeJSON(t, []byte(published)), decodeJSON(t, listed)) {
		t.Fatalf("agents event differs from GET /v1/agents:\n%s\n%s", published, listed)
	}
}

func TestAPIStatus_WebOriginIsNullWhenTheServerOmitsIt(t *testing.T) {
	h := newHarness(t)
	endpoint, _ := meServer(t, h, func(w http.ResponseWriter) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{"user": map[string]any{"email": "jane@example.com", "display_name": "Jane"}, "installation": map[string]any{"id": "i", "name": "l"}})
	})
	h.connectTo(t, endpoint)
	api := h.api(t)
	api.eventuallyAccount(t)
	_, body := api.call(t, "GET", "/v1/status", "")
	if !strings.Contains(string(body), `"web_origin":null`) {
		t.Fatalf("web_origin must be an explicit null: %s", body)
	}
}
