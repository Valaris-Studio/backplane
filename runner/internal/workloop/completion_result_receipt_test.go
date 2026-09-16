// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Valaris-Studio/backplane/runner/internal/valaris"
)

func TestCompletionResultRejectedReceiptIsTerminalForPublication(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		_, _ = w.Write([]byte(`{"result_receipt":{"attempt_id":"attempt-1","status":"rejected","code":"completion_context_changed","retryable":true,"next_action":"retry_completion"}}`))
	}))
	defer server.Close()
	mode := &LoopMode{client: valaris.NewClient(server.URL, "vlr_fixture"), workspaceSlug: "default", boardID: "board"}
	err := mode.publishCompletionResult(context.Background(), "attempt-1", valaris.CompletionResult{})
	var rejected *valaris.CompletionResultRejection
	if !errors.As(err, &rejected) || calls != 1 {
		t.Fatalf("rejected receipt must not be retried: calls=%d err=%v", calls, err)
	}
}
