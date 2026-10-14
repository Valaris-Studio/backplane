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

const snapshotExecution = "00000000-0000-4000-8000-000000000352"
const snapshotWorkspace = "00000000-0000-4000-8000-000000000348"

func snapshotBinding() ContextBinding {
	return ContextBinding{
		ReservationID: dispatchHold, AgentID: dispatchAgent, WorkspaceID: snapshotWorkspace, BoardID: dispatchBoard,
		CardID: dispatchCard, Role: "operator-research-47",
		ContextDispatch: ContextDispatchStamp{Version: 1, Mode: ContextDispatchRequired, PolicyRevision: strings.Repeat("a", 64)},
	}
}

func validSnapshot() map[string]any {
	binding := snapshotBinding()
	return map[string]any{
		"protocol_version": 1, "mode": "required", "execution_id": snapshotExecution,
		"context_binding": map[string]any{
			"reservation_id": binding.ReservationID, "agent_id": binding.AgentID, "workspace_id": binding.WorkspaceID,
			"board_id": binding.BoardID, "card_id": binding.CardID, "role": binding.Role,
			"context_dispatch": map[string]any{"version": 1, "mode": "required", "policy_revision": strings.Repeat("a", 64)},
		},
		"invocation":       map[string]any{"kind": "stage", "step_name": nil, "prompt_slot": "main"},
		"context":          map[string]string{"approved": "Approved é🧪\n"},
		"context_manifest": map[string]any{"schema_version": 1, "sources": []any{map[string]any{"source_index": 0, "alias": "approved"}}},
		"context_revision": strings.Repeat("d", 64), "dispatch_revision": strings.Repeat("e", 64),
		"card": map[string]any{"id": dispatchCard, "title": "Card é", "position": json.Number("12345678901234567890"), "due_date": nil},
		"dispatch": map[string]any{
			"provider": "operator-provider", "model": "operator-model", "tier": "", "prompt_slug": "slug",
			"input_template": "{{ index .Card \"title\" }}", "system_template": "", "tool_policy": map[string]any{"deny": []string{}},
			"output_schema": "", "required_source_indices": []int{0},
		},
	}
}

// fetchSnapshot serves body (acknowledged unless header is "") and returns the
// client's verdict on it for the stage's main call: the fetch error, else the
// validation error.
func fetchSnapshot(t *testing.T, body map[string]any, header string) (*DispatchSnapshot, error) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if header != "" {
			w.Header().Set(ContextDispatchHeader, header)
		}
		_ = json.NewEncoder(w).Encode(body)
	}))
	defer srv.Close()
	invocation := DispatchInvocation{Kind: "stage", PromptSlot: "main"}
	snapshot, err := NewClient(srv.URL, "synthetic").DispatchContext(context.Background(), "workspace", snapshotExecution, invocation)
	if err != nil {
		return nil, err
	}
	return snapshot, snapshot.Validate(snapshotExecution, snapshotBinding(), invocation)
}

// A snapshot is taken only for this execution, its exact binding and
// invocation, with every member present and typed.
func TestDispatchSnapshotRefusesAnythingButTheBoundCurrentSnapshot(t *testing.T) {
	step := "named-step"
	changes := map[string]func(map[string]any){
		"protocol_version":  func(s map[string]any) { s["protocol_version"] = 2 },
		"legacy_mode":       func(s map[string]any) { s["mode"] = "legacy" },
		"other_execution":   func(s map[string]any) { s["execution_id"] = dispatchCard },
		"other_reservation": func(s map[string]any) { s["context_binding"].(map[string]any)["reservation_id"] = dispatchCard },
		"other_role":        func(s map[string]any) { s["context_binding"].(map[string]any)["role"] = "other-role" },
		"downgraded_floor": func(s map[string]any) {
			s["context_binding"].(map[string]any)["context_dispatch"].(map[string]any)["mode"] = "legacy"
		},
		"other_invocation_kind":  func(s map[string]any) { s["invocation"].(map[string]any)["kind"] = "lifecycle" },
		"other_invocation_step":  func(s map[string]any) { s["invocation"].(map[string]any)["step_name"] = step },
		"malformed_revision":     func(s map[string]any) { s["dispatch_revision"] = "revision" },
		"other_card":             func(s map[string]any) { s["card"].(map[string]any)["id"] = dispatchBoard },
		"card_not_object":        func(s map[string]any) { s["card"] = "card" },
		"missing_card":           func(s map[string]any) { delete(s, "card") },
		"null_dispatch_revision": func(s map[string]any) { s["dispatch_revision"] = nil },
		"missing_manifest":       func(s map[string]any) { delete(s, "context_manifest") },
		"context_not_strings":    func(s map[string]any) { s["context"] = []string{"approved"} },
		"missing_provider":       func(s map[string]any) { delete(s["dispatch"].(map[string]any), "provider") },
		"missing_required_index": func(s map[string]any) { delete(s["dispatch"].(map[string]any), "required_source_indices") },
		"indices_not_integers":   func(s map[string]any) { s["dispatch"].(map[string]any)["required_source_indices"] = "0" },
		"index_past_manifest":    func(s map[string]any) { s["dispatch"].(map[string]any)["required_source_indices"] = []int{1} },
		"repeated_index":         func(s map[string]any) { s["dispatch"].(map[string]any)["required_source_indices"] = []int{0, 0} },
		"negative_index":         func(s map[string]any) { s["dispatch"].(map[string]any)["required_source_indices"] = []int{-1} },
		"empty_input_template":   func(s map[string]any) { s["dispatch"].(map[string]any)["input_template"] = "" },
		"null_system_template":   func(s map[string]any) { s["dispatch"].(map[string]any)["system_template"] = nil },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			body := validSnapshot()
			change(body)
			if _, err := fetchSnapshot(t, body, "1"); err == nil {
				t.Error("a snapshot that is not this execution's bound current one was accepted")
			}
		})
	}
	for name, header := range map[string]string{"missing_header": "", "wrong_header": "2"} {
		t.Run(name, func(t *testing.T) {
			if _, err := fetchSnapshot(t, validSnapshot(), header); err == nil {
				t.Error("an unacknowledged snapshot was accepted")
			}
		})
	}
}

// The valid control keeps the card's own keys and values, numbers as written.
func TestDispatchSnapshotKeepsTheCardAsTheServerWroteIt(t *testing.T) {
	snapshot, err := fetchSnapshot(t, validSnapshot(), "1")
	if err != nil {
		t.Fatalf("valid snapshot: %v", err)
	}
	if position, ok := snapshot.Card["position"].(json.Number); !ok || position.String() != "12345678901234567890" {
		t.Errorf("card number changed: %#v", snapshot.Card["position"])
	}
	if due, present := snapshot.Card["due_date"]; !present || due != nil {
		t.Errorf("card null lost: %#v (present %t)", due, present)
	}
	if snapshot.Card["title"] != "Card é" || snapshot.Context["approved"] != "Approved é🧪\n" {
		t.Errorf("card or context changed: %#v / %#v", snapshot.Card, snapshot.Context)
	}
}
