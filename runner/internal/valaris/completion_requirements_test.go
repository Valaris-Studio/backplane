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

func TestCompletionRequirementsSafeSetupDiagnosis(t *testing.T) {
	for _, code := range []string{"completion_role_unconfigured", "completion_role_model_required", "completion_role_prompt_required", "completion_role_tool_policy_invalid", "completion_prompt_render_invalid"} {
		t.Run(code, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(409)
				_, _ = w.Write([]byte(`{"error_code":"` + code + `","detail":"credential-secret-from-upstream"}`))
			}))
			defer server.Close()
			_, err := NewClient(server.URL, "vlr_fixture").GetCompletionRequirements(context.Background(), "acme", "board-1")
			if err == nil || !strings.Contains(err.Error(), code) || strings.Contains(err.Error(), "credential-secret") {
				t.Fatalf("expected safe actionable code %q got %v", code, err)
			}
		})
	}
}
