// Copyright (c) 2026 Valaris Studio
// SPDX-License-Identifier: MIT

package events

// Event represents a WebSocket message from the Valaris backend.
type Event struct {
	Type      string       `json:"event"`
	Timestamp string       `json:"timestamp"`
	EventID   string       `json:"event_id"`
	Payload   EventPayload `json:"payload"`
}

// EventPayload contains the event-specific data.
type EventPayload struct {
	EntityType string         `json:"entity_type,omitempty"`
	EntityID   string         `json:"entity_id,omitempty"`
	Action     string         `json:"action,omitempty"`
	ActorID    string         `json:"actor_id,omitempty"`
	BoardID    string         `json:"board_id,omitempty"`
	Summary    string         `json:"summary,omitempty"`
	Changes    map[string]any `json:"changes,omitempty"`
	// Approval-specific fields
	ApprovalID string `json:"approval_id,omitempty"`
	Status     string `json:"status,omitempty"`
	// Execution-specific fields
	ExecutionID string  `json:"execution_id,omitempty"`
	AgentID     string  `json:"agent_id,omitempty"`
	CostUSD     float64 `json:"cost_usd,omitempty"`
	// Agent-directed events (e.g. agent.poll_requested) use target_agent_id
	// instead of agent_id/actor_id so they bypass the self-filter and reach
	// the agent they are addressed to.
	TargetAgentID string `json:"target_agent_id,omitempty"`
	// board.loop_updated's flag. A POINTER because absent must stay
	// distinguishable from false: this event carries no actor_id, so the
	// self-filter cannot see it, and `enabled == true` is the only thing that
	// keeps a runner's own rail-tripped disable from waking it straight back up.
	Enabled *bool `json:"enabled,omitempty"`
}
