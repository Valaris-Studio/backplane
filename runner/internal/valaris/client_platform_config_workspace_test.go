// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The platform picks which workspace's pipeline_config to serve from
// ?workspace_slug=; without it the backend falls back to guessing from team
// membership, which served the wrong workspace's config in the 2026-05-19
// incident. The runner knows its workspace and must always say so.
func TestGetPlatformConfigSendsConfiguredWorkspaceSlug(t *testing.T) {
	var receivedSlug string
	var slugParamPresent bool
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedSlug = r.URL.Query().Get("workspace_slug")
		_, slugParamPresent = r.URL.Query()["workspace_slug"]
		json.NewEncoder(w).Encode(map[string]any{
			"agent_id":         "agent-001",
			"workspace_config": map[string]any{"version": 1},
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	if _, err := client.GetPlatformConfig(context.Background(), "internal-projects"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if !slugParamPresent {
		t.Fatal("request carried no workspace_slug param")
	}
	if receivedSlug != "internal-projects" {
		t.Errorf("workspace_slug = %q, want %q", receivedSlug, "internal-projects")
	}
}

// Slugs are user-authored config values; anything needing escaping must survive
// the round trip rather than corrupting the query string.
func TestGetPlatformConfigEscapesWorkspaceSlug(t *testing.T) {
	var receivedSlug string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		receivedSlug = r.URL.Query().Get("workspace_slug")
		json.NewEncoder(w).Encode(map[string]any{
			"agent_id":         "agent-001",
			"workspace_config": map[string]any{"version": 1},
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	if _, err := client.GetPlatformConfig(context.Background(), "a b&c=d"); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if receivedSlug != "a b&c=d" {
		t.Errorf("workspace_slug = %q, want %q", receivedSlug, "a b&c=d")
	}
}

// Config validation makes an empty slug unreachable in practice, but an empty
// param would ask the backend to resolve the empty-string workspace rather than
// fall back to team membership.
func TestGetPlatformConfigOmitsEmptyWorkspaceSlug(t *testing.T) {
	var rawQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rawQuery = r.URL.RawQuery
		json.NewEncoder(w).Encode(map[string]any{
			"agent_id":         "agent-001",
			"workspace_config": map[string]any{"version": 1},
		})
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	if _, err := client.GetPlatformConfig(context.Background(), ""); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if rawQuery != "" {
		t.Errorf("query = %q, want empty", rawQuery)
	}
}
