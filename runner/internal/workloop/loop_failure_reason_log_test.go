// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package workloop

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestRecordFailure_LogsReason pins the observability fix: recordFailure must
// surface its reason string in the log, not just bump an opaque counter. For
// three sessions the implement commit-then-fail loop was un-diagnosable because
// `card failure recorded` printed only a count — operators could not tell a
// failed `git push` from `produced no changes` from a `git commit` error. The
// reason is the single most important field when a card bounces; it must be in
// the line the operator already watches.
func TestRecordFailure_LogsReason(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("{}"))
	}))
	defer srv.Close()

	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	loop := newTestLoop(srv.URL)

	const reason = "git push: remote rejected: shallow update not allowed"
	loop.recordFailure(reason, "card-xyz")

	out := buf.String()
	if !strings.Contains(out, "git push: remote rejected: shallow update not allowed") {
		t.Errorf("recordFailure must log the reason string so operators can diagnose the failure; got:\n%s", out)
	}
	if !strings.Contains(out, "card-xyz") {
		t.Errorf("recordFailure log must carry the card_id; got:\n%s", out)
	}
}
