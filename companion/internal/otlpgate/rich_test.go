// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package otlpgate

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/Valaris-Studio/backplane/companion/internal/privacy"
)

// A rich thread's telemetry is scrubbed exactly as a full one's: tool output
// keeps full's bound, and nothing more travels in the event.
func TestRichThreadsAreScrubbedExactlyLikeFull(t *testing.T) {
	long := strings.Repeat("CODEX_OUTPUT ", 3000)
	body := `{"resourceLogs":[{"resource":{"attributes":[]},"scopeLogs":[{"scope":{},"logRecords":[{"attributes":[` +
		`{"key":"event.name","value":{"stringValue":"codex.tool_result"}},{"key":"conversation.id","value":{"stringValue":"thread-root"}},` +
		`{"key":"arguments","value":{"stringValue":"{\"cmd\":\"make test\"}"}},{"key":"output","value":{"stringValue":"` + long + `"}}]}]}]}]}`
	forwardedAt := func(level privacy.ContentLevel) string {
		f := newFixture(t)
		f.resolver.set("thread-root", Decision{Verdict: Forward, ContentLevel: level})
		request := httptest.NewRequest(http.MethodPost, "/v1/logs", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		f.gate.ServeHTTP(httptest.NewRecorder(), request)
		return f.forwarder.all(Logs)
	}
	rich, full := forwardedAt(privacy.Rich), forwardedAt(privacy.Full)
	if rich != full {
		t.Fatalf("rich forwarded %d bytes, full %d: rich must be scrubbed as full", len(rich), len(full))
	}
}
