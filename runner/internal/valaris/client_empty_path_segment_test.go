// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestFailExecution_EmptyAgentID_RefusesMalformedURL pins the exact
// card-41506640 failure mode: a caller resolves an empty agentID (e.g. a
// user/personal API key with no linked agent) and every execution write
// would silently build "/api/agents//executions/..." — a URL with an empty
// path segment that 405s server-side instead of failing at the call site
// with an actionable message.
func TestFailExecution_EmptyAgentID_RefusesMalformedURL(t *testing.T) {
	hit := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	err := client.FailExecution(context.Background(), "", "exec-1", "boom")
	if err == nil {
		t.Fatal("expected an error for an empty agentID, got nil")
	}
	if hit {
		t.Fatal("client must refuse before issuing the request — the malformed URL must never reach the server")
	}
	if !strings.Contains(err.Error(), "empty") {
		t.Errorf("error should name the empty-segment problem, got: %q", err.Error())
	}
}

// TestClaimCard_EmptyCardID_RefusesMalformedURL proves the same guard covers
// a different path position (cardID, mid-path) and a different HTTP method
// (POST), not just the agentID/PATCH case.
func TestClaimCard_EmptyCardID_RefusesMalformedURL(t *testing.T) {
	hit := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	err := client.ClaimCard(context.Background(), "acme", "board-1", "", "agent-1")
	if err == nil {
		t.Fatal("expected an error for an empty cardID, got nil")
	}
	if hit {
		t.Fatal("client must refuse before issuing the request — the malformed URL must never reach the server")
	}
}

// TestMoveCard_EmptyBoardID_RefusesMalformedURL proves the guard covers the
// boardID segment specifically, since board-scoped routes are the most
// common shape in this client.
func TestMoveCard_EmptyBoardID_RefusesMalformedURL(t *testing.T) {
	hit := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	err := client.MoveCard(context.Background(), "acme", "", "card-1", "col-1", 1024)
	if err == nil {
		t.Fatal("expected an error for an empty boardID, got nil")
	}
	if hit {
		t.Fatal("client must refuse before issuing the request — the malformed URL must never reach the server")
	}
}

// TestGetCard_EmptyWorkspaceSlug_RefusesMalformedURL proves the guard also
// fires on the jsonGet path (GET, not just the jsonRequest/jsonRequestDecode
// mutation paths), and on the workspaceSlug segment.
func TestGetCard_EmptyWorkspaceSlug_RefusesMalformedURL(t *testing.T) {
	hit := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	_, err := client.GetCard(context.Background(), "", "board-1", "card-1")
	if err == nil {
		t.Fatal("expected an error for an empty workspaceSlug, got nil")
	}
	if hit {
		t.Fatal("client must refuse before issuing the request — the malformed URL must never reach the server")
	}
}

// TestLogExecutionStart_EmptyAgentID_RefusesMalformedURL pins card 41506640's
// exact failure: a non-agent key leaves agentID empty, which built
// POST /api/agents//executions and 405'd on every write while the loop kept
// spending. This also covers the jsonRequestDecode path (POST-and-decode),
// the third of the three shared request funcs behind the seam.
func TestLogExecutionStart_EmptyAgentID_RefusesMalformedURL(t *testing.T) {
	hit := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"exec-new"}`))
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	_, err := client.LogExecutionStart(
		context.Background(), "", "acme", "loop_iteration", "board-1", "", "summary", "",
	)
	if err == nil {
		t.Fatal("expected an error for an empty agentID, got nil")
	}
	if hit {
		t.Fatal("client must refuse before issuing the request — the malformed URL must never reach the server")
	}
}

// TestJSONRequest_URLWithEmptyPathSegment_RefusesDirectly exercises the
// shared seam directly (bypassing any specific method) so a NEW client
// method added later that builds a URL with an empty path segment is caught
// by this guard automatically — that is the entire point of centralizing it
// in jsonRequest/jsonGet/jsonRequestDecode rather than validating per-method.
func TestJSONRequest_URLWithEmptyPathSegment_RefusesDirectly(t *testing.T) {
	hit := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	malformed := server.URL + "/api/agents//executions/exec-1"
	err := client.jsonRequest(context.Background(), http.MethodPatch, malformed, map[string]any{"status": "failed"})
	if err == nil {
		t.Fatal("expected an error for a URL containing an empty path segment")
	}
	if hit {
		t.Fatal("the malformed URL must never reach the server")
	}
}

// TestJSONGet_URLWithEmptyPathSegment_RefusesDirectly is the jsonGet-seam
// counterpart to the jsonRequest direct test above.
func TestJSONGet_URLWithEmptyPathSegment_RefusesDirectly(t *testing.T) {
	hit := false
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hit = true
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{}`))
	}))
	defer server.Close()

	malformed := server.URL + "/api/workspaces//boards/board-1/cards/card-1"
	_, err := jsonGet[*Card](context.Background(), NewClient(server.URL, "vlr_test"), malformed)
	if err == nil {
		t.Fatal("expected an error for a URL containing an empty path segment")
	}
	if hit {
		t.Fatal("the malformed URL must never reach the server")
	}
}

// TestJSONRequest_NormalURLWithoutEmptySegments_StillWorks proves the guard
// is scoped to empty segments only — it must not false-positive on the "//"
// that legitimately follows the scheme in every URL.
func TestJSONRequest_NormalURLWithoutEmptySegments_StillWorks(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	client := NewClient(server.URL, "vlr_test")
	err := client.jsonRequest(context.Background(), http.MethodPatch, server.URL+"/api/agents/agent-1/executions/exec-1", map[string]any{"status": "failed"})
	if err != nil {
		t.Errorf("a well-formed URL must not be rejected: %v", err)
	}
}
