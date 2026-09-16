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

func TestCompletionResultRejectedReceiptIsNotAcceptance(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"result_receipt":{"attempt_id":"attempt-1","status":"rejected","code":"completion_context_changed","retryable":true,"next_action":"retry_completion"}}`))
	}))
	defer server.Close()
	err := NewClient(server.URL, "vlr_fixture").CompleteCompletionWork(context.Background(), "default", "board", "attempt-1", CompletionResult{})
	if err == nil || !strings.Contains(err.Error(), "rejected") || !strings.Contains(err.Error(), "retry") {
		t.Fatalf("rejection swallowed: %v", err)
	}
}

func TestCompletionResultLegacyResponseStillWorks(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"candidate":{"status":"awaiting_merge"}}`))
	}))
	defer server.Close()
	if err := NewClient(server.URL, "vlr_fixture").CompleteCompletionWork(context.Background(), "default", "board", "attempt-1", CompletionResult{}); err != nil {
		t.Fatal(err)
	}
}
