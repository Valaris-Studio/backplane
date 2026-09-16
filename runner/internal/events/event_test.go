// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package events

import (
	"encoding/json"
	"testing"
)

func TestEventJSONUnmarshal(t *testing.T) {
	raw := `{
		"event": "card.updated",
		"timestamp": "2026-04-12T10:30:00Z",
		"event_id": "evt_abc123",
		"payload": {
			"entity_type": "card",
			"entity_id": "card-42",
			"action": "updated",
			"actor_id": "user-7",
			"board_id": "board-1",
			"summary": "Card priority changed to high",
			"changes": {"priority": "high", "old_priority": "medium"}
		}
	}`

	var ev Event
	if err := json.Unmarshal([]byte(raw), &ev); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if ev.Type != "card.updated" {
		t.Errorf("Type = %q, want %q", ev.Type, "card.updated")
	}
	if ev.Timestamp != "2026-04-12T10:30:00Z" {
		t.Errorf("Timestamp = %q, want %q", ev.Timestamp, "2026-04-12T10:30:00Z")
	}
	if ev.EventID != "evt_abc123" {
		t.Errorf("EventID = %q, want %q", ev.EventID, "evt_abc123")
	}
	if ev.Payload.EntityType != "card" {
		t.Errorf("EntityType = %q, want %q", ev.Payload.EntityType, "card")
	}
	if ev.Payload.EntityID != "card-42" {
		t.Errorf("EntityID = %q, want %q", ev.Payload.EntityID, "card-42")
	}
	if ev.Payload.Action != "updated" {
		t.Errorf("Action = %q, want %q", ev.Payload.Action, "updated")
	}
	if ev.Payload.ActorID != "user-7" {
		t.Errorf("ActorID = %q, want %q", ev.Payload.ActorID, "user-7")
	}
	if ev.Payload.BoardID != "board-1" {
		t.Errorf("BoardID = %q, want %q", ev.Payload.BoardID, "board-1")
	}
	if ev.Payload.Summary != "Card priority changed to high" {
		t.Errorf("Summary = %q, want %q", ev.Payload.Summary, "Card priority changed to high")
	}
	if ev.Payload.Changes == nil {
		t.Fatal("Changes is nil")
	}
	if ev.Payload.Changes["priority"] != "high" {
		t.Errorf("Changes[priority] = %v, want %q", ev.Payload.Changes["priority"], "high")
	}
}

func TestEventJSONUnmarshalPartial(t *testing.T) {
	raw := `{
		"event": "board.created",
		"timestamp": "2026-04-12T11:00:00Z",
		"event_id": "evt_minimal"
	}`

	var ev Event
	if err := json.Unmarshal([]byte(raw), &ev); err != nil {
		t.Fatalf("unmarshal partial: %v", err)
	}

	if ev.Type != "board.created" {
		t.Errorf("Type = %q, want %q", ev.Type, "board.created")
	}
	if ev.EventID != "evt_minimal" {
		t.Errorf("EventID = %q, want %q", ev.EventID, "evt_minimal")
	}
	// All optional payload fields should be zero-valued
	if ev.Payload.EntityType != "" {
		t.Errorf("EntityType = %q, want empty", ev.Payload.EntityType)
	}
	if ev.Payload.Changes != nil {
		t.Errorf("Changes = %v, want nil", ev.Payload.Changes)
	}
	if ev.Payload.CostUSD != 0 {
		t.Errorf("CostUSD = %f, want 0", ev.Payload.CostUSD)
	}
}

func TestEventPayloadApproval(t *testing.T) {
	raw := `{
		"event": "approval.requested",
		"timestamp": "2026-04-12T12:00:00Z",
		"event_id": "evt_approval_1",
		"payload": {
			"entity_type": "card",
			"entity_id": "card-99",
			"action": "approval_requested",
			"approval_id": "apr_xyz",
			"status": "pending",
			"board_id": "board-3",
			"summary": "Agent requests approval to merge PR"
		}
	}`

	var ev Event
	if err := json.Unmarshal([]byte(raw), &ev); err != nil {
		t.Fatalf("unmarshal approval: %v", err)
	}

	if ev.Type != "approval.requested" {
		t.Errorf("Type = %q, want %q", ev.Type, "approval.requested")
	}
	if ev.Payload.ApprovalID != "apr_xyz" {
		t.Errorf("ApprovalID = %q, want %q", ev.Payload.ApprovalID, "apr_xyz")
	}
	if ev.Payload.Status != "pending" {
		t.Errorf("Status = %q, want %q", ev.Payload.Status, "pending")
	}
}

func TestEventPayloadExecution(t *testing.T) {
	raw := `{
		"event": "execution.completed",
		"timestamp": "2026-04-12T13:00:00Z",
		"event_id": "evt_exec_1",
		"payload": {
			"execution_id": "exec-42",
			"agent_id": "agent-1",
			"cost_usd": 0.035,
			"summary": "Card implementation completed"
		}
	}`

	var ev Event
	if err := json.Unmarshal([]byte(raw), &ev); err != nil {
		t.Fatalf("unmarshal execution: %v", err)
	}

	if ev.Payload.ExecutionID != "exec-42" {
		t.Errorf("ExecutionID = %q, want %q", ev.Payload.ExecutionID, "exec-42")
	}
	if ev.Payload.AgentID != "agent-1" {
		t.Errorf("AgentID = %q, want %q", ev.Payload.AgentID, "agent-1")
	}
	if ev.Payload.CostUSD != 0.035 {
		t.Errorf("CostUSD = %f, want 0.035", ev.Payload.CostUSD)
	}
}

func TestEventJSONMarshalRoundtrip(t *testing.T) {
	original := Event{
		Type:      "card.moved",
		Timestamp: "2026-04-12T14:00:00Z",
		EventID:   "evt_rt_1",
		Payload: EventPayload{
			EntityType: "card",
			EntityID:   "card-10",
			Action:     "moved",
			BoardID:    "board-5",
			Changes:    map[string]any{"column_id": "col-new"},
		},
	}

	data, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var decoded Event
	if err := json.Unmarshal(data, &decoded); err != nil {
		t.Fatalf("unmarshal roundtrip: %v", err)
	}

	if decoded.Type != original.Type {
		t.Errorf("Type = %q, want %q", decoded.Type, original.Type)
	}
	if decoded.EventID != original.EventID {
		t.Errorf("EventID = %q, want %q", decoded.EventID, original.EventID)
	}
	if decoded.Payload.EntityID != original.Payload.EntityID {
		t.Errorf("EntityID = %q, want %q", decoded.Payload.EntityID, original.Payload.EntityID)
	}
}
