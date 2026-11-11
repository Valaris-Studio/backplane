// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package uplink

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// Under /api/companion/contents/ a headless client sends only what the
// content uploader sends: GET {id}, PUT {id}/chunks/{n}, POST {id}/finalize.
// Every other method or shape under that prefix is refused before sending.

func fixContentsToken() string { return "bpc_" + strings.Repeat("Ct6", 14) + "c" }

// fixRecordingServer answers 404 to everything and records what arrived.
func fixRecordingServer(t *testing.T) (*httptest.Server, func() []string) {
	t.Helper()
	var mu sync.Mutex
	var arrived []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		arrived = append(arrived, r.Method+" "+r.URL.EscapedPath())
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		w.Write([]byte(`{"detail":"Not Found","error_code":"not_found"}`))
	}))
	t.Cleanup(server.Close)
	return server, func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), arrived...)
	}
}

func TestHeadlessClient_FixContentsRoutesAllowOnlyTheMethodsTheUploaderSends(t *testing.T) {
	server, arrived := fixRecordingServer(t)
	base, err := New(Options{Endpoint: server.URL, AllowLoopbackHTTP: true})
	if err != nil {
		t.Fatal(err)
	}
	device, err := base.WithDeviceToken(fixContentsToken())
	if err != nil {
		t.Fatal(err)
	}
	headless := device.Headless()
	ctx := context.Background()
	const content = "/api/companion/contents/content-1"

	refused := []struct{ method, path string }{
		{http.MethodDelete, content},
		{http.MethodPut, content},
		{http.MethodPost, content},
		{http.MethodPatch, content},
		{http.MethodGet, content + "/chunks/0"},
		{http.MethodPost, content + "/chunks/0"},
		{http.MethodDelete, content + "/chunks/0"},
		{http.MethodPut, content + "/chunks/0/extra"},
		{http.MethodGet, content + "/finalize"},
		{http.MethodPut, content + "/finalize"},
		{http.MethodPost, content + "/publish"},
		{http.MethodPost, "/api/companion/contents/"},
		// The prefix alone must not carry a request out of the contents API.
		{http.MethodPost, "/api/companion/contents/../pairing/start"},
		{http.MethodGet, "/api/companion/contents/../../me/agent-key"},
	}
	for _, call := range refused {
		_, err := headless.do(ctx, call.method, call.path, headless.token, nil)
		if !errors.Is(err, ErrHeadlessPathRefused) {
			t.Errorf("%s %s: %v, want headless_path_refused", call.method, call.path, err)
		}
		if err != nil && strings.Contains(err.Error(), fixContentsToken()) {
			t.Errorf("%s %s: the refusal carries the token", call.method, call.path)
		}
	}
	if sent := arrived(); len(sent) != 0 {
		t.Fatalf("refused contents routes were sent: %v", sent)
	}

	// The uploader's own three calls still go out.
	chunk := []byte("chunk")
	sum := sha256.Sum256(chunk)
	if _, err := headless.ContentUpload(ctx, "content-1"); errors.Is(err, ErrHeadlessPathRefused) {
		t.Fatalf("GET {id}: %v", err)
	}
	if _, err := headless.PutContentChunk(ctx, "content-1", 0, chunk); errors.Is(err, ErrHeadlessPathRefused) {
		t.Fatalf("PUT {id}/chunks/{n}: %v", err)
	}
	if _, err := headless.FinalizeContent(ctx, "content-1", int64(len(chunk)), hex.EncodeToString(sum[:])); errors.Is(err, ErrHeadlessPathRefused) {
		t.Fatalf("POST {id}/finalize: %v", err)
	}
	want := []string{"GET " + content, "PUT " + content + "/chunks/0", "POST " + content + "/finalize"}
	if sent := arrived(); strings.Join(sent, "\n") != strings.Join(want, "\n") {
		t.Fatalf("the uploader's calls sent %v, want %v", sent, want)
	}

	// The desktop client keeps its whole surface.
	if _, err := device.do(ctx, http.MethodDelete, content, device.token, nil); errors.Is(err, ErrHeadlessPathRefused) {
		t.Fatalf("the unrestricted device client was restricted: %v", err)
	}
	if sent := arrived(); len(sent) != len(want)+1 {
		t.Fatalf("the desktop client's call was not sent: %v", sent)
	}
}
