// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// ListWorkspaces hits an endpoint guarded only by get_current_user, so an AGENT
// key resolves to its creating user and sees that user's workspaces — which is
// what makes the wizard's picker possible at all.
func TestListWorkspaces_DecodesNameAndSlug(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workspaces" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		if r.Method != http.MethodGet {
			t.Errorf("method = %s, want GET", r.Method)
		}
		if r.Header.Get("Authorization") != "Bearer vlr_test" {
			t.Error("missing or incorrect Authorization header")
		}
		_, _ = w.Write([]byte(`[
			{"id":"w1","name":"Valaris Internal","slug":"valaris","board_count":4},
			{"id":"w2","name":"Acme","slug":"acme"}
		]`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	workspaces, err := client.ListWorkspaces(context.Background())
	if err != nil {
		t.Fatalf("ListWorkspaces: %v", err)
	}

	if len(workspaces) != 2 {
		t.Fatalf("want 2 workspaces, got %d", len(workspaces))
	}
	if workspaces[0].ID != "w1" || workspaces[0].Name != "Valaris Internal" || workspaces[0].Slug != "valaris" {
		t.Errorf("first workspace decoded wrong: %+v", workspaces[0])
	}
	if workspaces[1].Slug != "acme" {
		t.Errorf("second workspace decoded wrong: %+v", workspaces[1])
	}
}

func TestListWorkspaces_EmptyListIsNotAnError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[]`))
	}))
	defer server.Close()

	workspaces, err := NewClient(server.URL, "vlr_test").ListWorkspaces(context.Background())
	if err != nil {
		t.Fatalf("an empty workspace list is a state, not a failure: %v", err)
	}
	if len(workspaces) != 0 {
		t.Errorf("want no workspaces, got %d", len(workspaces))
	}
}

func TestListWorkspaces_SurfacesAPIErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"detail":"invalid key"}`))
	}))
	defer server.Close()

	if _, err := NewClient(server.URL, "vlr_bad").ListWorkspaces(context.Background()); err == nil {
		t.Fatal("a 401 must surface as an error, not an empty list")
	}
}
