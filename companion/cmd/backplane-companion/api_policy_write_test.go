// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/policy"
	"github.com/Valaris-Studio/backplane/companion/internal/store"
)

// writeAnsweringServer answers the device's settings and mapping writes as
// the backend does and, once failPolicy is set, fails every policy refresh,
// so only the write's own answer can bring the new values.
func writeAnsweringServer(t *testing.T, h *harness) (string, *atomic.Bool) {
	t.Helper()
	upstream, _ := url.Parse(h.server.URL)
	proxy := httputil.NewSingleHostReverseProxy(upstream)
	failPolicy := &atomic.Bool{}
	answer := func(w http.ResponseWriter, document any) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(document)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/companion/policy" && failPolicy.Load():
			http.Error(w, "unavailable", http.StatusServiceUnavailable)
		case r.Method == "PATCH" && r.URL.Path == "/api/companion/settings":
			answer(w, map[string]any{"paused": false, "auto_match_repos": false, "enabled_agents": []string{"codex_cli"}, "exclude_globs": []string{"**/secret/**"}, "retention_days": nil})
		case r.Method == "POST" && r.URL.Path == "/api/companion/mappings":
			answer(w, map[string]any{"id": "m2", "workspace_id": "w", "board_id": "b2", "root_path": "/tmp/other", "repo_url_normalized": nil, "origin": "explicit", "enabled": true, "content_level": "metadata"})
		case r.Method == "PATCH" && r.URL.Path == "/api/companion/mappings/m1":
			answer(w, map[string]any{"id": "m1", "workspace_id": "w", "board_id": nil, "root_path": h.repo, "repo_url_normalized": nil, "origin": "explicit", "enabled": false, "content_level": "full"})
		case r.Method == "DELETE" && r.URL.Path == "/api/companion/mappings/m1":
			w.WriteHeader(http.StatusNoContent)
		default:
			proxy.ServeHTTP(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server.URL, failPolicy
}

func cachedPolicy(t *testing.T, h *harness) policy.Policy {
	t.Helper()
	cached, err := policy.Load(store.Layout{Root: h.data}.Policy())
	if err != nil {
		t.Fatal(err)
	}
	return cached.Policy
}

func connectedWithFailingRefresh(t *testing.T) (*harness, *apiClient) {
	t.Helper()
	h := newHarness(t)
	endpoint, failPolicy := writeAnsweringServer(t, h)
	h.connectTo(t, endpoint)
	failPolicy.Store(true)
	return h, h.api(t)
}

func TestAPISettingsWrite_StatusCarriesTheNewValuesWhenTheRefreshFails(t *testing.T) {
	h, api := connectedWithFailingRefresh(t)
	if status, body := api.call(t, "PATCH", "/v1/settings", `{"exclude_globs":["**/secret/**"]}`); status != 200 {
		t.Fatalf("settings: %d %s", status, body)
	}
	_, body := api.call(t, "GET", "/v1/status", "")
	var view struct {
		Capture struct {
			AutoMatchRepos bool     `json:"auto_match_repos"`
			EnabledAgents  []string `json:"enabled_agents"`
			ExcludeGlobs   []string `json:"exclude_globs"`
		} `json:"capture"`
	}
	json.Unmarshal(body, &view)
	if view.Capture.AutoMatchRepos || strings.Join(view.Capture.EnabledAgents, ",") != "codex_cli" || strings.Join(view.Capture.ExcludeGlobs, ",") != "**/secret/**" {
		t.Fatalf("status still carries the old settings: %s", body)
	}
	if installation := cachedPolicy(t, h).Installation; installation.ID == "" {
		t.Fatal("the cached installation keeps its id")
	}
}

func TestAPIMappingCreate_CachedPolicyHasTheMappingWhenTheRefreshFails(t *testing.T) {
	h, api := connectedWithFailingRefresh(t)
	if status, body := api.call(t, "POST", "/v1/mappings", `{"workspace_id":"w","board_id":"b2","root_path":"/tmp/other","content_level":"metadata"}`); status != 200 {
		t.Fatalf("create: %d %s", status, body)
	}
	mappings := cachedPolicy(t, h).Mappings
	if len(mappings) != 2 || mappings[1].ID != "m2" || mappings[1].RootPath != "/tmp/other" || mappings[1].ContentLevel != "metadata" {
		t.Fatalf("mappings after create: %+v", mappings)
	}
	if count := statusMappings(t, api); count != 2 {
		t.Fatalf("status mappings = %d, want 2", count)
	}
}

func TestAPIMappingUpdate_CachedPolicyHasTheUpdateWhenTheRefreshFails(t *testing.T) {
	h, api := connectedWithFailingRefresh(t)
	if status, body := api.call(t, "PATCH", "/v1/mappings/m1", `{"enabled":false,"content_level":"full"}`); status != 200 {
		t.Fatalf("update: %d %s", status, body)
	}
	mappings := cachedPolicy(t, h).Mappings
	if len(mappings) != 1 || mappings[0].Enabled || mappings[0].ContentLevel != "full" {
		t.Fatalf("mappings after update: %+v", mappings)
	}
}

func TestAPIMappingDelete_CachedPolicyDropsTheMappingWhenTheRefreshFails(t *testing.T) {
	h, api := connectedWithFailingRefresh(t)
	if status, body := api.call(t, "DELETE", "/v1/mappings/m1", ""); status != 200 {
		t.Fatalf("delete: %d %s", status, body)
	}
	if mappings := cachedPolicy(t, h).Mappings; len(mappings) != 0 {
		t.Fatalf("mappings after delete: %+v", mappings)
	}
	if count := statusMappings(t, api); count != 0 {
		t.Fatalf("status mappings = %d, want 0", count)
	}
}

func TestAPIPolicyWrite_RefusedWriteLeavesTheCachedPolicyAlone(t *testing.T) {
	h, api := connectedWithFailingRefresh(t)
	before := cachedPolicy(t, h)
	if status, _ := api.call(t, "DELETE", "/v1/mappings/unknown", ""); status == 200 {
		t.Fatal("the server has no such mapping")
	}
	if after := cachedPolicy(t, h); len(after.Mappings) != len(before.Mappings) {
		t.Fatalf("a refused write changed the cache: %+v", after.Mappings)
	}
}

func statusMappings(t *testing.T, api *apiClient) int {
	t.Helper()
	_, body := api.call(t, "GET", "/v1/status", "")
	var view struct {
		Capture struct {
			Mappings int `json:"mappings"`
		} `json:"capture"`
	}
	json.Unmarshal(body, &view)
	return view.Capture.Mappings
}
