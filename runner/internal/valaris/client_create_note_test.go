// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

// recorder captures the most recent inbound request so assertions can inspect
// URL, method, headers, and decoded JSON body without re-implementing httptest
// boilerplate in every test.
type capturedRequest struct {
	mu      sync.Mutex
	method  string
	path    string
	auth    string
	body    map[string]any
	rawBody []byte
}

func (c *capturedRequest) capture(r *http.Request) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.method = r.Method
	c.path = r.URL.Path
	c.auth = r.Header.Get("Authorization")
	c.rawBody, _ = io.ReadAll(r.Body)
	_ = json.Unmarshal(c.rawBody, &c.body)
}

func newCaptureServer(t *testing.T, status int) (*httptest.Server, *capturedRequest) {
	t.Helper()
	cap := &capturedRequest{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cap.capture(r)
		if status == 0 {
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"id":"note-1"}`))
			return
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"detail":"forced error"}`))
	}))
	t.Cleanup(srv.Close)
	return srv, cap
}

func TestClient_CreateNote_PostsCanonicalPayload(t *testing.T) {
	srv, cap := newCaptureServer(t, 0)
	client := NewClient(srv.URL, "vlr_test")

	err := client.CreateNote(
		context.Background(),
		"ws-slug", "board-123", "card-xyz",
		"plan", "Plan: card-xyz", "## plan body", "", true,
	)
	if err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	if cap.method != http.MethodPost {
		t.Errorf("method = %q, want POST", cap.method)
	}
	if cap.path != "/api/workspaces/ws-slug/boards/board-123/notes" {
		t.Errorf("path = %q", cap.path)
	}
	if cap.auth != "Bearer vlr_test" {
		t.Errorf("Authorization header = %q", cap.auth)
	}
	if cap.body["title"] != "Plan: card-xyz" {
		t.Errorf("title = %v", cap.body["title"])
	}
	if cap.body["content"] != "## plan body" {
		t.Errorf("content = %v", cap.body["content"])
	}
	if cap.body["card_id"] != "card-xyz" {
		t.Errorf("card_id = %v", cap.body["card_id"])
	}
	if cap.body["kind"] != "plan" {
		t.Errorf("kind = %v", cap.body["kind"])
	}
	if cap.body["pinned"] != true {
		t.Errorf("pinned = %v, want true", cap.body["pinned"])
	}
}

func TestClient_CreateNote_OmitsEmptyFailureClass(t *testing.T) {
	srv, cap := newCaptureServer(t, 0)
	client := NewClient(srv.URL, "vlr_test")

	if err := client.CreateNote(
		context.Background(),
		"ws", "b", "c", "review_verdict", "title", "body", "", false,
	); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	if _, has := cap.body["failure_class"]; has {
		t.Errorf("failure_class must be omitted when empty; payload has it: %v", cap.body)
	}
}

func TestClient_CreateNote_IncludesFailureClass(t *testing.T) {
	srv, cap := newCaptureServer(t, 0)
	client := NewClient(srv.URL, "vlr_test")

	if err := client.CreateNote(
		context.Background(),
		"ws", "b", "c", "review_verdict", "title", "body", "test_failure", false,
	); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	if cap.body["failure_class"] != "test_failure" {
		t.Errorf("failure_class = %v, want test_failure", cap.body["failure_class"])
	}
}

func TestClient_CreateNote_PropagatesAPIError(t *testing.T) {
	srv, _ := newCaptureServer(t, http.StatusBadRequest)
	client := NewClient(srv.URL, "vlr_test")

	err := client.CreateNote(
		context.Background(),
		"ws", "b", "c", "review_verdict", "t", "b", "", false,
	)
	if err == nil {
		t.Fatal("expected non-nil error on 400")
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected *APIError, got %T (%v)", err, err)
	}
	if apiErr.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", apiErr.StatusCode)
	}
}

// CreateReviewNote is a legacy wrapper; the wire payload must be byte-identical
// to a direct CreateNote(kind="review_verdict", ...) call so any backend
// consumer that read the legacy bytes keeps working.
func TestClient_CreateReviewNote_DelegatesToCreateNote(t *testing.T) {
	srvLegacy, capLegacy := newCaptureServer(t, 0)
	defer srvLegacy.Close()
	clientLegacy := NewClient(srvLegacy.URL, "vlr_test")

	srvNew, capNew := newCaptureServer(t, 0)
	defer srvNew.Close()
	clientNew := NewClient(srvNew.URL, "vlr_test")

	if err := clientLegacy.CreateReviewNote(
		context.Background(),
		"ws", "b", "card-x", "approve", "all good",
	); err != nil {
		t.Fatalf("CreateReviewNote: %v", err)
	}
	if err := clientNew.CreateNote(
		context.Background(),
		"ws", "b", "card-x", "review_verdict",
		"Review: card-x — approve", "all good", "", false,
	); err != nil {
		t.Fatalf("CreateNote: %v", err)
	}

	// Decoded JSON maps compare equal (key order doesn't matter for callers).
	if !mapsEqual(capLegacy.body, capNew.body) {
		t.Errorf("legacy payload diverges from direct CreateNote.\nlegacy: %v\nnew:    %v",
			capLegacy.body, capNew.body)
	}
	if capLegacy.path != capNew.path {
		t.Errorf("path mismatch: legacy %q vs new %q", capLegacy.path, capNew.path)
	}
}

func mapsEqual(a, b map[string]any) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}
