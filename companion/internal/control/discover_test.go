// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package control

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestDiscoverProject_AnswersTheRecordedProject(t *testing.T) {
	server := newTestServer(t, nil)
	reply := server.do(t, "POST", "/v1/projects/discover", `{"path":"/src/app"}`)
	discovered, _ := reply.json(t)["discovered"].(map[string]any)
	if reply.status != 200 || discovered["root"] != "/src/app" {
		t.Fatalf("discover: %d %s", reply.status, reply.body)
	}
}

func TestDiscoverProject_RefusesARelativeUncleanOrMissingPath(t *testing.T) {
	server := newTestServer(t, nil)
	for _, body := range []string{`{"path":"src/app"}`, `{"path":"/src/../etc"}`, `{"path":"/src/app/"}`, `{}`, `{"path":""}`, `not json`, `{"path":"/a","extra":1}`} {
		reply := server.do(t, "POST", "/v1/projects/discover", body)
		if reply.status != http.StatusBadRequest || reply.errorCode(t) != CodeInvalidRequest {
			t.Fatalf("%s: %d %s", body, reply.status, reply.body)
		}
	}
	if len(server.backend.discovered) != 0 {
		t.Fatal("a refused request reached the backend")
	}
}

func TestDiscoverProject_AnswersTheBackendRefusalAsItsEnvelope(t *testing.T) {
	server := newTestServer(t, nil)
	server.backend.discoverErr = &Error{Status: http.StatusConflict, Code: "ignored_path", Message: "ignored"}
	reply := server.do(t, "POST", "/v1/projects/discover", `{"path":"/src/app"}`)
	if reply.status != http.StatusConflict || reply.errorCode(t) != "ignored_path" {
		t.Fatalf("refusal: %d %s", reply.status, reply.body)
	}
}

func TestEvents_DiscoverPublishesProjects(t *testing.T) {
	server := newTestServer(t, nil)
	stream := server.subscribe(t)
	stream.next(t, "status")
	server.do(t, "POST", "/v1/projects/discover", `{"path":"/src/app"}`)
	var projects map[string]any
	if err := json.Unmarshal([]byte(stream.next(t, "projects").data), &projects); err != nil {
		t.Fatal(err)
	}
}

func TestEvents_RefusedDiscoverPublishesNothing(t *testing.T) {
	server := newTestServer(t, nil)
	server.backend.discoverErr = &Error{Status: http.StatusBadRequest, Code: "home_or_root", Message: "home"}
	server.do(t, "POST", "/v1/projects/discover", `{"path":"/src/app"}`)
	if server.backend.invalidations.Load() != 0 {
		t.Fatal("a refused discover counted as a mutation")
	}
}
