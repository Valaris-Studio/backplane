// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package valaris

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const dispatchHeader = "X-Backplane-Context-Dispatch-Version"
const dispatchAgent = "00000000-0000-4000-8000-000000000047"
const dispatchBoard = "00000000-0000-4000-8000-000000000048"
const dispatchCard = "00000000-0000-4000-8000-000000000049"
const dispatchHold = "00000000-0000-4000-8000-000000000050"

func dispatchAssignmentBody() map[string]any {
	return map[string]any{
		"card":   map[string]any{"id": dispatchCard, "title": "Synthetic context dispatch"},
		"board":  map[string]any{"id": dispatchBoard, "slug": "board"},
		"column": map[string]any{"id": "00000000-0000-4000-8000-000000000051", "column_type": "todo"},
		"role":   "operator-research-47", "stage_action": "continue_project",
		"reservation":      map[string]any{"id": dispatchHold, "expires_at": "2099-01-01T00:00:00Z"},
		"context":          map[string]string{"approved": "Exact é🧪 note\n"},
		"context_revision": strings.Repeat("c", 64),
		"context_manifest": map[string]any{"schema_version": 1, "renderer_version": "context-v1", "sources": []any{}},
		"context_dispatch": map[string]any{"version": 1, "mode": "required", "policy_revision": strings.Repeat("a", 64)},
		"llm":              map[string]any{"provider": "operator-provider-47", "model": "operator-model-47", "tool_policy": map[string]any{"deny": []string{}}},
	}
}

func dispatchAssignmentRequest(t *testing.T, version int) NextAssignmentRequest {
	t.Helper()
	var req NextAssignmentRequest
	payload := map[string]any{"role_override": "operator-research-47", "board_id": dispatchBoard}
	if version != 0 {
		payload["context_dispatch_version"] = version
		payload["context_dispatch_policy_revision"] = strings.Repeat("a", 64)
	}
	encoded, _ := json.Marshal(payload)
	// Exercise the existing public client seam before additive typed fields exist.
	if err := json.Unmarshal(encoded, &req); err != nil {
		t.Fatal(err)
	}
	return req
}

func TestContextDispatchAssignmentAcknowledgement(t *testing.T) {
	tests := []struct {
		name, header string
		status       int
		mutate       func(map[string]any)
		valid        bool
	}{
		{name: "complete", header: "1", status: 200, valid: true},
		{name: "acknowledged_no_work", header: "1", status: 204, valid: true},
		{name: "no_work_missing_header", status: 204},
		{name: "wrong_header", header: "2", status: 200},
		{name: "missing_header", status: 200},
		{name: "missing_stamp", header: "1", status: 200, mutate: func(b map[string]any) { delete(b, "context_dispatch") }},
		{name: "stamp_version", header: "1", status: 200, mutate: func(b map[string]any) { b["context_dispatch"].(map[string]any)["version"] = 2 }},
		{name: "stamp_policy_revision", header: "1", status: 200, mutate: func(b map[string]any) {
			b["context_dispatch"].(map[string]any)["policy_revision"] = strings.Repeat("b", 64)
		}},
		{name: "stamp_unknown_mode", header: "1", status: 200, mutate: func(b map[string]any) { b["context_dispatch"].(map[string]any)["mode"] = "guess" }},
		{name: "empty_success", header: "1", status: 200, mutate: func(b map[string]any) { clear(b) }},
		{name: "missing_hold", header: "1", status: 200, mutate: func(b map[string]any) { delete(b, "reservation") }},
		{name: "mismatched_role", header: "1", status: 200, mutate: func(b map[string]any) { b["role"] = "other-role" }},
		{name: "mismatched_board", header: "1", status: 200, mutate: func(b map[string]any) { b["board"].(map[string]any)["id"] = dispatchCard }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body := dispatchAssignmentBody()
			if tt.mutate != nil {
				tt.mutate(body)
			}
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if tt.header != "" {
					w.Header().Set(dispatchHeader, tt.header)
				}
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(tt.status)
				if tt.status != 204 {
					_ = json.NewEncoder(w).Encode(body)
				}
			}))
			defer srv.Close()
			result, err := NewClient(srv.URL, "synthetic").NextAssignment(context.Background(), "workspace", dispatchAgent, dispatchAssignmentRequest(t, 1))
			if !tt.valid {
				if err == nil {
					t.Errorf("negotiated v1 accepted invalid acknowledgement: %+v", result)
				}
				return
			}
			if err != nil {
				t.Fatalf("valid acknowledgement: %v", err)
			}
			if tt.status == 204 {
				if result != nil {
					t.Fatal("acknowledged204 returned assignment")
				}
				return
			}
			encoded, _ := json.Marshal(result)
			var projection map[string]any
			_ = json.Unmarshal(encoded, &projection)
			stamp, ok := projection["context_dispatch"].(map[string]any)
			if !ok || stamp["policy_revision"] != strings.Repeat("a", 64) || stamp["mode"] != "required" || stamp["version"] != float64(1) {
				t.Errorf("negotiated stamp was lost: %s", encoded)
			}
			if projection["context_revision"] != strings.Repeat("c", 64) || projection["context_manifest"] == nil {
				t.Error("context revision/manifest was lost by typed client")
			}
			if result.Reservation.ID != dispatchHold || result.Context["approved"] != "Exact é🧪 note\n" {
				t.Error("existing hold/context transport changed")
			}
		})
	}
}

func TestContextDispatchAssignmentRequestAndLegacyControl(t *testing.T) {
	for _, version := range []int{0, 1} {
		t.Run(map[int]string{0: "explicit_legacy", 1: "v1"}[version], func(t *testing.T) {
			var got map[string]any
			var header string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				header = r.Header.Get(dispatchHeader)
				_ = json.NewDecoder(r.Body).Decode(&got)
				if version == 1 {
					w.Header().Set(dispatchHeader, "1")
				}
				w.WriteHeader(204)
			}))
			defer srv.Close()
			result, err := NewClient(srv.URL, "synthetic").NextAssignment(context.Background(), "workspace", dispatchAgent, dispatchAssignmentRequest(t, version))
			if err != nil || result != nil {
				t.Fatalf("no-work control: %+v %v", result, err)
			}
			if got["role_override"] != "operator-research-47" || got["board_id"] != dispatchBoard {
				t.Fatalf("operator role/board changed: %+v", got)
			}
			if version == 1 {
				if header != "1" || got["context_dispatch_version"] != float64(1) || got["context_dispatch_policy_revision"] != strings.Repeat("a", 64) {
					t.Errorf("v1 intent not transmitted: header=%q body=%+v", header, got)
				}
			} else if header != "" || got["context_dispatch_version"] != nil {
				t.Error("explicit legacy request was changed into an undeclared protocol")
			}
		})
	}
}
